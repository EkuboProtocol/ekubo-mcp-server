import { type Address, encodeFunctionData, type Hex } from "viem";
import { z } from "zod";
import { zeroSeedAbi } from "./abi.js";
import { MAX_CREATOR_FEE } from "./fee.js";
import { type InstancePin, supportedInstances, unsigned, validateCreationTiming, validateMetadata, ZeroSeedError } from "./policy.js";

export const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const address = z.string().regex(/^0x[0-9a-f]{40}$/);
export const bytes32 = z.string().regex(/^0x[0-9a-f]{64}$/);
export const Parameters = z.strictObject({
  quoteToken: address, name: z.string(), symbol: z.string(), decimals: z.number().int().min(0).max(255),
  supply: decimal, liquidity: decimal,
  askTick: z.number().int().min(-88722835).max(88722835),
  upperTick: z.number().int().min(-88722835).max(88722835),
  tickSpacing: z.number().int().min(1).max(698605), tradingStart: decimal,
  feeDuration: z.number().int().min(1).max(4294967295), initialFee: decimal, finalFee: decimal,
  decayFactor: decimal.describe("Literal Q0.64 per-second multiplier in (0, 2^64), not a half-life"), salt: bytes32,
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

export function validateParameters(input: ParametersInput, pin: InstancePin): void {
  requireLocalPin(pin);
  Parameters.parse(input);
  validateMetadata(input.name);
  validateMetadata(input.symbol);
  if (input.quoteToken !== pin.quote) throw new ZeroSeedError("unsupported_quote");
  const supply = unsigned(BigInt(input.supply), 127);
  unsigned(BigInt(input.liquidity), 127);
  if (supply === 0n || input.askTick >= input.upperTick) throw new ZeroSeedError("invalid_parameters");
  if (input.askTick % input.tickSpacing !== 0 || input.upperTick % input.tickSpacing !== 0) {
    throw new ZeroSeedError("invalid_tick_spacing");
  }
  validateFees(input);
}

/** Creation validation of the draft contract: FeeTooHigh above the 99% cap, InvalidFeeSchedule otherwise. */
function validateFees(input: ParametersInput): void {
  const initial = unsigned(BigInt(input.initialFee), 64);
  const final = unsigned(BigInt(input.finalFee), 64);
  const factor = unsigned(BigInt(input.decayFactor), 64);
  if (initial > MAX_CREATOR_FEE) throw new ZeroSeedError("fee_too_high");
  if (final > initial || factor === 0n) throw new ZeroSeedError("invalid_fee_schedule");
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
    ...input, quoteToken: input.quoteToken as Address, salt: input.salt as Hex,
    supply: BigInt(input.supply), liquidity: BigInt(input.liquidity),
    tradingStart: BigInt(input.tradingStart), initialFee: BigInt(input.initialFee), finalFee: BigInt(input.finalFee),
    decayFactor: BigInt(input.decayFactor),
  };
}

export function previewData(creator: Address, input: ParametersInput): Hex {
  return encodeFunctionData({ abi: zeroSeedAbi, functionName: "previewInstallation", args: [creator, abiParameters(input)] });
}

export function createData(input: ParametersInput): Hex {
  return encodeFunctionData({ abi: zeroSeedAbi, functionName: "create", args: [abiParameters(input)] });
}
