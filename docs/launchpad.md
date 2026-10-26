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
  `{chain_id, rpc_url, core, extension, periphery, router, deployment_block}`
  (`deployment_block`: decimal block number the periphery, deployed after the
  extension it binds, was deployed in; required). On first use per isolate
  the server checks `eth_chainId`, that the extension and periphery run the
  frozen runtime templates with the configured Core and extension as
  immutables, and that both have code at `deployment_block` and the periphery
  has none in the block before (`launch_deployment_mismatch` otherwise). A malformed entry or a
  historical launch contract gives `launch_deployment_invalid`.
- `LAUNCHPAD_API_URL`: the indexed launch API (`launch_api_not_configured`
  without it).

## Tools

| Tool | Input (exact strings unless noted) | Result |
| --- | --- | --- |
| `launchpad_list_launches` | `chain_id?`, `status?` all/trading/upcoming, `owner?` (current owner, "mine"), `creator?` (owner at creation), `sort?` newest/market_cap_usd/volume/sold_share/trade_count, `cursor?` (decimal offset from `next_cursor`), `limit?` 1-100 (20) | `launches[]` (v7 launch rows), `next_cursor`, `total`, `totals` {all, trading, upcoming}, `aggregates`, `evaluated_at`, `heads` |
| `launchpad_get_launch` | `chain_id`, `pool_id` | indexed `launch`, `pool_key`, `onchain` {block, owner, owner_matches_index, controller, trading_open, current_fee_q64/percent (feeAt at the latest block), unclaimed_fees}, `fee_schedule` with curve samples, `disclosures` |
| `launchpad_get_swaps` / `_claims` / `_owners` | `chain_id`, `pool_id`, `cursor?` (signed decimal event id from `next_cursor`), `limit?` 1-200 (50) | `swaps`/`claims`/`owners`, `next_cursor`, `as_of`; claims also `totals` {launch_token, quote_token}; rows deduplicated on `event.event_id` |
| `launchpad_preview_launch` | `chain_id`, `sender`, `name`, `symbol`, `total_supply` (whole tokens), `quote_token?` (zero = native), `start_price`+`upper_price` or `ask_tick`+`upper_tick`, `trading_start` (Unix s), `initial_fee_percent?` (50), `final_fee_percent?` (0.3), `half_life_seconds?` (86400), `salt?` (random) | `parameters` (exact tuple values), `range` (spacing, installed bounds and prices), `installation` (previewInstallation at the latest block), `fee_schedule` + curve, `preview_id`, `block`, `disclosures` |
| `launchpad_prepare_create` | preview arguments + `salt`, `preview_id`, `logo_url?` | plan: `periphery.create(parameters, logoUrl)`; `details.disclosures`; `owner_review` (create v6) |
| `launchpad_prepare_trade` | `chain_id`, `sender`, `pool_id`, `side` buy/sell, `amount` (exact input, base units), `slippage_bps?` 0-5000 (50), `deadline_minutes?` 1-30 (30), `recipient?` | plan: optional exact ERC-20 approval, router swap |
| `launchpad_prepare_claim_fees` | `chain_id`, `sender` (owner), `pool_id`, `recipient?` | plan: `periphery.claimFees(poolKey, recipient)`; `owner_review` (claim v5) |
| `launchpad_prepare_transfer_launch` | `chain_id`, `sender` (owner), `pool_id`, `new_owner` | plan: `periphery.transferLaunch(poolId, newOwner)`; `owner_review` (transfer v1) |

Every prepare tool returns the standard `preparedUiAction` result: `details.summary`
(owner-readable), `plan_id`, `execution_plan_reference` (stored plan, keccak256
integrity, TTL; a 404 means re-run the tool) and the wallet handoff text.
Create, claim and transfer also return `owner_review` (below); the execution
plan is unchanged by it. Nothing is signed or sent.

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
The transfer resolves the launch through the indexed API (pool key and quote,
for its owner-review artifact) and refuses a pool key that does not hash to
`pool_id`.

## Indexed API adapter

`src/launchpad/zero-seed/api.ts` is the only code that knows the wire shape:
the indexed launch API's response contract `zero-seed-launch-api/v7` (every
body carries `schema_version`; another version is refused as
`invalid_upstream_response`).

