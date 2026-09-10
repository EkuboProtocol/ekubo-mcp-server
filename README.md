# Ekubo MCP server

The official agent interface for Ekubo Protocol transactions. This repository
deploys a stateless, public MCP server on Cloudflare Workers. It discovers
tokens, compares Ekubo and 0x liquidity for same-chain EVM swaps, prepares and
tracks Across, LayerZero, and LI.FI any-to-any bridges, and constructs unsigned VeToken calls for ve(3,3)
vote and fee workflows. It also publishes provider-neutral STONX allocation
recommendations resolved to initialized Robinhood Ve33 pools, enumerates
indexed LP positions by owner, reproduces the interface's indexed/API/USD/RPC
position-data pipeline, discovers pair-level position candidates, prepares
unsigned LP deposits, withdrawals, and earnings claims, and exposes exact pool
state and liquidity data. It prepares interface-equivalent TokenDataFetcher
reads across each chain's canonical token list for wallet balances and selected
contract allowances. It also publishes the same ranked boosted-fee, incentive,
and ve(3,3)-emission liquidity opportunities shown by the interface.
It additionally exposes fixed, locally maintained Aave V3, Morpho Vault V2,
Sky Savings, Lido, Merkl, and Aerodrome deployments with signer-neutral action
plans, prepares proof-verified Merkl reward claims for campaigns on any
protocol, and prepares Aerodrome v2 liquidity, gauge, veAERO lock, vote, and
reward-claim actions on Base alongside the Sugar lens reads that feed them. Agents
discover live protocol data from official public APIs or the user's wallet/RPC
directly for those protocols. Uniswap V2/V3/V4 support additionally fetches indexed pool discovery, price/volume charts, and liquidity-depth ticks from the official Uniswap interface API, and prepares pool/position reads and liquidity transactions on six EVM chains. See [Uniswap coverage](docs/uniswap.md).

The MCP server owns agent-facing transaction construction. `prod-api` remains
a data API and the quoter remains a route-data service.

## Public endpoints

- `POST/GET /mcp` — MCP Streamable HTTP endpoint serving every protocol
- `POST/GET /mcp/{ekubo,aave,aerodrome,lido,merkl,morpho,sky,uniswap}` — the same MCP
  contract narrowed to one protocol
- `GET /` — service metadata, per-protocol endpoints, and canonical
  documentation links
- `GET /tools` — deterministic tool catalog for non-MCP discovery, filterable
  with `?protocol=<slug>`
- `GET /openapi.json` — OpenAPI 3.1 discovery contract
- `GET /llms.txt` — concise agent workflow
- `GET /skills/{use-morpho,use-sky,use-lido,use-merkl,use-aerodrome}/SKILL.md` — reusable direct-data
  agent instructions, with each skill's discovery reference beneath
  `references/discovery.md`

### One endpoint per protocol

`src/protocols.ts` partitions the catalog: every tool belongs to exactly one
protocol, `/mcp/<slug>` registers that protocol's tools and its own skill
resources, and `/mcp` registers all of them. The partition is checked against
`publicToolCatalog` in `test/protocols.test.ts`, so a tool added to the catalog
without a protocol fails the build rather than quietly appearing on no
per-protocol endpoint.

`/mcp` remains the endpoint for the complete catalog. A client that wants one protocol's tools in its context adds the narrower URL instead.

Filtering happens at the two registration choke points in `createEkuboServer`
rather than at the call sites, and the instructions are composed from
protocol-scoped paragraphs, so a single-protocol server never tells an agent to
call a tool it does not serve.

