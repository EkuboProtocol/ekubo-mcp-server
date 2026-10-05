# Launchpad analytics (prototype)

Non-production. The engine implements sections 2 to 5, 8 (B1 to B8) and 9 (L1)
of the EKU-645 interface contract, revision 4, and amendments A1 to A3 of the
EKU-650 ruling. Connect to `/mcp/launchpad`. This endpoint is separate from the
root `/mcp` bundle. Discovery is at `/tools?protocol=launchpad`.

## Configuration

| Variable | Meaning |
| --- | --- |
| `LAUNCHPAD_SOURCE` | `rpc` or `fixture`. Unset: tools and `/launchpad/stats` return `launchpad_not_configured`. |
| `LAUNCHPAD_MANIFEST` | For `rpc`: the evm-contracts `launchpad-manifest.json` (`chain_id`, `fork_block`, `git_revision`, `contracts.{name}.{address,code_hash}`). |
| `LAUNCHPAD_RPC_URL` | For `rpc`: JSON-RPC endpoint of the manifest's chain. `eth_chainId` must match. |
| `LAUNCHPAD_FIXTURE` | For `fixture`: a bundle in `eth_getLogs` shape (the EKU-662 v2 format). It may cover several chains. |

Both sources reject malformed addresses, hashes and log data at the boundary
instead of repairing them.

## Tools and endpoint

| Surface | Result |
| --- | --- |
| `launchpad_search` | Candidates on one chain by text, `launched_after`, `phase`, `quote_asset` and `min_quote_raised`/`max_quote_raised`. Sorted by `launch_block_desc`, `launch_block_asc` or `quote_raised_desc`. Rows carry the creation block (number, hash, timestamp), `quote_raised` with decimals and USD from a cited pinned price, and `metadata.non_ascii`. Responses echo `sort_applied` and `sponsored: false`. |
| `launchpad_get_launch` | Initial, final and current fee as exact Q64 values, fractions and percentages, plus the remaining schedule. Also released and deployed supply, phase, quote asset and decimals, migration bounds as ticks and prices beside the current terminal price, and principal received, deposited and pending. `privileges` is returned only when the emitter's code hash matches the manifest. |
| `launchpad_get_provenance` | Creation log and block, `transaction_sender`, `payer` and `beneficiary`, emitter code hash against the manifest, config excerpt, same-symbol earlier launches, `does_not_prove`. |
| `launchpad_get_analytics` | Holders with Core decomposed and excluded by category, plus `additional_exclusions` echoed as `caller_supplied`. Also creator allocation, early acquisition, 24-hour volume and the swap reconciliation. |
| `GET /launchpad/stats` | `tokens_created` and `rolling_24h_volume` per quote asset with scope, `as_of` and `source`. Pass `?chain_id=` when several chains are covered. It is not cached. |

Every response carries:
- `as_of`: chain, block number, hash, timestamp and finality.
- `source`: kind, indexed range, `complete`, missing ranges, head block and timestamp, lag, `retrieved_at`, engine version and manifest revision.
- `limitations`.
- `undecoded`: launchpad logs that failed to decode, kept raw.

Lookups on a chain the launchpad does not cover return `launch_not_found`. They never match another chain.

## Engine

`src/launchpad/analytics/` turns a snapshot into results with pure functions:

1. **Source** (`fixture-source.ts`, `rpc-source.ts`, `validate.ts`): canonical headers and raw logs up to `as_of`.
   - The RPC source reads Core, ScheduledLaunch, LockedLaunchLiquidity and LaunchRouter logs, then each launch token's `Transfer` logs, in fixed block chunks. A failed or malformed chunk becomes a missing range. A log whose block hash differs from the header read afterwards marks that block missing.
   - The fixture source takes the canonical header from the `reorgs` marker wherever two headers share a height.
2. **Canonical** (`canonical.ts`): drops non-canonical and removed logs, deduplicates by (block hash, transaction hash, log index) and sorts by position.
   - A log identity that arrives with different contents makes the result incomplete.
   - Headers whose timestamps decrease, or adjacent heights that do not link by parent hash, also make the result incomplete.
   - `CanonicalChain` is the incremental store. It truncates at a replaced height and asks for missing ancestors.
3. **Decode** (`decode.ts`): logs are accepted only from manifest addresses, and `Transfer` logs only from launch tokens.
   - Every decoded log must re-encode to exactly its topics and data. Otherwise it goes to `undecoded`; a Transfer with 96 bytes of data is one example.
   - Core's `PositionUpdated`, `PositionFeesCollected` and 116-byte swap `log0` are decoded too.
4. **Index** (`launches.ts`, `state.ts`, `terminal.ts`): per-launch records.
   - Launch-pool Core swaps split into the user swap behind each `LaunchSwapped` (the nearest earlier one in the same transaction) and internal release sales.
   - LockedLaunchLiquidity bookkeeping is rebuilt from call order: received, deposited, rebalanced, fees to principal, and the creator ledger.
5. **Figures** (`holders.ts`, `analytics.ts`, `reconcile.ts`, `views.ts`, `prices.ts`).

### Definitions

- **Ratios.** Shares, means and medians are exact fractions `{num, den}` in lowest terms. A truncated `decimal` sits beside each.
- **Core decomposition.**
  - `unreleased_inventory` is supply minus `released(as_of)` until the launch finishes.
  - `launch_pool_liquidity` and the terminal-pool reserve are each pool's swap deltas plus position deltas minus collected fees.
  - `unclaimed_creator_fees` covers both creator ledgers.
  - `locked_terminal_liquidity` is the terminal-pool reserve plus undeposited principal.
  - `other_core_held` is the remainder, including released inventory not yet deployed.
  - If the source carries no Core logs, these categories are `null`, as are internal sales, terminal and TWAMM volume, and the stalled phase.
- **Volume.** The window is `(as_of − 86400, as_of]`.
  - `user_launch` is the fee-inclusive quote of `LaunchSwapped`.
  - `twamm_virtual` is terminal-pool Core swaps whose locker is the manifest's TWAMM extension. TWAMM executes virtual orders inside its own Core lock. Without a TWAMM address in the manifest, `twamm_virtual` is `null` and a limitation says so.
  - Release sales and migration rebalancing are `internal`.
- **Round trip.** Only routed swaps are grouped, by router payer. A group counts when it both bought and sold and `|bought − sold| ≤ threshold_bps` of the larger side. It is reported with `confidence: "heuristic"` and never subtracted from gross volume. Unrouted swaps have no payer: the locker is reported as a locker, never as a trader.
- **Reconciliation (B8).** Each transaction with `LaunchSwapped` must move the launch token in and out of Core by exactly the swap deltas, less any fee withdrawals in it. A mismatch is listed and noted.
- **Privileges (L1).** The values were read from evm-contracts `3e4ffad`. A launch pool rejects every position but the extension's own, so `third_party_liquidity` is `rejected`. They are returned only when the observed emitter code hash equals the manifest's.
- **Incomplete zeros.** A zero computed while `source.complete` is false is returned as `null`.

Names and symbols are returned verbatim under `metadata` with `trust: "untrusted"`. They appear in no other field and never cause a network request.
