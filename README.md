# Ekubo MCP server

The official agent interface for Ekubo Protocol transactions. This repository
deploys a stateless, public MCP server on Cloudflare Workers. It discovers
tokens, compares Ekubo and 0x liquidity for same-chain EVM swaps, prepares
Across any-to-any bridges, and constructs unsigned VeToken calls for ve(3,3)
vote and fee workflows. It also publishes provider-neutral STONX allocation
recommendations resolved to initialized Robinhood Ve33 pools, enumerates
indexed LP positions by owner, reproduces the interface's indexed/API/USD/RPC
position-data pipeline, discovers pair-level position candidates, prepares
unsigned LP deposits, withdrawals, and earnings claims, and exposes exact pool
state and liquidity data. It prepares interface-equivalent TokenDataFetcher
reads across each chain's canonical token list for wallet balances and selected
contract allowances. It also publishes the same ranked boosted-fee, incentive,
and ve(3,3)-emission liquidity opportunities shown by the interface.

The MCP server owns agent-facing transaction construction. `prod-api` remains
a data API and the quoter remains a route-data service.

## Public endpoints

- `POST/GET /mcp` — MCP Streamable HTTP endpoint
- `GET /` — service metadata and canonical documentation links
- `GET /tools` — deterministic tool catalog for non-MCP discovery
- `GET /openapi.json` — OpenAPI 3.1 discovery contract
- `GET /llms.txt` — concise agent workflow

MCP-native discovery remains authoritative: clients use `tools/list` and
`resources/list`/`resources/templates/list`. The HTTP discovery endpoints are
additive and help crawlers, OpenAPI clients, and humans find the same
capabilities. `GET /tools` is deliberately uncached and includes both the
server version and a tool-catalog revision so integrations can detect stale
schemas after a Git-triggered deployment.

## Tools

- `ekubo_list_tokens` — list the canonical token list, ordered by descending
  `visibility_priority`, with optional symbol `search`, `chain_id`,
  `min_visibility_priority`, `page_size`, and `after_token` filters
- `ekubo_export_tokens` — hand a wallet the canonical list without reading it:
  returns only a `token_list_reference` envelope and a count, never entries.
  Scoped by `chain_id`, capped by `max_tokens` (default 1,000, the wallet's
  per-import limit), fixed at the interface's visibility threshold, and stored
  with only the five fields a wallet acts on
- `ekubo_get_token` — fetch token metadata by chain and address
- `ekubo_get_tokens` — fetch metadata for 1–1,000 exact token identifiers,
  across chains, through one `prod-api` batch request
- `ekubo_get_quotes_with_plans` — compare Ekubo and 0x for same-chain
  exact-input or exact-output swaps, or use Across when
  `destination_chain_id` differs, and return each option's firm unsigned
  approval and execution calldata alongside its quote; an Ekubo or 0x failure
  marks the comparison incomplete and tells the user to retry
- `ekubo_prepare_ve33_vote` — compile one active NFT's vote changes and
  deterministic splits into one multicall that always claims its current pool
  first; prefer the portfolio workflow below for complete state validation
- `ekubo_prepare_ve33_extend` — extend an unvoted token directly, or provide
  its active pool key to claim pending voter fees atomically before extension
- `ekubo_prepare_ve33_stake` — create a new VeToken with an exact token
  approval; max duration is the default when no duration is supplied
- `ekubo_prepare_ve33_split` — construct a split and predict the child token ID
- `ekubo_prepare_ve33_claim_fees` — claim one or many VeToken voter-fee balances
- `ekubo_prepare_ve33_reinvest` — automatically discover and claim all active
  fees, construct one exact-input swap per claimed non-stake token, and
  increase one VeToken or every existing active allocation
- `ekubo_prepare_ve33_claim_all_fees` — discover every active vote owned by a
  sender and prepare one native VeToken claim multicall, including `ownerOf`
  and `voteState` validation calldata
- `ekubo_get_ve33_allocations` — handle “show all my Ekubo STONX allocations”
  with only the connected wallet address because the production Ve33
  deployment is the STONX voting system; defaults to Robinhood Chain `4663`
  and its canonical VeToken, then returns the complete portfolio and
  `onchain_validation` request, explicitly marked `not_executed` until its
  `eth_call` is run. An explicit chain and VeToken pair remains available for
  another deployment such as testnet.
