import {
  decodeEvmPoolConfig,
  deriveEvmPoolId,
  encodeEvmConcentratedPoolConfig,
  encodeEvmStableswapPoolConfig,
} from "@ekubo/sdk";
import {
  type Address,
  getAddress,
  type Hex,
  keccak256,
  numberToHex,
} from "viem";
import { type Env, ServiceError } from "./core.js";

export interface PoolKeyInput {
  token0: string;
  token1: string;
  config?: Hex;
  fee?: string;
  tickSpacing?: number | string | null;
  extension?: string;
  stableswapParams?: {
    centerTick: number;
    amplification: number;
  } | null;
}

type Fetcher = typeof fetch;

const UINT64_MAX = (1n << 64n) - 1n;
const EVM_MAX_TICK_SPACING = 698_605n;

export function canonicalChainId(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ServiceError(
        "invalid_input",
        "chain_id as a JSON number must be a positive safe integer",
      );
    }
    return value.toString();
  }
  if (!/^(?:[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value)) {
    throw new ServiceError(
      "invalid_input",
      "chain_id must be a positive decimal or hexadecimal integer",
    );
  }
  const parsed = BigInt(value);
  if (parsed < 1n) {
    throw new ServiceError("invalid_input", "chain_id must be positive");
  }
  return parsed.toString();
}

export function decodePoolConfig(config: Hex) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(config)) {
    throw new ServiceError(
      "invalid_pool_config",
      "config must be exactly 32 bytes",
    );
  }
  let decoded: ReturnType<typeof decodeEvmPoolConfig>;
  try {
    decoded = decodeEvmPoolConfig(config);
  } catch (error) {
    throw new ServiceError(
      "invalid_pool_config",
      error instanceof Error ? error.message : String(error),
    );
  }
  const common = {
    config: decoded.config,
    extension: normalizeAddress(decoded.extension),
    fee: decoded.fee.toString(),
    fee_hex: numberToHex(decoded.fee, { size: 8 }),
    type_config: decoded.typeConfig,
    exact_integer_note:
      "fee is a uint64 Q64 value and is intentionally serialized as a decimal string and exact hex, never a JSON number",
  };
  if (decoded.poolType === "concentrated") {
    return {
      ...common,
      pool_type: "concentrated" as const,
      discriminator_bit_set: true,
      tick_spacing: decoded.tickSpacing,
      stableswap_params: null,
    };
  }
  return {
    ...common,
    pool_type: decoded.poolType,
    discriminator_bit_set: false,
    tick_spacing: null,
    stableswap_params: {
      center_tick: decoded.stableswapParams.centerTick,
      amplification: decoded.stableswapParams.amplification,
    },
  };
}

export function derivePoolId(input: PoolKeyInput) {
  const token0 = normalizeAddress(input.token0);
  const token1 = normalizeAddress(input.token1);
  if (BigInt(token0) >= BigInt(token1)) {
    throw new ServiceError(
      "invalid_pool_key",
      "pool_key.token0 must be numerically less than pool_key.token1",
    );
  }
  const config = input.config ?? encodePoolConfig(input);
  const decoded = decodePoolConfig(config);
  const poolId = deriveEvmPoolId({ token0, token1, config }, keccak256);
  return {
    pool_id: poolId,
    pool_id_decimal: BigInt(poolId).toString(),
    pool_key: { token0, token1, config },
    decoded_config: decoded,
  };
}

export async function getPositionsByOwner(
  env: Env,
  input: {
    owner: string;
    chainId?: string;
    state?: "opened" | "closed";
    pageSize: number;
    page: number;
  },
  fetcher: Fetcher = fetch,
) {
  const owner = normalizeAddress(input.owner);
  const url = new URL(
    `/positions/${encodeURIComponent(owner)}`,
    normalizedBase(env.EKUBO_API_URL),
  );
  if (input.chainId !== undefined) url.searchParams.set("chainId", input.chainId);
  if (input.state !== undefined) url.searchParams.set("state", input.state);
  url.searchParams.set("pageSize", input.pageSize.toString());
  url.searchParams.set("page", input.page.toString());
  const response = await fetchJson<Record<string, unknown>>(url, fetcher);
  if (!Array.isArray(response.data) || !isRecord(response.pagination)) {
    throw new ServiceError(
      "invalid_upstream_response",
      "Position ownership response must contain data and pagination",
    );
  }
  return {
    owner,
    chain_id: input.chainId ?? null,
    state: input.state ?? "all",
    positions: normalizeChainIdFields(response.data),
    pagination: response.pagination,
    cache: {
      mcp_result_storage: "none",
      upstream_cache_control: "no-cache",
    },
  };
}

