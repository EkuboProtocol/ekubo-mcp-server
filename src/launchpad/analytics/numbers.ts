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

/** A share in [0, 1] as a decimal string, or null when the base is zero or unknown. */
export function share(part: bigint, whole: bigint | null): string | null {
  if (whole === null || whole === 0n) return null;
  return decimalString(part, whole);
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
    raw: raw.toString(),
    denominator: FEE_DENOMINATOR.toString(),
    fraction: decimalString(raw, FEE_DENOMINATOR, 8),
  };
}
