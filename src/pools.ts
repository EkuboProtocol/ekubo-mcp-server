import {
  decodeEvmPoolConfig,
  deriveEvmPoolId,
  encodeEvmConcentratedPoolConfig,
  encodeEvmStableswapPoolConfig,
} from "@ekubo/sdk";
import {
  type Abi,
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
  keccak256,
  numberToHex,
} from "viem";
import {
  functionResultDecodePlan,
  sqrtRatioFloatSemanticCodec,
} from "./abi-decode.js";
import {
  coreDataFetcherContract,
  poolKeyIndexContract,
} from "./contracts.js";
import { type Env, getTokens, ServiceError } from "./core.js";
import {
  buildPositionStateReadPlan,
  type IndexedPosition,
  positionTokenIdentifiers,
} from "./position-state.js";
import { assertWalletBatchEthCallInput } from "./wallet-compatibility.js";

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
const V2_CORE_ADDRESS = getAddress(
  "0xe0e0e08A6A4b9Dc7bD67BCB7aadE5cF48157d444",
);
const V3_CORE_ADDRESS = getAddress(
  "0x00000000000014aA86C5d3c41765bb24e11bd701",
);
const V2_POSITIONS_ADDRESS = getAddress(
  "0xA37cc341634AFD9E0919D334606E676dbAb63E17",
);
const V3_POSITIONS_ADDRESS = getAddress(
  "0x02D9876A21AF7545f8632C3af76eC90b5ad4b66D",
);
const VE33_POSITIONS_ADDRESS = getAddress(
  "0xdA38ac72CE7220c4dd7719d114ef94eDadb8f068",
);
const VE33_EXTENSION_ADDRESS = getAddress(
  "0xD18685a514E59b06d59824e16Db07e73345d9953",
);

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
  const positions = normalizeChainIdFields(response.data);
  const readablePositions = positions.filter(isIndexedPosition);
  const tokenIdentifiers = uniqueTokenIdentifiers(
    readablePositions.flatMap(positionTokenIdentifiers),
  );
  const tokens =
    tokenIdentifiers.length === 0
      ? []
      : await getTokens(env, { tokens: tokenIdentifiers }, fetcher);
  const readPlans = new Map(
    readablePositions.map((position) => [
      positionIdentity(position),
      buildPositionStateReadPlan(position, owner),
    ]),
  );
  // Every position of the same manager version produces a byte-identical
  // decode plan and identical read semantics. Inlining them per position made
  // this response grow by several kilobytes per position while carrying no
  // additional information, so they are emitted once and referenced.
  const sharedDecodePlans = new Map<string, unknown>();
  const sharedSemantics = new Map<string, unknown>();
  const dedupe = (
    store: Map<string, unknown>,
    prefix: string,
    value: unknown,
  ) => {
    const serialized = JSON.stringify(value);
    for (const [key, existing] of store) {
      if (JSON.stringify(existing) === serialized) return key;
    }
    const key = `${prefix}_${store.size + 1}`;
    store.set(key, value);
    return key;
  };
  const compactPlan = (plan: ReturnType<typeof buildPositionStateReadPlan>) => {
    if (plan.available !== true) return plan;
    const {
      local_decode_plan: localDecodePlan,
      semantics,
      ...rest
    } = plan;
    return {
      ...rest,
      local_decode_plan_ref: dedupe(
        sharedDecodePlans,
        "decode_plan",
        localDecodePlan,
      ),
      semantics_ref: dedupe(sharedSemantics, "semantics", semantics),
    };
  };
  return {
    owner,
    chain_id: input.chainId ?? null,
    state: input.state ?? "all",
    positions: positions.map((position) =>
      isIndexedPosition(position)
        ? {
            ...position,
            current_state_query: compactPlan(
              readPlans.get(positionIdentity(position))!,
            ),
          }
        : position,
    ),
    shared_decode_plans: Object.fromEntries(sharedDecodePlans),
    shared_read_semantics: Object.fromEntries(sharedSemantics),
    shared_reference_note:
      "Each current_state_query names its decode plan and read semantics instead of repeating them. Resolve local_decode_plan_ref against shared_decode_plans and pass the resolved plan to the wallet unchanged; resolve semantics_ref against shared_read_semantics.",
    tokens,
    token_metadata_note:
      "Canonical token metadata and current USD prices used by the Ekubo interface. Join by canonical chain_id and numeric address; usd_price may be null.",
    current_state_note:
      "Indexed liquidity and pool_state are discovery snapshots. Execute and decode each available current_state_query locally, resolving local_decode_plan_ref against shared_decode_plans and following its result_decoder. Require every inner call to succeed, retain raw eth_call return data, and compare the decoded owner with expected_owner before using pending principal, fees or Ve33 rewards.",
    pagination: response.pagination,
    cache: {
      mcp_result_storage: "none",
      upstream_cache_control: "no-cache",
    },
  };
}