`/` and `/llms.txt` link the two public documentation pages:
[the server](https://docs.ekubo.org/products/mcp-server/) and
[protocol coverage and the wallet producer contract](https://docs.ekubo.org/wallet/protocols/).
The latter is where a third party building its own wallet-compatible MCP server
is sent, so keep it in sync when the protocol list or the handoff contract
mirrored in `src/wallet-compatibility.ts` changes.

MCP-native discovery remains authoritative: clients use `tools/list` and
`resources/list`/`resources/templates/list`. The HTTP discovery endpoints are
additive and help crawlers, OpenAPI clients, and humans find the same
capabilities. `GET /tools` is deliberately uncached and includes both the
server version and a tool-catalog revision so integrations can detect stale
schemas after a Git-triggered deployment.

MCP `2026-07-28` clients can use `server/discover` and standalone requests
without an initialization handshake. Browser preflights allow `Mcp-Method`
and `Mcp-Name` alongside the protocol-version header. Discovery and catalogs
carry a five-minute public cache hint; bundled documentation and ABI resource
reads carry a one-hour hint. Cache entries belong to the exact endpoint and
resource URI (the protocol-specific endpoints have different catalogs). The
externally fetched API OpenAPI document remains uncached. HTTP RPC envelopes
remain `no-store`: clients cache MCP result payloads, not another request's ID.
Legacy clients retain their existing result shapes. All tools publish output
schemas; informational schemas describe stable envelopes while preserving
additional upstream fields.

## Tools

- `list_tokens` — list the canonical token list, ordered by descending
  `visibility_priority`, with optional symbol `search`, `chain_id`,
  `min_visibility_priority`, `page_size`, and `after_token` filters
- `export_tokens` — hand a wallet the canonical list without reading it:
  returns only a `token_list_reference` envelope and a count, never entries.
  Scoped by `chain_id`, capped by `max_tokens` (default 1,000, the wallet's
  per-import limit), fixed at the interface's visibility threshold, and stored
  with only the five fields a wallet acts on
- `get_token` — fetch token metadata by chain and address
- `get_tokens` — fetch metadata for 1–1,000 exact token identifiers,
  across chains, through one `prod-api` batch request
- `get_quotes_with_plans` — compare Ekubo and 0x for same-chain
  exact-input or exact-output swaps, or compare Across, LayerZero, and LI.FI
  when `destination_chain_id` differs, and return each option's firm unsigned
  approval and execution calldata alongside its quote; an Ekubo or 0x failure
  marks the comparison incomplete and tells the user to retry
- `get_value_transfer_status` — track an executed LayerZero or LI.FI
  cross-chain transfer from origin submission to destination delivery, by the
  `provider_quote_id` its quote carried for LayerZero and by the origin
  transaction hash for LI.FI; a bridge is the one plan whose successful origin
  receipt does not mean the user has their funds
- `prepare_ve33_vote` — compile one active NFT's vote changes and
  deterministic splits into one multicall that always claims its current pool
  first; prefer the portfolio workflow below for complete state validation
- `prepare_ve33_extend` — extend an unvoted token directly, or provide
  its active pool key to claim pending voter fees atomically before extension
- `prepare_ve33_stake` — create a new VeToken with an exact token
  approval; max duration is the default when no duration is supplied
- `prepare_ve33_split` — construct a split and predict the child token ID
- `prepare_ve33_claim_fees` — claim one or many VeToken voter-fee balances
- `prepare_ve33_reinvest` — automatically discover and claim all active
  fees, construct one exact-input swap per claimed non-stake token, and
  increase one VeToken or every existing active allocation
- `prepare_ve33_claim_all_fees` — discover every active vote owned by a
  sender and prepare one native VeToken claim multicall, including `ownerOf`
  and `voteState` validation calldata
- `prepare_ve33_clear_vote` — remove the active vote from one or more
  VeTokens, claiming each stake's current pool immediately before its
  `clearVote` in one atomic batch. `current_pool_key` is required per stake:
  Ve33 discards pending voter fees when a stake's weight goes to zero, and a
  key that is not that stake's active pool reverts the batch before anything
  clears. The stake, its lock end, and its ownership are unchanged; the pool
  loses that weight, and a pool with no vote weight charges a zero extension
  fee
- `get_ve33_allocations` — handle “show all my Ekubo STONX allocations”
  with only the connected wallet address because the production Ve33
  deployment is the STONX voting system; defaults to Robinhood Chain `4663`
  and its canonical VeToken, then returns the complete portfolio and
  `onchain_validation` request, explicitly marked `not_executed` until its
  `eth_call` is run. An explicit chain and VeToken pair remains available for
  another deployment such as testnet.
- `get_stonx_allocation_recommendation` — return the current
  provider-neutral recommendation plus an exact 10,000-bps executable target
  list capped at 25 initialized canonical Ve33 pools. Snapshots older than one
  day trigger a refresh that is awaited for up to 20 seconds; stale, failed, or
  timed-out refreshes fail closed instead of returning an executable plan
- `prepare_ve33_reallocation` — resolve target `pool_key_id` values and
  compile up to 25 basis-point targets into one fee-preserving atomic VeToken
  multicall. `preserve_existing_locks` apportions each expiry cohort across
  every target; `compact_max_lock` consolidates and extends stake before
  creating exactly one voting NFT per target.
- `get_positions_by_owner` — enumerate indexed position NFTs with their
  pool keys, bounds, liquidity, current pool state, rewards, pagination,
  canonical token USD metadata, and exact pending position-state `eth_call`
- `get_position` — hydrate one owner position with NFT metadata, history,
  campaigns, earned rewards, token USD prices, and an atomic Multicall3 query
  for current principal, fees or Ve33 rewards, and ownership
- `get_position_pool_candidates` — list existing pools for a pair with
  verified exact PoolKeys, v2/v3 Core generation, extension classification,
  token prices, pool statistics, and the correct position manager
- `get_liquidity_opportunities` — rank the interface's current
  boosted-fee, active-incentive, and projected STONX-emission opportunities;
  returns canonical tokens, exact actionable pools or a pair-level candidate
  lookup, APR components and denominators, freshness, and risk context. The
  Ve33 emission input is read and decoded by the user's wallet, then passed
  back for the final interface-equivalent ranking. Starknet incentives remain
  visible but are marked discovery-only because the current pool-candidate and
  deposit preparation tools are EVM-specific.
- `prepare_lp_position_deposit` — prepare a new v3 position mint or add
  liquidity, including exact PoolKey derivation and `maybeInitializePool` for
  a new pool atomically before the deployed `mintAndDeposit` call in one
  multicall, shared-SDK liquidity math, a nonzero slippage floor, exact
  approvals/refunds/cleanup, decoded intent, wallet-policy requirements, and a
  signer-neutral execution plan; no Cast encoding is required
- `prepare_pool_initialization` — prepare a standalone, idempotent
  `maybeInitializePool` transaction for an exact v3 PoolKey and initial tick
  when initialization should not be bundled with the first position mint
- `prepare_lp_position_earnings_claim` — resolve an owned position and
  prepare collection of standard LP fees or Ve33 LP rewards without removing
  liquidity or touching the NFT, including pending ownership/earnings reads,
  decoded calldata, wallet-policy requirements, and a wallet execution plan
- `prepare_lp_position_withdraw` — prepare a partial or full position
  withdrawal from an exact liquidity amount, or pass up to 100 withdrawals for
  one atomic wallet-batch-capable plan; each withdrawal automatically collects
  ordinary fees or Ve33 rewards and includes its own pending validation
- `get_pool` — resolve an exact chain/core/pool ID to a verified PoolKey,
  decoded config, the latest indexed state snapshot, and a `current_state_query`
  read bundle whose `read_calls_reference` the wallet executes for fresh
  on-chain sqrtRatio, tick, and liquidity
- `get_pool_liquidity` — return tick-level net liquidity deltas for one
  exact pool
- `list_pool_keys` — enumerate a Core deployment's initialized pools
  with keyset pagination (`after_pool_id`, ascending pool_id) and
  token/pair/extension filters; every pool_id is re-derived locally from its
  PoolKey before it is reported
- `derive_pool_id` — pack a PoolKey and derive its exact Keccak pool ID
- `decode_pool_config` — decode the extension, exact uint64 Q64 fee,
  v3 discriminator, and concentrated or stableswap parameters

### Aave V3

- `get_aave_v3_markets` — return a local, versioned catalog of fixed
  Aave V3 Pools and major reserves on Ethereum, Base, Arbitrum, Optimism,
  Polygon, and Avalanche
- `prepare_aave_v3_supply`, `prepare_aave_v3_withdraw`,
  `prepare_aave_v3_borrow`, and `prepare_aave_v3_repay` — prepare
  complete signer-neutral Pool calls, including temporary exact ERC-20
  approvals and allowance cleanup where needed
- `prepare_aave_v3_collateral` and `prepare_aave_v3_emode` —
  prepare collateral-toggle and eMode-category calls against a fixed Pool

The agent—not this MCP—queries Aave's public GraphQL endpoint at
`https://api.v3.aave.com/graphql` for live market/user data. API results select
explicit fixed identifiers for the preparation tools; wallet simulation
remains authoritative.

### Morpho Vault V2

- `get_morpho_vaults` returns a local, pinned catalog and direct-discovery
  guidance.
- `prepare_morpho_vault_deposit` uses the official Morpho SDK's guarded
  Bundler3/GeneralAdapter1 route with a caller-supplied fresh
  `max_share_price_ray`, exact asset approval, and atomic cleanup.
- `prepare_morpho_vault_withdraw` and `prepare_morpho_vault_redeem` construct
  direct fixed-vault exits.

Read `ekubo://skills/use-morpho`. The agent queries
`https://api.morpho.org/graphql` itself, then uses fresh wallet/RPC state and
the official SDK to derive the share-price bound. The server never proxies the
API or RPC.

### Sky Savings

- `get_sky_savings_deployment` returns fixed Ethereum USDS/sUSDS addresses.
- `prepare_sky_savings_deposit`, `prepare_sky_savings_withdraw`, and
  `prepare_sky_savings_redeem` construct canonical ERC-4626 calls.

Read `ekubo://skills/use-sky`. Current previews, conversions, limits, balances,
and allowances come directly from the user's wallet/RPC. The direct ERC-4626
methods have no deadline or minimum-output argument, so fresh preview and exact
wallet simulation are required.

### Lido

- `get_lido_deployment` returns fixed Ethereum stETH, wstETH, and withdrawal
  queue addresses.
- `prepare_lido_stake`, `prepare_lido_wrap`, and `prepare_lido_unwrap` build
  liquid-staking and token-conversion plans.
- `prepare_lido_withdrawal_request` creates bounded asynchronous unstETH NFT
  requests; `prepare_lido_withdrawal_claim` claims one finalized request.

Read `ekubo://skills/use-lido`. Pause/limit, conversion, balance, ownership,
queue, and finalization state is read directly through the user's wallet/RPC.
Withdrawal requests are irreversible, stop rewards while queued, and may
settle below 1:1 after extraordinary protocol losses.

### Merkl

- `get_merkl_deployment` returns the reward Distributor address and the chains
  it was verified on.
- `prepare_merkl_claim` builds one `claim()` covering every reward token the
  sender holds on a chain.

Read `ekubo://skills/use-merkl`. Amounts and Merkle proofs come from
`https://api.merkl.xyz/v4/users/{address}/rewards/summary`, which the agent
queries directly — it is public and needs no key.

This is the one preparation whose inputs arrive from an outside API and still
need not be trusted. Every proof is folded here into the root it implies, a
batch spanning two roots is refused, and the returned read bundle asks the
wallet for the root the chain is enforcing. A mismatch means the tree rotated
or is inside its dispute period, so the plan simply fails simulation instead of
being signed. The Distributor is pinned per chain rather than assumed: ZKsync
Era has no code at the address the other chains share.

Merkl's `amount` is cumulative and the contract transfers it minus what was
already claimed, so the claimable figure is `amount - claimed`; its `pending`
field is not claimable at all. `prepare_merkl_claim` covers Merkl campaigns on
any protocol, while `prepare_rewards_claim` covers Ekubo's own incentive drops.

### Aerodrome

- `get_aerodrome_deployment` returns the Base contracts and the protocol
  behaviour that decides what an action can do.
- `prepare_aerodrome_sugar_reads` builds the eth_call bundle for one Sugar
  dataset: pools, an account's positions, veNFTs, epochs, or a veNFT's
  claimable rewards.
- `prepare_aerodrome_liquidity_deposit` / `_withdraw` — v2 add and remove
  through the Router, with per-side approvals and allowance cleanup.
- `prepare_aerodrome_gauge_deposit` / `_withdraw` / `_claim` — stake, unstake,
  and collect AERO emissions.
- `prepare_aerodrome_lock` — create, add to, extend, permanently lock, unlock,
  or withdraw a veAERO position.
- `prepare_aerodrome_vote` — cast or reset one veNFT's gauge vote.
- `prepare_aerodrome_incentive_claim` — a voter's fees, bribes, and rebase.

Read `ekubo://skills/use-aerodrome`. Aerodrome is Base-only and publishes no
data API: the **Sugar** lens contracts are its data pipeline and answer
`eth_call`, so discovery is a read against the user's own RPC and the no-proxy
boundary costs nothing. Each prepared read ships a decode plan matching the
deployed struct layout.

Every address was derived on chain from the Voter outward rather than copied
from Velodrome's SDKs, which is not pedantry: `sdk.js` publishes Optimism
addresses, and its `Position` struct has drifted from the deployed Base lens by
two fields, so decoding a live response with it silently misreads everything
after `sqrt_ratio_upper` instead of failing.

The fee and bribe contracts a claim needs are per pool and come only from a
Sugar rewards read; a claim naming the wrong one succeeds and transfers
nothing, so a green simulation is not by itself evidence the inputs were right.
Swaps are deliberately absent — `get_quotes_with_plans` remains the single swap
path — and Slipstream positions are readable but not yet mintable here.

The remaining EVM interface transaction paths also have first-class tools:

- `prepare_transfers` — prepare 1–4,096 ordered native, ERC-20, ERC-721,
  and ERC-1155 transfers on one chain; kinds may be mixed in one atomic batch;
- wrap/unwrap and LP NFT transfer;
- standalone pool initialization and phased pool price correction, including
  exact reads, quote, approval, and execution route;
- TWAMM/DCA creation, collection, stop, and virtual-order execution;
- auction creation, completion/graduation initialization, and creator proceeds;
- manual boosts, oracle capacity, ERC-20 revocations, and old gEKUBO unwrap;
- incentive rewards, Recovery Fund claims, and revenue buyback maintenance;
- VeToken increase-stake, fee-safe merge, and expired withdrawal.

Each `prepare_*` result supplies the exact ordered transaction list. The
wallet validates, signs, and submits it; it does not encode calls, select
overloads, build multicalls, append approvals, or determine ordering.

## Resources

- `ekubo://skills/use-morpho`, `ekubo://skills/use-sky`,
  `ekubo://skills/use-lido`, `ekubo://skills/use-merkl`, and
  `ekubo://skills/use-aerodrome` — reusable
  no-proxy protocol workflows, with a
  `references/discovery.md` child resource for official endpoints and reads
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

`get_quotes_with_plans` has no provider-selection input and does not
select a quote. Same-chain requests return every Ekubo and 0x option in
`quotes` with its source URL and normalized amounts, so the agent or user can
choose. Supply `sender` and `slippage_bps` together and each option also
carries the `execution_plan_reference` that executes it, so a chosen plan goes
straight to a wallet with no second round trip and the compared quote is the
executed one. Unless the user specifies a tolerance, choose `slippage_bps` so
the maximum value exposed to slippage is approximately one estimated gas fee
(`10_000 * gas cost / swap notional`, with both values in the same currency),
not a generic 50 bps/0.5%. Prefer re-quoting and preparing new calldata after
a slippage failure to widening that bound; never resubmit reverted calldata
unchanged. Omit both for an indicative comparison, and set `include_raw_quotes` to
add the untouched provider responses, which are otherwise left out as the
largest and least useful part of a response.
If a configured provider fails, the response reports it in
`unavailable_sources` without invalidating successful quote options, and an
option that could not be made executable reports its own
`execution_unavailable` while the rest stand.
Cross-chain requests are quoted by Across, by LayerZero's Value Transfer API,
and by LI.FI, each included where its credentials are configured, and are
compared the same way as same-chain options. LayerZero prices an exact source
amount only, so an exact-output bridge request reports `unsupported_quote_type`
for it and is served by Across and LI.FI. After executing a LayerZero or LI.FI
option, poll `get_value_transfer_status` with that option's `source` until
`settled` is true — LayerZero by the quote's `provider_quote_id`, LI.FI by the
origin transaction hash. Token
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
boundary before storage — and token lists exported by `export_tokens` are
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

`export_tokens` is the tool for that trip, and it is a separate tool
rather than a flag on `list_tokens` because it does a different job.
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

For a new LP position, start with `get_position_pool_candidates`; do not
browse `prod-api` or infer a manager from an ABI resource. Its default
`min_tvl_usd=0` keeps initialized pools with negligible liquidity visible.
After the user selects an existing v3 pool, range, token maxima, and slippage,
call `prepare_lp_position_deposit`. Pass its exact
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

For an existing position, call `prepare_lp_position_earnings_claim` with
the connected owner, chain, manager, and token ID from the owner-position list.
It automatically selects standard fee collection or Ve33 reward claiming. Run
its pending current-state query with the supplied local decode plan, verify the
decoded owner against `expected_owner`, and include the current claim with its
unchanged execution plan in the wallet MCP handoff. The prepared call does not
remove liquidity, burn the NFT, or transfer it.

For partial or full withdrawals, execute and decode every position's pending
current-state query and choose an exact positive liquidity amount no greater
than its decoded liquidity. Call `prepare_lp_position_withdraw` with the
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
`get_ve33_allocations` with only the connected EVM wallet address as
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
`get_ve33_allocations`, present its complete allocation and `state_id`,
and execute `onchain_validation.eth_call` through the user's provider.
Then pass that exact state ID and target `weight_bps` values to
`prepare_ve33_reallocation`. The target shares must total 10,000. The
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
workflow. First call `get_stonx_allocation_recommendation` and require
`execution_ready=true`, at most 25 targets, and
`target_total_weight_bps=10000`. Then fetch and
validate the wallet's complete current allocation as above. Finally pass its
exact `state_id`, the recommendation's `targets`, and
`strategy=compact_max_lock` to
`prepare_ve33_reallocation`. Recommendation rows that do not yet have an
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
The deployment also uses five Worker secrets:

- `ZERO_X_API_KEY`
- `ACROSS_API_KEY`
- `ACROSS_INTEGRATOR_ID`
- `LAYER_ZERO_API_KEY`
- `LI_FI_API_KEY`
- `DUNE_API_KEY` (internal allocation-recommendation data access; never
  returned or identified by the public MCP surface)

They are declared as required runtime secrets in `wrangler.jsonc`, so a deploy
fails rather than silently publishing disabled provider tools when a binding is
missing. Bind them to the production `mcp` Worker under **Settings > Variables
& Secrets**; Cloudflare build variables are not available at runtime.

0x requests use Swap API v2's AllowanceHolder endpoints. Across requests use
`GET /swap/approval` with bearer authentication and the configured integrator
ID. LayerZero requests use the Value Transfer API at
`https://transfer.layerzero-api.com/v1` with `x-api-key` authentication:
`POST /quotes` for a transfer and `GET /status/{quoteId}` for its progress,
plus the unauthenticated `GET /chains` that maps EIP-155 chain IDs onto the
chain keys that API addresses. That catalog is cached for ten minutes per
isolate, because re-reading effectively static data would spend part of a
quote's own lifetime on it. LI.FI requests use `https://li.quest/v1` with
`x-lifi-api-key` authentication: `GET /quote` for an exact-input transfer,
`GET /quote/toAmount` for an exact-output one, and `GET /status` for its
progress. These credentials remain server-side and are never returned by a
tool. The Worker never receives wallet credentials.

LayerZero returns several routes per transfer (OFT, Stargate taxi and bus,
CCTP, Aori). The executable route with the largest destination amount is taken.
A route whose `userSteps` include an EIP-712 signature step is skipped: it needs
a `/submit-signature` round trip in the middle of execution, which an execution
plan — a fixed ordered set of transactions a wallet signs — cannot perform. The
approval spender is decoded out of the step LayerZero itself built and re-issued
for the exact transfer amount, which is what keeps the allowance on the
TransferDelegate rather than the LZMulticall wrapper the API documents as the
wrong spender.

LI.FI addresses chains by EIP-155 id and native currency by the zero address,
so neither needs translating, and it selects the route itself rather than
returning a set to choose between. Its `estimate.approvalAddress` is re-issued
as an exact-amount approval, and the `transactionRequest`'s chain is checked
against the transfer's origin rather than trusted. `GET /status` resolves a
LI.FI transfer by origin transaction hash only — a quote id is rejected — and
answers a hash it has not yet observed with a 404, which is reported as status
`NOT_FOUND` rather than raised so that a poll loop survives the window before
the origin transaction is indexed. A LI.FI transfer reports `REFUNDED` and
`PARTIAL` as substatuses of status `DONE`, so `substatus` rather than `status`
decides whether the funds arrived.

`mcp.ekubo.org` is the only name this server is published under. The default
`mcp.<subdomain>.workers.dev` hostname is unrouted in `wrangler.jsonc`
(`"workers_dev": false`), so a request on it never reaches the Worker.

To be precise about what that does: the account subdomain is a wildcard, so the
name still resolves and Cloudflare answers **404** at the edge — the same 404
returned for a name that was never a Worker at all. The DNS record does not
disappear; the routing does.

It is an unrouting rather than a redirect on purpose. An edge rule is scoped to
a zone, and `workers.dev` belongs to Cloudflare rather than to this account, so
there is no zone to attach a redirect rule to, and bouncing the name would mean
running the Worker on every request that arrives on it. Since the hostname was
never published, not answering is preferred to spending an invocation on it.

`preview_urls` defaults to whatever `workers_dev` is set to, so it is stated
separately above rather than left to follow this setting.

Set optional comma-separated `ALLOWED_HOSTNAMES` and `ALLOWED_ORIGINS`
variables if the deployment needs a stricter host list or cross-origin browser
MCP clients. The request's own hostname is always accepted as a browser origin;
non-browser MCP clients normally omit `Origin`.

## Jurisdiction restrictions

Swap quotes (`get_quotes_with_plans`) are always available regardless of the
MCP connection country. Each quote and execution envelope returns `jurisdiction`
metadata: a policy version, the union of restricted ISO alpha-2 jurisdictions,
and per-asset restrictions for selling the input and buying the output. This
applies to every quote provider, including cross-chain outputs. An empty list
means this policy lists no restriction, not that the API certified eligibility.

The agent/wallet must read `execution_notice` before signing or submitting any
approval or swap. A restricted or unknown user connection jurisdiction requires
an explicit user attestation of domicile outside the listed jurisdictions; an
agent/server IP is not evidence of the user's domicile. Reused attestations must
match the executing wallet, cover the restrictions, be unexpired and valid for
at most seven days. The API/MCP does not receive, verify, store, or publish proofs
or the user's declared country. Metadata accompanies plan references and is preserved in the fetched plan as
`extensions["ekubo.jurisdiction"]`, so this is agent/client policy, not automatic wallet
or on-chain enforcement. No shared signature package or privacy-policy change
is introduced by this metadata-only change.

The following controls continue to apply to **other preparation tools**:

Some assets may not be traded from some countries. The Ekubo interface disables
its action buttons for them; this server has no UI to disable, so other preparation tools refuse to
produce an execution plan. The restriction data and its semantics mirror
`interface/src/util/common/tokenRestrictions.ts` — currently the tokenized
equities on Robinhood chain (`4663`), which are restricted in `US`, `GB`, `CA`,
`SG`, `AE`, `CH`, `IR`, `KP`, `SY`, `CU`, and `UA`. `src/token-restrictions.ts`
holds both.

The country comes from `request.cf.country`, which Cloudflare derives from the
connecting IP and a client cannot supply, matching the Ekubo API's `/country`
route that the interface reads. It must be taken from the *original* request:
`admitMcpRequest` replays a POST through `new Request(url, init)` to re-serve
the body it already priced, and the replayed request carries the headers over
but drops `cf`.

A refusal is an ordinary tool error with code `restricted_jurisdiction`, listing
the offending assets in `details`. It is raised before any upstream quote is
fetched, so a restricted request never spends 0x, Across, LayerZero, or LI.FI
credit.

What is gated is the *acquisition* of a restricted asset:
`prepare_twamm_order`, `prepare_lp_position_deposit`,
`prepare_auction_create`, `prepare_oracle_capacity_expansion`,
`prepare_fix_pool_price`, and the swap phase of `prepare_ve33_reinvest`. Exits
are deliberately never gated — withdrawing liquidity, collecting fees or
proceeds, transferring a position, and revoking approvals stay available to
everyone, as they do in the interface. Discovery is also untouched: restricted
assets remain listed and priced by `list_tokens`, `get_token`, and the
opportunity tools, exactly as the interface still displays them.

### Disposals are exempt where the restriction is offering-based

Selling a restricted asset for an unrestricted one is prepared even from a
country that restricts it, provided that country appears in
`DISPOSAL_EXEMPT_COUNTRIES` — currently `US`, `GB`, `CA`, `SG`, `AE`, and `CH`,
the countries whose restriction exists because the offering is not registered
for their residents. Blocking the sale there leaves a holder no way to stop
holding, which is the opposite of what the restriction is for.

The exemption is narrow, and three limits are load-bearing:

- **It does not extend to the sanctions countries** — `IR`, `KP`, `SY`, `CU`,
  `UA`. A disposal is still a transaction facilitated for a sanctioned
  jurisdiction, so those stay blocked in both directions.
- **It does not extend to an unresolved country.** The exemption is a claim
  about one jurisdiction's rules, and an unresolved origin has not been shown
  to be in one.
- **Only the asset being given up is exempt.** Selling one restricted equity
  for another is still refused, on the acquisition side, without needing a
  rule of its own.

Every call site declares which way its asset moves, via the required `side`
field on `RestrictableAsset`. There is no default, so a new gated tool has to
state its direction rather than inherit an exemption by omission. This is the
one place where this server deliberately diverges from the interface, which
blocks both directions and therefore still offers its users no exit; the
interface needs the same carve-out before the two agree.

Two further behaviours are worth stating explicitly, because both are
deliberate:

- **An unresolved country fails closed, but only for assets that are actually
  restricted.** A chain-wide restriction entry that names no countries restricts
  nobody and must not drag every token on that chain into the check. An empty
  `Set` is truthy, so this was previously inverted in the interface; both
  implementations now treat an empty entry as no restriction.
- **A request arriving over Tor (`cf.country === "T1"`) is treated as an
  unresolved country** rather than as an ISO code that can never match, so a
  restricted asset fails closed. The interface applies the same rule in
  `resolvedCountryCode`.

The gate applies when a plan is issued. An already-issued
`execution_plan_reference` stays fetchable from `/artifact/<id>` for
`ARTIFACT_TTL_SECONDS` regardless of where it is fetched from, because that
route serves wallets and carries no tool identity.

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
| `RATE_LIMITER_BURST` | 10s | 120 requests | A flood, visible within ten seconds rather than after a minute of it |
| `RATE_LIMITER` | 60s | 300 requests | Sustained request volume across every route |
| `RATE_LIMITER_TOOLS` | 60s | 120 units | Weighted tool cost: scraping and upstream load |
| `RATE_LIMITER_METERED` | 60s | 20 calls | Calls that spend 0x, Across, LayerZero, LI.FI, or Dune credit |

The unit scale is anchored at 1 = one ordinary `prod-api` read. A bulk or
fan-out read costs 3–4, a preparation that writes an artifact costs 3, a quote
comparison costs 10, and a STONX recommendation costs 20; `derive_pool_id`
and `decode_pool_config` touch nothing and cost nothing. A tool with no
entry in the table is charged 3 if it is a preparation and 2 otherwise, so a
tool added later without a deliberate price is over-charged rather than free.
At the defaults a caller gets roughly ten complete swap flows or a hundred
catalog reads a minute, and a catalog scrape stalls within seconds.

The two request budgets are sized for a client that opens *seven* sessions,
not one. A harness configured with the per-protocol endpoints connects to
`ekubo` and to each satellite protocol, and every one of those opens with a
stream GET, `initialize`, `notifications/initialized`, `tools/list`,
`resources/list`, and `prompts/list` — around forty requests from one caller
in a couple of seconds. They were 30 and 120, sized when a client opened one
session, and the first harness start after the split overran the burst budget
and took 429s on an arbitrary subset of the servers. None of that traffic
reaches a third party or costs a tool unit, which is why the two cost budgets
below did not move with them.

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

They are also eventually consistent *within* a colo, which matters the moment
anyone tries to verify this by hand. Measured against production when the
burst budget was 30: 60 requests issued back to back over one keep-alive
connection, 1.3 seconds total, returned 31 × 200 and then 429 from request 32
with `Retry-After: 10` — the budget behaving exactly as configured. The same
60 requests fired 25-at-a-time all returned 200, because concurrent requests
read the counter before any of their increments land. A burst test that passes
proves nothing; test sequentially, and issue more than the budget now allows.

Verifying `RATE_LIMITER_TOOLS` does not require spending anything upstream.
Cost is charged from the tool name before dispatch, so calling an expensive
tool with arguments that fail schema validation draws its full price and never
reaches a provider: 16 calls to `prepare_ve33_reinvest` (8 units each)
crossed the 120-unit budget and returned the `tool_units` rejection with no
upstream request made. Do not burst-test `RATE_LIMITER_METERED` the same way —
those calls spend real 0x and Dune credit.

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

Connect MCP Inspector to `http://localhost:8787/mcp`, or to
`http://localhost:8787/mcp/<protocol>` for one protocol's tools.

## Deployment

Production deployment is automatic through the Cloudflare Pages Git
integration. Merging or pushing a commit to `main` starts the Cloudflare build
and publishes the resulting deployment; there is no manual release command.

Do not run `wrangler deploy`, `bun run deploy`, or a separate CI deployment
after pushing. Those bypass the automatic release path and can produce a live
version that does not correspond to the Cloudflare Pages deployment for
`main`. The repository's GitHub Actions workflow only installs, type-checks,
tests, and validates the bundle; Cloudflare Pages owns the deployment itself.

After the Cloudflare deployment completes, smoke-test the canonical production
origin:

```sh
curl https://mcp.ekubo.org/
curl https://mcp.ekubo.org/tools
MCP_ORIGIN=https://mcp.ekubo.org bun run smoke
npx @modelcontextprotocol/inspector@latest
```

`bun run smoke` checks root discovery, OpenAPI, the HTTP tool catalog, MCP
initialization, protocol-native tools, the contract resource templates, and
that each `/mcp/<protocol>` endpoint serves exactly the tools the deployed root
document says it does — against the deployment rather than against a list in
the script, so a deployment routing every slug back to the full catalog fails
rather than passing a check that only asked whether some tools came back.

Connect MCP Inspector to
`https://mcp.ekubo.org/mcp`, initialize the server,
list tools, list tokens, request same-chain and cross-chain quotes, and
prepare unsigned execution plans. Connect it to
`https://mcp.ekubo.org/mcp/<protocol>` as well: a narrower endpoint should
list only that protocol's tools, offer only its own skill resource, and open
with instructions that name no tool it does not serve. Validate every plan through the user's
connected wallet or provider before signing.

The implementation uses the recommended stateless `createMcpHandler` path and
does not require Durable Objects. Authorization is intentionally omitted
because all tools operate on public data and cannot mutate protocol or user
state. Signing and submission remain client-side.

## License

MIT, © 2026 Ekubo, Inc. See [LICENSE](LICENSE).
