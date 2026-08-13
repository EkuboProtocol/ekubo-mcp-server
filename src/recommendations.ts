import {
  type Address,
  getAddress,
  type Hex,
  keccak256,
  numberToHex,
  stringToHex,
} from "viem";
import { type Env, getVe33Pools, ServiceError } from "./core.js";

const RECOMMENDATION_RESULT_URL =
  "https://api.dune.com/api/v1/query/8187907/results";
const RECOMMENDATION_EXECUTE_URL =
  "https://api.dune.com/api/v1/query/8187907/execute";
const MAX_RECOMMENDATION_POOLS = 100;
const MAX_EXECUTABLE_RECOMMENDATION_TARGETS = 25;
/// The upstream query is scheduled at most once a day, so demanding a snapshot
/// younger than the refresh interval makes the tool unavailable for part of
/// every day: a snapshot just over a day old triggers a refresh that Dune
/// declines to run, and the result is discarded even though it is perfectly
/// serviceable. Allocation weights move slowly, so a week-old snapshot is worth
/// far more than no recommendation at all.
///
/// Two thresholds instead of one: past REFRESH_AFTER a refresh is attempted,
/// and only past MAX_AGE is a snapshot refused.
const RECOMMENDATION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1_000;
const MAX_RECOMMENDATION_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const REFRESH_MAX_WAIT_MS = 20_000;
const REFRESH_POLL_INTERVAL_MS = 1_000;
const PROVIDER_REQUEST_TIMEOUT_MS = 20_000;
const BPS_TOTAL = 10_000;
const PREFERRED_VE33_TICK_SPACING = 1_024;
const UINT64_MAX = (1n << 64n) - 1n;

interface RecommendationIntent {
  chainId: string;
  veToken: Address;
  ve33: Address;
}

interface RecommendationRow {
  index: number;
  bucket: string;
  priorityRank: number;
  pair: string;
  token0: Address;
  token0Symbol: string;
  token1: Address;
  token1Symbol: string;
  targetWeightBps: number;
  allocationCapBps: number;
  swapFeeBps: number;
  swapFee: bigint;
  grossFeesUsd7d: number | null;
  volumeUsd7d: number | null;
  recentFeeTrendPct: number | null;
  momentum: string;
  confidence: string;
  reason: string;
}

interface RecommendationSnapshot {
  snapshotAt: string;
  rows: RecommendationRow[];
  refreshedOnRequest: boolean;
}

interface RecommendationRuntime {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  refreshMaxWaitMs?: number;
  refreshPollIntervalMs?: number;
}

interface ResolvedPool {
  poolKeyId: string;
  poolId: Hex;
  tickSpacing: number;
}

interface ResolvedRecommendation {
  row: RecommendationRow;
  pool: ResolvedPool | null;
  unavailableReason: "pool_not_initialized" | "ambiguous_pool_configuration" | null;
}

interface ExecutableWeight {
  recommendation: ResolvedRecommendation;
  weightBps: number;
}

