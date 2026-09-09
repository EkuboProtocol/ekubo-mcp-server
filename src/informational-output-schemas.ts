import { z } from "zod";

// Describe the stable fields we own, retaining additional upstream data.
// Never infer a complete upstream contract from a single response sample.
const record = z.record(z.string(), z.unknown());
const uint = z.string().regex(/^(0|[1-9][0-9]*)$/);
const token = z.looseObject({ chain_id: z.string().optional() });
const tokens = z.looseObject({ tokens: z.array(token) });
const deployment = {
  protocol: z.string(),
  network_access: z.literal("none"),
  source: record,
  agent_market_data_discovery: record,
  limitations: record,
};
const fixedDeployment = z.looseObject({ ...deployment, deployment: record });
const indexedUniswap = z.looseObject({
  source: z.string(),
  fetched_at: z.string(),
  indexed_data: z.literal(true),
  partial: z.boolean(),
  errors: z.array(z.looseObject({ message: z.string() })),
  // GraphQL roots differ by version and operation, and partial responses may
  // contain nulls. The envelope, not those upstream fields, is our contract.
  data: z.unknown(),
});
const poolConfig = z.looseObject({
  config: z.string(),
  extension: z.string(),
  fee: uint,
  fee_hex: z.string(),
  type_config: z.string(),
  pool_type: z.enum(["concentrated", "stableswap", "full_range"]),
  discriminator_bit_set: z.boolean(),
  tick_spacing: z.number().int().nullable(),
  stableswap_params: z.looseObject({
    center_tick: z.number().int(),
    amplification: z.number().int(),
  }).nullable(),
});

export const informationalOutputSchemas: Readonly<Record<string, z.ZodObject>> = {
  list_tokens: tokens,
  get_tokens: tokens,
  get_token: z.looseObject({ token }),
  get_value_transfer_status: z.looseObject({
    source: z.enum(["layerzero", "lifi"]),
    source_url: z.string(),
    quote_id: z.string().nullable(),
    origin_transaction_hash: z.string().nullable(),
    status: z.string(),
    substatus: z.string().nullable(),
    substatus_message: z.string().nullable(),
    settled: z.boolean(),
    explorer_url: z.string().nullable(),
    execution_history: z.array(record),
    polling: z.looseObject({ settled: z.boolean(), instruction: z.string() }),
  }),
  get_stonx_allocation_recommendation: z.looseObject({
    schema_version: z.literal("1"),
    recommendation_id: z.string(),
    snapshot_at: z.string(),
    chain_id: z.string(),
    execution_ready: z.boolean(),
    recommendations: z.array(record),
    targets: z.array(z.looseObject({
      pool_key_id: z.string(),
      swap_fee: uint,
      weight_bps: z.number().int(),
    })),
  }),
  get_pool_liquidity: z.looseObject({
    chain_id: z.string(),
    core_address: z.string(),
    pool_id: z.string(),
    pool_id_decimal: uint,
    liquidity_deltas: z.array(z.unknown()),
  }),
  list_pool_keys: z.looseObject({
    chain_id: z.string(),
    core_address: z.string(),
    core_generation: z.enum(["v2", "v3"]),
    pools: z.array(record),
    page: z.looseObject({
      page_size: z.number().int(),
      after_pool_id: z.string().nullable(),
      next_after_pool_id: z.string().nullable(),
      has_more: z.boolean(),
    }),
  }),
  derive_pool_id: z.looseObject({
    pool_id: z.string(),
    pool_id_decimal: uint,
    pool_key: z.looseObject({ token0: z.string(), token1: z.string(), config: z.string() }),
    decoded_config: poolConfig,
  }),
  decode_pool_config: poolConfig,
  get_position_pool_candidates: z.looseObject({
    chain_id: z.string(),
    pair: z.looseObject({ token0: z.string(), token1: z.string() }),
    tokens: z.array(token),
    candidates: z.array(record),
    candidate_count: z.number().int(),
  }),
  get_aave_v3_markets: z.looseObject({ ...deployment, markets: z.array(record) }),
  get_morpho_vaults: z.looseObject({ ...deployment, vaults: z.array(record) }),
  get_sky_savings_deployment: fixedDeployment,
  get_merkl_deployment: fixedDeployment,
  get_aerodrome_deployment: fixedDeployment,
  get_lido_deployment: fixedDeployment,
  decode_uniswap_v4_position_info: z.looseObject({
    tick_lower: z.number().int(),
    tick_upper: z.number().int(),
    has_subscriber: z.boolean(),
    pool_id_prefix: z.string(),
    instruction: z.string(),
  }),
  quote_uniswap_liquidity: z.looseObject({
    liquidity: uint,
    mint_amount0: uint,
    mint_amount1: uint,
    amount0_max: uint,
    amount1_max: uint,
    amount0_min: uint,
    amount1_min: uint,
    input_snapshot: record,
    live_state_queried: z.literal(false),
    instructions: z.string(),
  }),
  get_uniswap_deployments: z.looseObject({
    protocol: z.literal("uniswap"),
    deployments: z.array(z.looseObject({ chain_id: z.string(), network: z.string() })),
    source: z.string(),
  }),
  discover_uniswap_pools: indexedUniswap,
  get_uniswap_pool: indexedUniswap,
  get_uniswap_pool_ticks: indexedUniswap,
  get_uniswap_charts: indexedUniswap,
};
