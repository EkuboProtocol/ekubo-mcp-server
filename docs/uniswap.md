# Uniswap

`/mcp/uniswap` provides Uniswap V2, V3 and V4 tools. `/mcp` includes the same
tools in the full catalog. The server prepares unsigned wallet plans; it never
signs, holds funds or submits transactions.

## Coverage

Contracts are pinned through `@uniswap/sdk-core@7.19.2` for Ethereum (1),
Optimism (10), Base (8453), Arbitrum (42161), Unichain (130) and Robinhood (4663).

| Tool | Behavior |
| --- | --- |
| `get_uniswap_deployments` | Canonical factories, routers, position managers, Permit2, StateView and wrapped native currencies |
| `discover_uniswap_pools` | V2/V3/V4 discovery by chain, token and TVL cursor |
| `get_uniswap_pool` | Indexed pool currencies, fees, liquidity, volume and supplies |
| `get_uniswap_charts` | Timestamped token prices and USD volume history |
| `get_uniswap_pool_ticks` | Paginated initialized ticks for liquidity depth charts |
| `prepare_uniswap_reads` | Wallet-owned pool/position/ownership reads, V3 owner enumeration, allowance checks |
| `decode_uniswap_v4_position_info` | Decode packed V4 position ticks and subscriber state |
| `quote_uniswap_liquidity` | Integer V3/V4 range math and amount bounds from a supplied current price snapshot |
| `prepare_uniswap_v2_add_liquidity` | ERC20 or native deposit, including pair creation |
| `prepare_uniswap_v2_remove_liquidity` | LP withdrawal, optionally returning native ETH |
| `prepare_uniswap_v3_add_liquidity` | Mint/increase, optional pool initialization, native payment/refund |
| `prepare_uniswap_v3_remove_liquidity` | Partial/full removal, collect, optional NFT burn and native unwrapping |
| `prepare_uniswap_v3_collect_fees` | Fee-only collection, optionally unwrapping WETH |
| `prepare_uniswap_v4_add_liquidity` | Mint/increase, optional initialization, native payment/refund and Permit2 cleanup |
| `prepare_uniswap_v4_remove_liquidity` | Exact partial/full removal or full NFT burn |
| `prepare_uniswap_v4_collect_fees` | Zero decrease plus TAKE_PAIR to collect fees |

V2 fees accrue in LP reserves and are realized on withdrawal. There is no
separate V2 fee claim. V3/V4 swaps can use the server's existing quote tools;
this addition does not implement a separate swap router, migration, staking,
or arbitrary hook-specific workflows.

## Workflow

1. Discover a pool and inspect its currencies/decimals. Pass a pool address for
   V2/V3 or the bytes32 pool ID for V4. Indexed values may lag.
2. Use `prepare_uniswap_reads` and pass its `read_calls_reference` unchanged to
   the wallet. Verify the canonical factory, currencies, tick spacing, current
   price, NFT ownership and position range. V3 positions are enumerable through
   `owner_indices`; V4 token IDs come from wallet NFT inventory or Transfer
   events. `next_token_id` is a counter, not proof of ownership. Decode V4 packed info with `decode_uniswap_v4_position_info`; `prepare_uniswap_reads` also returns the full derived pool ID.
3. For concentrated liquidity, use `quote_uniswap_liquidity` with the current
   sqrt price and range. Amounts are integer raw units. Bounds apply a token
   amount tolerance, not a price forecast; maxima can exceed the supplied
   budgets by that tolerance. Refresh the snapshot before preparing.
4. Prepare the operation. Pass the resulting `execution_plan_reference`
   unchanged to the wallet for simulation and authorization. Approvals and
   cleanup form an atomic plan, so an ordinary EOA needs a wallet capable of
   an atomic batch (the testing wallet uses Calibur). No unlimited token or
   Permit2 approval is introduced.
5. Confirm the receipt and re-read position liquidity, ownership, balances and
   allowances. A fee-collection simulation can succeed with zero fees.

V3/V4 NFT operations require the exact position currencies; callers must
verify these with the prepared reads. V4 additionally requires `pool_id`, and
its hash must match the supplied key. The indexer's `feeTier` can include
protocol fees and is not necessarily the immutable key's fee. Discovery
returns `pool_key` only when a candidate key hashes to the indexed ID; otherwise
it returns null. Do not substitute a display fee for a missing key. For a new
pool, calculate the intended key's ID before initialization.

For V4 native pools use zero address as token0. V2/V3 use the deployed WETH
address with `use_native`/`unwrap_native`. V4 increases close each currency's
delta independently, so accrued fees can flow back while liquidity increases.
V4 `burn:true` requires `liquidity:"0"`, explicitly meaning the whole position;
the minima apply to the entire withdrawal. A regular decrease requires a
positive exact liquidity amount. V3 `burn:true` reverts unless the withdrawal
leaves the NFT empty.

Deadlines must be in the next 24 hours. V3 collect itself has no onchain deadline.
Hook data is forwarded unchanged, and hook code may reject or alter a liquidity
operation. Always simulate the exact plan; support for the V4 call format does
not establish compatibility with every hook or nonstandard token.

## Data provenance and failures

The implementation was checked against [Uniswap/interface at da6d36f](https://github.com/Uniswap/interface/tree/da6d36f71c4d2fd665b0aae1a052a4ffda917b31), especially:

- `packages/api/src/clients/graphql/web/{topPools,pool,allV3Ticks,allV4Ticks}.graphql`
- `packages/api/src/clients/liquidity/createLiquidityServiceClient.ts`
- `packages/uniswap/src/features/transactions/liquidity/steps/`

Queries go to the public interface GraphQL endpoint, with bounded pages and a
20-second timeout. Responses retain `source`, `fetched_at`, `partial`, and
upstream field errors. A missing chart is not converted to zero volume; partial
responses preserve available series. Rankings and USD values are upstream
estimates, not onchain valuations or token endorsements. The pool key is
cryptographically checked independently of displayed fee/TVL data.

Transaction encoding follows canonical V2 Router02, V3 NonfungiblePositionManager,
and `@uniswap/v4-sdk@2.3.3` action layouts. The V4 SDK uses CLOSE_CURRENCY on
increases and a zero decrease for fee collection. Integer liquidity math comes
from `@uniswap/v3-sdk@3.31.3`.

## Reproducing validation

Run `bun test`, `bun run lint`, `bun run build`, and `bun run check`.
`script/uniswap-plan.ts` accepts `{ "tool": "...", "input": {...} }` on stdin
and invokes the same handlers registered over MCP, emitting digest-checked
inline wallet artifacts for local testing. It never signs or submits.

Live test receipts and the precise validation matrix are in [uniswap-validation.md](uniswap-validation.md). Unit tests cover transaction ordering, raw amount bounds,
native refunds, fee-only collection, Permit2 cleanup, rejected inputs and
partial upstream failures. MCP tests fetch the stored plan/read artifacts
through the actual worker route.