export async function getStonxAllocationRecommendation(
  env: Env,
  intent: RecommendationIntent,
  fetcher: typeof fetch = fetch,
  runtime: RecommendationRuntime = {},
) {
  const [snapshot, poolCatalog] = await Promise.all([
    fetchRecommendationSnapshot(env, fetcher, runtime),
    getVe33Pools(
      env,
      { chainId: intent.chainId, ve33: getAddress(intent.ve33) },
      fetcher,
    ),
  ]);
  const resolved = snapshot.rows.map((row) =>
    resolveRecommendation(
      row,
      poolCatalog.pools,
      BigInt(intent.chainId),
      getAddress(intent.ve33),
    ),
  );
  const executableCandidates = resolved
    .filter(
      (recommendation): recommendation is ResolvedRecommendation & {
        pool: ResolvedPool;
      } => recommendation.pool !== null,
    )
    .sort((left, right) =>
      left.row.priorityRank !== right.row.priorityRank
        ? left.row.priorityRank - right.row.priorityRank
        : left.row.index - right.row.index,
    )
    .slice(0, MAX_EXECUTABLE_RECOMMENDATION_TARGETS);
  const candidateIndexes = new Set(
    executableCandidates.map(({ row }) => row.index),
  );
  const executable = redistributeUnavailableWeight(executableCandidates);
  const executableByIndex = new Map(
    (executable ?? []).map((target) => [target.recommendation.row.index, target]),
  );
  const unavailable = resolved.filter(({ pool }) => pool === null);
  const unavailableWeight = unavailable.reduce(
    (sum, { row }) => sum + row.targetWeightBps,
    0,
  );
  const excludedByTargetCap = resolved.filter(
    ({ row, pool }) => pool !== null && !candidateIndexes.has(row.index),
  );
  const excludedWeight = excludedByTargetCap.reduce(
    (sum, { row }) => sum + row.targetWeightBps,
    0,
  );
  const redistributedWeight = unavailableWeight + excludedWeight;
  const targets =
    executable?.map(({ recommendation, weightBps }) => ({
      pool_key_id: (recommendation.pool as ResolvedPool).poolKeyId,
      swap_fee: recommendation.row.swapFee.toString(),
      weight_bps: weightBps,
    })) ?? [];
  const recommendationId = keccak256(
    stringToHex(
      JSON.stringify({
        schema_version: "1",
        snapshot_at: snapshot.snapshotAt,
        chain_id: intent.chainId,
        ve_token: getAddress(intent.veToken),
        ve33: getAddress(intent.ve33),
        recommendations: resolved.map(({ row, pool, unavailableReason }) => ({
          token0: row.token0,
          token1: row.token1,
          target_weight_bps: row.targetWeightBps,
          allocation_cap_bps: row.allocationCapBps,
          swap_fee: row.swapFee.toString(),
          pool_key_id: pool?.poolKeyId ?? null,
          unavailable_reason: unavailableReason,
        })),
        targets,
      }),
    ),
  );

  return {
    schema_version: "1",
    recommendation_id: recommendationId,
    snapshot_at: snapshot.snapshotAt,
    snapshot_refreshed_on_request: snapshot.refreshedOnRequest,
    snapshot_age_seconds: Math.max(
      0,
      Math.floor(snapshotAgeMs(snapshot.snapshotAt, runtime) / 1_000),
    ),
    /// Past this the snapshot is refused outright.
    snapshot_max_age_seconds: MAX_RECOMMENDATION_AGE_MS / 1_000,
    /// Past this a refresh is attempted, but the snapshot stays serviceable
    /// until it reaches snapshot_max_age_seconds.
    snapshot_refresh_after_seconds: RECOMMENDATION_REFRESH_AFTER_MS / 1_000,
    chain_id: intent.chainId,
    ve_token: getAddress(intent.veToken),
    ve33: getAddress(intent.ve33),
    execution_ready: executable !== null,
    original_total_weight_bps: BPS_TOTAL,
    unavailable_weight_bps: unavailableWeight,
    redistributed_weight_bps: executable === null ? 0 : redistributedWeight,
    recommendation_count: resolved.length,
    executable_target_count: targets.length,
    recommendations: resolved.map(({ row, pool, unavailableReason }) => {
      const adjusted = executableByIndex.get(row.index);
      return {
        allocation_bucket: row.bucket,
        priority_rank: row.priorityRank,
        pair: row.pair,
        token0: { address: row.token0, symbol: row.token0Symbol },
        token1: { address: row.token1, symbol: row.token1Symbol },
        recommended_weight_bps: row.targetWeightBps,
        executable_weight_bps: adjusted?.weightBps ?? null,
        redistributed_weight_bps:
          adjusted === undefined ? null : adjusted.weightBps - row.targetWeightBps,
        allocation_cap_bps: row.allocationCapBps,
        suggested_swap_fee: row.swapFee.toString(),
        suggested_swap_fee_bps: row.swapFeeBps,
        initialized_pool:
          pool === null
            ? null
            : {
                pool_key_id: pool.poolKeyId,
                pool_id: pool.poolId,
                tick_spacing: pool.tickSpacing,
              },
        execution_status:
          pool === null
            ? unavailableReason
            : adjusted === undefined
              ? "target_limit"
              : "ready",
        evidence: {
          confidence: row.confidence,
          momentum: row.momentum,
          gross_fees_usd_7d: row.grossFeesUsd7d,
          volume_usd_7d: row.volumeUsd7d,
          recent_fee_trend_pct: row.recentFeeTrendPct,
          rationale: row.reason,
        },
      };
    }),
    unavailable_recommendations: unavailable.map(({ row, unavailableReason }) => ({
      pair: row.pair,
      token0: row.token0,
      token1: row.token1,
      recommended_weight_bps: row.targetWeightBps,
      reason: unavailableReason,
    })),
    target_limit: MAX_EXECUTABLE_RECOMMENDATION_TARGETS,
    target_limit_excluded_weight_bps: excludedWeight,
    target_limit_excluded_recommendations: excludedByTargetCap.map(({ row }) => ({
      pair: row.pair,
      token0: row.token0,
      token1: row.token1,
      recommended_weight_bps: row.targetWeightBps,
      reason: "target_limit",
    })),
    targets,
    target_total_weight_bps: targets.reduce(
      (sum, target) => sum + target.weight_bps,
      0,
    ),
    pool_resolution: {
      policy:
        "Use the unique initialized Ve33 pool for each pair; when several exist, use the unique initialized 1024-tick pool. Never guess among remaining ambiguities.",
      unavailable_weight_is_redistributed:
        "Unavailable weight and weight below the 25-target priority cutoff are redistributed proportionally among selected initialized recommendations without exceeding any allocation cap.",
    },
    safe_execution_workflow: {
      instructions: [
        "Call get_ve33_allocations with the connected wallet and show its complete state.",
        "Execute and decode that tool's onchain_validation.eth_call through the connected provider.",
        "Pass the exact returned state_id plus this result's targets and strategy=compact_max_lock to prepare_ve33_reallocation.",
        "Pass the max-lock extension, surviving NFT, burned source NFT IDs, final NFT count, every decoded call, and complete plan to the wallet; let the wallet simulate, present the result, and collect authorization or signature.",
      ],
      every_current_vote_is_claimed_before_it_is_cleared_or_moved: true,
      compact_max_lock_strategy: true,
      maximum_final_voting_nfts: MAX_EXECUTABLE_RECOMMENDATION_TARGETS,
      one_voting_nft_per_target_pool: true,
      ownership_or_nft_transfer_calls_are_forbidden: true,
      recommendation_tool_constructs_no_transaction: true,
    },
  };
}

