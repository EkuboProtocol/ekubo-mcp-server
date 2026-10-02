# Launchpad analytics (prototype)

Non-production. The engine reads one local chain named by a launchpad
manifest. It implements sections 2 to 5 of the EKU-645 interface contract.
Connect to `/mcp/launchpad`. This endpoint is separate from the root `/mcp`
bundle. Discovery is at `/tools?protocol=launchpad`.

## Configuration

| Variable | Meaning |
| --- | --- |
| `LAUNCHPAD_SOURCE` | `rpc` or `fixture`. Unset: tools and `/launchpad/stats` return `launchpad_not_configured`. |
| `LAUNCHPAD_MANIFEST` | Manifest JSON (`chain_id`, `fork_block`, optional `deployment_block`, `git_revision`, `contracts`) for `rpc`. |
| `LAUNCHPAD_RPC_URL` | JSON-RPC endpoint of the manifest's chain for `rpc`. |
| `LAUNCHPAD_FIXTURE` | A fixture bundle (`ekubo-launchpad-fixture/1`) for `fixture`. It carries its own manifest. |

## Tools and endpoint

| Surface | Result |
| --- | --- |
| `launchpad_search` | Candidates by text, exact address, quote token, beneficiary, phase or creation blocks. `requires_exact_address` is set when text matches more than one launch. |
| `launchpad_get_launch` | Schedule, current fee, released, deployed, phase, launch-pool state, terminal pool, pending principal. |
| `launchpad_get_provenance` | Creation log and block, transaction sender, router payer, fee beneficiary, emitter code hash against the manifest, config excerpt, same-symbol earlier launches, `does_not_prove`. |
| `launchpad_get_analytics` | Holders with Core decomposed and excluded by category, creator allocation, early acquisition, 24-hour volume. |
| `GET /launchpad/stats` | `tokens_created` and `rolling_24h_volume` per quote asset with scope, `as_of` and `source`. It is not cached. |

Every response carries `as_of` (chain, block number, hash, timestamp,
finality), `source` (kind, indexed range, `complete`, missing ranges, head
block and timestamp, lag, `retrieved_at`, engine version, manifest revision)
and `limitations`.

## Engine

`src/launchpad/analytics/` turns a snapshot into results with pure functions:

1. **Source** (`fixture-source.ts`, `rpc-source.ts`): canonical headers and raw
   logs up to `as_of`. The RPC source reads Core, ScheduledLaunch,
   LockedLaunchLiquidity and LaunchRouter logs, then each launch token's
   `Transfer` logs, in fixed block chunks. A failed chunk becomes a missing
   range. A log whose block hash differs from the header read afterwards marks
   that block missing.
2. **Canonical** (`canonical.ts`): drops non-canonical and removed logs. It
   deduplicates by (block hash, transaction hash, log index) and sorts by
   position. A log identity that arrives with different contents makes the
   result incomplete. `CanonicalChain` is the incremental store: it truncates at
   a replaced height and asks for missing ancestors.
3. **Decode** (`decode.ts`): extension, liquidity, router and ERC-20 events, plus
   Core's `PositionUpdated`, `PositionFeesCollected` and 116-byte swap `log0`.
4. **Index** (`launches.ts`, `state.ts`): per-launch records. Launch-pool Core
   swaps are split into the user swap behind each `LaunchSwapped` (the nearest
   earlier one in the same transaction) and internal release sales.
5. **Figures** (`holders.ts`, `analytics.ts`, `views.ts`).

### Definitions

- **Core decomposition.** `unreleased_inventory` is supply minus `released(as_of)`
  until the launch finishes. `launch_pool_liquidity` and the terminal-pool
  reserve are each pool's swap deltas plus position deltas minus collected
  fees. `unclaimed_creator_fees` is the launch-token fee charged by
  `LaunchSwapped`, plus fees collected at finish, minus `CreatorFeesClaimed`.
  `other_core_held` is the remainder, including released inventory not yet
  deployed. After the first deposit, undeposited principal and terminal-ledger
  fees cannot be separated from events, so they also fall into
  `other_core_held`.
- **Round trip.** Launch swaps in the window are grouped by router payer, or by
  locker when the swap was not routed. A group counts when it both bought and
  sold and `|bought − sold| ≤ threshold_bps` of the larger side. Its quote
  volume is reported beside gross user volume and is never subtracted from it.
- **Phase.** `stalled` means released inventory is not yet deployed while the
  last observed launch-pool tick is beyond the far bound of the launch range.
- **Incomplete zeros.** A figure of zero computed while `source.complete` is
  false is returned as `null`.

Names and symbols are returned verbatim under `metadata` with
`trust: "untrusted"`. They appear in no other field.

## EKU-649 benchmark

`bun test/launchpad/eku649/report.ts` prints the reproduction report for the
Data Engineer's bundle. `test/launchpad/eku649.test.ts` pins its statuses.
