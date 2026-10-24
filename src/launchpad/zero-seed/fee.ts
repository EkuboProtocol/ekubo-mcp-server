import { ZeroSeedError } from "./policy.js";

/** 2^64: the Q0.64 unit. Exactly 100% is not encodable as a uint64 fee. */
export const Q64 = 1n << 64n;
/** 2^128: the Q128 unit of the decay chain. */
export const Q128 = 1n << 128n;
const MAX_U128 = (1n << 128n) - 1n;
const MAX_I128 = (1n << 127n) - 1n;

/**
 * type(uint64).max: the largest creator fee, 1 - 2^-64 of the amount, just under 100%. Every uint64 is a valid
 * initial or final fee; the contract checks only finalFee <= initialFee (and, for fixed_base_duration_v1,
 * feeDuration > 0).
 */
export const MAX_CREATOR_FEE = Q64 - 1n;

// fixed_base_duration_v1 (evm-contracts 43d6628), unchanged: read-only for launches of that model.

/** The fixed half-life of the v1 decay, in seconds. Not a launch parameter. */
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

// tick_rate_v2 (evm-contracts 3d6378f, src/math/feeDecay.sol): the excess over the long-run floor finalFee shrinks
// by tickToSqrtRatio(-m), about 1.000001^(-m/2), where m = floor(decayRateX32 * elapsed / 2^32) is the tick
// magnitude the Q32.32 rate has accumulated. There is no end time.

/** Largest tick magnitude of the tick helper. */
export const MAX_TICK_MAGNITUDE = 88722835n;
/** (MAX_TICK_MAGNITUDE + 1) * 2^32 - 1: above it the fee saturates to finalFee instead of calling the helper. */
export const MAX_DECAY_PRODUCT = ((MAX_TICK_MAGNITUDE + 1n) << 32n) - 1n;
/**
 * floor(2 * ln 2 / ln 1.000001 * 2^32 * 10^30): the Q32.32 ticks per half-life of the excess, scaled by 10^30. The
 * normative integer every half-life <-> rate conversion uses; never a float.
 */
export const HALF_LIFE_X32_E30 = 5954091920683119788732747343471285361579197626n;
/** The default decayRateX32: a one-day half-life of the excess over the floor, floor(HALF_LIFE_X32_E30 / 86400e30). */
export const DEFAULT_DECAY_RATE_X32 = 68913100933n;

/**
 * Multipliers of tickToSqrtRatio for a negative tick (evm-contracts src/math/ticks.sol): bit 0 subtracts the first
 * constant from 2^128, every higher set bit multiplies by its constant and floors (>> 128), in ascending bit order.
 */
const TICK_BIT0 = 0x8637b66cd638344daef276cd7c5n;
const TICK_TABLE: readonly bigint[] = Object.freeze([
  0xffffef390978c398134b4ff3764fe410n, 0xffffde72140b00a354bd3dc828e976c9n, 0xffffbce42c7be6c998ad6318193c0b18n,
  0xffff79c86a8f6150a32d9778eceef97cn, 0xfffef3911b7cff24ba1b3dbb5f8f5974n, 0xfffde72350725cc4ea8feece3b5f13c8n,
  0xfffbce4b06c196e9247ac87695d53c60n, 0xfff79ca7a4d1bf1ee8556cea23cdbaa5n, 0xffef3995a5b6a6267530f207142a5764n,
  0xffde7444b28145508125d10077ba83b8n, 0xffbceceeb791747f10df216f2e53ec57n, 0xff79eb706b9a64c6431d76e63531e929n,
  0xfef41d1a5f2ae3a20676bec6f7f9459an, 0xfde95287d26d81bea159c37073122c73n, 0xfbd701c7cbc4c8a6bb81efd232d1e4e7n,
  0xf7bf5211c72f5185f372aeb1d48f937en, 0xefc2bf59df33ecc28125cf78ec4f167fn, 0xe08d35706200796273f0b3a981d90cfdn,
  0xc4f76b68947482dc198a48a54348c4edn, 0x978bcb9894317807e5fa4498eee7c0fan, 0x59b63684b86e9f486ec54727371ba6can,
  0x1f703399d88f6aa83a28b22d4a1f56e3n, 0x3dc5dac7376e20fc8679758d1bcdcfcn, 0xee7e32d61fdb0a5e622b820f681d0n,
  0xde2ee4bc381afa7089aa84bb66n, 0xc0d55d4d7152c25fb139n,
]);

/**
 * toFixed(tickToSqrtRatio(-magnitude)): the Q128 factor the pool math uses, after the compact SqrtRatio encoding
 * rounds the ratio down (mantissa of 94 bits: below 2^96 the low 2 bits are dropped, below 2^128 the low 34, at
 * 2^128 exactly the low 66, which are zero).
 */
export function tickFactorQ128(magnitude: bigint): bigint {
  if (magnitude < 0n || magnitude > MAX_TICK_MAGNITUDE) throw new ZeroSeedError("unsigned_domain");
  let ratio = Q128 - (magnitude & 1n) * TICK_BIT0;
  for (let bit = 1; bit <= TICK_TABLE.length; bit++) {
    if (((magnitude >> BigInt(bit)) & 1n) === 1n) ratio = (ratio * TICK_TABLE[bit - 1]) >> 128n;
  }
  const dropped = ratio < 1n << 96n ? 2n : ratio < Q128 ? 34n : 66n;
  return (ratio >> dropped) << dropped;
}