- `ekubo_get_stonx_allocation_recommendation` — return the current
  provider-neutral recommendation plus an exact 10,000-bps executable target
  list capped at 25 initialized canonical Ve33 pools. Snapshots older than one
  day trigger a refresh that is awaited for up to 20 seconds; stale, failed, or
  timed-out refreshes fail closed instead of returning an executable plan
- `ekubo_prepare_ve33_reallocation` — resolve target `pool_key_id` values and
  compile up to 25 basis-point targets into one fee-preserving atomic VeToken
  multicall. `preserve_existing_locks` apportions each expiry cohort across
  every target; `compact_max_lock` consolidates and extends stake before
  creating exactly one voting NFT per target.
- `ekubo_get_positions_by_owner` — enumerate indexed position NFTs with their
  pool keys, bounds, liquidity, current pool state, rewards, pagination,
  canonical token USD metadata, and exact pending position-state `eth_call`
- `ekubo_get_position` — hydrate one owner position with NFT metadata, history,
  campaigns, earned rewards, token USD prices, and an atomic Multicall3 query
  for current principal, fees or Ve33 rewards, and ownership
- `ekubo_get_position_pool_candidates` — list existing pools for a pair with
  verified exact PoolKeys, v2/v3 Core generation, extension classification,
  token prices, pool statistics, and the correct position manager
- `ekubo_get_liquidity_opportunities` — rank the interface's current
  boosted-fee, active-incentive, and projected STONX-emission opportunities;
  returns canonical tokens, exact actionable pools or a pair-level candidate
  lookup, APR components and denominators, freshness, and risk context. The
  Ve33 emission input is read and decoded by the user's wallet, then passed
  back for the final interface-equivalent ranking. Starknet incentives remain
  visible but are marked discovery-only because the current pool-candidate and
  deposit preparation tools are EVM-specific.
- `ekubo_prepare_lp_position_deposit` — prepare a new v3 position mint or add
  liquidity, including exact PoolKey derivation and `maybeInitializePool` for
  a new pool atomically before the deployed `mintAndDeposit` call in one
  multicall, shared-SDK liquidity math, a nonzero slippage floor, exact
  approvals/refunds/cleanup, decoded intent, wallet-policy requirements, and a
  signer-neutral execution plan; no Cast encoding is required
- `ekubo_prepare_pool_initialization` — prepare a standalone, idempotent
  `maybeInitializePool` transaction for an exact v3 PoolKey and initial tick
  when initialization should not be bundled with the first position mint
- `ekubo_prepare_lp_position_earnings_claim` — resolve an owned position and
  prepare collection of standard LP fees or Ve33 LP rewards without removing
  liquidity or touching the NFT, including pending ownership/earnings reads,
  decoded calldata, wallet-policy requirements, and a wallet execution plan
- `ekubo_prepare_lp_position_withdraw` — prepare a partial or full position
  withdrawal from an exact liquidity amount, or pass up to 100 withdrawals for
  one atomic wallet-batch-capable plan; each withdrawal automatically collects
  ordinary fees or Ve33 rewards and includes its own pending validation
- `ekubo_get_pool` — resolve an exact chain/core/pool ID to a verified PoolKey,
  decoded config, the latest indexed state snapshot, and a `current_state_query`
  read bundle whose `read_calls_reference` the wallet executes for fresh
  on-chain sqrtRatio, tick, and liquidity
- `ekubo_get_pool_liquidity` — return tick-level net liquidity deltas for one
  exact pool
- `ekubo_list_pool_keys` — enumerate a Core deployment's initialized pools
  with keyset pagination (`after_pool_id`, ascending pool_id) and
  token/pair/extension filters; every pool_id is re-derived locally from its
  PoolKey before it is reported
- `ekubo_derive_pool_id` — pack a PoolKey and derive its exact Keccak pool ID
- `ekubo_decode_pool_config` — decode the extension, exact uint64 Q64 fee,
  v3 discriminator, and concentrated or stableswap parameters