function isIndexedPosition(value: unknown): value is IndexedPosition {
  if (!isRecord(value)) return false;
  const poolKey = value.pool_key;
  const bounds = value.bounds;
  return (
    (typeof value.chain_id === "string" || typeof value.chain_id === "number") &&
    typeof value.id === "string" &&
    typeof value.positions_address === "string" &&
    isRecord(poolKey) &&
    typeof poolKey.token0 === "string" &&
    typeof poolKey.token1 === "string" &&
    typeof poolKey.fee === "string" &&
    typeof poolKey.extension === "string" &&
    isRecord(bounds) &&
    typeof bounds.lower === "number" &&
    typeof bounds.upper === "number"
  );
}

function positionIdentity(position: IndexedPosition) {
  return `${BigInt(position.chain_id)}:${BigInt(position.positions_address)}:${BigInt(position.id)}`;
}

function uniqueTokenIdentifiers(
  tokens: { chainId: string; address: string }[],
) {
  const seen = new Set<string>();
  return tokens.filter((token) => {
    const key = `${BigInt(token.chainId)}:${BigInt(token.address)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Build the fresh on-chain pool-state read as an exact wallet_batch_eth_call
 * argument object. The registerTool wrapper's structural walk stores any
 * property named `read_calls` in KV and replaces it with a
 * read_calls_reference, so the wallet fetches and executes the stored bundle
 * verbatim and the agent never reassembles calldata or ABIs.
 */
export function buildPoolStateReadBundle(input: {
  chainId: string;
  poolId: Hex;
  poolKey: { token0: Address; token1: Address; config: Hex };
}) {
  const dataFetcher = coreDataFetcherContract(input.chainId);
  if (dataFetcher === undefined) return null;
  const poolStateAbi = (dataFetcher.abi as Abi).filter(
    (entry) => entry.type === "function" && entry.name === "poolState",
  );
  if (poolStateAbi.length !== 1) return null;
  const data = encodeFunctionData({
    abi: poolStateAbi,
    functionName: "poolState",
    args: [input.poolKey],
  });
  const readCalls = {
    chain_id: input.chainId,
    block_parameter: "pending",
    calls: [
      {
        id: `ekubo-pool-state-${input.chainId}-${input.poolId}`,
        to: dataFetcher.address,
        data,
        include_raw: true,
        decode: functionResultDecodePlan(poolStateAbi, "poolState", {
          semanticCodecs: [sqrtRatioFloatSemanticCodec("sqrtRatio")],
        }),
      },
    ],
  };
  // Fail closed at build time: the bundle must already be a valid wallet
  // argument object, or it must never leave this server.
  assertWalletBatchEthCallInput(readCalls);
  return {
    available: true as const,
    contract: {
      address: dataFetcher.address,
      name: "CoreDataFetcher",
      function_name: "poolState",
      resource_uri: dataFetcher.resourceUri,
    },
    block_parameter: "pending" as const,
    read_calls: readCalls,
    result_semantics: {
      sqrtRatio:
        "uint96 SqrtRatio float; the attached semantic codec yields the canonical Q128 fixed value",
      tick: "int32 current pool tick",
      liquidity: "uint128 currently active liquidity as a decimal string",
    },
    instruction:
      "Hand read_calls_reference to wallet_batch_eth_call (read_calls_url as calls_url, content_keccak256 as expected_content_keccak256, same chain_id, no inline calls) and prefer its decoded values over the indexed pool_state snapshot. Never broadcast this read-only call.",
  };
}

export async function getPool(
  env: Env,
  input: { chainId: string; coreAddress: string; poolId: string },
  fetcher: Fetcher = fetch,
) {
  const coreAddress = normalizeAddress(input.coreAddress);
  const generation = coreGeneration(coreAddress);
  if (generation === "unknown") {
    throw new ServiceError(
      "unsupported_core",
      "This tool supports the v2 and v3 Ekubo Core deployments only",
      { chain_id: input.chainId, core_address: coreAddress },
    );
  }
  const poolIdValue = unsigned(input.poolId, "pool_id");
  const poolId = numberToHex(poolIdValue, { size: 32 });
  const base = normalizedBase(env.EKUBO_API_URL);
  const response = await fetchJson<Record<string, unknown>>(
    new URL(
      `/poolKeys/${encodeURIComponent(input.chainId)}/${encodeURIComponent(coreAddress)}/${encodeURIComponent(poolId)}`,
      base,
    ),
    fetcher,
  );
  if (!isRecord(response.pool_key)) {
    throw new ServiceError(
      "invalid_upstream_response",
      "Pool key response is missing pool_key",
    );
  }
  const key = poolKeyFromApi(response.pool_key);
  const token0 = normalizeAddress(key.token0);
  const token1 = normalizeAddress(key.token1);
  const config =
    generation === "v3" ? encodePoolConfig(key) : encodeV2PoolConfig(key);
  const derivedPoolId = derivePoolIdFromConfig(token0, token1, config);
  if (BigInt(derivedPoolId) !== poolIdValue) {
    throw new ServiceError(
      "invalid_upstream_response",
      "Indexed pool key does not derive to the requested pool_id",
      { requested_pool_id: poolId, derived_pool_id: derivedPoolId },
    );
  }
  const poolKey = { token0, token1, config };
  const poolState = isRecord(response.state) ? response.state : null;
  const currentStateQuery =
    generation === "v3"
      ? (buildPoolStateReadBundle({
          chainId: input.chainId,
          poolId,
          poolKey,
        }) ?? {
          available: false as const,
          reason:
            "No CoreDataFetcher deployment is cataloged for this chain; pool_state is the indexed snapshot",
        })
      : {
          available: false as const,
          reason:
            "CoreDataFetcher reads the v3 Core only; pool_state is the indexed snapshot",
        };
  return {
    chain_id: input.chainId,
    core_address: coreAddress,
    core_generation: generation,
    pool_id: poolId,
    pool_id_decimal: poolIdValue.toString(),
    pool_key: poolKey,
    decoded_config: decodedConfigForGeneration(generation, key, config),
    pool_state: poolState,
    pool_state_note:
      poolState === null
        ? "No indexed state snapshot is available for this pool yet; use current_state_query for fresh on-chain state"
        : "Indexed snapshot from the pool-key row; execute current_state_query through the wallet for fresh on-chain state",
    current_state_query: currentStateQuery,
    cache: {
      mcp_result_storage: "none",
      pool_key_upstream_max_age_seconds: 1800,
      pool_state_upstream_max_age_seconds: 180,
    },
  };
}

export async function listPoolKeys(
  env: Env,
  input: {
    chainId: string;
    coreAddress: string;
    tokenA?: string;
    tokenB?: string;
    extension?: string;
    pageSize: number;
    afterPoolId?: string;
    includeState: boolean;
  },
  fetcher: Fetcher = fetch,
) {
  const coreAddress = normalizeAddress(input.coreAddress);
  const generation = coreGeneration(coreAddress);
  if (generation === "unknown") {
    throw new ServiceError(
      "unsupported_core",
      "Pool key discovery supports the v2 and v3 Ekubo Core deployments only",
      { chain_id: input.chainId, core_address: coreAddress },
    );
  }
  const tokenA =
    input.tokenA === undefined ? undefined : normalizeAddress(input.tokenA);
  const tokenB =
    input.tokenB === undefined ? undefined : normalizeAddress(input.tokenB);
  if (tokenA !== undefined && tokenA === tokenB) {
    throw new ServiceError(
      "invalid_pair",
      "token_a and token_b must be different tokens",
    );
  }
  const extensionFilter =
    input.extension === undefined
      ? undefined
      : normalizeAddress(input.extension);
  const afterPoolId =
    input.afterPoolId === undefined
      ? undefined
      : numberToHex(unsigned(input.afterPoolId, "after_pool_id"), {
          size: 32,
        });
  const url = new URL(
    `/poolKeys/${encodeURIComponent(input.chainId)}/${encodeURIComponent(coreAddress)}`,
    normalizedBase(env.EKUBO_API_URL),
  );
  if (tokenA !== undefined) url.searchParams.set("tokenA", tokenA);
  if (tokenB !== undefined) url.searchParams.set("tokenB", tokenB);
  if (extensionFilter !== undefined) {
    url.searchParams.set("extension", extensionFilter);
  }
  if (afterPoolId !== undefined) url.searchParams.set("after", afterPoolId);
  url.searchParams.set("limit", input.pageSize.toString());
  url.searchParams.set("includeState", input.includeState ? "true" : "false");
  const response = await fetchJson<Record<string, unknown>>(url, fetcher);
  if (
    !Array.isArray(response.pools) ||
    typeof response.has_more !== "boolean" ||
    (response.next_cursor !== null && typeof response.next_cursor !== "string")
  ) {
    throw new ServiceError(
      "invalid_upstream_response",
      "Pool key listing must contain pools, next_cursor, and has_more",
    );
  }
  const pools = response.pools.map((entry, index) =>
    normalizeListedPool(input.chainId, generation, entry, index),
  );
  const onchainIndex = poolKeyIndexContract(input.chainId);
  return {
    chain_id: input.chainId,
    core_address: coreAddress,
    core_generation: generation,
    filters: {
      token_a: tokenA ?? null,
      token_b: tokenB ?? null,
      extension: extensionFilter ?? null,
    },
    pools,
    page: {
      page_size: input.pageSize,
      after_pool_id: afterPoolId ?? null,
      next_after_pool_id:
        typeof response.next_cursor === "string" ? response.next_cursor : null,
      has_more: response.has_more,
    },
    pagination_note:
      "Pools are ordered by ascending pool_id. Pass next_after_pool_id as after_pool_id to fetch the next page; pool ids are keccak hashes, so a newly initialized pool can land inside an already-fetched range within the upstream cache window.",
    onchain_index:
      onchainIndex === undefined
        ? null
        : {
            address: onchainIndex.address,
            contract: "PoolKeyIndex",
            resource_uri: onchainIndex.resourceUri,
            verification_functions: [
              "isRegistered",
              "poolKeyById",
              "getPoolKeysByToken",
              "getPoolKeysByExtension",
            ],
            note: "Optional on-chain registry for spot verification. Registration is opt-in, so it is not guaranteed complete; every returned pool_id above was already re-derived locally from its pool key, which is the stronger integrity check.",
          },
    cache: {
      mcp_result_storage: "none",
      upstream_max_age_seconds: 1800,
    },
  };
}

function normalizeListedPool(
  chainId: string,
  generation: "v2" | "v3",
  value: unknown,
  index: number,
) {
  if (!isRecord(value) || typeof value.pool_id !== "string") {
    throw new ServiceError(
      "invalid_upstream_response",
      `Pool key listing entry ${index} is malformed`,
    );
  }
  if (!isRecord(value.pool_key)) {
    throw new ServiceError(
      "invalid_upstream_response",
      `Pool key listing entry ${index} is missing pool_key`,
    );
  }
  const key = poolKeyFromApi(value.pool_key);
  const token0 = normalizeAddress(key.token0);
  const token1 = normalizeAddress(key.token1);
  if (BigInt(token0) >= BigInt(token1)) {
    throw new ServiceError(
      "invalid_upstream_response",
      `Pool key listing entry ${index} has unsorted tokens`,
    );
  }
  const config =
    generation === "v3" ? encodePoolConfig(key) : encodeV2PoolConfig(key);
  const poolId = derivePoolIdFromConfig(token0, token1, config);
  const indexedPoolId = unsigned(value.pool_id, "indexed pool_id");
  if (BigInt(poolId) !== indexedPoolId) {
    throw new ServiceError(
      "invalid_upstream_response",
      `Pool key listing entry ${index} does not derive to its indexed pool_id`,
      { indexed_pool_id: value.pool_id, derived_pool_id: poolId },
    );
  }
  const extension = normalizeAddress(key.extension ?? "0x0");
  return {
    pool_id: poolId,
    pool_id_decimal: indexedPoolId.toString(),
    pool_key: { token0, token1, config },
    decoded_config: decodedConfigForGeneration(generation, key, config),
    pool_type:
      key.stableswapParams === null || key.stableswapParams === undefined
        ? ("concentrated" as const)
        : ("stableswap" as const),
    extension: {
      address: extension,
      type: extensionType(generation, extension),
      resource_uri:
        BigInt(extension) === 0n
          ? null
          : `ekubo://contracts/evm/${chainId}/${extension}`,
    },
    indexed_state: isRecord(value.state) ? value.state : null,
  };
}

