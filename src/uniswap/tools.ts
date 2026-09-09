import { decodeV4PositionInfo } from "./pool-key.js";
import { quoteSchema, quoteUniswapLiquidity } from "./quote.js";
import { z } from "zod";
import { uintSchema, getUniswapDeployments } from "./common.js";
import {
  ticksDataSchema,
  getUniswapPoolTicks,
  discoverySchema,
  poolSchema,
  chartsSchema,
  discoverUniswapPools,
  getUniswapPool,
  getUniswapCharts,
} from "./data.js";
import { readsSchema, prepareUniswapReads } from "./reads.js";
import {
  v2AddSchema,
  v2RemoveSchema,
  prepareV2Add,
  prepareV2Remove,
} from "./v2.js";
import {
  v3AddSchema,
  v3RemoveSchema,
  v3CollectSchema,
  prepareV3Add,
  prepareV3Remove,
  prepareV3Collect,
} from "./v3.js";
import {
  v4AddSchema,
  v4RemoveSchema,
  v4CollectSchema,
  prepareV4Add,
  prepareV4Remove,
  prepareV4Collect,
} from "./v4.js";
function tool<S extends z.ZodObject>(
  name: string,
  title: string,
  description: string,
  schema: S,
  handler: (input: z.output<S>) => unknown,
) {
  return {
    name,
    title,
    description,
    schema,
    handler: (input: unknown) => handler(schema.parse(input)),
  };
}
export const uniswapTools = [
  tool(
    "decode_uniswap_v4_position_info",
    "Decode Uniswap V4 position info",
    "Decode the packed PositionInfo returned by wallet reads into signed tick bounds, subscriber flag and the truncated pool-ID prefix. This is local integer decoding, not a state query.",
    z.object({ info: uintSchema }),
    (input) => decodeV4PositionInfo(input.info),
  ),
  tool(
    "quote_uniswap_liquidity",
    "Calculate Uniswap concentrated liquidity amounts",
    "Calculate V3/V4 range liquidity, rounded mint/burn amounts and explicit token bounds from a current sqrt-price snapshot and raw token budgets, or an exact liquidity amount. Fees are excluded. Obtain current state using prepare_uniswap_reads.",
    quoteSchema,
    quoteUniswapLiquidity,
  ),
  tool(
    "get_uniswap_deployments",
    "Get Uniswap deployments",
    "Canonical V2/V3/V4 contracts on Ethereum, Optimism, Base, Arbitrum and Unichain, including Permit2 and wrapped native addresses.",
    z.object({}),
    getUniswapDeployments,
  ),
  tool(
    "discover_uniswap_pools",
    "Discover Uniswap pools",
    "Fetch indexed V2, V3 or V4 pools ranked by TVL from Uniswap's interface API. Filter by chain and token; paginate using the last pool's TVL as tvl_cursor. Returns token symbols and decimals, liquidity and daily volume.",
    discoverySchema,
    discoverUniswapPools,
  ),
  tool(
    "get_uniswap_pool",
    "Get a Uniswap pool",
    "Fetch indexed pool details, currencies, fee, TVL, volume and supplies. V4 takes a bytes32 pool ID; V2/V3 take an address. Use prepare_uniswap_reads for current chain state.",
    poolSchema,
    getUniswapPool,
  ),
  tool(
    "get_uniswap_pool_ticks",
    "Get Uniswap liquidity depth data",
    "Fetch paginated initialized ticks and exact liquidityNet/liquidityGross strings for V3/V4 liquidity depth charts. first/skip bound each request; combine with current pool liquidity and tick from prepare_uniswap_reads. Indexer data can lag.",
    ticksDataSchema,
    getUniswapPoolTicks,
  ),
  tool(
    "get_uniswap_charts",
    "Get Uniswap pool charts",
    "Fetch timestamped token0/token1 prices and USD volume history over the requested duration from the same GraphQL fields as the open source Uniswap interface. Empty series means no indexed data, never zero volume.",
    chartsSchema,
    getUniswapCharts,
  ),
  tool(
    "prepare_uniswap_reads",
    "Prepare Uniswap pool and position reads",
    "Return exact wallet read bundles for pool state, reserves, positions and ownership. V3 supports bounded owner-index enumeration. V4 requires known token IDs. Verify returned tokens, fee, factory/pool key, tick spacing and owner before preparing liquidity operations.",
    readsSchema,
    prepareUniswapReads,
  ),
  tool(
    "prepare_uniswap_v2_add_liquidity",
    "Prepare Uniswap V2 liquidity deposit",
    "Add liquidity or create a V2 pair with exact token approvals and cleanup. Amounts are raw units; sorted token0/token1 and explicit minimum outputs are required. use_native pays ETH for the wrapped-native side. Execute atomically through the wallet.",
    v2AddSchema,
    prepareV2Add,
  ),
  tool(
    "prepare_uniswap_v2_remove_liquidity",
    "Prepare Uniswap V2 liquidity withdrawal",
    "Burn an exact LP amount through the canonical V2 router; realize accrued fees with principal. LP token address is derived from the factory. Optional native unwrapping. V2 has no separate fee claim. Requires atomic LP approval and cleanup.",
    v2RemoveSchema,
    prepareV2Remove,
  ),
  tool(
    "prepare_uniswap_v3_add_liquidity",
    "Prepare Uniswap V3 liquidity deposit",
    "Mint a ranged NFT or increase token_id with raw desired amounts and minima. First verify factory fee tick spacing and position tokens/range. Optional initialize_sqrt_price_x96 creates the pool; use_native pays ETH and refunds excess. Exact approvals and cleanup require an atomic wallet.",
    v3AddSchema,
    prepareV3Add,
  ),
  tool(
    "prepare_uniswap_v3_remove_liquidity",
    "Prepare Uniswap V3 liquidity withdrawal",
    "Decrease exact uint128 liquidity, collect principal and all accrued fees, and optionally burn a fully emptied NFT. Raw minima protect withdrawal proceeds. Optional unwrap_native requires verified position currencies.",
    v3RemoveSchema,
    prepareV3Remove,
  ),
  tool(
    "prepare_uniswap_v3_collect_fees",
    "Prepare Uniswap V3 fee collection",
    "Collect all owed fees without removing liquidity, optionally unwrapping WETH. Verify NFT ownership and currencies first. V3 collect has no onchain deadline; regenerate and simulate before execution.",
    v3CollectSchema,
    prepareV3Collect,
  ),
  tool(
    "prepare_uniswap_v4_add_liquidity",
    "Prepare Uniswap V4 liquidity deposit",
    "Mint or increase an exact liquidity amount using raw uint128 token maxima. Zero token0 means native ETH. Uses exact ERC20 and Permit2 approvals with cleanup, settles both signs of accrued-fee deltas on increase, and refunds native surplus. Verify NFT pool key/range and hook behavior; hook_data is forwarded unchanged. Optional pool initialization.",
    v4AddSchema,
    prepareV4Add,
  ),
  tool(
    "prepare_uniswap_v4_remove_liquidity",
    "Prepare Uniswap V4 liquidity withdrawal",
    "Remove liquidity and take principal plus fees to the sender. Optional burn:true requires liquidity:0 and withdraws the entire NFT with minima applied to the full position. Requires exact pool currencies and hook data; uint128 minima bound principal outputs.",
    v4RemoveSchema,
    prepareV4Remove,
  ),
  tool(
    "prepare_uniswap_v4_collect_fees",
    "Prepare Uniswap V4 fee collection",
    "Poke a V4 position with zero liquidity decrease then take both currencies to the sender. Principal remains invested. Verify ownership, pool key and hook behavior first.",
    v4CollectSchema,
    prepareV4Collect,
  ),
];
export const uniswapCatalog = uniswapTools.map(
  ({ name, title, description, schema }) => ({
    name,
    title,
    description,
    inputSchema: z.toJSONSchema(schema, { io: "input" }),
  }),
);
