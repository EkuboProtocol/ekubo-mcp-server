import { type Env, getTokens, ServiceError } from "./core.js";
import {
  findToken,
  ROBINHOOD_STONX,
  tokenAmountUsd,
  tokenIdentity,
  tokenPairUsd,
  validateEmissionState,
  type Ve33EmissionStateInput,
} from "./opportunities.js";

type JsonRecord = Record<string, unknown>;

/// Ekubo's Ve33 has no voting epochs: emissions stream continuously at the
/// current rate and votes persist until changed. A week is the measurement
/// epoch because it is the longest trailing fee window the pool directory
/// reports.
export const EFFICIENCY_EPOCH_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_MAX_EMISSION_SHARE_PER_FEE_SHARE = 3;
const EPOCH_DAYS = 7;
const Q32 = 2 ** 32;
const VOTE_WEIGHT_SCALE = 1e18;
const BPS_TOTAL = 10_000;

export interface VoterPoolInput {
  poolKeyId: string;
  lpShare: number;
  currentVoteWeight?: string;
}

export interface VoterInput {
  voteWeight: string;
  pools: VoterPoolInput[];
}

export interface EfficiencyOptions {
  ve33EmissionState?: Ve33EmissionStateInput;
  voter?: VoterInput;
  pruneLowEfficiency?: boolean;
  maxEmissionSharePerFeeShare?: number;
}

export interface PoolEconomics {
  poolKeyId: string;
  voteWeight: number;
  voteShare: number;
  trailingFeesUsd: number | null;
  retainedFeesUsd: number | null;
  retainedVolumeUsd: number | null;
  emissionsUsdPerEpoch: number | null;
  swapFee: string | null;
  tickSpacing: number | null;
}

export interface EfficiencyContext {
  status: "complete" | "emission_rate_required" | "prices_unavailable";
  totalVoteWeight: number;
  totalRetainedFeesUsd: number;
  epochEmissionsUsd: number | null;
  stonxUsdPrice: number | null;
  pools: Map<string, PoolEconomics>;
  maxEmissionSharePerFeeShare: number;
}

/// Prices every Ve33 pool's trailing and current fee flow and its emission
/// share. A missing price source degrades the KPI to null rather than failing
/// the recommendation, which stays usable without it.
export async function buildEfficiencyContext(
  env: Env,
  chainId: string,
  pools: JsonRecord[],
  totalVoteWeightValue: unknown,
  options: EfficiencyOptions,
  fetcher: typeof fetch,
): Promise<EfficiencyContext> {
  const totalVoteWeight = scaledWeight(totalVoteWeightValue);
  const threshold =
    options.maxEmissionSharePerFeeShare ??
    DEFAULT_MAX_EMISSION_SHARE_PER_FEE_SHARE;
  const tokenMap = await fetchTokenMap(env, chainId, pools, fetcher);
  const stonx = tokenMap === null
    ? undefined
    : findToken(tokenMap, chainId, ROBINHOOD_STONX);
  const stonxUsdPrice = usdPrice(stonx);
  const epochEmissionsUsd = epochEmissionsValue(
    options.ve33EmissionState,
    stonx,
  );
  const economics = new Map<string, PoolEconomics>();
  for (const pool of pools) {
    const entry = poolEconomics(
      pool,
      chainId,
      tokenMap,
      totalVoteWeight,
      epochEmissionsUsd,
    );
    if (entry !== null) economics.set(entry.poolKeyId, entry);
  }
  const totalRetainedFeesUsd = [...economics.values()].reduce(
    (sum, pool) => sum + (pool.retainedFeesUsd ?? 0),
    0,
  );
  return {
    status:
      tokenMap === null
        ? "prices_unavailable"
        : epochEmissionsUsd === null
          ? "emission_rate_required"
          : "complete",
    totalVoteWeight,
    totalRetainedFeesUsd,
    epochEmissionsUsd,
    stonxUsdPrice,
    pools: economics,
    maxEmissionSharePerFeeShare: threshold,
  };
}