- `GET /launches?chainId&status=all|trading|upcoming&owner&creator&order_by=market_cap|volume|sold_share|trade_count|created&offset&limit`
  → `{schema_version, data, total, totals: {all, trading, upcoming},
  aggregates, next_offset, evaluated_at, heads}`. `sort` newest maps to
  `order_by=created`, market_cap_usd to `market_cap`, and volume, sold_share
  and trade_count to the same names. The API orders the whole filtered set in
  SQL before `offset`/`limit`, descending, ties newest first; `market_cap` and
  `volume` put launches with a USD value first (by USD), then the rest by
  whole quote units (`raw / 10^decimals`, unknown decimals last). The tool
  `cursor` is the API `offset` and `next_cursor` is `next_offset` as a string.
- `aggregates` covers the same set as `total` (every filter, never one page):
  `{launch_count, trade_count, by_quote: [{chain_id, quote_token,
  launch_count, trade_count, volume, market_cap, usd_priced, volume_usd,
  market_cap_usd}], usd: {volume, market_cap, priced_launch_count,
  excluded_launch_count}}`. Raw amounts (quote base units, exact decimal
  strings) are summed only per (chain, quote token); `usd` sums the per-launch
  6-decimal USD values of priced launches and is null when none is priced;
  `excluded_launch_count` counts launches without an indexed quote price. The
  tool keeps only the groups of configured chains, like the rows, and
  recomputes the totals from them.
- `GET /launches/{chainId}/{poolId}` → a launch row plus `principal` and
  `fee_ledger`.
- `GET /launches/{chainId}/{poolId}/swaps|claims|owners?after_event_id&limit`
  → `{schema_version, chain_id, pool_id, next_cursor, as_of, data}` (claims
  add `totals`). The tool `cursor` is passed as `after_event_id`. Rows carry
  `event` {block_number, block_hash, block_time, event_id, transaction_index,
  event_index, transaction_hash}; claims are one row per extension
  `CreatorFeesClaimed` with the periphery's `owner`, `recipient` and
  `payout_event_id`.

A launch row has `chain_id`, `pool_id`, `pool_key` {core_address, token0,
token1, config, fee, tick_spacing, extension}, `token` {address, name, symbol,
decimals: 18}, `quote_token` {…, kind native|erc20}, `launch_token_is_token1`,
`controller`, `creator`, `owner`, `logo_url` (string|null), `parameters` (every
`LaunchParameters` field: numbers as decimal strings, words as bytes32 hex),
`range` {tick_spacing, aligned_ask_tick, aligned_upper_tick, pool_tick_lower,
pool_tick_upper}, `supply`, `trading_start` (Unix seconds), `status`
(upcoming|trading), `fee_schedule`, `market` {price_tick, price_x128,
market_cap, market_cap_usd, raised, sold, sold_share, trade_count, volume,
volume_usd}, `created`
and `as_of`. The API serves lowercase addresses; the tools return them
checksummed. The pool key must match the configured Core and extension and
hash to `pool_id`. Rows outside the requested filters are rejected. API
errors are `{status, error}`; a 4xx/5xx becomes `upstream_error` with
`details.status` and `details.upstream_message`, retryable for 5xx and 429.
`volume` is `|quote delta|` summed over every `LaunchSwapped`, buys and sells,
fee-inclusive, in raw quote units; `volume_usd` and `market_cap_usd` are
6-decimal USD from the API's indexed quote price, null without one.
`test/launchpad/api-contract.test.ts` parses the API's own v7 golden
responses through the adapter and the tools.

## Disclosures

