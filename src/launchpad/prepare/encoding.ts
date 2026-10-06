import { type Address, encodeAbiParameters, type Hex, keccak256, numberToHex } from "viem";

/**
 * Bit layouts of the contracts' user-defined value types, mirrored from
 * `types/poolConfig.sol` and `types/poolKey.sol` at the bundled revision.
 */

export const MIN_TICK = -88722835;
export const MAX_TICK = 88722835;
export const MAX_TICK_SPACING = 698605;
/** `MAX_MIGRATION_TICK_WIDTH` in ScheduledLaunch.sol: 1.000001^2302585 is just under a 10x price ratio. */
export const MAX_MIGRATION_TICK_WIDTH = 2_302_585;
/**
 * The hosted limit, narrower than the contract's: 1.000001^693147 is just
 * under a 2x price ratio. The contract ceiling is not a recommendation.
 */
export const HOSTED_MAX_MIGRATION_TICK_WIDTH = 693_147;
export const INT128_MAX = (1n << 127n) - 1n;
export const Q64 = 1n << 64n;

export interface PoolKey {
  token0: Address;
  token1: Address;
  config: Hex;
}

const word = (value: bigint): Hex => numberToHex(value, { size: 32 });

/** `createConcentratedPoolConfig(fee, tickSpacing, extension)`. */
export function concentratedPoolConfig(fee: bigint, tickSpacing: number, extension: Address): Hex {
  const typeConfig = 0x80000000n | (BigInt(tickSpacing) & 0x7fffffffn);
  return word((BigInt(extension) << 96n) | (fee << 32n) | typeConfig);
}

/** `PoolKey.toPoolId`: keccak256 over the key's three 32-byte words. */
export function poolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "bytes32" }],
      [key.token0, key.token1, key.config],
    ),
  );
}

/**
 * Quote units per whole launch token at an economic tick (raw quote per raw
 * token is 1.000001^tick), to 6 significant digits. Display only: every value
 * that reaches calldata stays an exact tick.
 */
export function priceAtTick(tick: number, tokenDecimals: number, quoteDecimals: number): string {
  const raw = Math.exp(tick * Math.log1p(1e-6));
  return (raw * 10 ** (tokenDecimals - quoteDecimals)).toPrecision(6);
}

/** A Q0.64 fee as a percentage string, rounded to at most 6 decimals. */
export function feePercent(fee: bigint): string {
  const scaled = (fee * 200_000_000n + Q64) / (2n * Q64);
  const whole = scaled / 1_000_000n;
  const fraction = (scaled % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction === "" ? `${whole}%` : `${whole}.${fraction}%`;
}

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}
