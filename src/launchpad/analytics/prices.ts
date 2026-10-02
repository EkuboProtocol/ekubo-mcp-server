import { decimalString } from "./numbers.js";
import type { Address, PinnedPrice } from "./types.js";

/**
 * Ekubo ticks are powers of 1.000001: the pool price (token1 per token0, raw
 * units) at tick t is 1.000001^t. Computed in 10^48 fixed point by repeated
 * squaring; the relative error is far below the 18 significant digits shown.
 */
const SCALE = 10n ** 48n;
const BASE = SCALE + SCALE / 1_000_000n;

function mul(a: bigint, b: bigint): bigint {
  return (a * b) / SCALE;
}

function powScaled(exponent: number): bigint {
  let result = SCALE;
  let base = BASE;
  let e = Math.abs(exponent);
  while (e > 0) {
    if (e % 2 === 1) result = mul(result, base);
    base = mul(base, base);
    e = Math.floor(e / 2);
  }
  return exponent < 0 ? (SCALE * SCALE) / result : result;
}

/** Up to `digits` significant digits of numerator/denominator, as a plain decimal string. */
export function significant(numerator: bigint, denominator: bigint, digits = 18): string {
  if (numerator === 0n) return "0";
  const whole = numerator / denominator;
  if (whole > 0n) {
    const places = Math.max(0, digits - whole.toString().length);
    return decimalString(numerator, denominator, places);
  }
  let leading = 0;
  let scaled = numerator * 10n;
  while (scaled < denominator) {
    scaled *= 10n;
    leading += 1;
  }
  return decimalString(numerator, denominator, leading + digits);
}

/**
 * Quote per launch token at a tick in launch orientation (the orientation of
 * the config's ticks), in raw units and per whole unit when decimals are known.
 */
export function tickPrice(tick: number, tokenDecimals: number, quoteDecimals: number | null) {
  const scaled = powScaled(tick);
  const human =
    quoteDecimals === null
      ? null
      : significant(scaled * 10n ** BigInt(Math.max(0, tokenDecimals - quoteDecimals)), SCALE * 10n ** BigInt(Math.max(0, quoteDecimals - tokenDecimals)));
  return {
    tick,
    quote_per_token_raw: significant(scaled, SCALE),
    quote_per_token: human,
  };
}

function parseDecimal(value: string): { num: bigint; den: bigint } {
  const [whole, fraction = ""] = value.split(".");
  return { num: BigInt(whole + fraction), den: 10n ** BigInt(fraction.length) };
}

/** USD value of a raw quote amount from a pinned price, citing the source; null without one. */
export function usdValue(amount: bigint, asset: Address, prices: readonly PinnedPrice[]) {
  const price = prices.find((p) => p.asset === asset);
  if (price === undefined) return null;
  const { num, den } = parseDecimal(price.price_usd);
  return {
    value: decimalString(amount * num, den * 10n ** BigInt(price.decimals), 6),
    price_usd: price.price_usd,
    source: price.source,
    price_as_of: price.as_of,
  };
}