The remaining EVM interface transaction paths also have first-class tools:

- wrap/unwrap and LP NFT transfer;
- standalone pool initialization and phased pool price correction, including
  exact reads, quote, approval, and execution route;
- TWAMM/DCA creation, collection, stop, and virtual-order execution;
- auction creation, completion/graduation initialization, and creator proceeds;
- manual boosts, oracle capacity, ERC-20 revocations, and old gEKUBO unwrap;
- incentive rewards, Recovery Fund claims, and revenue buyback maintenance;
- VeToken increase-stake, fee-safe merge, and expired withdrawal.

Each `ekubo_prepare_*` result supplies the exact ordered transaction list. The
wallet validates, signs, and submits it; it does not encode calls, select
overloads, build multicalls, append approvals, or determine ordering.

## Resources

- `ekubo://docs/lp-position-workflow` — interface-equivalent indexed/API/USD/
  RPC joins, atomic TWAMM/Ve33 read semantics, decoding, and APR inputs
- `ekubo://contracts/evm` — supported chain IDs and contract-resource links
- `ekubo://contracts/evm/{chain_id}` — address-to-contract map for one chain
- `ekubo://contracts/evm/{chain_id}/{address}` — the exact deployment metadata
  and, when present in the current contracts checkout, ABI for one contract

Contract resources provide provenance and read-only ABI context. Transaction
calldata and complete transaction lists come from first-class preparation
tools, not from a wallet, agent, or ad hoc `cast` encoding. The client must
still verify deployed code and
permissions and simulate the exact calldata before requesting a signature.
VeToken address resources include function-level warnings for operations that
fully clear a vote, the fee-preserving compound alternatives, and the
stake-orphaning risk of `burn`. Ownership handovers, ERC721 approvals and
transfers, safe transfers, and burns are explicitly outside every safe MCP
workflow even though the complete ABI resource describes them.

The checked-in snapshot merges the latest `../evm-contracts` GitHub release
deployment tables with all non-dry-run Foundry broadcasts and current
artifacts. Every contract resource includes the source release, source commit,
nearest tag, snapshot worktree state, and per-ABI hash. A release or broadcast
address remains discoverable when a legacy contract no longer has an artifact
in the current checkout; its address resource explicitly marks the ABI as
unavailable. The Yul router address and public quote ABI come from
`@ekubo/yul-router-sdk`, so the MCP server follows the SDK version it ships.
Refresh the contract snapshot after contract deployments or ABI changes with
`bun run contracts:generate` from this repository.

`ekubo_get_quotes_with_plans` has no provider-selection input and does not
select a quote. Same-chain requests return every Ekubo and 0x option in
`quotes` with its source URL and normalized amounts, so the agent or user can
choose. Supply `sender` and `slippage_bps` together and each option also
carries the `execution_plan_reference` that executes it, so a chosen plan goes
straight to a wallet with no second round trip and the compared quote is the
executed one. Omit both for an indicative comparison, and set `include_raw_quotes` to
add the untouched provider responses, which are otherwise left out as the
largest and least useful part of a response.
If a configured provider fails, the response reports it in
`unavailable_sources` without invalidating successful quote options, and an
option that could not be made executable reports its own
`execution_unavailable` while the rest stand.
Cross-chain requests route through Across. Token
arguments accept raw EVM addresses or
`eip155:<chain_id>:<address>` identifiers. The output token's EIP-155 chain
must match `destination_chain_id`.

The catalog explicitly contains read tools and unsigned preparation tools. All
server operations are non-custodial and idempotent: the Worker has no wallet,
key material, signing function, or broadcast function. Preparation tools return
an exact unsigned transaction plan for the agent to pass to the user's wallet.
The agent does not ask for a separate confirmation first: wallet tooling is
responsible for current-state simulation, presenting the simulated result,
collecting authorization or signature, signing, and submission.

