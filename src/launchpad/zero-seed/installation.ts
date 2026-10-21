import { type Address, encodeFunctionData, type Hex } from "viem";
import { z } from "zod";
import { peripheryAbi } from "./abi.js";
import { MAX_CREATOR_FEE } from "./fee.js";
import { type InstancePin, launchQuote, type LaunchQuote, NATIVE_QUOTE, supportedInstances, unsigned, validateCreationTiming,
  validateMetadata, ZeroSeedError } from "./policy.js";

export const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const address = z.string().regex(/^0x[0-9a-f]{40}$/);
export const bytes32 = z.string().regex(/^0x[0-9a-f]{64}$/);
/**
 * LaunchParameters of evm-contracts 40af6cb, in tuple order. `supply` is the requested supply, submitted unchanged:
 * the contract derives the liquidity from it and mints the uninstallable remainder to address(0). There is no
 * liquidity input and no decay factor (600 s half-life).
 */
export const Parameters = z.strictObject({
  name: z.string(), symbol: z.string(), decimals: z.number().int().min(0).max(255),
  supply: decimal.describe("Requested raw supply (totalSupply)"),
  quoteToken: address.default(NATIVE_QUOTE).describe("Quote token; address(0) is native ETH"),
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
