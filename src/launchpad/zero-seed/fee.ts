// The creator fee of the final launch extension: a shifted exponential in Q0.64, decaying at decayRateX32 (unsigned
// Q32.32 ticks per second) from initialFee towards the finalFee floor. Every step mirrors the contract's integer
// operations in order: fee = finalFee + ((initialFee - finalFee) * toFixed(tickToSqrtRatio(-m))) >> 128 with
// m = (decayRateX32 * elapsed) >> 32, saturating to finalFee once elapsed > MAX_DECAY_PRODUCT / decayRateX32.

export const Q64 = 1n << 64n;
const Q128 = 1n << 128n;
export const MAX_FEE = Q64 - 1n;
const MAX_TICK_MAGNITUDE = 88722835n;
export const MAX_DECAY_PRODUCT = ((MAX_TICK_MAGNITUDE + 1n) << 32n) - 1n;
/** floor(2 * ln 2 / ln 1.000001 * 2^32 * 10^30): Q32.32 ticks per half-life of the excess, scaled by 10^30. */
const HALF_LIFE_X32_E30 = 5954091920683119788732747343471285361579197626n;
/** One-day half-life of the excess: floor(HALF_LIFE_X32_E30 / 86400e30). */
export const DEFAULT_DECAY_RATE_X32 = 68913100933n;
/** Consumer defaults: 50% at trading start, a 0.3% floor. */
export const DEFAULT_INITIAL_FEE = Q64 / 2n;
export const DEFAULT_FINAL_FEE = 55340232221128654n;

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

/** toFixed(tickToSqrtRatio(-magnitude)), including the compact encoding's round-down of the low bits. */
function tickFactorQ128(magnitude: bigint): bigint {
  let ratio = Q128 - (magnitude & 1n) * TICK_BIT0;
  for (let bit = 1; bit <= TICK_TABLE.length; bit++) {
    if (((magnitude >> BigInt(bit)) & 1n) === 1n) ratio = (ratio * TICK_TABLE[bit - 1]) >> 128n;
  }
  const dropped = ratio < 1n << 96n ? 2n : ratio < Q128 ? 34n : 66n;
  return (ratio >> dropped) << dropped;
}

export interface FeeSchedule {
  tradingStart: bigint;
  decayRateX32: bigint;
  initialFee: bigint;
  finalFee: bigint;
}

/** feeAt(poolId, timestamp): initialFee at or before trading start. */
export function feeAt(schedule: FeeSchedule, timestamp: bigint): bigint {
  const { tradingStart, decayRateX32, initialFee, finalFee } = schedule;
  if (timestamp <= tradingStart || decayRateX32 === 0n) return initialFee;
  const elapsed = timestamp - tradingStart;
  if (elapsed > MAX_DECAY_PRODUCT / decayRateX32) return finalFee;
  return finalFee + (((initialFee - finalFee) * tickFactorQ128((decayRateX32 * elapsed) >> 32n)) >> 128n);
}

export type FeePhase = "before_trading_start" | "decaying" | "at_floor" | "constant";

/** before_trading_start; at_floor once the fee equals the floor; constant for rate 0 above the floor; else decaying. */
export function feePhase(schedule: FeeSchedule, timestamp: bigint): FeePhase {
  if (timestamp < schedule.tradingStart) return "before_trading_start";
  if (feeAt(schedule, timestamp) === schedule.finalFee) return "at_floor";
  return schedule.decayRateX32 === 0n ? "constant" : "decaying";
}

/** The first elapsed second at which the excess over the floor is at most half the initial excess; null when flat. */
export function excessHalvingSeconds(schedule: FeeSchedule): bigint | null {
  const spread = schedule.initialFee - schedule.finalFee;
  const saturation = saturationSeconds(schedule.decayRateX32);
  if (spread === 0n || saturation === null) return null;
  let low = 1n;
  let high = saturation + 1n;
  while (low < high) {
    const middle = (low + high) / 2n;
    if (2n * (feeAt(schedule, schedule.tradingStart + middle) - schedule.finalFee) <= spread) high = middle;
    else low = middle + 1n;
  }
  return low;
}

