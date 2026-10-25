# Launchpad (final zero-seed launch)

The `launchpad_*` tools prepare and read zero-seed token launches on the final
launch contracts, EkuboProtocol/evm-contracts `853b608` (`ZeroSeedLaunch`
extension, `ZeroSeedLaunchPeriphery`, `LaunchToken`). Their compiled ABIs are
imported verbatim in `src/launchpad/zero-seed/frozen/` with
`provenance.json` (source commit, file SHA-256, runtime templates). Earlier
launch revisions (fixed-base duration, tick-rate drafts) are not supported:
their ABIs, pins and fixtures are removed, and a configuration naming one of
their contracts is refused.

## Where the tools are served and when they work

They are served only at `/mcp/launchpad`, a standalone endpoint excluded from
`/mcp` and `?protocols=` bundles. No final deployment exists, so none is built
in: every tool answers `launch_support_disabled` before any request until the
server is configured with

- `LAUNCHPAD_DEPLOYMENTS`: a JSON array of
  `{chain_id, rpc_url, core, extension, periphery, router}`. On first use per
  isolate the server checks `eth_chainId` and that the extension and periphery
  run the frozen runtime templates with the configured Core and extension as
  immutables (`launch_deployment_mismatch` otherwise). A malformed entry or a
  historical launch contract gives `launch_deployment_invalid`.
- `LAUNCHPAD_API_URL`: the indexed launch API (`launch_api_not_configured`
  without it).

## Tools

| Tool | Input (exact strings unless noted) | Result |
| --- | --- | --- |
| `launchpad_list_launches` | `chain_id?`, `status?` all/trading/upcoming, `owner?` (current owner, "mine"), `sort?` newest/market_cap_usd, `cursor?`, `limit?` 1-100 (20) | `launches[]`, `next_cursor`, `totals` |
| `launchpad_get_launch` | `chain_id`, `pool_id` | indexed `launch`, `pool_key`, `onchain` {block, owner, owner_matches_index, controller, trading_open, current_fee_q64/percent (feeAt at the latest block), unclaimed_fees}, `fee_schedule` with curve samples |
| `launchpad_get_swaps` / `_claims` / `_owners` | `chain_id`, `pool_id`, `cursor?`, `limit?` 1-200 (50) | `swaps`/`claims`/`owners`, `next_cursor`; claims deduplicated on (transaction_hash, log_index) |
| `launchpad_preview_launch` | `chain_id`, `sender`, `name`, `symbol`, `total_supply` (whole tokens), `quote_token?` (zero = native), `start_price`+`upper_price` or `ask_tick`+`upper_tick`, `trading_start` (Unix s), `initial_fee_percent?` (50), `final_fee_percent?` (0.3), `half_life_seconds?` (86400), `salt?` (random) | `parameters` (exact tuple values), `range` (spacing, installed bounds and prices), `installation` (previewInstallation at the latest block), `fee_schedule` + curve, `preview_id`, `block` |
| `launchpad_prepare_create` | preview arguments + `salt`, `preview_id`, `logo_url?` | plan: `periphery.create(parameters, logoUrl)` |
| `launchpad_prepare_trade` | `chain_id`, `sender`, `pool_id`, `side` buy/sell, `amount` (exact input, base units), `slippage_bps?` 0-5000 (50), `deadline_minutes?` 1-30 (30), `recipient?` | plan: optional exact ERC-20 approval, router swap |
| `launchpad_prepare_claim_fees` | `chain_id`, `sender` (owner), `pool_id`, `recipient?` | plan: `periphery.claimFees(poolKey, recipient)` |
| `launchpad_prepare_transfer_launch` | `chain_id`, `sender` (owner), `pool_id`, `new_owner` | plan: `periphery.transferLaunch(poolId, newOwner)` |

Every prepare tool returns the standard `preparedUiAction` result: `details.summary`
(owner-readable), `plan_id`, `execution_plan_reference` (stored plan, keccak256
integrity, TTL; a 404 means re-run the tool) and the wallet handoff text.
Nothing is signed or sent.