`launchpad_preview_launch`, `launchpad_prepare_create` (`details.disclosures`)
and `launchpad_get_launch` return `disclosures`
`{version: 7, status: "draft_not_approved", statements: [{code, text}]}` with
the ten codes, in order: `zero_initial_bid`, `buyer_funded_quote_reserve`,
`permanent_principal_lock`, `creator_fee_recipient_and_rate`,
`transferable_launch_ownership`, `creator_fee_recapture`, `high_initial_fee`,
`exact_output_gross_up`, `no_exit_guarantee`, `quote_token_trust`. The texts
(`src/launchpad/zero-seed/disclosures.ts`) are byte for byte the Cloud
Wallet's `createStatements` (PR #128, `policy.ts`), so the create owner
summary's `statements` equal `details.disclosures.statements[].text`. They
state the zero initial bid, the buyer-funded quote reserve, the permanent
principal lock including the supply remainder minted to address(0), the
shifted-exponential fee with `finalFee` as a long-run floor and no end date,
transferable ownership that carries accrued fees, owner recapture, the high
early fee, the exact-output gross-up, no exit guarantee and the quote trust:
for an ERC-20 quote the trust is token-wide (Core keeps one balance per token,
so a token that misreports balances or transfers exposes every pool, position
and fee ledger holding it, not just this pair); a native-ETH quote trusts no
token contract. `get_launch` uses the same texts, except that
`transferable_launch_ownership` names the current on-chain owner instead of
"this account becomes". Only integers, addresses, times and percentages are
interpolated; name, symbol and logo URL never are.

## Owner review (Cloud Wallet)

Create, claim and transfer return, next to the unchanged
`execution_plan_reference`:

```
owner_review: {
  artifact: {body, integrity, bytes},       // sealed body (below)
  preview_read?: {body, integrity, bytes},  // create only
  owner_summary: {..., summary_keccak256},  // what the wallet's verifier returns
  note
}
```

Sealing: `body` is `JSON.stringify` of the value (no whitespace, key order as
listed here), `integrity = keccak256(utf8(body))`, `bytes = utf8 length`.
Every address and hex string is lowercase; integers that can exceed 2^53 are
decimal strings; ticks are JSON numbers. `summary_keccak256 =
keccak256(utf8(JSON.stringify(summary without summary_keccak256)))`, appended
as the last key. The artifacts are explicitly non-executable (`scope:
"synthetic-local-non-executable"`, `executable: false`) and describe exactly
the plan's call (`target`, `data`, `value: "0"`).

Common envelope, in order: `schema_version, scope, executable, chain_id,
sender, target (periphery), data, value, pin`, with

- `pin` = `{chainId, feeModel: "tick_rate_final", core, extension, periphery,
  extensionRuntime, peripheryRuntime, deploymentBlock, extensionAbiSha256,
  peripheryAbiSha256}`: runtimes are keccak256 of `eth_getCode` of the
  deployed extension and periphery (checked against the frozen templates),
  `deploymentBlock` is the configured `deployment_block`, ABI hashes are the
  SHA-256 of the frozen ABI files (`frozen/provenance.json`:
  `6a131c2d…56eb`, `5d05426f…c839`).
- `quote` = `{kind: "native", address: 0x0…0, runtime: null}` or
  `{kind: "erc20", address, runtime: keccak256(eth_getCode(quote))}`. The
  wallet accepts an ERC-20 only if its own reviewed list has that runtime.

`zero-seed-local-create/v6` adds `quote, disclosure_version: 7, build
{buildTime, executionExpiry, blockNumber, blockHash, blockTime}, requested
{name, symbol, supply, quoteToken, askTick, upperTick, tradingStart,
decayRateX32, initialFee, finalFee, salt} (the calldata tuple), logo_url ("" when
absent), installation {token, poolKey {token0, token1, config}, positionId,
initialTick, liquidity, installedSupply, tickSpacing, askTick, upperTick}
(previewInstallation's result), preview {count: 1, read_integrity,
read_bytes}`. `buildTime = blockTime` = timestamp of the block the create was
built on; `executionExpiry = buildTime + 300` (always ≤ `tradingStart`, which
is at least 300 s later).

`preview_read` (`zero-seed-preview-read/v1`), the seal behind
`preview.read_integrity`/`read_bytes`: `{schema_version, chain_id,
block_number, block_hash, to (periphery), data (previewInstallation
calldata), result (raw return data)}`. The server performs this one eth_call
itself, pinned by block hash (EIP-1898, `requireCanonical`), at the build
block; a consumer can decode `result` and compare it with `installation`.

`zero-seed-local-claim/v5` adds `quote, pool_key, recipient, owner_check
{block_number, block_hash, pool_id, launch_owner}, build {buildTime,
executionExpiry}`; `owner_check` is the `launchOwner(poolId)` read at the
build block, equal to `sender`.