async function fetchTokenMap(
  env: Env,
  chainId: string,
  pools: JsonRecord[],
  fetcher: typeof fetch,
): Promise<Map<string, JsonRecord> | null> {
  const addresses = new Set<string>([ROBINHOOD_STONX.toLowerCase()]);
  for (const pool of pools) {
    for (const key of ["token0", "token1"]) {
      const value = pool[key];
      if (typeof value === "string") addresses.add(value.toLowerCase());
    }
  }
  try {
    const tokens = await getTokens(
      env,
      {
        tokens: [...addresses].map((address) => ({ chainId, address })),
      },
      fetcher,
    );
    const map = new Map<string, JsonRecord>();
    for (const token of tokens) {
      if (!isRecord(token)) continue;
      try {
        map.set(tokenIdentity(token), token);
      } catch {
        // A token without a usable identity simply stays unpriced.
      }
    }
    return map;
  } catch {
    return null;
  }
}

function epochEmissionsValue(
  state: Ve33EmissionStateInput | undefined,
  stonx: JsonRecord | undefined,
): number | null {
  if (state === undefined) return null;
  const { currentEmissionRate } = validateEmissionState(state);
  const amount =
    (currentEmissionRate * BigInt(EFFICIENCY_EPOCH_SECONDS)) / BigInt(Q32);
  return tokenAmountUsd(amount.toString(), stonx);
}

function poolEconomics(
  pool: JsonRecord,
  chainId: string,
  tokenMap: Map<string, JsonRecord> | null,
  totalVoteWeight: number,
  epochEmissionsUsd: number | null,
): PoolEconomics | null {
  const poolKeyId = pool.pool_key_id;
  if (typeof poolKeyId !== "string" && typeof poolKeyId !== "number") {
    return null;
  }
  const voteWeight = scaledWeight(pool.pool_total_vote_weight);
  const voteShare = totalVoteWeight > 0 ? voteWeight / totalVoteWeight : 0;
  const token0 = tokenFor(tokenMap, chainId, pool.token0);
  const token1 = tokenFor(tokenMap, chainId, pool.token1);
  const priced = (key0: string, key1: string, multiplier: number) =>
    tokenMap === null
      ? null
      : scaleUsd(
          safePairUsd(pool[key0], pool[key1], token0, token1),
          multiplier,
        );
  return {
    poolKeyId: String(poolKeyId),
    voteWeight,
    voteShare,
    trailingFeesUsd: priced("ve33_fees0_7d", "ve33_fees1_7d", 1),
    retainedFeesUsd: priced("ve33_fees0_24h", "ve33_fees1_24h", EPOCH_DAYS),
    retainedVolumeUsd: priced("volume0_24h", "volume1_24h", EPOCH_DAYS),
    emissionsUsdPerEpoch:
      epochEmissionsUsd === null ? null : epochEmissionsUsd * voteShare,
    swapFee: typeof pool.swap_fee === "string" ? pool.swap_fee : null,
    tickSpacing: typeof pool.tick_spacing === "number" ? pool.tick_spacing : null,
  };
}

function tokenFor(
  tokenMap: Map<string, JsonRecord> | null,
  chainId: string,
  address: unknown,
) {
  if (tokenMap === null || typeof address !== "string") return undefined;
  try {
    return findToken(tokenMap, chainId, address);
  } catch {
    return undefined;
  }
}

function safePairUsd(
  amount0: unknown,
  amount1: unknown,
  token0: JsonRecord | undefined,
  token1: JsonRecord | undefined,
) {
  if (typeof amount0 !== "string" || typeof amount1 !== "string") return null;
  try {
    return tokenPairUsd(amount0, amount1, token0, token1);
  } catch {
    return null;
  }
}

function scaleUsd(value: number | null, multiplier: number) {
  return value === null ? null : value * multiplier;
}

function usdPrice(token: JsonRecord | undefined) {
  const price = token?.usd_price;
  return typeof price === "number" && Number.isFinite(price) ? price : null;
}

