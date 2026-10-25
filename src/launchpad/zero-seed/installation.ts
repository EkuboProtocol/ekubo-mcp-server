import { type Address, encodeFunctionData, type Hex } from "viem";
import { z } from "zod";
import { peripheryAbi } from "./abi.js";
import { DEFAULT_DECAY_RATE_X32, decayRateForHalfLife, MAX_CREATOR_FEE } from "./fee.js";
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

const UINT64_MAX = (1n << 64n) - 1n;
const DECAY_RATE_DESCRIPTION =
  "uint64 Q32.32 ticks/s (2^32 = 1 tick/s): 68913100933 = one-day half-life (default), 9923486534471 = 600 s, 0 = flat at initialFee";
const decayRateX32 = z.string({ error: "must be a decimal string; a JSON number cannot carry every uint64 exactly" })
  .regex(CANONICAL_DECIMAL, { abort: true, message:
    "must be a canonical decimal string: digits only, no leading zeros, sign, spaces, hex, exponent or fraction" })
  .refine((value) => BigInt(value) <= UINT64_MAX, { message: `must be at most ${UINT64_MAX} (uint64 max)` })
  .describe(DECAY_RATE_DESCRIPTION);

/** The LaunchParameters fields in tuple order, with the decay field (or fields) in the 10th position. */
const parameterFields = <D extends z.ZodRawShape>(decay: D) => ({
  name: z.string(), symbol: z.string(), decimals: z.number().int().min(0).max(255),
  supply: decimal.describe("Requested raw supply (totalSupply)"),
  quoteToken: address.default(NATIVE_QUOTE).describe("Quote token; address(0) is native ETH"),
  askTick: z.number().int().min(-88722835).max(88722835),
  upperTick: z.number().int().min(-88722835).max(88722835),
  tickSpacing: z.number().int().min(1).max(698605), tradingStart: decimal,
  ...decay,
  initialFee: feeQ64(`uint64 Q0.64 creator fee at trading start (value / 2^64): 0 to ${MAX_CREATOR_FEE}, just under 100%`),
  finalFee: feeQ64("Long-run floor the fee approaches, not an end date; same encoding, <= initialFee"),
  salt: bytes32.describe("The owner's salt; the periphery and extension namespace it by owner and controller"),
});
const RISING_FEE = {
  path: ["finalFee"],
  message: "invalid_fee_schedule: finalFee must be at most initialFee (the contract refuses a rising fee with InvalidFeeSchedule)",
};
const notRising = (input: { initialFee: string; finalFee: string }) =>
  !isFee(input.initialFee) || !isFee(input.finalFee) || BigInt(input.finalFee) <= BigInt(input.initialFee);

/**
 * LaunchParameters of evm-contracts 3d6378f (tick_rate_v2), in tuple order. `supply` is the requested supply,
 * submitted unchanged: the contract derives the liquidity from it and mints the uninstallable remainder to
 * address(0). `decayRateX32` replaces the earlier `feeDuration`: finalFee is a floor the fee approaches, with no end
 * time. Like the contract, the schedule needs only finalFee <= initialFee (InvalidFeeSchedule); every uint64 rate,
 * 0 included, and every uint64 fee are accepted.
 */
export const Parameters = z.strictObject(parameterFields({ decayRateX32 })).refine(notRising, RISING_FEE);
export type ParametersInput = z.infer<typeof Parameters>;

const HALF_LIFE_DESCRIPTION =
  "Or the half-life of the excess over finalFee, seconds with up to 6 decimals, converted exactly; its rate must be 1 to uint64 max";

/**
 * The tool input: LaunchParameters with the decay given as decayRateX32 or as halfLifeSeconds, never both; neither
 * means the one-day default. resolveParameters turns it into the exact tuple.
 */
export const CreateParameters = z.strictObject(parameterFields({
  decayRateX32: decayRateX32.optional(),
  halfLifeSeconds: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/, {
    message: "must be a decimal string of seconds with at most 6 decimals, for example \"86400\" or \"600.5\"",
  }).optional().describe(HALF_LIFE_DESCRIPTION),
})).refine(notRising, RISING_FEE).refine((input) => input.decayRateX32 === undefined || input.halfLifeSeconds === undefined, {
  path: ["halfLifeSeconds"], message: "give decayRateX32 or halfLifeSeconds, not both",
});
export type CreateParametersInput = z.input<typeof CreateParameters>;

/** The exact tuple of a tool input; a half-life whose rate would be 0 or above uint64 is refused, not clamped. */
export function resolveParameters(input: CreateParametersInput): ParametersInput {
  const { halfLifeSeconds, decayRateX32: rate, ...rest } = CreateParameters.parse(input);
  const resolved = halfLifeSeconds !== undefined ? decayRateForHalfLife(halfLifeSeconds) : rate ?? DEFAULT_DECAY_RATE_X32;
  return Parameters.parse({ ...rest, decayRateX32: resolved.toString() });
}
export const BuildContext = z.strictObject({
  buildTime: decimal, executionExpiry: decimal,
  blockNumber: decimal, blockHash: bytes32, blockTime: decimal,
});
export type BuildInput = z.infer<typeof BuildContext>;

export function requireLocalPin(pin: InstancePin): void {
  if (supportedInstances([pin], true).length !== 1) throw new ZeroSeedError("launch_support_disabled");
}

/**
 * New launches are prepared only for a tick_rate_v2 instance. A fixed_base_duration_v1 instance keeps its reads,
 * decoding and claims, but no create or preview is ever built for it.
 */
export function requireCreatablePin(pin: InstancePin): void {
  requireLocalPin(pin);
  if (pin.feeModel !== "tick_rate_v2") throw new ZeroSeedError("unsupported_fee_model");
}

/** The launch's own quote on the pin's chain; only native ETH or a reviewed ERC-20 is supported. */
export function quoteOf(input: ParametersInput, pin: InstancePin): LaunchQuote {
  return launchQuote(pin.chainId, input.quoteToken, true);
}

export function validateParameters(input: ParametersInput, pin: InstancePin): LaunchQuote {
  requireCreatablePin(pin);
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

/** Creation validation of the contract: any uint64 fee and rate, InvalidFeeSchedule when the fee would rise. */
function validateFees(input: ParametersInput): void {
  const initial = unsigned(BigInt(input.initialFee), 64);
  const final = unsigned(BigInt(input.finalFee), 64);
  unsigned(BigInt(input.decayRateX32), 64);
  if (final > initial) throw new ZeroSeedError("invalid_fee_schedule");
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
    tradingStart: BigInt(input.tradingStart), decayRateX32: BigInt(input.decayRateX32),
    initialFee: BigInt(input.initialFee), finalFee: BigInt(input.finalFee),
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