function coreGeneration(coreAddress: Address): "v2" | "v3" | "unknown" {
  return coreAddress === V3_CORE_ADDRESS
    ? "v3"
    : coreAddress === V2_CORE_ADDRESS
      ? "v2"
      : "unknown";
}

function decodedConfigForGeneration(
  generation: "v2" | "v3",
  key: PoolKeyInput,
  config: Hex,
) {
  if (generation === "v3") return decodePoolConfig(config);
  const stableswapParams = key.stableswapParams ?? null;
  return {
    config,
    version: "v2" as const,
    extension: normalizeAddress(key.extension ?? "0x0"),
    fee: unsigned(key.fee ?? 0, "pool fee").toString(),
    tick_spacing:
      stableswapParams === null
        ? Number(unsigned(key.tickSpacing ?? 0, "tick_spacing"))
        : null,
    stableswap_params:
      stableswapParams === null
        ? null
        : {
            center_tick: stableswapParams.centerTick,
            amplification: stableswapParams.amplification,
          },
    exact_integer_note:
      "fee is a uint64 Q64 value and is intentionally serialized as a decimal string, never a JSON number",
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

export async function getPositionPoolCandidates(
  env: Env,
  input: {
    chainId: string;
    tokenA: string;
    tokenB: string;
    minTvlUsd: number;
    coreAddress?: string;
    extension?: string;
    poolType?: "concentrated" | "stableswap";
  },
  fetcher: Fetcher = fetch,
) {
  const tokenA = normalizeAddress(input.tokenA);
  const tokenB = normalizeAddress(input.tokenB);
  if (tokenA === tokenB) {
    throw new ServiceError(
      "invalid_pair",
      "Position pool discovery requires two different tokens",
    );
  }
  const [token0, token1] =
    BigInt(tokenA) < BigInt(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA];
  const coreFilter =
    input.coreAddress === undefined
      ? undefined
      : normalizeAddress(input.coreAddress);
  const extensionFilter =
    input.extension === undefined
      ? undefined
      : normalizeAddress(input.extension);
  const url = new URL(
    `/pair/${encodeURIComponent(input.chainId)}/${encodeURIComponent(token0)}/${encodeURIComponent(token1)}/pools`,
    normalizedBase(env.EKUBO_API_URL),
  );
  url.searchParams.set("minTvlUsd", input.minTvlUsd.toString());
  const response = await fetchJson<Record<string, unknown>>(url, fetcher);
  if (!Array.isArray(response.topPools)) {
    throw new ServiceError(
      "invalid_upstream_response",
      "Pair pool response is missing topPools",
    );
  }

  const candidates = response.topPools
    .map((entry, index) =>
      normalizePoolCandidate(input.chainId, token0, token1, entry, index),
    )
    .filter(
      (candidate) =>
        (coreFilter === undefined || candidate.core_address === coreFilter) &&
        (extensionFilter === undefined ||
          candidate.extension.address === extensionFilter) &&
        (input.poolType === undefined || candidate.pool_type === input.poolType),
    );
  const tokens = await getTokens(
    env,
    {
      tokens: [
        { chainId: input.chainId, address: token0 },
        { chainId: input.chainId, address: token1 },
      ],
    },
    fetcher,
  );

  return {
    chain_id: input.chainId,
    pair: { token0, token1 },
    tokens,
    filters: {
      min_tvl_usd: input.minTvlUsd,
      core_address: coreFilter ?? null,
      extension: extensionFilter ?? null,
      pool_type: input.poolType ?? null,
    },
    candidates,
    candidate_count: candidates.length,
    selection_guidance: {
      ranking:
        "Candidates preserve the data API ordering. Compare exact 24-hour volume, fees, TVL, depth, pool type, and extension; do not choose by fee alone.",
      initialized_only:
        "Every returned row is an indexed existing pool. min_tvl_usd defaults to zero so initialized pools with negligible liquidity remain discoverable.",
      position_manager:
        "Use each candidate's position_manager when constructing a position. Ve33 pools use Ve33Positions; ordinary v3 pools use Positions; legacy v2 pools use the v2 Positions manager.",
      exact_pool_key:
        "Use pool_key.config verbatim. pool_id was independently re-derived and checked against the indexed row.",
    },
    sources: {
      pair_pools: url.toString(),
      token_metadata: `${normalizedBase(env.EKUBO_API_URL)}tokens/batch`,
    },
    cache: {
      mcp_result_storage: "none",
      upstream_max_age_seconds: 180,
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

function normalizePoolCandidate(
  chainId: string,
  token0: Address,
  token1: Address,
  value: unknown,
  index: number,
) {
  if (!isRecord(value)) {
    throw new ServiceError(
      "invalid_upstream_response",
      `Pair pool candidate ${index} is not an object`,
    );
  }
  if (
    typeof value.pool_id !== "string" ||
    typeof value.core_address !== "string" ||
    typeof value.extension !== "string" ||
    typeof value.fee !== "string" ||
    (value.tick_spacing !== null &&
      typeof value.tick_spacing !== "number" &&
      typeof value.tick_spacing !== "string")
  ) {
    throw new ServiceError(
      "invalid_upstream_response",
      `Pair pool candidate ${index} has invalid identity fields`,
    );
  }
  const coreAddress = normalizeAddress(value.core_address);
  const extension = normalizeAddress(value.extension);
  const stable = value.stableswap_params;
  const stableswapParams =
    stable === null
      ? null
      : isRecord(stable) &&
          typeof stable.center_tick === "number" &&
          typeof stable.amplification === "number"
        ? {
            centerTick: stable.center_tick,
            amplification: stable.amplification,
          }
        : undefined;
  if (stableswapParams === undefined) {
    throw new ServiceError(
      "invalid_upstream_response",
      `Pair pool candidate ${index} has invalid stableswap_params`,
    );
  }
  const generation = coreGeneration(coreAddress);
  if (generation === "unknown") {
    throw new ServiceError(
      "unsupported_core",
      `Pair pool candidate ${index} uses an unsupported Core deployment`,
      { chain_id: chainId, core_address: coreAddress },
    );
  }
  const poolInput: PoolKeyInput = {
    token0,
    token1,
    fee: value.fee,
    tickSpacing: value.tick_spacing,
    extension,
    stableswapParams,
  };
  const config =
    generation === "v3"
      ? encodePoolConfig(poolInput)
      : encodeV2PoolConfig(poolInput);
  const poolId = derivePoolIdFromConfig(token0, token1, config);
  const indexedPoolId = unsigned(value.pool_id, "indexed pool_id");
  if (BigInt(poolId) !== indexedPoolId) {
    throw new ServiceError(
      "invalid_upstream_response",
      `Pair pool candidate ${index} PoolKey does not derive to its indexed pool_id`,
      { indexed_pool_id: value.pool_id, derived_pool_id: poolId },
    );
  }
  const poolType = stableswapParams === null ? "concentrated" : "stableswap";
  const manager = positionManager(generation, extension);
  return {
    rank: index + 1,
    pool_id: poolId,
    pool_id_decimal: indexedPoolId.toString(),
    core_address: coreAddress,
    core_generation: generation,
    core_resource_uri: `ekubo://contracts/evm/${chainId}/${coreAddress}`,
    pool_key: { token0, token1, config },
    decoded_config:
      generation === "v3"
        ? decodePoolConfig(config)
        : {
            config,
            version: "v2",
            extension,
            fee: unsigned(value.fee, "pool fee").toString(),
            tick_spacing:
              poolType === "concentrated"
                ? Number(unsigned(value.tick_spacing ?? 0, "tick_spacing"))
                : null,
            stableswap_params:
              stableswapParams === null
                ? null
                : {
                    center_tick: stableswapParams.centerTick,
                    amplification: stableswapParams.amplification,
                  },
            exact_integer_note:
              "fee is a uint64 Q64 value and is intentionally serialized as a decimal string, never a JSON number",
          },
    pool_type: poolType,
    extension: {
      address: extension,
      type: extensionType(generation, extension),
      resource_uri:
        BigInt(extension) === 0n
          ? null
          : `ekubo://contracts/evm/${chainId}/${extension}`,
    },
    position_manager: {
      ...manager,
      resource_uri: `ekubo://contracts/evm/${chainId}/${manager.address}`,
    },
    stats: normalizeChainIdFields(value),
  };
}

function derivePoolIdFromConfig(
  token0: Address,
  token1: Address,
  config: Hex,
) {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "token0", type: "address" },
            { name: "token1", type: "address" },
            { name: "config", type: "bytes32" },
          ],
        },
      ],
      [{ token0, token1, config }],
    ),
  );
}