/** 2^64 / (2^64 - fee) to two decimals, rounded down: the exact-output input multiplier at that fee. */
export function exactOutputMultiplier(fee: bigint): string {
  const hundredths = (Q64 * 100n) / (Q64 - fee);
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
}

/** The last elapsed second evaluated through the curve; after it the fee is exactly finalFee. Null for rate 0. */
export function saturationSeconds(decayRateX32: bigint): bigint | null {
  return decayRateX32 === 0n ? null : MAX_DECAY_PRODUCT / decayRateX32;
}

/** Half-life of the excess over the floor, seconds with 6 decimals (floored); null for rate 0. Display only. */
export function halfLifeSeconds(decayRateX32: bigint): string | null {
  if (decayRateX32 === 0n) return null;
  const micros = HALF_LIFE_X32_E30 / (decayRateX32 * 10n ** 24n);
  return `${micros / 1_000_000n}.${(micros % 1_000_000n).toString().padStart(6, "0")}`;
}

const SECONDS = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/;

/** decayRateX32 for a half-life in seconds (up to 6 decimals); null when it is malformed or its rate is 0 or > uint64. */
export function decayRateForHalfLife(seconds: string): bigint | null {
  const match = SECONDS.exec(seconds);
  if (match === null) return null;
  const micros = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  if (micros === 0n) return null;
  const rate = HALF_LIFE_X32_E30 / (micros * 10n ** 24n);
  return rate === 0n || rate > MAX_FEE ? null : rate;
}

const PERCENT = /^(0|[1-9][0-9]?|100)(?:\.([0-9]{1,18}))?$/;

/** A percentage as a Q0.64 fraction, rounded down; null when malformed or not below 100%. */
export function percentToQ64(percent: string): bigint | null {
  const match = PERCENT.exec(percent);
  if (match === null) return null;
  const fraction = match[2] ?? "";
  const value = (BigInt(match[1] + fraction) * Q64) / (10n ** BigInt(fraction.length) * 100n);
  return value > MAX_FEE ? null : value;
}

/** Q0.64 as a percentage with 4 decimals, rounded half up but never shown as 100%. Display only. */
export function feePercent(q64: bigint): string {
  const rounded = (q64 * 1_000_000n + (1n << 63n)) >> 64n;
  const scaled = q64 < Q64 && rounded === 1_000_000n ? 999_999n : rounded;
  return `${scaled / 10_000n}.${(scaled % 10_000n).toString().padStart(4, "0")}%`;
}

const SAMPLE_OFFSETS = [0n, 3_600n, 21_600n, 86_400n, 172_800n, 604_800n, 2_592_000n];

/** The fee at fixed offsets after trading start, for display; exact Q0.64 values and their percentages. */
export function feeCurve(schedule: FeeSchedule) {
  return SAMPLE_OFFSETS.map((offset) => {
    const fee = feeAt(schedule, schedule.tradingStart + offset);
    return { seconds_after_start: offset.toString(), fee_q64: fee.toString(), fee_percent: feePercent(fee) };
  });
}

/** The fee schedule as the tools report it. */
export function describeSchedule(schedule: FeeSchedule) {
  const saturation = saturationSeconds(schedule.decayRateX32);
  return {
    trading_start: schedule.tradingStart.toString(),
    initial_fee_q64: schedule.initialFee.toString(),
    final_fee_q64: schedule.finalFee.toString(),
    initial_fee_percent: feePercent(schedule.initialFee),
    final_fee_percent: feePercent(schedule.finalFee),
    decay_rate_x32: schedule.decayRateX32.toString(),
    half_life_seconds: halfLifeSeconds(schedule.decayRateX32),
    saturation_seconds: saturation === null ? null : saturation.toString(),
  };
}