async function fetchRecommendationSnapshot(
  env: Env,
  fetcher: typeof fetch,
  runtime: RecommendationRuntime,
): Promise<RecommendationSnapshot> {
  if (!env.DUNE_API_KEY) {
    throw new ServiceError(
      "allocation_recommendations_not_configured",
      "Allocation recommendations are not configured for this deployment",
    );
  }
  const url = new URL(RECOMMENDATION_RESULT_URL);
  url.searchParams.set("limit", MAX_RECOMMENDATION_POOLS.toString());
  const payload = await fetchProviderJson(env, fetcher, url);

  // What Dune already has, kept as the fallback for a refresh that does not
  // land. Parsed eagerly so a malformed snapshot still surfaces its own error.
  let existing: RecommendationSnapshot | null = null;
  if (payload.state === "QUERY_STATE_COMPLETED") {
    existing = parseRecommendationSnapshot(payload, false);
    if (isCurrent(existing.snapshotAt, runtime)) return existing;
  } else if (isActiveExecution(payload)) {
    return refreshOrFallback(env, fetcher, executionId(payload), null, runtime);
  }

  const execution = await fetchProviderJson(
    env,
    fetcher,
    RECOMMENDATION_EXECUTE_URL,
    { method: "POST" },
  );
  return refreshOrFallback(
    env,
    fetcher,
    executionId(execution),
    existing,
    runtime,
  );
}