export async function getPool(
  env: Env,
  input: { chainId: string; coreAddress: string; poolId: string },
  fetcher: Fetcher = fetch,
) {
  const coreAddress = normalizeAddress(input.coreAddress);
  const poolIdValue = unsigned(input.poolId, "pool_id");
  const poolId = numberToHex(poolIdValue, { size: 32 });
  const base = normalizedBase(env.EKUBO_API_URL);
  const path = `/pools/${encodeURIComponent(input.chainId)}/${encodeURIComponent(coreAddress)}/${encodeURIComponent(poolId)}`;
  const [keyResponse, positionsResponse] = await Promise.all([
    fetchJson<Record<string, unknown>>(new URL(`${path}/key`, base), fetcher),
    fetchJson<Record<string, unknown>>(
      new URL(`${path}/positions?limit=1`, base),
      fetcher,
    ),
  ]);
  if (!isRecord(keyResponse.pool_key)) {
    throw new ServiceError(
      "invalid_upstream_response",
      "Pool key response is missing pool_key",
    );
  }
  const key = poolKeyFromApi(keyResponse.pool_key);
  const derived = derivePoolId(key);
  if (BigInt(derived.pool_id) !== poolIdValue) {
    throw new ServiceError(
      "invalid_upstream_response",
      "Indexed pool key does not derive to the requested pool_id",
      { requested_pool_id: poolId, derived_pool_id: derived.pool_id },
    );
  }
  const positions = Array.isArray(positionsResponse.data)
    ? positionsResponse.data
    : [];
  const firstPosition = positions[0];
  const poolState = isRecord(firstPosition) && isRecord(firstPosition.pool_state)
    ? firstPosition.pool_state
    : null;
  return {
    chain_id: input.chainId,
    core_address: coreAddress,
    pool_id: poolId,
    pool_id_decimal: poolIdValue.toString(),
    pool_key: derived.pool_key,
    decoded_config: derived.decoded_config,
    pool_state: poolState,
    pool_state_note:
      poolState === null
        ? "No indexed position was available to supply the pool-state snapshot"
        : "Indexed snapshot returned with the pool's largest position",
    cache: {
      mcp_result_storage: "none",
      pool_key_upstream_max_age_seconds: 1800,
      pool_state_upstream_max_age_seconds: 180,
    },
  };
}

export async function getPoolLiquidity(
  env: Env,
  input: { chainId: string; coreAddress: string; poolId: string },
  fetcher: Fetcher = fetch,
) {
  const coreAddress = normalizeAddress(input.coreAddress);
  const poolIdValue = unsigned(input.poolId, "pool_id");
  const poolId = numberToHex(poolIdValue, { size: 32 });
  const url = new URL(
    `/pools/${encodeURIComponent(input.chainId)}/${encodeURIComponent(coreAddress)}/${encodeURIComponent(poolId)}/liquidity`,
    normalizedBase(env.EKUBO_API_URL),
  );
  const response = await fetchJson<Record<string, unknown>>(url, fetcher);
  if (!Array.isArray(response.data)) {
    throw new ServiceError(
      "invalid_upstream_response",
      "Pool liquidity response is missing data",
    );
  }
  return {
    chain_id: input.chainId,
    core_address: coreAddress,
    pool_id: poolId,
    pool_id_decimal: poolIdValue.toString(),
    liquidity_deltas: response.data,
    interpretation:
      "Apply net_liquidity_delta_diff cumulatively in ascending tick order to reconstruct active liquidity depth",
    cache: {
      mcp_result_storage: "none",
      upstream_max_age_seconds: 1800,
      upstream_must_revalidate: true,
    },
  };
}

export function normalizeChainIdFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeChainIdFields(entry)) as T;
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "chain_id" &&
      (typeof entry === "string" || typeof entry === "number")
        ? canonicalChainId(entry)
        : normalizeChainIdFields(entry),
    ]),
  ) as T;
}

