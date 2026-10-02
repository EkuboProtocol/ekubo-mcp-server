/**
 * Exact decimal rendering for ratios and means. Token amounts stay integers
 * in raw units; these helpers only render derived figures, truncated (never
 * rounded up) to a fixed number of places so results are deterministic.
 */

export const RATIO_PLACES = 6;

export function decimalString(
  numerator: bigint,
  denominator: bigint,
  places = RATIO_PLACES,
): string {
  if (denominator === 0n) throw new Error("division by zero");
  const negative = numerator < 0n !== denominator < 0n && numerator !== 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const whole = n / d;
  const scale = 10n ** BigInt(places);
  const fraction = ((n % d) * scale) / d;
  const digits = fraction.toString().padStart(places, "0").replace(/0+$/, "");
  const body = digits === "" ? whole.toString() : `${whole}.${digits}`;
  return negative ? `-${body}` : body;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** An exact rational in lowest terms, with a truncated decimal rendering beside it. */
export interface Ratio {
  num: string;
  den: string;
  decimal: string;
}

export function ratio(numerator: bigint, denominator: bigint): Ratio {
  const divisor = gcd(numerator, denominator) || 1n;
  const sign = denominator < 0n ? -1n : 1n;
  return {
    num: ((sign * numerator) / divisor).toString(),
    den: ((sign * denominator) / divisor).toString(),
    decimal: decimalString(numerator, denominator),
  };
}

/** A share as an exact fraction, or null when the base is zero or unknown. */
export function share(part: bigint, whole: bigint | null): Ratio | null {
  if (whole === null || whole === 0n) return null;
  return ratio(part, whole);
}

export function sum(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

export function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export const FEE_DENOMINATOR = 1n << 64n;

/** Ekubo fees are a 0.64 fixed-point fraction of the amount. */
export function feeView(raw: bigint) {
  return {
    q64: raw.toString(),
    fraction: ratio(raw, FEE_DENOMINATOR),
    percent: decimalString(raw * 100n, FEE_DENOMINATOR, 8),
  };
}