Prepared execution plan bodies, read-call bundles — exact
`wallet_batch_eth_call` argument objects, validated against the wallet
boundary before storage — and token lists exported by `ekubo_export_tokens` are
stored in R2 — strongly consistent, so a fresh reference never 404s from replication lag — and served at
`/artifact/<id>` so wallets fetch them by reference. All three travel as
`artifact_reference` envelopes (under `execution_plan_reference`,
`read_calls_reference`, and `token_list_reference`) whose `integrity.value`
keccak256 and `bytes` count
bind the exact stored bytes; the agent passes the envelope unchanged as the
wallet tool's `reference` argument. No other tool
result is stored or replayed, and `/mcp` responses use
`Cache-Control: no-store`. No fixed request quota is guaranteed; clients must
honor HTTP 429 and the `Retry-After` header it carries. Owner positions use upstream `no-cache`
semantics. Indexed pool-state snapshots may be cached upstream for 180 seconds,
while PoolKeys and tick-liquidity data may be cached for 1,800 seconds. Polling
more frequently than those freshness windows does not produce fresher pool
data.

The token-list reference exists because a list is the largest thing an agent
is ever asked to carry between two servers, and the cost is not in fetching it
but in re-emitting it. The canonical list is 483 KB: about 146,000 tokens of
context to read, and roughly 49,000 output tokens — minutes of generation — to
write back out as a wallet's `propose_tokens` arguments.

`ekubo_export_tokens` is the tool for that trip, and it is a separate tool
rather than a flag on `ekubo_list_tokens` because it does a different job.
Listing answers a question the model reasons about — which address is the USDC
the user meant — so it returns entries and offers search, paging, and full
metadata to serve that. Exporting answers no question: it hands a wallet a
list to hold. So it returns a `token_list_reference` and a count and nothing
else, its stored body carries only the five fields a wallet acts on, and its
whole input surface is which chain and how many at most.

Scope an export by chain, but do not assume that fits it under a consumer's
limit. At the interface visibility threshold Ethereum carries roughly 5,600
tokens, BNB Chain 3,600, Base 2,600, and Arbitrum and Polygon about 1,000
each, against the 1,000 entries a wallet accepts in a single import. An export
past the importer's limit is refused whole rather than truncated, so a larger
`max_tokens` is not a safer one.

Every export therefore reports `complete`. False means more tokens exist at
that visibility than `max_tokens` allowed, and the stored list is a prefix
rather than the chain's list — a distinction nothing downstream could
otherwise draw, because the agent never sees an entry to miss.

Position-state plans use one Multicall3 `eth_call` at `pending`. TWAMM virtual
orders or Ve33 reward accumulation, when required, are simulated immediately
before the position read in that same call. Splitting them into separate calls
would discard the simulated state; the aggregate payload is read-only workflow
data and must never be broadcast. Each query carries a complete declarative
Multicall3 and child-result decode plan for local wallet execution. The wallet
returns raw bytes by default, decodes them on the user's device, and never
installs or executes codec code named by the remote plan.

Decode plans distinguish Solidity ABI decoding from protocol semantics.
Standard results use `function_result`; atomic position queries use
`multicall3` with an ABI and required child-result specification, or
`function_result_bytes_array` for a function returning nested `bytes[]`. A semantic
codec attached to an ABI output preserves the ABI-decoded value and adds the
interpreted value. A custom payload with no ABI envelope may instead use
`semantic_value`, which consumes the raw return bytes while the wallet retains
those bytes in the result. Codec IDs are
platform-neutral. Implementations explicitly identify their ecosystem; for
example, Ekubo's compact `SqrtRatio` codec names the pinned npm package URL,
export, version, and integrity for `@ekubo/sdk`. Wallets must run only a locally
installed, allowlisted implementation and must never fetch or execute code from
a decode plan.

For a new LP position, start with `ekubo_get_position_pool_candidates`; do not
browse `prod-api` or infer a manager from an ABI resource. Its default
`min_tvl_usd=0` keeps initialized pools with negligible liquidity visible.
After the user selects an existing v3 pool, range, token maxima, and slippage,
call `ekubo_prepare_lp_position_deposit`. Pass its exact
`execution_plan_reference` (URL plus digest) to the wallet MCP for policy
checking and exact-plan simulation. The wallet—not this
server—controls target, spender, selector, native-value, signing, and submission
authorization.