function encodeV2PoolConfig(input: PoolKeyInput): Hex {
  if (input.fee === undefined || input.extension === undefined) {
    throw new ServiceError("invalid_pool_key", "v2 pool key is incomplete");
  }
  const fee = unsigned(input.fee, "pool_key.fee");
  if (fee > UINT64_MAX) {
    throw new ServiceError("invalid_pool_key", "pool_key.fee exceeds uint64");
  }
  let low32: bigint;
  if (input.stableswapParams !== null && input.stableswapParams !== undefined) {
    const { amplification, centerTick } = input.stableswapParams;
    if (
      !Number.isInteger(amplification) ||
      amplification < 0 ||
      amplification > 127 ||
      !Number.isInteger(centerTick) ||
      centerTick % 16 !== 0
    ) {
      throw new ServiceError(
        "invalid_pool_key",
        "v2 stableswap parameters are invalid",
      );
    }
    const encodedCenter = BigInt(centerTick / 16);
    if (encodedCenter < -(1n << 23n) || encodedCenter > (1n << 23n) - 1n) {
      throw new ServiceError(
        "invalid_pool_key",
        "v2 stableswap center tick exceeds signed 24 bits",
      );
    }
    low32 =
      (BigInt(amplification) << 24n) |
      (encodedCenter < 0n ? (1n << 24n) + encodedCenter : encodedCenter);
  } else {
    low32 = unsigned(input.tickSpacing ?? 0, "pool_key.tick_spacing");
    if (low32 > 0xffff_ffffn) {
      throw new ServiceError("invalid_pool_key", "v2 pool config exceeds uint32");
    }
  }
  return numberToHex(
    (BigInt(normalizeAddress(input.extension)) << 96n) | (fee << 32n) | low32,
    { size: 32 },
  );
}