### Create

- `name`/`symbol` are encoded with Solady `LibString.packOne`: byte 0 is the
  UTF-8 byte length 1..31, the content follows, the tail is zero. Longer or empty
  values are refused, never truncated.
- Decimals are always 18; `total_supply` is whole tokens with up to 18 decimals,
  more than 0 and at most one trillion (10^30 base units, the contract cap).
- Prices are quote tokens per whole launch token. The economic tick is
  `round(log_1.000001(raw quote per raw token))`, address-order independent.
  The contract derives the spacing `s = (upper - ask + 255) // 256` and installs
  `[ceil(ask/s)*s, floor(upper/s)*s]` with signed ceil/floor; there is no 1024
  snapping. The preview refuses (`preview_mismatch`) if the contract's
  reported spacing or bounds differ from this rule.
- `trading_start` must be 5 minutes to 24 hours after the latest block (UI
  policy; the contract only requires it not to be past).
- Fees: percent strings converted to Q0.64 rounded down; `final_fee_percent <=
  initial_fee_percent`; `half_life_seconds` becomes `decayRateX32 =
  floor(HALF_LIFE_X32_E30 / (micros * 10^24))` (one day = `68913100933`).
- `salt` is random 32 bytes in the preview; the periphery namespaces it by owner.
- `preview_id` is keccak256 of the periphery, owner, parameters, range,
  installation and fee schedule. `prepare_create` recomputes the preview and
  refuses with `preview_mismatch` when it differs.
- `logo_url`: optional https:// or ipfs:// URL, at most 2048 bytes, no
  whitespace; passed as `""` when absent. It is emitted in `LaunchCreated`, not
  stored, and is untrusted display data.

### Trade

The launch is resolved through the indexed API; its pool key is rebuilt from
token, quote, configured extension and tick spacing and must hash to `pool_id`.
The quote is `router.quote` of the single forwarded hop (`@ekubo/yul-router-sdk`)
at the latest block, so it includes the creator fee `feeAt` returns for that
block (reported as `creator_fee_q64`). The route carries the minimum output
`floor(out * 10000 / (10000 + slippage_bps))` and the deadline. Native input is
attached as value; ERC-20 input gets an exact approval to the router only when
`allowance(sender, router)` is short. Before trading opens: `trading_not_started`.
A partial fill is refused: `insufficient_liquidity`.

### Owner actions

Both read `launchOwner(poolId)` at the latest block and refuse a non-owner
(`not_launch_owner`). A claim refuses recipients the periphery refuses (zero,
Core, extension, periphery, either pool token) and refuses `no_fees_to_claim`
when `creatorFees(poolKey)` is zero. A transfer refuses the zero address and the
current owner. The new owner receives every fee right, including accrued fees.

## Indexed API adapter

`src/launchpad/zero-seed/api.ts` is the only code that knows the wire shape:
`GET /launches?chain_id&status&owner&sort&cursor&limit` →
`{data, next_cursor, totals}`; `GET /launches/{chain}/{pool_id}`; and
`/swaps|claims|owners` pages `{data, next_cursor}` whose rows carry at least
`transaction_hash` and `log_index`. A launch row has `chain_id`, `pool_id`,
`token`/`quote_token` `{address, name, symbol, decimals}`, `controller`,
`owner`, `creator`, `logo_url` (string|null), `parameters` {`supply`,
`initial_fee`, `final_fee`, `decay_rate_x32`} as decimal strings,
`tick_spacing`, `ask_tick`, `upper_tick`, `trading_start`, `status`
(upcoming|trading) and `market` {price, market_cap, market_cap_usd, raised,
sold_share, trades}. Rows outside the requested filters are rejected.

## Errors

