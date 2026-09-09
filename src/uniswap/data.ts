import { getAddress, zeroAddress } from "viem";
import { v4PoolId } from "./pool-key.js";
import { z } from "zod";
import { chainSchema, chainNames, addressSchema } from "./common.js";
import { ServiceError } from "../core.js";
export const UNISWAP_GRAPHQL_URL =
  "https://interface.gateway.uniswap.org/v1/graphql";
export const versionSchema = z.enum(["v2", "v3", "v4"]);
export const discoverySchema = z.object({
  chain_id: chainSchema,
  version: versionSchema,
  token_address: addressSchema.optional(),
  first: z.number().int().min(1).max(100).default(20),
  tvl_cursor: z.number().finite().nonnegative().optional(),
});
export const poolSchema = z.object({
  chain_id: chainSchema,
  version: versionSchema,
  pool: z.string().regex(/^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/),
});
export const chartsSchema = poolSchema.extend({
  duration: z
    .enum(["HOUR", "DAY", "WEEK", "MONTH", "YEAR", "MAX"])
    .default("WEEK"),
});
const tokenFields = "address chain symbol name decimals";
const commonFields = `id protocolVersion token0 { ${tokenFields} } token1 { ${tokenFields} } totalLiquidity { value } txCount volume24h: cumulativeVolume(duration: DAY) { value }`;
const versionFields = {
  v2: "address",
  v3: "address feeTier",
  v4: "poolId feeTier tickSpacing isDynamicFee hook { address }",
};
const roots = { v2: "v2Pair", v3: "v3Pool", v4: "v4Pool" };
async function query(
  query: string,
  variables: Record<string, unknown>,
  fetcher: typeof fetch,
) {
  const response = await fetcher(UNISWAP_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.uniswap.org",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw new ServiceError(
      "uniswap_data_unavailable",
      `Uniswap data API returned HTTP ${response.status}`,
    );
  const result = (await response.json()) as {
    data?: unknown;
    errors?: { message: string; path?: (string | number)[] }[];
  };
  if (!result.data)
    throw new ServiceError(
      "uniswap_data_unavailable",
      "Uniswap data API returned errors or no data",
    );
  return {
    source: UNISWAP_GRAPHQL_URL,
    fetched_at: new Date().toISOString(),
    indexed_data: true,
    partial: !!result.errors?.length,
    errors: result.errors ?? [],
    data: enrichData(result.data),
  };
}
export function discoverUniswapPools(
  raw: z.input<typeof discoverySchema>,
  fetcher = fetch,
) {
  const input = discoverySchema.parse(raw);
  const root = { v2: "topV2Pairs", v3: "topV3Pools", v4: "topV4Pools" }[
    input.version
  ];
  return query(
    `query Pools($chain: Chain!, $first: Int!, $token: String, $cursor: Float) { ${root}(chain: $chain, first: $first, tokenFilter: $token, tvlCursor: $cursor) { ${commonFields} ${versionFields[input.version]} } }`,
    {
      chain: chainNames[input.chain_id],
      first: input.first,
      token: input.token_address,
      cursor: input.tvl_cursor,
    },
    fetcher,
  );
}
function poolQuery(
  input: z.infer<typeof poolSchema>,
  fields: string,
  duration?: string,
) {
  const expected = input.version === "v4" ? 66 : 42;
  if (input.pool.length !== expected)
    throw new ServiceError(
      "invalid_uniswap_pool",
      "V4 requires a bytes32 pool ID; V2/V3 require a pool address",
    );
  const arg = input.version === "v4" ? "poolId" : "address";
  return {
    query: `query Pool($chain: Chain!, $pool: String!${duration ? ", $duration: HistoryDuration!" : ""}) { ${roots[input.version]}(chain: $chain, ${arg}: $pool) { ${fields} } }`,
    variables: {
      chain: chainNames[input.chain_id],
      pool: input.pool,
      ...(duration ? { duration } : {}),
    },
  };
}
export function getUniswapPool(
  raw: z.input<typeof poolSchema>,
  fetcher = fetch,
) {
  const input = poolSchema.parse(raw);
  const q = poolQuery(
    input,
    `${commonFields} ${versionFields[input.version]} token0Supply token1Supply`,
  );
  return query(q.query, q.variables, fetcher);
}
export function getUniswapCharts(
  raw: z.input<typeof chartsSchema>,
  fetcher = fetch,
) {
  const input = chartsSchema.parse(raw);
  const q = poolQuery(
    input,
    "id priceHistory(duration: $duration) { timestamp token0Price token1Price } historicalVolume(duration: $duration) { timestamp value }",
    input.duration,
  );
  return query(q.query, q.variables, fetcher);
}

// The API can report total swap fees in feeTier. Only expose a usable pool
// key when its hash proves it identifies the returned pool, never by rounding
// a display fee or assuming a popular tier.
function enrichData(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(enrichData);
  if (!data || typeof data !== "object") return data;
  const row = data as Record<string, unknown>;
  if (typeof row.poolId === "string")
    return {
      ...row,
      pool_key: resolvePoolKey(row),
      fee_tier_is_display_data: true,
    };
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, enrichData(v)]),
  );
}
function resolvePoolKey(row: Record<string, unknown>) {
  const key = indexedKey(row);
  if (!key) return null;
  const candidates = [
    Number(row.feeTier),
    100,
    500,
    3000,
    10000,
    1000,
    2000,
    2500,
    8388608,
  ];
  for (const fee of candidates) {
    if (!Number.isInteger(fee) || fee < 0 || fee > 8388608) continue;
    if (v4PoolId({ ...key, fee }) === String(row.poolId).toLowerCase())
      return { ...key, fee, pool_id: row.poolId };
  }
  return null;
}
function indexedKey(row: Record<string, unknown>) {
  const t0 = row.token0 as { address?: string | null } | undefined;
  const t1 = row.token1 as { address?: string | null } | undefined;
  const hook = row.hook as { address?: string } | null;
  if (!t0 || !t1?.address || typeof row.tickSpacing !== "number") return null;
  return {
    token0: getAddress(t0.address ?? zeroAddress),
    token1: getAddress(t1.address),
    tick_spacing: row.tickSpacing,
    hooks: getAddress(hook?.address ?? zeroAddress),
  };
}

export const ticksDataSchema = poolSchema.extend({
  version: z.enum(["v3", "v4"]),
  first: z.number().int().min(1).max(1000).default(100),
  skip: z.number().int().min(0).max(100000).default(0),
});
export function getUniswapPoolTicks(
  raw: z.input<typeof ticksDataSchema>,
  fetcher = fetch,
) {
  const input = ticksDataSchema.parse(raw);
  // first/skip are bounded integers parsed above, never arbitrary query text.
  const q = poolQuery(
    input,
    `id ticks(first: ${input.first}, skip: ${input.skip}) { tickIdx liquidityGross liquidityNet price0 price1 }`,
  );
  return query(q.query, q.variables, fetcher);
}