/**
 * The contract's tick-rate decayedFee over `elapsed` seconds after trading start, in its normative order: rate 0
 * keeps initialFee; elapsed > MAX_DECAY_PRODUCT / rate saturates to finalFee; otherwise
 * finalFee + floor((initialFee - finalFee) * tickFactorQ128(floor(rate * elapsed / 2^32)) / 2^128).
 */
export function tickRateDecayedFee(initialFee: bigint, finalFee: bigint, decayRateX32: bigint, elapsed: bigint): bigint {
  if (elapsed < 0n) throw new ZeroSeedError("unsigned_domain");
  if (decayRateX32 === 0n) return initialFee;
  if (elapsed > MAX_DECAY_PRODUCT / decayRateX32) return finalFee;
  return finalFee + (((initialFee - finalFee) * tickFactorQ128((decayRateX32 * elapsed) >> 32n)) >> 128n);
}

export interface TickRateSchedule {
  tradingStart: bigint;
  decayRateX32: bigint;
  initialFee: bigint;
  finalFee: bigint;
}

/** Creation validation of tick_rate_v2: every uint64 rate, 0 included; only a rising fee is refused. */
export function checkTickRateSchedule(schedule: TickRateSchedule): void {
  const { tradingStart, decayRateX32, initialFee, finalFee } = schedule;
  for (const value of [tradingStart, decayRateX32, initialFee, finalFee]) {
    if (value < 0n || value >= Q64) throw new ZeroSeedError("unsigned_domain");
  }
  if (finalFee > initialFee) throw new ZeroSeedError("invalid_fee_schedule");
}

/** feeAt of a tick_rate_v2 launch: initialFee at or before trading start; elapsed time is not narrowed. */
export function tickRateFeeAt(schedule: TickRateSchedule, timestamp: bigint): bigint {
  checkTickRateSchedule(schedule);
  if (timestamp <= schedule.tradingStart) return schedule.initialFee;
  return tickRateDecayedFee(schedule.initialFee, schedule.finalFee, schedule.decayRateX32, timestamp - schedule.tradingStart);
}

export type TickRatePhase = "before_trading_start" | "decaying" | "at_floor" | "constant";

/**
 * The API v5 phase labels: before trading start; at_floor once the fee equals the floor (by rounding or
 * saturation, and for a flat schedule at the floor); constant for rate 0 above the floor; otherwise decaying.
 */
export function tickRatePhase(schedule: TickRateSchedule, timestamp: bigint): TickRatePhase {
  if (timestamp < schedule.tradingStart) return "before_trading_start";
  if (tickRateFeeAt(schedule, timestamp) === schedule.finalFee) return "at_floor";
  return schedule.decayRateX32 === 0n ? "constant" : "decaying";
}

/** floor(MAX_DECAY_PRODUCT / rate): the last elapsed second the curve is evaluated at; null for rate 0. */
export function saturationElapsedSeconds(decayRateX32: bigint): bigint | null {
  return decayRateX32 === 0n ? null : MAX_DECAY_PRODUCT / decayRateX32;
}

/**
 * The half-life of the excess over the floor for a rate, display only: floor(HALF_LIFE_X32_E30 * 10^6 / (rate *
 * 10^30)) microseconds as `S.uuuuuu`, or null for rate 0.
 */
export function halfLifeSeconds(decayRateX32: bigint): string | null {
  if (decayRateX32 < 0n || decayRateX32 >= Q64) throw new ZeroSeedError("unsigned_domain");
  if (decayRateX32 === 0n) return null;
  const micros = HALF_LIFE_X32_E30 / (decayRateX32 * 10n ** 24n);
  return `${micros / 1_000_000n}.${(micros % 1_000_000n).toString().padStart(6, "0")}`;
}

const HALF_LIFE = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;

/**
 * decayRateX32 for a half-life given as a decimal string of seconds with at most 6 decimals:
 * floor(HALF_LIFE_X32_E30 / (microseconds * 10^24)), the same rational as the integer-seconds and milliseconds
 * forms. A half-life must give a rate of at least 1 that fits uint64; a flat fee is decayRateX32 = 0, not a
 * half-life.
 */
export function decayRateForHalfLife(seconds: string): bigint {
  const match = HALF_LIFE.exec(seconds);
  if (match === null) throw new ZeroSeedError("invalid_half_life");
  const micros = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? ".").slice(1).padEnd(6, "0"));
  if (micros === 0n) throw new ZeroSeedError("invalid_half_life");
  const rate = HALF_LIFE_X32_E30 / (micros * 10n ** 24n);
  if (rate === 0n || rate >= Q64) throw new ZeroSeedError("invalid_half_life");
  return rate;
}

/**
 * The first elapsed second at which the excess over the floor is at most half the initial excess, from the exact
 * integer schedule (monotone). Null for a flat schedule (rate 0 or initialFee = finalFee).
 */
export function tickRateExcessHalvingTime(schedule: TickRateSchedule): bigint | null {
  checkTickRateSchedule(schedule);
  const spread = schedule.initialFee - schedule.finalFee;
  const saturation = saturationElapsedSeconds(schedule.decayRateX32);
  if (spread === 0n || saturation === null) return null;
  const halved = (t: bigint) =>
    2n * (tickRateDecayedFee(schedule.initialFee, schedule.finalFee, schedule.decayRateX32, t) - schedule.finalFee) <= spread;
  let low = 1n;
  let high = saturation + 1n;
  while (low < high) {
    const middle = (low + high) / 2n;
    if (halved(middle)) high = middle;
    else low = middle + 1n;
  }
  return low;
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