/// Wait for a refresh, but treat it as an improvement rather than a
/// precondition: a snapshot still inside the usable window answers the request
/// when the refresh times out, errors, or comes back no newer than what we
/// already had. Without a usable fallback the refresh's own failure stands, so
/// a genuinely broken upstream is still reported as itself.
async function refreshOrFallback(
  env: Env,
  fetcher: typeof fetch,
  id: string,
  existing: RecommendationSnapshot | null,
  runtime: RecommendationRuntime,
): Promise<RecommendationSnapshot> {
  const fallback =
    existing !== null && isUsable(existing.snapshotAt, runtime)
      ? existing
      : null;
  let refreshed: RecommendationSnapshot;
  try {
    refreshed = await waitForRefreshedSnapshot(env, fetcher, id, runtime);
  } catch (error) {
    if (fallback !== null) return fallback;
    throw error;
  }
  if (isUsable(refreshed.snapshotAt, runtime)) return refreshed;
  if (fallback !== null) return fallback;
  throw recommendationUnavailable();
}

function parseRecommendationSnapshot(
  payload: Record<string, unknown>,
  refreshedOnRequest: boolean,
): RecommendationSnapshot {
  if (payload.state !== "QUERY_STATE_COMPLETED") {
    throw recommendationUnavailable();
  }
  const snapshotAt = payload.submitted_at;
  if (typeof snapshotAt !== "string" || !Number.isFinite(Date.parse(snapshotAt))) {
    throw invalidRecommendation("Recommendation snapshot has an invalid timestamp");
  }
  const result = payload.result;
  if (!isRecord(result) || !Array.isArray(result.rows)) {
    throw invalidRecommendation("Recommendation snapshot is missing its rows");
  }
  const metadata = result.metadata;
  const totalRows =
    isRecord(metadata) && metadata.total_row_count !== undefined
      ? integer(metadata.total_row_count, "total_row_count")
      : result.rows.length;
  if (
    totalRows > MAX_RECOMMENDATION_POOLS ||
    result.rows.length > MAX_RECOMMENDATION_POOLS ||
    result.rows.length !== totalRows
  ) {
    throw new ServiceError(
      "allocation_recommendation_too_large",
      `Allocation recommendations must contain at most ${MAX_RECOMMENDATION_POOLS} complete rows`,
      { returned_rows: result.rows.length, total_rows: totalRows },
    );
  }
  if (result.rows.length === 0) {
    throw invalidRecommendation("Recommendation snapshot contains no allocations");
  }
  const rows = result.rows.map((row, index) => parseRecommendationRow(row, index));
  const totalWeight = rows.reduce((sum, row) => sum + row.targetWeightBps, 0);
  if (totalWeight !== BPS_TOTAL) {
    throw invalidRecommendation(
      `Recommendation weights sum to ${totalWeight}, expected ${BPS_TOTAL}`,
    );
  }
  const pairKeys = new Set(rows.map((row) => `${row.token0}:${row.token1}`));
  if (pairKeys.size !== rows.length) {
    throw invalidRecommendation("Recommendation snapshot contains duplicate pairs");
  }
  return { snapshotAt, rows, refreshedOnRequest };
}