**Important:** See [`docs/lp-position-bounds.md`](docs/lp-position-bounds.md) for
how to calculate correct tick bounds. Ticks encode prices that must account for
token decimal differences. For example, an ETH/USDC pair with ETH at 18 decimals
and USDC at 6 decimals requires adjusting the price ratio by a factor of 10^(6-18)
before converting to ticks, resulting in tick values around -20M, not +76K. Incorrect
tick calculations cause deposits to fail or create positions at unintended prices.

If one side must be acquired first, prepare and execute that swap as a separate
wallet plan. Wait for its successful receipt, measure the actual token balance,
reserve native gas, and only then size and prepare the LP deposit. Never use an
unconfirmed quote output as though it were a settled wallet balance.

Finish every swap before minting, and re-read the pool tick with
`current_state_query` afterwards — a position's token ratio follows the range
and the current price, not the amounts deposited, so a swap made after the mint
moves the tick and re-skews the position it was meant to balance.

For an existing position, call `ekubo_prepare_lp_position_earnings_claim` with
the connected owner, chain, manager, and token ID from the owner-position list.
It automatically selects standard fee collection or Ve33 reward claiming. Run
its pending current-state query with the supplied local decode plan, verify the
decoded owner against `expected_owner`, and include the current claim with its
unchanged execution plan in the wallet MCP handoff. The prepared call does not
remove liquidity, burn the NFT, or transfer it.

For partial or full withdrawals, execute and decode every position's pending
current-state query and choose an exact positive liquidity amount no greater
than its decoded liquidity. Call `ekubo_prepare_lp_position_withdraw` with the
legacy single-position fields or a `withdrawals` array of up to 100 positions.
It resolves every PoolKey, bounds, manager overload, recipient, and fee/reward
behavior. A multi-position request returns one atomic wallet plan; the wallet
may batch these unrelated position calls into one EIP-7702 transaction. Wallet
tooling must not construct or alter calls. Each position NFT is preserved.

Every chain input accepts a JSON integer, decimal string, or hexadecimal
string. Responses use canonical decimal chain-ID strings. Pool fees are uint64
Q64 values and must always be passed and consumed as decimal or hexadecimal
strings, never JSON numbers.

Every executable preparation also includes a signer-neutral
`execution_plan_reference` handoff: an `artifact_reference` envelope naming
where the plan body is stored and an `integrity` block (keccak256 plus byte
count) over its exact bytes. The envelope describes none of the plan's
contents; the integrity-verified body is the only source of truth. The agent
relays only the envelope, unchanged; the
wallet fetches the body itself, recomputes the digest, refuses a mismatch, and
validates the plan as if it had been supplied inline. No timestamps travel in
the envelope: plan validity is enforced by the wallet's simulation against
current chain state, and storage expiry surfaces as a fetch 404. The stored
body's `ordered_steps` place approvals before the main execution and any
exact-output allowance cleanup after it, each as a decimal transaction object.
The `plan_id` commits to the chain, sender, destination, calldata, and native
value of every approval, execution, and cleanup transaction in the sequence.

Bind the actual wallet address as `sender` before preparation. Prefer the
connected account and call/simulate/submit abstractions exposed by wallet
tooling; the wallet refuses a fetched plan whose chain or sender disagrees
with its connected chain and account. Pass the whole envelope unchanged as the
wallet MCP's `reference` argument for it to fetch, verify, and execute in
order. The
wallet executes multi-step plans as one atomic batch; a plan that lists a
capability in `required_capabilities` the wallet does not implement must be
rejected, not adapted. Use Cast only when the
user selected it or no compatible wallet abstraction is available; the
execution-plan resource retains its exact fallback syntax without making Cast
the default.

`execution_plan_ready` means the quote, bounds, and unsigned calldata are
complete enough to hand to the wallet. `agent_confirmation_required` is false:
the wallet presents its simulated result and owns authorization. ERC20 plans
include the required unsigned approval
transaction(s) in addition to the unsigned swap or bridge transaction.
Exact-output Ekubo and 0x plans that create an allowance also include a
post-execution allowance reset.
The client should check current allowance before handing any still-required
approval step to the wallet.
`wallet_validation_required` remains true for every prepared plan.