`invalid_argument` (with `details.argument`, raised before any upstream call
where the check needs no chain data; contract refusals of the preview map to
the argument, with `details.contract_error`), `launch_support_disabled`,
`launch_deployment_invalid`, `launch_deployment_mismatch`,
`launch_api_not_configured`, `launch_not_found`, `preview_mismatch`,
`preview_reverted`, `trading_not_started`, `quote_reverted`,
`insufficient_liquidity`, `not_launch_owner`, `launch_not_owned_by_periphery`,
`no_fees_to_claim`, `upstream_error`, `upstream_timeout`,
`invalid_upstream_response`. `details.retryable` says whether the same call may
succeed later.

## Interface parity (launch UI, interface b22982e)

| UI action | Tool | Notes |
| --- | --- | --- |
| Name, symbol, total supply (≤ 1T, 18 decimals) | `launchpad_preview_launch` | same packOne and cap |
| Quote token (native or ERC-20; selects chain) | `quote_token` + `chain_id` | ERC-20 must have code and `decimals()` |
| Start and upper price | `start_price`, `upper_price` | spacing by the contract rule; the UI's 1,024-spacing choice is not used, the contract derives it |
| Trading start 5 min-24 h ahead | `trading_start` | checked against the latest block |
| Initial fee, final fee, half-life (50% → 0.3%, one day) | `*_fee_percent`, `half_life_seconds` | same defaults and conversion |
| Fee chart | `fee_schedule.curve` | samples at 0, 1 h, 6 h, 1 d, 2 d, 7 d, 30 d |
| Logo URL | `logo_url` on `launchpad_prepare_create` | |
| Random salt | preview default | |
| Preview, then create | `launchpad_preview_launch` → `launchpad_prepare_create` | bound by `preview_id` |
| Launch list, totals, top by USD market cap, all/trading/upcoming/mine | `launchpad_list_launches` | `mine` = `owner` filter |
| Launch page: facts, owner, controller, current fee, schedule, market data | `launchpad_get_launch` | on-chain owner/fee at latest block |
| Trades history | `launchpad_get_swaps` | |
| Buy / sell exact input, slippage, deadline, approval | `launchpad_prepare_trade` | exact-output trades are a gap: not offered by the tool |
| Claim fees (both tokens) | `launchpad_prepare_claim_fees` | |
| Transfer launch | `launchpad_prepare_transfer_launch` | |

Gaps: exact-output trades; market data and USD values come only from the
indexed API (not recomputed on chain); the API v6 shape above is this server's
adapter contract and must be confirmed against the revised API.

## Verification

- `test/launchpad/frozen.test.ts`: file hashes; every selector, error and
  topic of the three ABIs against `zero-seed-launch.json`; recorded
  `LaunchCreated` logs (empty and nonempty logo); packOne; 56 installation rows
  and the specification spacing table; fee vectors and oracle curve digests.
- `test/launchpad/acceptance.test.ts`: tools/list and tools/call through
  `worker.fetch` against a mocked RPC (frozen runtimes) and API.
- `test/launchpad/local-chain.test.ts` (`LAUNCHPAD_ANVIL=1`, needs `anvil`):
  deploys the frozen init code, Core runtime and the production Yul router
  runtime (`0x03c8…441C`, keccak `0x32ba8475…`, read from Ethereum mainnet with
  `eth_getCode`) locally and executes, from tool-prepared plans: native and
  ERC-20 quote creates (empty and nonempty logo), native buy and sell, ERC-20 buy
  with approval, owner claim, transfer, refused claim by the old owner and claim
  by the new owner. It asserts preview = installation, events, owners and
  balances. With `LAUNCHPAD_WRITE_FIXTURE=1` it rewrites
  `test/fixtures/launchpad/local-lifecycle.json`, which
  `test/launchpad/calldata.test.ts` decodes independently on every run.
- `test/mcp-acceptance/launchpad-scenarios.json`: small-model scenarios for
  `SCENARIOS=… MCP_URL=…/mcp/launchpad bun run test:mcp-acceptance` (paid, not run).