async function waitForRefreshedSnapshot(
  env: Env,
  fetcher: typeof fetch,
  id: string,
  runtime: RecommendationRuntime,
): Promise<RecommendationSnapshot> {
  const now = runtime.now ?? Date.now;
  const sleep = runtime.sleep ?? delay;
  const maxWaitMs = runtime.refreshMaxWaitMs ?? REFRESH_MAX_WAIT_MS;
  const pollIntervalMs =
    runtime.refreshPollIntervalMs ?? REFRESH_POLL_INTERVAL_MS;
  const deadline = now() + maxWaitMs;
  const url = new URL(
    `/api/v1/execution/${encodeURIComponent(id)}/results`,
    "https://api.dune.com",
  );
  url.searchParams.set("limit", MAX_RECOMMENDATION_POOLS.toString());

  while (true) {
    const payload = await fetchProviderJson(env, fetcher, url);
    if (payload.state === "QUERY_STATE_COMPLETED") {
      // Age is judged by the caller, which knows whether an older snapshot is
      // standing by.
      return parseRecommendationSnapshot(payload, true);
    }
    if (!isActiveExecution(payload) || now() >= deadline) {
      throw recommendationUnavailable();
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }
}

async function fetchProviderJson(
  env: Env,
  fetcher: typeof fetch,
  url: string | URL,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("X-Dune-API-Key", env.DUNE_API_KEY);
    response = await fetcher(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw recommendationUnavailable();
  }
  if (!response.ok) throw recommendationUnavailable();

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw recommendationUnavailable();
  }
  if (!isRecord(payload)) throw recommendationUnavailable();
  return payload;
}

function snapshotAgeMs(
  snapshotAt: string,
  runtime: RecommendationRuntime,
): number {
  const submittedAt = Date.parse(snapshotAt);
  if (!Number.isFinite(submittedAt)) return Number.POSITIVE_INFINITY;
  return (runtime.now ?? Date.now)() - submittedAt;
}

/// Young enough that no refresh is worth attempting.
function isCurrent(snapshotAt: string, runtime: RecommendationRuntime): boolean {
  return snapshotAgeMs(snapshotAt, runtime) <= RECOMMENDATION_REFRESH_AFTER_MS;
}

/// Young enough to answer with, refreshed or not.
function isUsable(snapshotAt: string, runtime: RecommendationRuntime): boolean {
  return snapshotAgeMs(snapshotAt, runtime) <= MAX_RECOMMENDATION_AGE_MS;
}

function isActiveExecution(payload: Record<string, unknown>): boolean {
  return (
    payload.state === "QUERY_STATE_PENDING" ||
    payload.state === "QUERY_STATE_EXECUTING"
  );
}