The boundary mirrors the Ekubo interface: the public services provide token
data and route quotes, transaction construction applies the user's slippage,
and the user's connected wallet or provider handles balances, allowances,
current-state validation, gas estimation, signing, submission, and receipts.
The Recovery Fund's initial EIP-712 agreement is the one explicit exception to
the Ekubo wallet MCP handoff: that wallet intentionally exposes no arbitrary
typed-data signing tool. Its preparation result marks the incompatibility and
requires a separately selected connected wallet with `eth_signTypedData_v4`;
the resulting execution plan remains compatible with the Ekubo wallet MCP.

For STONX allocation requests, clients should call
`ekubo_get_ve33_allocations` with only the connected EVM wallet address as
`owner`. The public server is unauthenticated and cannot infer what “my” means.
If the client does not expose a connected address, ask the user for it; do not
substitute a local keystore, repository account, or machine environment value.

VeToken splitting follows the deployed contract invariants: the source token
must retain a nonzero stake, its active vote remains with reduced weight, and
the child token starts unvoted. Vote compilation claims pending fees
unconditionally before a vote is replaced or cleared, including when the
claimable amounts are zero. The extension tool exposes only compound
claim-and-extend methods because extension clears its vote.

Safe vote reorganization is a two-tool workflow. First call
`ekubo_get_ve33_allocations`, present its complete allocation and `state_id`,
and execute `onchain_validation.eth_call` through the user's provider.
Then pass that exact state ID and target `weight_bps` values to
`ekubo_prepare_ve33_reallocation`. The target shares must total 10,000. The
server resolves each `pool_key_id` from the canonical Ve33 pool directory,
and supports two explicit strategies. `preserve_existing_locks` apportions
every lock-end cohort independently so every target has the same expiry mix;
its final NFT count may exceed the target count. `compact_max_lock` claims and
max-extends one survivor, fee-safely merges every other active NFT into it,
then splits exactly one voting NFT per target. Compound merges burn their
source NFT IDs, which the plan discloses. Every active vote is claimed before
it is cleared or moved, even when its current claimable amounts are zero.
Unvoted NFTs are left untouched and direct burn or withdrawal calls remain
forbidden.

“Update my STONX allocations to the suggested allocations” is a three-tool
workflow. First call `ekubo_get_stonx_allocation_recommendation` and require
`execution_ready=true`, at most 25 targets, and
`target_total_weight_bps=10000`. Then fetch and
validate the wallet's complete current allocation as above. Finally pass its
exact `state_id`, the recommendation's `targets`, and
`strategy=compact_max_lock` to
`ekubo_prepare_ve33_reallocation`. Recommendation rows that do not yet have an
initialized canonical pool are reported separately; their weight is
redistributed along with weight below the 25-target priority cutoff without
exceeding any selected row's allocation cap. The recommendation tool
constructs no transaction. Each recommendation response reports `snapshot_at`,
`snapshot_refreshed_on_request`, and `snapshot_max_age_seconds`. A completed
snapshot older than 86,400 seconds triggers a provider refresh; the request
waits for that execution and returns no plan if the execution fails or does not
complete within 20 seconds.

The first-phase claims are also atomic stale-state guards: if an indexed active
vote now points at another pool or is no longer owned by the sender, its claim
reverts before any split or vote runs. The client must still verify the returned
`balanceOf`, `ownerOf`, `stakes`, and `voteState` expectations and simulate the
exact multicall immediately before signing, because the existing VeToken
interface has no general on-chain assertion for an exact aggregate stake
amount.

Fee reinvestment is intentionally phased. A static transaction cannot know the
exact output of an exact-input swap and therefore cannot safely call
`increaseStakeAmount` for every resulting unit in the same transaction. The
claim phase can omit `claims` to discover every active allocation and returns
the exact balance-snapshot requests. After the claim confirms, pass only the
claimed deltas to the swap phase; it constructs one exact-input plan per
non-stake token. After all receipts confirm, refresh the allocation state and
pass its `state_id` plus the complete measured STONX output to `stake_all`.
That phase apportions the exact amount across every existing active allocation
using only `increaseStakeAmount`, preserving votes and fee accounting. Never
pass a wallet's pre-existing token balance as a claimed-fee delta.