function scaledWeight(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value / VOTE_WEIGHT_SCALE;
  }
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value)) {
    return Number(BigInt(value)) / VOTE_WEIGHT_SCALE;
  }
  return 0;
}

/// Emissions-efficiency KPI for one pool: the emissions its votes direct over
/// one epoch per dollar of voter fees it is still generating at the end of
/// that epoch. Votes persist until changed, so the current vote share stands
/// for the trailing epoch's emission share, and the latest day's fee run rate
/// stands for what the pool retained one epoch later.
export function emissionsEfficiency(
  context: EfficiencyContext,
  poolKeyId: string,
  exempt: boolean,
) {
  const pool = context.pools.get(poolKeyId);
  if (pool === undefined) return null;
  const retainedFeeShare =
    pool.retainedFeesUsd === null || context.totalRetainedFeesUsd <= 0
      ? null
      : pool.retainedFeesUsd / context.totalRetainedFeesUsd;
  const sharePerFeeShare = ratio(pool.voteShare, retainedFeeShare);
  const prune = pruneDecision(context, pool, sharePerFeeShare, exempt);
  return {
    epoch_seconds: EFFICIENCY_EPOCH_SECONDS,
    vote_share: pool.voteShare,
    trailing_epoch_ve33_fees_usd: pool.trailingFeesUsd,
    retained_epoch_ve33_fees_usd: pool.retainedFeesUsd,
    retained_epoch_volume_usd: pool.retainedVolumeUsd,
    fee_retention_ratio: ratio(pool.retainedFeesUsd, pool.trailingFeesUsd),
    retained_fee_share: retainedFeeShare,
    emission_share_per_retained_fee_share: sharePerFeeShare,
    projected_emissions_usd_per_epoch: pool.emissionsUsdPerEpoch,
    emissions_usd_per_retained_fee_usd: ratio(
      pool.emissionsUsdPerEpoch,
      pool.retainedFeesUsd,
    ),
    emissions_usd_per_retained_volume_usd: ratio(
      pool.emissionsUsdPerEpoch,
      pool.retainedVolumeUsd,
    ),
    prune_candidate: prune !== null,
    prune_reason: prune,
  };
}

function pruneDecision(
  context: EfficiencyContext,
  pool: PoolEconomics,
  sharePerFeeShare: number | null,
  exempt: boolean,
): string | null {
  if (exempt || pool.voteShare <= 0 || pool.retainedFeesUsd === null) {
    return null;
  }
  if (context.totalRetainedFeesUsd <= 0) return null;
  if (pool.retainedFeesUsd <= 0) return "no_retained_fees";
  return sharePerFeeShare !== null &&
    sharePerFeeShare > context.maxEmissionSharePerFeeShare
    ? "emission_share_exceeds_retained_fee_share"
    : null;
}

function ratio(numerator: number | null, denominator: number | null) {
  return numerator === null || denominator === null || denominator <= 0
    ? null
    : numerator / denominator;
}

export interface VoterCandidate {
  poolKeyId: string;
  swapFee: string;
  /// Voter fees the pool is expected to pay over the next epoch, in USD.
  feesUsd: number;
  /// Vote weight already in the pool from everyone except this voter.
  othersWeight: number;
  /// The voter's share of the pool's emission-earning liquidity.
  lpShare: number;
}

export interface VoterAllocation {
  poolKeyId: string;
  swapFee: string;
  weight: number;
}