function executionId(payload: Record<string, unknown>): string {
  const value = payload.execution_id;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 200 ||
    !/^[0-9A-Za-z_-]+$/.test(value)
  ) {
    throw recommendationUnavailable();
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseRecommendationRow(value: unknown, index: number): RecommendationRow {
  if (!isRecord(value)) {
    throw invalidRecommendation(`Recommendation row ${index} is not an object`);
  }
  const token0 = evmAddress(value.asset0_address, "asset0_address");
  const token1 = evmAddress(value.asset1_address, "asset1_address");
  if (BigInt(token0) >= BigInt(token1)) {
    throw invalidRecommendation(`Recommendation row ${index} has an invalid token order`);
  }
  const targetWeightBps = integer(value.target_weight_bps, "target_weight_bps");
  const allocationCapBps = integer(value.allocation_cap_bps, "allocation_cap_bps");
  if (
    targetWeightBps <= 0 ||
    targetWeightBps > BPS_TOTAL ||
    allocationCapBps < targetWeightBps ||
    allocationCapBps > BPS_TOTAL
  ) {
    throw invalidRecommendation(`Recommendation row ${index} has invalid weight bounds`);
  }
  if (integer(value.plan_total_weight_bps, "plan_total_weight_bps") !== BPS_TOTAL) {
    throw invalidRecommendation(`Recommendation row ${index} has an invalid plan total`);
  }
  const swapFeeText = text(value.suggested_swap_fee_q64, "suggested_swap_fee_q64");
  if (!/^(?:0|[1-9][0-9]*)$/.test(swapFeeText)) {
    throw invalidRecommendation(`Recommendation row ${index} has an invalid swap fee`);
  }
  const swapFee = BigInt(swapFeeText);
  if (swapFee > UINT64_MAX) {
    throw invalidRecommendation(`Recommendation row ${index} swap fee exceeds uint64`);
  }
  return {
    index,
    bucket: text(value.allocation_bucket, "allocation_bucket"),
    priorityRank: integer(value.priority_rank, "priority_rank"),
    pair: text(value.pair, "pair"),
    token0,
    token0Symbol: text(value.asset0_symbol, "asset0_symbol"),
    token1,
    token1Symbol: text(value.asset1_symbol, "asset1_symbol"),
    targetWeightBps,
    allocationCapBps,
    swapFeeBps: finiteNumber(value.suggested_swap_fee_bps, "suggested_swap_fee_bps"),
    swapFee,
    grossFeesUsd7d: nullableNumber(value.last_7d_gross_fees_usd, "last_7d_gross_fees_usd"),
    volumeUsd7d: nullableNumber(value.last_7d_volume_usd, "last_7d_volume_usd"),
    recentFeeTrendPct: nullableNumber(
      value.recent_vs_prior_fee_trend_pct,
      "recent_vs_prior_fee_trend_pct",
    ),
    momentum: text(value.momentum_flag, "momentum_flag"),
    confidence: text(value.evidence_confidence, "evidence_confidence"),
    reason: text(value.allocation_reason, "allocation_reason"),
  };
}

function resolveRecommendation(
  row: RecommendationRow,
  indexedPools: Record<string, unknown>[],
  expectedChainId: bigint,
  expectedVe33: Address,
): ResolvedRecommendation {
  const matching = indexedPools
    .filter((pool) => {
      if (!isRecord(pool.pool_state)) return false;
      try {
        return (
          evmAddress(pool.token0, "token0") === row.token0 &&
          evmAddress(pool.token1, "token1") === row.token1
        );
      } catch {
        return false;
      }
    })
    .map((pool) => parseResolvedPool(pool, expectedChainId, expectedVe33));
  const poolKeyIds = new Set(matching.map(({ poolKeyId }) => poolKeyId));
  const poolIds = new Set(matching.map(({ poolId }) => poolId));
  if (poolKeyIds.size !== matching.length || poolIds.size !== matching.length) {
    throw invalidRecommendation(
      "Ve33 pool directory contains a duplicate matching pool",
    );
  }
  if (matching.length === 1) {
    return { row, pool: matching[0], unavailableReason: null };
  }
  if (matching.length > 1) {
    const preferred = matching.filter(
      ({ tickSpacing }) => tickSpacing === PREFERRED_VE33_TICK_SPACING,
    );
    if (preferred.length === 1) {
      return { row, pool: preferred[0], unavailableReason: null };
    }
    return {
      row,
      pool: null,
      unavailableReason: "ambiguous_pool_configuration",
    };
  }
  return { row, pool: null, unavailableReason: "pool_not_initialized" };
}

function parseResolvedPool(
  pool: Record<string, unknown>,
  expectedChainId: bigint,
  expectedVe33: Address,
): ResolvedPool {
  if (unsignedBigInt(pool.chain_id, "chain_id") !== expectedChainId) {
    throw invalidRecommendation(
      "Ve33 pool directory contains a pool for an unexpected chain",
    );
  }
  if (evmAddress(pool.extension, "extension") !== expectedVe33) {
    throw invalidRecommendation(
      "Ve33 pool directory contains a pool for an unexpected extension",
    );
  }
  const poolKeyId = unsignedIntegerText(pool.pool_key_id, "pool_key_id");
  const poolIdValue = pool.pool_id;
  if (typeof poolIdValue !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(poolIdValue)) {
    throw invalidRecommendation("Ve33 pool directory contains an invalid pool_id");
  }
  return {
    poolKeyId,
    poolId: numberToHex(BigInt(poolIdValue), { size: 32 }),
    tickSpacing: integer(pool.tick_spacing, "tick_spacing"),
  };
}

function unsignedBigInt(value: unknown, field: string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw invalidRecommendation(`${field} must be an unsigned integer`);
    }
    return BigInt(value);
  }
  if (
    typeof value !== "string" ||
    !/^(?:(?:0|[1-9][0-9]*)|0x[0-9a-fA-F]+)$/.test(value)
  ) {
    throw invalidRecommendation(`${field} must be an unsigned integer`);
  }
  return BigInt(value);
}