New stakes use max duration by default and do not touch an existing NFT.
Extending an existing stake remains an explicit operation because it clears
the current vote. The extension tool requires the active pool key and uses a
compound claim-and-extend function, so pending fees are claimed before either
an explicit duration or `max_duration=true` is applied.

## Configuration

`wrangler.jsonc` configures the two fixed public Ekubo upstreams:

- `EKUBO_API_URL=https://prod-api.ekubo.org`
- `EKUBO_QUOTER_URL=https://prod-api-quoter.ekubo.org`

Never make an upstream URL a tool argument. Keeping upstreams
operator-controlled prevents the MCP server from becoming an arbitrary proxy.
The deployment also uses four Worker secrets:

- `ZERO_X_API_KEY`
- `ACROSS_API_KEY`
- `ACROSS_INTEGRATOR_ID`
- `DUNE_API_KEY` (internal allocation-recommendation data access; never
  returned or identified by the public MCP surface)

They are declared as required runtime secrets in `wrangler.jsonc`, so a deploy
fails rather than silently publishing disabled provider tools when a binding is
missing. Bind them to the production `mcp` Worker under **Settings > Variables
& Secrets**; Cloudflare build variables are not available at runtime.

0x requests use Swap API v2's AllowanceHolder endpoints. Across requests use
`GET /swap/approval` with bearer authentication and the configured integrator
ID. These credentials remain server-side and are never returned by a tool. The
Worker never receives wallet credentials.

Cloudflare routing protects the default `workers.dev` hostname and any custom
domain. Set optional comma-separated `ALLOWED_HOSTNAMES` and `ALLOWED_ORIGINS`
variables if the deployment needs a stricter host list or cross-origin browser
MCP clients. The request's own hostname is always accepted as a browser origin;
non-browser MCP clients normally omit `Origin`.

## Abuse protection

The endpoint is public and unauthenticated, so there is no account to bill or
suspend. A caller is an IPv4 address or an IPv6 /64 — a single v6 address is
not an identity, since the smallest allocation a residential or cloud customer
receives is a /64 — taken from `cf-connecting-ip`, which Cloudflare sets on the
way in. `x-forwarded-for` is client-supplied and deliberately never consulted.

### Worker budgets

