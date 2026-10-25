import { type Address, encodeAbiParameters, getAddress, type Hex, keccak256, numberToHex } from "viem";

export const MIN_TICK = -88722835;
export const MAX_TICK = 88722835;
/** Launch tokens always have 18 decimals; the contract has no decimals input. */
export const LAUNCH_DECIMALS = 18;
/** The contract's supply cap in base units (10^30), and the producer cap of one trillion whole tokens (10^30 too). */
export const MAX_SUPPLY = 10n ** 30n;
export const MAX_METADATA_BYTES = 31;

const encoder = new TextEncoder();

/**
 * Solady LibString.packOne: byte 0 is the UTF-8 byte length (1..31), the content follows and the tail is zero.
 * Refuses rather than truncates; returns null for an empty or too-long value.
 */
export function packOne(value: string): Hex | null {
  const bytes = encoder.encode(value);
  if (bytes.length < 1 || bytes.length > MAX_METADATA_BYTES) return null;
  const word = new Uint8Array(32);
  word[0] = bytes.length;
  word.set(bytes, 1);
  return `0x${[...word].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** The content of a canonical packOne word, or null when the word is not canonical. */
export function unpackOne(word: Hex): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(word)) return null;
  const bytes = Uint8Array.from(word.slice(2).match(/../g)!.map((pair) => parseInt(pair, 16)));
  const length = bytes[0];
  if (length < 1 || length > MAX_METADATA_BYTES || bytes.subarray(length + 1).some((byte) => byte !== 0)) return null;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(1, length + 1));
}

const floorDiv = (a: number, b: number) => Math.floor(a / b);
const ceilDiv = (a: number, b: number) => -Math.floor(-a / b);

export interface LaunchRange {
  tickSpacing: number;
  alignedAskTick: number;
  alignedUpperTick: number;
}

/**
 * src/math/launchRange.sol: spacing = ceil(width / 256), the ask rounded up and the top rounded down to it, with
 * mathematical signed ceil/floor (never truncation toward zero). Inputs are integers in the tick domain.
 */
export function launchRange(askTick: number, upperTick: number): LaunchRange {
  const tickSpacing = floorDiv(upperTick - askTick + 255, 256);
  return {
    tickSpacing,
    alignedAskTick: ceilDiv(askTick, tickSpacing) * tickSpacing,
    alignedUpperTick: floorDiv(upperTick, tickSpacing) * tickSpacing,
  };
}

const LN_BASE = Math.log1p(1e-6);
const LN_10 = Math.log(10);

/** ln of a positive bigint, from its leading 17 digits and its decimal exponent. */
function lnBig(value: bigint): number {
  const digits = value.toString();
  const head = Number(digits.slice(0, 17));
  return Math.log(head) + (digits.length - Math.min(17, digits.length)) * LN_10;
}

const PRICE = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,36}))?$/;

/**
 * The economic tick of a display price (quote token per whole launch token), rounded to the nearest tick: log base
 * 1.000001 of raw quote units per raw launch-token unit, independent of address order. Null when the price is not a
 * positive plain decimal or its tick is outside the tick domain. Double precision keeps the error far below one tick
 * across the domain.
 */
export function priceToTick(price: string, quoteDecimals: number): number | null {
  const match = PRICE.exec(price);
  if (match === null) return null;
  const fraction = match[2] ?? "";
  const numerator = BigInt(match[1] + fraction);
  if (numerator === 0n) return null;
  const exponent = quoteDecimals - LAUNCH_DECIMALS - fraction.length;
  const ln = lnBig(numerator) + exponent * LN_10;
  const tick = Math.round(ln / LN_BASE);
  return tick >= MIN_TICK && tick <= MAX_TICK ? tick : null;
}

/** The display price of an economic tick, about 15 significant digits; display only. */
export function tickToPrice(tick: number, quoteDecimals: number): string {
  const ln = tick * LN_BASE + (LAUNCH_DECIMALS - quoteDecimals) * LN_10;
  return Number(Math.exp(ln).toPrecision(15)).toString();
}

export interface PoolKey {
  token0: Address;
  token1: Address;
  config: Hex;
}

/** A concentrated pool config with fee 0: extension (20 bytes) | fee (8 bytes) | 1 bit concentrated | 31 bit spacing. */
export function launchPoolConfig(extension: Address, tickSpacing: number): Hex {
  return numberToHex((BigInt(extension) << 96n) | 0x80000000n | BigInt(tickSpacing), { size: 32 });
}

export function spacingOfConfig(config: Hex): number {
  return Number(BigInt(config) & 0x7fffffffn);
}

export function extensionOfConfig(config: Hex): Address {
  return getAddress(numberToHex(BigInt(config) >> 96n, { size: 20 }));
}

export function poolIdOf(key: PoolKey): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "bytes32" }],
    [key.token0, key.token1, key.config],
  ));
}
