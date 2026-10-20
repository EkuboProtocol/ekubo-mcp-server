import { type Address, encodeFunctionData, type Hex } from "viem";
import { z } from "zod";
import { peripheryAbi } from "./abi.js";
import { MAX_CREATOR_FEE } from "./fee.js";
import { type InstancePin, supportedInstances, unsigned, validateCreationTiming, validateMetadata, ZeroSeedError } from "./policy.js";

export const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const address = z.string().regex(/^0x[0-9a-f]{40}$/);
export const bytes32 = z.string().regex(/^0x[0-9a-f]{64}$/);
/** LaunchParameters: no quote token (the instance's constructor fixes it) and no decay factor (600 s half-life). */
export const Parameters = z.strictObject({
  name: z.string(), symbol: z.string(), decimals: z.number().int().min(0).max(255),
  supply: decimal, liquidity: decimal,
  askTick: z.number().int().min(-88722835).max(88722835),
  upperTick: z.number().int().min(-88722835).max(88722835),
  tickSpacing: z.number().int().min(1).max(698605), tradingStart: decimal,
  feeDuration: z.number().int().min(1).max(4294967295), initialFee: decimal, finalFee: decimal,
  salt: bytes32.describe("The owner's salt; the periphery and extension namespace it by owner and controller"),
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
  const supply = unsigned(BigInt(input.supply), 127);
  unsigned(BigInt(input.liquidity), 127);
  if (supply === 0n || input.askTick >= input.upperTick) throw new ZeroSeedError("invalid_parameters");
  if (input.askTick % input.tickSpacing !== 0 || input.upperTick % input.tickSpacing !== 0) {
    throw new ZeroSeedError("invalid_tick_spacing");
  }
  validateFees(input);
}

/** Creation validation of the contract: FeeTooHigh above the 99% cap, InvalidFeeSchedule otherwise. */
function validateFees(input: ParametersInput): void {
  const initial = unsigned(BigInt(input.initialFee), 64);
  const final = unsigned(BigInt(input.finalFee), 64);
  if (initial > MAX_CREATOR_FEE) throw new ZeroSeedError("fee_too_high");
  if (final > initial) throw new ZeroSeedError("invalid_fee_schedule");
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
    ...input, salt: input.salt as Hex,
    supply: BigInt(input.supply), liquidity: BigInt(input.liquidity),
    tradingStart: BigInt(input.tradingStart), initialFee: BigInt(input.initialFee), finalFee: BigInt(input.finalFee),
  };
}

/** periphery.previewInstallation(owner, parameters): the periphery namespaces the salt by owner. */
export function previewData(owner: Address, input: ParametersInput): Hex {
  return encodeFunctionData({ abi: peripheryAbi, functionName: "previewInstallation", args: [owner, abiParameters(input)] });
}

export function createData(input: ParametersInput): Hex {
  return encodeFunctionData({ abi: peripheryAbi, functionName: "create", args: [abiParameters(input)] });
}