function encodePoolConfig(input: PoolKeyInput): Hex {
  if (input.fee === undefined || input.extension === undefined) {
    throw new ServiceError(
      "invalid_pool_key",
      "pool_key requires config, or fee, extension, and one pool type",
    );
  }
  const fee = unsigned(input.fee, "pool_key.fee");
  if (fee > UINT64_MAX) {
    throw new ServiceError("invalid_pool_key", "pool_key.fee exceeds uint64");
  }
  const extension = normalizeAddress(input.extension);
  if (input.stableswapParams !== undefined && input.stableswapParams !== null) {
    if (input.tickSpacing !== undefined && input.tickSpacing !== null) {
      throw new ServiceError(
        "invalid_pool_key",
        "provide tick_spacing or stableswap_params, not both",
      );
    }
    const { amplification, centerTick } = input.stableswapParams;
    if (!Number.isInteger(amplification) || amplification < 0 || amplification > 26) {
      throw new ServiceError(
        "invalid_pool_key",
        "stableswap amplification must be an integer from 0 to 26",
      );
    }
    if (!Number.isInteger(centerTick) || centerTick % 16 !== 0) {
      throw new ServiceError(
        "invalid_pool_key",
        "stableswap center_tick must be an integer multiple of 16",
      );
    }
    const encodedCenter = centerTick / 16;
    if (encodedCenter < -(1 << 23) || encodedCenter > (1 << 23) - 1) {
      throw new ServiceError(
        "invalid_pool_key",
        "stableswap center_tick does not fit signed 24 bits after scaling",
      );
    }
    return encodeEvmStableswapPoolConfig({
      fee,
      centerTick,
      amplification,
      extension,
    });
  } else {
    if (input.tickSpacing === undefined || input.tickSpacing === null) {
      throw new ServiceError(
        "invalid_pool_key",
        "concentrated pools require tick_spacing; full-range pools require stableswap_params with zero values",
      );
    }
    const spacing = unsigned(input.tickSpacing, "pool_key.tick_spacing");
    if (spacing < 1n || spacing > EVM_MAX_TICK_SPACING) {
      throw new ServiceError(
        "invalid_pool_key",
        "concentrated tick_spacing must be between 1 and 698605",
      );
    }
    return encodeEvmConcentratedPoolConfig({
      fee,
      tickSpacing: Number(spacing),
      extension,
    });
  }
}

function poolKeyFromApi(poolKey: Record<string, unknown>): PoolKeyInput {
  if (
    typeof poolKey.token0 !== "string" ||
    typeof poolKey.token1 !== "string" ||
    typeof poolKey.fee !== "string" ||
    typeof poolKey.extension !== "string"
  ) {
    throw new ServiceError(
      "invalid_upstream_response",
      "Pool key has invalid token, fee, or extension fields",
    );
  }
  const stable = poolKey.stableswap_params;
  return {
    token0: poolKey.token0,
    token1: poolKey.token1,
    fee: poolKey.fee,
    extension: poolKey.extension,
    tickSpacing:
      typeof poolKey.tick_spacing === "string" ? poolKey.tick_spacing : null,
    stableswapParams: isRecord(stable) &&
      typeof stable.center_tick === "number" &&
      typeof stable.amplification === "number"
      ? {
          centerTick: stable.center_tick,
          amplification: stable.amplification,
        }
      : stable === null
        ? null
        : undefined,
  };
}

function normalizeAddress(value: string): Address {
  try {
    return getAddress(numberToHex(BigInt(value), { size: 20 }));
  } catch {
    throw new ServiceError(
      "invalid_address",
      `address must fit in 20 bytes: ${value}`,
    );
  }
}

function unsigned(value: string | number, label: string): bigint {
  if (
    (typeof value === "string" &&
      !/^(?:(?:0|[1-9][0-9]*)|0x[0-9a-fA-F]+)$/.test(value)) ||
    (typeof value === "number" &&
      (!Number.isSafeInteger(value) || value < 0))
  ) {
    throw new ServiceError(
      "invalid_input",
      `${label} must be an unsigned decimal or hexadecimal integer`,
    );
  }
  return BigInt(value);
}

async function fetchJson<T>(url: URL, fetcher: Fetcher): Promise<T> {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new ServiceError(
      "invalid_upstream_response",
      `Upstream returned non-JSON content from ${url}`,
    );
  }
  if (!response.ok) {
    throw new ServiceError(
      "upstream_error",
      `${response.status} ${response.statusText} from ${url}`,
      body,
    );
  }
  return body as T;
}

function normalizedBase(url: string): string {
  return `${url.replace(/\/+$/, "")}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
