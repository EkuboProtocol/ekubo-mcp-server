import { ZeroSeedError } from "./policy.js";

/** 2^64: the Q0.64 unit. Exactly 100% is not encodable as a uint64 fee. */
export const Q64 = 1n << 64n;
/** 2^128: the Q128 unit of the decay chain. */
export const Q128 = 1n << 128n;
const MAX_U128 = (1n << 128n) - 1n;
const MAX_I128 = (1n << 127n) - 1n;

/**
 * type(uint64).max: the largest creator fee, 1 - 2^-64 of the amount, just under 100%. Every uint64 is a valid
 * initial or final fee; the contract checks only finalFee <= initialFee and feeDuration > 0.
 */
export const MAX_CREATOR_FEE = Q64 - 1n;

/** The fixed half-life of the decay, in seconds. Not a launch parameter. */
export const FEE_HALF_LIFE_SECONDS = 600;

/** Elapsed seconds from which the decay is exactly zero (2^17). */
export const DECAY_ZERO_FROM = 131072n;

/**
 * round(2^128 * 2^(-2^i / 600)) for bits 0..16, as in the contract's feeDecay.sol. The contract applies bit 0 as
 * 2^128 minus a constant; the product is the same.
 */
export const DECAY_TABLE_Q128: readonly bigint[] = Object.freeze([
  339889484297159900493648602831395569057n,
  339497055287118257930533248299650400736n,
  338713556013920184336129943844147573651n,
  337151977828609613753562640265082287810n,
  334050386396171404885545237344599070716n,
  327932539264834336949184815807600758235n,
  316030922441737935988095136387330274498n,
  293507844215098455952964317090465751204n,
  253162852354938356992240649094357060196n,
  188347784201757897225807540435664088841n,
  104251325552682051605813724741512712010n,
  31939177389160626453527783486618815759n,
  2997836947964109484105344435429137776n,
  26410496811510722015611852309540293n,
  2049810421099131403277778219901n,
  12347753427443481862030n,
  448060n,
]);

/**
 * decayQ128: 2^(-elapsed / 600) in Q128. Starting at 2^128, multiply by the table constant of every set bit of
 * `elapsed` in ascending bit order and floor after each multiply; zero from 2^17 seconds. The order is normative.
 */
export function decayQ128(elapsed: bigint): bigint {
  if (elapsed < 0n) throw new ZeroSeedError("unsigned_domain");
  if (elapsed >= DECAY_ZERO_FROM) return 0n;
  let result = Q128;
  for (let bit = 0; bit < DECAY_TABLE_Q128.length; bit++) {
    if (((elapsed >> BigInt(bit)) & 1n) === 1n) result = (result * DECAY_TABLE_Q128[bit]) / Q128;
  }
  return result;
}

export interface FeeSchedule {
  tradingStart: bigint;
  feeDuration: bigint;
  initialFee: bigint;
  finalFee: bigint;
}

/** Same domain as the contract's creation validation, minus the cap (indexed data is checked, not capped). */
export function checkSchedule(schedule: FeeSchedule): void {
  const { tradingStart, feeDuration, initialFee, finalFee } = schedule;
  for (const [value, bits] of [[tradingStart, 64], [feeDuration, 32], [initialFee, 64], [finalFee, 64]] as const) {
    if (value < 0n || value >= 1n << BigInt(bits)) throw new ZeroSeedError("unsigned_domain");
  }
  if (feeDuration === 0n || finalFee > initialFee) throw new ZeroSeedError("invalid_fee_schedule");
}

/**
 * The contract's decayedFee over elapsed = timestamp - tradingStart: the initial fee at or before trading start, the
 * final fee from start + duration, and in between finalFee + floor((initialFee - finalFee) * (decay(t) - decay(D)) /
 * (2^128 - decay(D))). Elapsed time is not narrowed.
 */
export function feeAt(schedule: FeeSchedule, timestamp: bigint): bigint {
  checkSchedule(schedule);
  const { tradingStart, feeDuration, initialFee, finalFee } = schedule;
  if (timestamp <= tradingStart) return initialFee;
  const elapsed = timestamp - tradingStart;
  if (elapsed >= feeDuration) return finalFee;
  const endpoint = decayQ128(feeDuration);
  return finalFee + ((initialFee - finalFee) * (decayQ128(elapsed) - endpoint)) / (Q128 - endpoint);
}

/**
 * Q0.64 fee as a percentage to four decimals, rounding half up, except that a fee below 2^64 never rounds up to
 * 100%: rates from 99.99995% to the maximum show as 99.9999%.
 */
export function feePercent(q64: bigint): string {
  const rounded = (q64 * 1_000_000n + (1n << 63n)) >> 64n;
  const scaled = q64 < Q64 && rounded === 1_000_000n ? 999_999n : rounded;
  return `${scaled / 10_000n}.${(scaled % 10_000n).toString().padStart(4, "0")}%`;
}

/** 2^64 / (2^64 - rate) to two decimals, rounded down: the exact-output input multiplier. */
export function exactOutputMultiplier(rate: bigint): string {
  const hundredths = (Q64 * 100n) / (Q64 - rate);
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
}

export type FeePhase = "before_trading_start" | "fee_decay" | "final_fee";

/** Phase labels: the exclusive start and end of the decay window. */
export function feePhase(schedule: FeeSchedule, timestamp: bigint): FeePhase {
  if (timestamp < schedule.tradingStart) return "before_trading_start";
  return timestamp < schedule.tradingStart + schedule.feeDuration ? "fee_decay" : "final_fee";
}

/**
 * The first elapsed second at which the excess over the final fee is at most half the initial excess, found from
 * the exact integer schedule (monotone). It equals the 600 s half-life only when the duration is long; the
 * endpoint rescaling makes it shorter for short windows. Null for a flat schedule.
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