`zero-seed-local-transfer/v1` (proposed here; the wallet has a decoder for
`transferLaunch` but no artifact verifier yet) follows claim v5: `quote,
pool_key, pool_id, new_owner, owner_check {block_number, block_hash, pool_id,
launch_owner}, build {buildTime, executionExpiry}`. A verifier should refuse,
with the claim v5 codes where they apply: the seal and canonical checks
(`artifact_length_mismatch`, `artifact_tampered`, `artifact_schema_mismatch`,
`artifact_noncanonical`); the envelope (`pin_mismatch`, `target_mismatch`,
`owner_mismatch`, `stored_call_mismatch`); `unsupported_quote` unless the
quote resolves as in claim v5 and is a side of `pool_key`;
`pool_extension_mismatch` unless `pool_key.config >> 96 == extension`;
`owner_check_pool_mismatch` unless `pool_id == keccak256(abi.encode(pool_key))
== owner_check.pool_id`; `not_launch_owner` unless `owner_check.launch_owner
== sender`; `invalid_owner` for a zero `new_owner`, and (new code)
`same_owner` for `new_owner == sender`; `calldata_method_mismatch` /
`calldata_summary_mismatch` unless the calldata decodes as
`transferLaunch(pool_id, new_owner)`; `expired_or_future_plan` unless
`buildTime ≤ now < executionExpiry`. Its owner summary (`owner summary v6`,
`method: "transferLaunch"`, `selector: 0x8b1cb36f`) is `{schema_version,
chain_id, target, selector, method, disclosure {version, status}, fields
{owner, instance, quote, pool_key, pool_id, new_owner, owner_check, effect
{moves_tokens: false, moves_principal: false, unclaimed_fees_follow_owner:
true, reversible_by_previous_owner: false, execution_guaranteed: false}},
statements: transferStatements(new_owner), summary_keccak256}`, with
`instance` and `quote` exactly as in the claim summary.

`owner_summary` for create and claim is `zero-seed-launch-owner-summary/v6`
exactly as the wallet's `verifyLaunchCreate` / `verifyLaunchClaim` build it
(`src/launchpad/zero-seed/review.ts` mirrors `artifact.ts` field by field):
instance and quote, packed name/symbol words with their bytes and lossy text,
the logo as untrusted display data, requested/installed/sink supply, requested
and installed range, the fee schedule fields and samples, salts, ownership,
binding (pool id, position, calldata keccak256, preview read integrity),
rounding and the ten statements.

Trades carry no launch artifact: they are router calls, and the wallet has no
launch-specific trade artifact. Their review relies on the wallet's existing
Yul router decoding and summary (the plan's route, minimum output, deadline
and approval).

### Pre-validation against the wallet