function positionManager(generation: "v2" | "v3", extension: Address) {
  if (generation === "v2") {
    return { address: V2_POSITIONS_ADDRESS, contract: "Positions", version: "v2" };
  }
  if (extension === VE33_EXTENSION_ADDRESS) {
    return {
      address: VE33_POSITIONS_ADDRESS,
      contract: "Ve33Positions",
      version: "v3",
    };
  }
  return { address: V3_POSITIONS_ADDRESS, contract: "Positions", version: "v3" };
}

function extensionType(generation: "v2" | "v3", extension: Address) {
  if (BigInt(extension) === 0n) return "none";
  const known =
    generation === "v2"
      ? new Map<string, string>([
          ["0xd4279c050da1f5c5b2830558c7a08e57e12b54ec", "twamm"],
          ["0x51d02a5948496a67827242eabc5725531342527c", "oracle"],
          ["0x553a2efc570c9e104942cec6ac1c18118e54c091", "mev_capture"],
        ])
      : new Map<string, string>([
          ["0xd47f1b1edcfeabb08f6ebd8fc337c27e636c75ba", "twamm"],
          ["0xd4f1060cb9c1a13e1d2d20379b8aa2cf7541ed9b", "twamm_legacy"],
          ["0x517e506700271aea091b02f42756f5e174af5230", "oracle"],
          ["0x5555ff9ff2757500bf4ee020dcfd0210cffa41be", "mev_capture"],
          ["0xd4b54d0ca6979da05f25895e6e269e678ba00f9e", "boosted_fees"],
          ["0x948b9c2c99718034954110cb61a6e08e107745f9", "boosted_fees"],
          [VE33_EXTENSION_ADDRESS.toLowerCase(), "ve33"],
        ]);
  return known.get(extension.toLowerCase()) ?? "custom";
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