Four [Rate Limiting
bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
are declared in `wrangler.jsonc`. They exist separately because the failure
modes have different shapes and one requests-per-minute number cannot express
any two of them at once. `src/rate-limit.ts` holds the cost table.

| Binding | Window | Default | Bounds |
| --- | --- | --- | --- |
| `RATE_LIMITER_BURST` | 10s | 30 requests | A flood, visible within ten seconds rather than after a minute of it |
| `RATE_LIMITER` | 60s | 120 requests | Sustained request volume across every route |
| `RATE_LIMITER_TOOLS` | 60s | 120 units | Weighted tool cost: scraping and upstream load |
| `RATE_LIMITER_METERED` | 60s | 20 calls | Calls that spend 0x, Across, or Dune credit |

The unit scale is anchored at 1 = one ordinary `prod-api` read. A bulk or
fan-out read costs 3–4, a preparation that writes an artifact costs 3, a quote
comparison costs 10, and a STONX recommendation costs 20; `ekubo_derive_pool_id`
and `ekubo_decode_pool_config` touch nothing and cost nothing. A tool with no
entry in the table is charged 3 if it is a preparation and 2 otherwise, so a
tool added later without a deliberate price is over-charged rather than free.
At the defaults a caller gets roughly ten complete swap flows or a hundred
catalog reads a minute, and a catalog scrape stalls within seconds.

`RATE_LIMITER_METERED` is separate from `RATE_LIMITER_TOOLS` on purpose: it is
the budget that maps to an invoice, and no volume of cheap local calls should
be able to buy headroom in it. Tune any of these by editing `simple.limit` in
`wrangler.jsonc`; changing a `namespace_id` resets that budget's counters.

Every binding is optional at runtime. An unbound limiter admits everything,
which is what makes `wrangler dev` and an unprovisioned preview deployment
usable, and a limiter that throws also admits and logs
`rate_limiter_unavailable`: losing a counter must not lose the endpoint. The
counters are per-colo rather than globally consistent, which is the right trade
for a per-caller limit — one caller's requests land in one colo — and leaves
the distributed case to the edge rule below.

Requests are also capped at 262,144 bytes (HTTP 413), 20 JSON-RPC messages, and
40 tool units (both HTTP 400), so one request cannot carry an unbounded number
of billable calls. The unit ceiling refuses rather than clamps: charging a
160-unit batch 40 units and serving it is precisely the hole a cost model is
supposed to close. No single tool reaches 40, so the ceiling only ever asks a
client to split a batch — and JSON-RPC batching was removed from the protocol
in revision 2025-06-18 anyway.

A rejection is an HTTP 429 with `Retry-After` in seconds. When the request was
a single identified JSON-RPC call it also carries a JSON-RPC error with code
`-32029` and a `data.scope` of `burst`, `sustained`, `tool_units`, or
`metered_providers`, so the agent driving the client reads why it was refused
and what to do differently rather than only that it was refused.

### Edge rule

The Worker budgets run per request, which means a volumetric flood still pays
for a Worker invocation each time. Put a zone-level [WAF rate limiting
rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) on
`ekubo.org` in front of them so the flood is dropped before it reaches this
code, and so a distributed attack — which per-colo counters see only a slice of
— is handled where the aggregate is visible:

- **When incoming requests match:** `(http.host eq "mcp.ekubo.org")`
- **Characteristics:** IP with NAT support
- **Rate:** 600 requests per 60 seconds
- **Action:** Block, for 60 seconds, with a custom JSON response carrying
  `Retry-After: 60`

Set it well above the Worker budgets. It is a circuit breaker for traffic that
is not worth a Worker invocation, not the limit that shapes normal use; the
Worker budgets are what actually bound cost and scraping, because only they
know what a request is asking for.

One caveat: **`workers_dev` is currently `true`**, so the Worker is also
reachable at its `*.workers.dev` hostname, and a zone rule on `mcp.ekubo.org`
does not apply there. Anything that must not be bypassed belongs in the Worker.
Set `workers_dev: false` once `mcp.ekubo.org` is the only intended entry point.

## Development

```sh
bun install
bun run contracts:generate # when ../evm-contracts deployments or ABIs change
bun run build
bun run test
bun run check
bun run dev
```

Connect MCP Inspector to `http://localhost:8787/mcp`.

## Deployment

Authenticate Wrangler, install the locked dependencies, and deploy:

```sh
bun install --frozen-lockfile
bunx wrangler login
bun run deploy
```

`wrangler.jsonc` intentionally enables `workers.dev` without declaring a
custom domain. The first deployment therefore produces a testable
`https://mcp.<account-subdomain>.workers.dev` URL. Add
`mcp.ekubo.org` as a Worker custom domain after that deployment; no code or
configuration change is required.

For CI or non-interactive deployment, provide `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` instead of running `wrangler login`.

Smoke-test the deployed origin before adding the custom domain:

```sh
curl https://mcp.<account-subdomain>.workers.dev/
curl https://mcp.<account-subdomain>.workers.dev/tools
MCP_ORIGIN=https://mcp.<account-subdomain>.workers.dev bun run smoke
npx @modelcontextprotocol/inspector@latest
```

`bun run smoke` checks root discovery, OpenAPI, the HTTP tool catalog, MCP
initialization, protocol-native tools, and the contract resource templates.

Connect MCP Inspector to
`https://mcp.<account-subdomain>.workers.dev/mcp`, initialize the server,
list tools, list tokens, request same-chain and cross-chain quotes, and
prepare unsigned execution plans. Validate every plan through the user's
connected wallet or provider before signing.

The implementation uses the recommended stateless `createMcpHandler` path and
does not require Durable Objects. Authorization is intentionally omitted
because all tools operate on public data and cannot mutate protocol or user
state. Signing and submission remain client-side.