`test/fixtures/launchpad/wallet-handoff-final.json` (written with the
lifecycle) has the pin, the reviewed ERC-20 quote, both creates, both claims,
the transfer, four trades and 21 negative cases with the refusal code the
wallet should emit. It was replayed through the unmodified Cloud Wallet
verifier (PR #128 at `fede2ff`) in a scratch checkout: both creates and both
claims are accepted with owner summaries byte-equal to `owner_summary`
(including `summary_keccak256`), the transfer's call decodes as
`transferLaunch(pool_id, new_owner)` ("Transfer a token launch"), every
trade's route decodes and re-encodes canonically and summarises as "Swap"
(input, output, minimum output, deadline, the forwarded launch hop) when
summarised with the bundled registry on a chain that lists the canonical
router (Base, 8453); on the local chain id 31337, which no registry entry
lists, the wallet shows the router call undecoded, and all 21 negative cases refuse with the listed code.
`test/launchpad/owner-review.test.ts` re-checks the seals, the bindings and
recomputes every owner summary from its body on each run.

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

## Interface parity (launch pages, interface #1365 at 3720ebc)

Baseline: the interface's launch pages at `3720ebc` ("Launch pages: final
launch contracts (evm-contracts 853b608)"), `src/pages/evm/EvmLaunch.tsx`,
`EvmLaunches.tsx`, `EvmLaunchInfo.tsx`. They read launches from chain logs
(`LaunchCreated`, `LaunchSwapped`) and `launchOwner`; the tools read the
indexed API v7 and the chain.

| UI action | Tool | Notes |
| --- | --- | --- |
| Name, symbol, total supply (≤ 1T, 18 decimals) | `launchpad_preview_launch` | same packOne and cap |
| Quote token (native or ERC-20; selects chain) | `quote_token` + `chain_id` | ERC-20 must have code and `decimals()` |
| Start and upper price | `start_price`, `upper_price` | exact ticks; the contract derives spacing and installs the inward-aligned range, as the UI (no 1024 snapping in either) |
| Trading start 5 min-24 h ahead | `trading_start` | checked against the latest block |
| Initial fee, final fee, half-life (50% → 0.3%, one day) | `*_fee_percent`, `half_life_seconds` | same defaults and conversion |
| Fee chart | `fee_schedule.curve` | samples at 0, 1 h, 6 h, 1 d, 2 d, 7 d, 30 d |
| Logo URL (https:// or ipfs://, ≤ 2048 bytes; preview image) | `logo_url` on `launchpad_prepare_create` | no image is fetched |
| Random salt | preview default | |
| Preview, then create | `launchpad_preview_launch` → `launchpad_prepare_create` | bound by `preview_id`; disclosures in both |
| Launch list, all/trading/upcoming/mine, totals | `launchpad_list_launches` | `mine` = current `owner` (`launchOwner`), as the UI |
| Sort by market cap (default in the UI) | `sort` market_cap_usd → `order_by=market_cap` | USD first, then by quote amount, as the UI's `rankValue`; `market.market_cap` = price × requested supply, the UI's `marketCap` |
| Sort by volume | `sort` volume | `market.volume` = Σ\|quote delta\| of `LaunchSwapped`, fee-inclusive, the UI's `summarizeSwaps`; USD first, then quote amount |
| Sort by sold | `sort` sold_share | `market.sold_share` (see note below) |
| Sort by trades | `sort` trade_count | `market.trade_count`, every `LaunchSwapped`, as the UI's `trades` |
| Newest | `sort` newest (tool default) | creation order, newest first |
| Tile: total market cap | `aggregates.usd.market_cap` | sum over priced launches, as the UI's `sumUsd`; per-quote raw sums in `by_quote[].market_cap` |
| Tile: volume | `aggregates.usd.volume` | sum over priced launches; `excluded_launch_count` counts the rest; per-quote raw sums in `by_quote[].volume` |
| Tile: launches | `total` / `aggregates.launch_count` | |
| Tile: trades | `aggregates.trade_count` | |
| Launch page: facts, owner, controller, trading start, supply, current fee, schedule, market | `launchpad_get_launch` | on-chain owner/fee at the latest block |
| Recent trades | `launchpad_get_swaps` | |
| Buy / sell exact input, slippage, deadline, approval | `launchpad_prepare_trade` | |
| Claim fees (both tokens, owner only) | `launchpad_prepare_claim_fees` | |
| — (no UI) | `launchpad_prepare_transfer_launch`, `launchpad_get_owners`, `launchpad_get_claims` | the pages at 3720ebc have no transfer, owner-history or claim-history view (`transferLaunch` is only in the ABI); the tools cover the contract's full owner surface |

No action is new at 3720ebc relative to b22982e; the change is the final ABI
(packed metadata, contract-derived spacing, logo argument, `previewInstallation`).
The UI computes its tiles over every launch regardless of the selected
tab; the tools' aggregates follow the request's filters, so `status` all
with no `owner`/`creator` gives the UI's tiles. Differences from the UI:
`sold_share` is `sold / installed` from the pool's launch-token balance,
while the UI derives its sold fraction from the pool tick; USD comes from the
API's indexed price rather than the interface token list. Exact-output trades
are offered by neither. Market data and USD values come only from the
indexed API. The API v7 shape is no longer an assumption:
`test/launchpad/api-contract.test.ts` parses the API's own golden responses (API `75ee5be`) through the adapter and every
read tool.

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
  `test/fixtures/launchpad/local-lifecycle.json` (every plan with its
  owner-review artifact and summary), which `test/launchpad/calldata.test.ts`
  decodes independently on every run, and `wallet-handoff-final.json`, checked
  by `test/launchpad/owner-review.test.ts`.
- `test/mcp-acceptance/launchpad-scenarios.json`: small-model scenarios for
  `SCENARIOS=… MCP_URL=…/mcp/launchpad bun run test:mcp-acceptance` (paid, not run).
