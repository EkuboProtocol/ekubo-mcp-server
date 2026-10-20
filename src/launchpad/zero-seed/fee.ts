import { ZeroSeedError } from "./policy.js";

/** 2^64: the Q0.64 unit. Exactly 100% is not encodable as a uint64 fee or factor. */
export const Q64 = 1n << 64n;
const MAX_U128 = (1n << 128n) - 1n;
const MAX_I128 = (1n << 127n) - 1n;

/** Draft protocol cap floor(99 * 2^64 / 100) on the initial fee. A proposal under review, not a live parameter. */
export const MAX_CREATOR_FEE = 18262276632972456099n;

/**
 * Study factors only (about six underlying half-lives over the duration); not selected product parameters
 * and never a default. Literal Q0.64 per-second multipliers, not half-lives.
 */
export const STUDY_DECAY_FACTORS: Readonly<Record<600 | 3600, bigint>> = Object.freeze({
  600: 18319323104848571946n,
  3600: 18425445863997925462n,
});

/**
 * factor ** exponent in Q0.64, exactly as the contract's powQ64: for each set exponent bit multiply the running
 * result by the current factor and floor; shift; square and floor the factor only while bits remain.
 */
export function powQ64(factor: bigint, exponent: bigint): bigint {
  let result = Q64;
  let base = factor;
  let rest = exponent;
  while (rest !== 0n) {
    if ((rest & 1n) === 1n) result = (result * base) / Q64;
    rest >>= 1n;
    if (rest !== 0n) base = (base * base) / Q64;
  }
  return result;
}

export interface FeeSchedule {
  tradingStart: bigint;
  feeDuration: bigint;
  initialFee: bigint;
  finalFee: bigint;
  decayFactor: bigint;
}

/** Same domain as the contract's creation validation, minus the cap (indexed data is checked, not capped). */
export function checkSchedule(schedule: FeeSchedule): void {
  const { tradingStart, feeDuration, initialFee, finalFee, decayFactor } = schedule;
  for (const [value, bits] of [[tradingStart, 64], [feeDuration, 32], [initialFee, 64], [finalFee, 64], [decayFactor, 64]] as const) {
    if (value < 0n || value >= 1n << BigInt(bits)) throw new ZeroSeedError("unsigned_domain");
  }
  if (feeDuration === 0n || finalFee > initialFee || decayFactor === 0n) throw new ZeroSeedError("invalid_fee_schedule");
}

/**
 * The contract's _feeAt: the initial fee at or before trading start, the final fee from start + duration, and
 * in between finalFee + floor((initialFee - finalFee) * (b^t - b^D) / (2^64 - b^D)). Elapsed time is not narrowed.
 */
export function feeAt(schedule: FeeSchedule, timestamp: bigint): bigint {
  checkSchedule(schedule);
  const { tradingStart, feeDuration, initialFee, finalFee, decayFactor } = schedule;
  if (timestamp <= tradingStart) return initialFee;
  const elapsed = timestamp - tradingStart;
  if (elapsed >= feeDuration) return finalFee;
  const endpoint = powQ64(decayFactor, feeDuration);
  return finalFee + ((initialFee - finalFee) * (powQ64(decayFactor, elapsed) - endpoint)) / (Q64 - endpoint);
}

/** Q0.64 fee as a percentage to four decimals, rounding half up. */
export function feePercent(q64: bigint): string {
  const scaled = (q64 * 1_000_000n + (1n << 63n)) >> 64n;
  return `${scaled / 10_000n}.${(scaled % 10_000n).toString().padStart(4, "0")}%`;
}

/** 2^64 / (2^64 - rate) to two decimals, rounded down: the exact-output input multiplier. */
export function exactOutputMultiplier(rate: bigint): string {
  const hundredths = (Q64 * 100n) / (Q64 - rate);
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
}

export type FeePhase = "before_trading_start" | "fee_decay" | "final_fee";

/** The API's phase labels: the exclusive start and end match its served schedule. */
export function feePhase(schedule: FeeSchedule, timestamp: bigint): FeePhase {
  if (timestamp < schedule.tradingStart) return "before_trading_start";
  return timestamp < schedule.tradingStart + schedule.feeDuration ? "fee_decay" : "final_fee";
}

/**
 * The first elapsed second at which the excess over the final fee is at most half the initial excess, found
 * from the exact integer schedule (monotone), never from the factor's underlying half-life. Null for a flat
 * schedule.
 */
export function excessHalvingTime(schedule: FeeSchedule): bigint | null {
  checkSchedule(schedule);
  const spread = schedule.initialFee - schedule.finalFee;
  if (spread === 0n) return null;
  const halved = (t: bigint) => 2n * (feeAt(schedule, schedule.tradingStart + t) - schedule.finalFee) <= spread;
  let low = 1n;
  let high = schedule.feeDuration;
  while (low < high) {
    const middle = (low + high) / 2n;
    if (halved(middle)) high = middle;
    else low = middle + 1n;
  }
  return low;
}

function amount128(value: bigint): bigint {
  if (value < 0n || value > MAX_U128) throw new ZeroSeedError("unsigned_domain");
  return value;
}

function rate64(value: bigint): bigint {
  if (value < 0n || value >= Q64) throw new ZeroSeedError("unsigned_domain");
  return value;
}

/** computeFee: the exact-input fee ceil(amount * rate / 2^64) on the gross calculated output. */
export function exactInputFee(gross: bigint, rate: bigint): bigint {
  return (amount128(gross) * rate64(rate) + Q64 - 1n) / Q64;
}

/**
 * amountBeforeFee: the exact-output fee-inclusive input ceil(amount * 2^64 / (2^64 - rate)). It is nonlinear in
 * the rate. Above uint128 the contract reverts with AmountBeforeFeeOverflow.
 */
export function exactOutputPaid(calculated: bigint, rate: bigint): bigint {
  const denominator = Q64 - rate64(rate);
  const paid = (amount128(calculated) * Q64 + denominator - 1n) / denominator;
  if (paid > MAX_U128) throw new ZeroSeedError("amount_before_fee_overflow");
  return paid;
}

/**
 * The fee the extension books for one fill and the signed fee-inclusive calculated delta, checked like
 * SafeCastLib.toInt128: a helper overflow and a signed-delta overflow stay distinct, and nothing truncates.
 */
export function feeInclusiveDelta(input: { calculated: bigint; rate: bigint; exactOut: boolean }) {
  const { calculated, rate, exactOut } = input;
  if (calculated < -MAX_I128 - 1n || calculated > MAX_I128) throw new ZeroSeedError("unsigned_domain");
  const amount = calculated < 0n ? -calculated : calculated;
  const fee = exactOut ? exactOutputPaid(amount, rate) - amount : exactInputFee(amount, rate);
  const withFee = calculated + fee;
  if (withFee > MAX_I128) throw new ZeroSeedError("signed_delta_overflow");
  return { fee, withFee };
}
