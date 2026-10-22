import { type Address, encodeFunctionData, type Hex } from "viem";
import { z } from "zod";
import { peripheryAbi } from "./abi.js";
import { MAX_CREATOR_FEE } from "./fee.js";
import { type InstancePin, launchQuote, type LaunchQuote, NATIVE_QUOTE, supportedInstances, unsigned, validateCreationTiming,
  validateMetadata, ZeroSeedError } from "./policy.js";

const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;
export const decimal = z.string().regex(CANONICAL_DECIMAL);
export const address = z.string().regex(/^0x[0-9a-f]{40}$/);
export const bytes32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const isFee = (value: string) => CANONICAL_DECIMAL.test(value) && BigInt(value) <= MAX_CREATOR_FEE;

/**
 * A creator fee: the canonical decimal string of a uint64 Q0.64 rate, every value 0..2^64 - 1 accepted. Anything
 * else is refused, never truncated or wrapped: 2^64 (exactly 100%) and above are not uint64.
 */
const feeQ64 = (description: string) => z.string({ error: "must be a decimal string; a JSON number cannot carry every uint64 exactly" })
  .regex(CANONICAL_DECIMAL, { abort: true, message:
    "must be a canonical decimal string: digits only, no leading zeros, sign, spaces, hex, exponent or fraction" })
  .refine((value) => BigInt(value) <= MAX_CREATOR_FEE, { message:
    `must be at most ${MAX_CREATOR_FEE} (uint64 max, just under 100%); 2^64 = ${MAX_CREATOR_FEE + 1n} would be exactly 100% and is not a uint64` })
  .describe(description);

/**
 * LaunchParameters of evm-contracts 43d6628, in tuple order. `supply` is the requested supply, submitted unchanged:
 * the contract derives the liquidity from it and mints the uninstallable remainder to address(0). There is no
 * liquidity input and no decay factor (600 s half-life). Like the contract, the fee schedule needs only
 * finalFee <= initialFee and feeDuration > 0 (InvalidFeeSchedule); there is no fee ceiling below uint64.
 */
export const Parameters = z.strictObject({
  name: z.string(), symbol: z.string(), decimals: z.number().int().min(0).max(255),
  supply: decimal.describe("Requested raw supply (totalSupply)"),
  quoteToken: address.default(NATIVE_QUOTE).describe("Quote token; address(0) is native ETH"),
  askTick: z.number().int().min(-88722835).max(88722835),
  upperTick: z.number().int().min(-88722835).max(88722835),
  tickSpacing: z.number().int().min(1).max(698605), tradingStart: decimal,
  feeDuration: z.number().int().min(1, { message: "must be at least 1 second (the contract refuses 0 with InvalidFeeSchedule)" })
    .max(4294967295),
  initialFee: feeQ64(`uint64 Q0.64 creator fee at trading start (value / 2^64): 0 to ${MAX_CREATOR_FEE}, just under 100%`),
  finalFee: feeQ64("Fee from tradingStart + feeDuration, same encoding, <= initialFee"),
  salt: bytes32.describe("The owner's salt; the periphery and extension namespace it by owner and controller"),
}).refine((input) => !isFee(input.initialFee) || !isFee(input.finalFee) || BigInt(input.finalFee) <= BigInt(input.initialFee), {
  path: ["finalFee"],
  message: "invalid_fee_schedule: finalFee must be at most initialFee (the contract refuses a rising fee with InvalidFeeSchedule)",
});
export type ParametersInput = z.infer<typeof Parameters>;
export const BuildContext = z.strictObject({
  buildTime: decimal, executionExpiry: decimal,
  blockNumber: decimal, blockHash: bytes32, blockTime: decimal,
});
export type BuildInput = z.infer<typeof BuildContext>;

export function requireLocalPin(pin: InstancePin): void {
  if (supportedInstances([pin], true).length !== 1) throw new ZeroSeedError("launch_support_disabled");
}

/** The launch's own quote on the pin's chain; only native ETH or a reviewed ERC-20 is supported. */
export function quoteOf(input: ParametersInput, pin: InstancePin): LaunchQuote {
  return launchQuote(pin.chainId, input.quoteToken, true);
}

export function validateParameters(input: ParametersInput, pin: InstancePin): LaunchQuote {
  requireLocalPin(pin);
  Parameters.parse(input);
  validateMetadata(input.name);
  validateMetadata(input.symbol);
  // Requested supply in 1..int128.max, as the contract requires.
  const supply = unsigned(BigInt(input.supply), 127);
  const quote = quoteOf(input, pin);
  if (supply === 0n || input.askTick >= input.upperTick) throw new ZeroSeedError("invalid_parameters");
  if (input.askTick % input.tickSpacing !== 0 || input.upperTick % input.tickSpacing !== 0) {
    throw new ZeroSeedError("invalid_tick_spacing");
  }
  validateFees(input);
  return quote;
}

/** Creation validation of the contract: any uint64 fee, InvalidFeeSchedule when the fee would rise. */
function validateFees(input: ParametersInput): void {
  const initial = unsigned(BigInt(input.initialFee), 64);
  const final = unsigned(BigInt(input.finalFee), 64);
  if (final > initial || input.feeDuration < 1) throw new ZeroSeedError("invalid_fee_schedule");
  unsigned(BigInt(input.tradingStart) + BigInt(input.feeDuration), 64);
}

export function validateBuild(input: ParametersInput, build: BuildInput, freshTime: bigint): void {
  BuildContext.parse(build);
  unsigned(BigInt(build.blockNumber), 256);
  unsigned(BigInt(build.blockTime), 64);
  if (build.blockTime !== build.buildTime) throw new ZeroSeedError("build_snapshot_mismatch");
  validateCreationTiming({
    buildTime: BigInt(build.buildTime), executionExpiry: BigInt(build.executionExpiry),
    tradingStart: BigInt(input.tradingStart),
  }, freshTime);
}

export function abiParameters(input: ParametersInput) {
  return {
    ...input, salt: input.salt as Hex, quoteToken: input.quoteToken as Address,
    supply: BigInt(input.supply),
    tradingStart: BigInt(input.tradingStart), initialFee: BigInt(input.initialFee), finalFee: BigInt(input.finalFee),
  };
}

/** periphery.previewInstallation(owner, parameters): the periphery namespaces the salt by owner. */
export function previewData(owner: Address, input: ParametersInput): Hex {
  return encodeFunctionData({ abi: peripheryAbi, functionName: "previewInstallation", args: [owner, abiParameters(input)] });
}

/** periphery.create(parameters) with the requested parameters exactly as previewed, supply included. */
export function createData(input: ParametersInput): Hex {
  return encodeFunctionData({ abi: peripheryAbi, functionName: "create", args: [abiParameters(input)] });
}