function redistributeUnavailableWeight(
  resolved: ResolvedRecommendation[],
): ExecutableWeight[] | null {
  const available = resolved.filter(
    (recommendation): recommendation is ResolvedRecommendation & { pool: ResolvedPool } =>
      recommendation.pool !== null,
  );
  if (available.length === 0) return null;
  const weights = available.map((recommendation) => ({
    recommendation,
    weightBps: recommendation.row.targetWeightBps,
  }));
  let remaining =
    BPS_TOTAL - weights.reduce((sum, target) => sum + target.weightBps, 0);
  const capacity = weights.reduce(
    (sum, target) =>
      sum + (target.recommendation.row.allocationCapBps - target.weightBps),
    0,
  );
  if (remaining < 0 || capacity < remaining) return null;

  while (remaining > 0) {
    const active = weights.filter(
      (target) =>
        target.weightBps < target.recommendation.row.allocationCapBps,
    );
    if (active.length === 0) return null;
    const scoreTotal = active.reduce(
      (sum, target) => sum + target.recommendation.row.targetWeightBps,
      0,
    );
    const proposals = active.map((target) => {
      const score = target.recommendation.row.targetWeightBps;
      const capacity =
        target.recommendation.row.allocationCapBps - target.weightBps;
      return {
        target,
        amount: Math.min(capacity, Math.floor((remaining * score) / scoreTotal)),
        remainder: (remaining * score) % scoreTotal,
      };
    });
    let distributed = proposals.reduce((sum, proposal) => sum + proposal.amount, 0);
    for (const proposal of proposals) proposal.target.weightBps += proposal.amount;
    remaining -= distributed;
    if (remaining === 0) break;
    const remainderOrder = proposals
      .filter(
        ({ target }) =>
          target.weightBps < target.recommendation.row.allocationCapBps,
      )
      .sort((left, right) =>
        left.remainder !== right.remainder
          ? right.remainder - left.remainder
          : left.target.recommendation.row.index - right.target.recommendation.row.index,
      );
    distributed = 0;
    for (const proposal of remainderOrder) {
      if (remaining === 0) break;
      proposal.target.weightBps += 1;
      remaining -= 1;
      distributed += 1;
    }
    if (distributed === 0) return null;
  }
  if (
    weights.reduce((sum, target) => sum + target.weightBps, 0) !== BPS_TOTAL ||
    weights.some(
      (target) =>
        target.weightBps > target.recommendation.row.allocationCapBps,
    )
  ) {
    throw new Error("internal recommendation redistribution error");
  }
  return weights;
}

function evmAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,40}$/.test(value)) {
    throw invalidRecommendation(`${field} must be an EVM address`);
  }
  return getAddress(numberToHex(BigInt(value), { size: 20 }));
}

function unsignedIntegerText(value: unknown, field: string): string {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
  ) {
    throw invalidRecommendation(`${field} must be an unsigned integer`);
  }
  const normalized = String(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(normalized)) {
    throw invalidRecommendation(`${field} must be an unsigned integer`);
  }
  return normalized;
}

function integer(value: unknown, field: string): number {
  const normalized = unsignedIntegerText(value, field);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidRecommendation(`${field} is too large`);
  }
  return parsed;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_000) {
    throw invalidRecommendation(`${field} must be a nonempty string`);
  }
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidRecommendation(`${field} must be a finite number`);
  }
  return value;
}

function nullableNumber(value: unknown, field: string): number | null {
  return value === null ? null : finiteNumber(value, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recommendationUnavailable() {
  return new ServiceError(
    "allocation_recommendations_unavailable",
    "Allocation recommendations are temporarily unavailable; do not construct or reuse a target plan",
  );
}

function invalidRecommendation(message: string) {
  return new ServiceError("invalid_allocation_recommendation", message);
}