/// Mazett (2024) optimal ve(3,3) vote for one voter: maximise
///   sum_i F_i x_i / (w_i + x_i) + s_i E (w_i + x_i) / W
/// over sum_i x_i = v, x_i >= 0, where F_i is the pool's voter fees, w_i the
/// others' votes, s_i the voter's LP share, E the epoch emissions and W the
/// total vote weight after the move. The first-order condition
///   F_i w_i / (w_i + x_i)^2 + c_i = lambda,   c_i = s_i E / W
/// gives x_i = sqrt(F_i w_i / (lambda - c_i)) - w_i, and lambda is found by
/// bisection because the total is decreasing in it.
export function optimalVoterAllocation(
  candidates: VoterCandidate[],
  voteWeight: number,
  epochEmissionsUsd: number,
  totalWeightAfter: number,
): VoterAllocation[] {
  if (candidates.length === 0 || voteWeight <= 0) return [];
  const floor = voteWeight * 1e-9;
  const items = candidates.map((candidate) => ({
    candidate,
    w: Math.max(candidate.othersWeight, floor),
    c:
      totalWeightAfter > 0
        ? (candidate.lpShare * epochEmissionsUsd) / totalWeightAfter
        : 0,
  }));
  const cMax = Math.max(...items.map(({ c }) => c));
  const hi = Math.max(
    ...items.map(({ candidate, w, c }) => candidate.feesUsd / w + c),
  );
  const demand = (lambda: number) =>
    items.map(({ candidate, w, c }) =>
      lambda <= c
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.sqrt((candidate.feesUsd * w) / (lambda - c)) - w),
    );
  const total = (values: number[]) => values.reduce((a, b) => a + b, 0);
  let lo = cMax;
  let up = hi;
  if (up > lo) {
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const mid = (lo + up) / 2;
      if (total(demand(mid)) > voteWeight) lo = mid;
      else up = mid;
    }
  }
  const weights = up > cMax ? demand(up) : items.map(() => 0);
  const remainder = voteWeight - total(weights);
  if (remainder > voteWeight * 1e-9) {
    const best = items.findIndex(({ c }) => c === cMax);
    weights[best] += remainder;
  }
  return items.map(({ candidate }, index) => ({
    poolKeyId: candidate.poolKeyId,
    swapFee: candidate.swapFee,
    weight: weights[index],
  }));
}

/// The voter's expected fee and emission value for one epoch under a split.
export function voterValue(
  candidates: VoterCandidate[],
  weights: Map<string, number>,
  epochEmissionsUsd: number,
  totalWeightAfter: number,
) {
  let fees = 0;
  let emissions = 0;
  for (const candidate of candidates) {
    const x = weights.get(candidate.poolKeyId) ?? 0;
    const pool = candidate.othersWeight + x;
    if (x > 0 && pool > 0) fees += (candidate.feesUsd * x) / pool;
    if (totalWeightAfter > 0) {
      emissions +=
        (candidate.lpShare * epochEmissionsUsd * pool) / totalWeightAfter;
    }
  }
  return {
    voter_fees_usd: fees,
    own_pool_emissions_usd: emissions,
    total_usd: fees + emissions,
  };
}

/// Integer basis points over at most `limit` pools, summing to exactly 10,000.
export function allocationBps(
  allocations: VoterAllocation[],
  limit: number,
): { poolKeyId: string; swapFee: string; weightBps: number }[] {
  const kept = allocations
    .filter(({ weight }) => weight > 0)
    .sort((left, right) => right.weight - left.weight)
    .slice(0, limit);
  const total = kept.reduce((sum, { weight }) => sum + weight, 0);
  if (total <= 0) return [];
  const raw = kept.map((allocation) => {
    const exact = (allocation.weight * BPS_TOTAL) / total;
    return { allocation, floor: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let remaining = BPS_TOTAL - raw.reduce((sum, { floor }) => sum + floor, 0);
  for (const entry of [...raw].sort((a, b) => b.rest - a.rest)) {
    if (remaining === 0) break;
    entry.floor += 1;
    remaining -= 1;
  }
  return raw
    .filter(({ floor }) => floor > 0)
    .map(({ allocation, floor }) => ({
      poolKeyId: allocation.poolKeyId,
      swapFee: allocation.swapFee,
      weightBps: floor,
    }));
}

export function parseVoterWeight(value: string, field: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ServiceError("invalid_input", `${field} must be a decimal integer`);
  }
  return Number(BigInt(value)) / VOTE_WEIGHT_SCALE;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
