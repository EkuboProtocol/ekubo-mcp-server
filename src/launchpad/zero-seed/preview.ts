import { type Address, decodeFunctionResult, encodeFunctionResult, type Hex, numberToHex } from "viem";
import { z } from "zod";
import { functionReadCall, readCallsBundle } from "../../abi-decode.js";
import type { ArtifactReference } from "../../artifact-store.js";
import { peripheryAbi, previewAbi } from "./abi.js";
import { address, BuildContext, type BuildInput, bytes32, decimal, Parameters, type ParametersInput,
  previewData, validateBuild, validateParameters } from "./installation.js";
import { type InstancePin, type LaunchQuote, NATIVE_QUOTE, unsigned, ZeroSeedError } from "./policy.js";
import { predictLaunchToken } from "./token.js";

export const PREVIEW_ID = "zero_seed_installation";
const PoolKey = z.strictObject({ token0: address, token1: address, config: bytes32 });
export const Installation = z.strictObject({
  token: address, poolKey: PoolKey, positionId: bytes32, initialTick: z.number().int(),
  liquidity: decimal, installedSupply: decimal,
});
export type InstallationInput = z.infer<typeof Installation>;
/**
 * Raw launch-token units, decimal strings. `requested` is LaunchParameters.supply (the token's totalSupply),
 * `installed` the amount the position takes, `sink` = requested - installed, minted to `sink_holder` = address(0).
 */
export const Supply = z.strictObject({
  requested: decimal, installed: decimal, sink: decimal, sink_holder: z.literal(NATIVE_QUOTE),
});
export type SupplyOutput = z.infer<typeof Supply>;

export function supplyOf(request: ParametersInput, installation: InstallationInput): SupplyOutput {
  const requested = BigInt(request.supply);
  const installed = BigInt(installation.installedSupply);
  if (installed === 0n || installed > requested) throw new ZeroSeedError("invalid_installation_amounts");
  return { requested: requested.toString(), installed: installed.toString(), sink: (requested - installed).toString(),
    sink_holder: NATIVE_QUOTE };
}

// Synthetic adapter contract, not a claim about connected-wallet result shapes.
export interface SyntheticPreviewWallet {
  storeRead(body: ReturnType<typeof readCallsBundle>): Promise<ArtifactReference>;
  read(reference: ArtifactReference): Promise<{
    chainId: string; blockNumber: string; blockHash: string; blockTime: string;
    results: { id: string; success: boolean; data: Hex }[];
  }>;
}

function normalizeInstallation(raw: ReturnType<typeof decodePreview>): InstallationInput {
  return Installation.parse({
    ...raw, token: raw.token.toLowerCase(),
    poolKey: { ...raw.poolKey, token0: raw.poolKey.token0.toLowerCase(), token1: raw.poolKey.token1.toLowerCase() },
    liquidity: raw.liquidity.toString(), installedSupply: raw.installedSupply.toString(),
  });
}

function decodePreview(data: Hex) {
  const result = decodeFunctionResult({ abi: peripheryAbi, functionName: "previewInstallation", data });
  const canonical = encodeFunctionResult({ abi: peripheryAbi, functionName: "previewInstallation", result });
  if (data !== canonical) throw new ZeroSeedError("preview_noncanonical_bytes");
  return result;
}

/** Position id of the launch position: salt 0, then the int32 lower and upper pool ticks. */
export function positionIdOf(lower: number, upper: number): Hex {
  return numberToHex((BigInt.asUintN(32, BigInt(lower)) << 32n) | BigInt.asUintN(32, BigInt(upper)), { size: 32 });
}

export function poolConfig(extension: string, tickSpacing: number): Hex {
  return numberToHex((BigInt(extension) << 96n) | 0x80000000n | BigInt(tickSpacing), { size: 32 });
}

/** The installation the periphery reports for exactly this request, owner, instance and the launch's own quote. */
export function validateInstallation(
  result: InstallationInput, request: ParametersInput, pin: InstancePin, quote: LaunchQuote, owner: Address,
): void {
  Installation.parse(result);
  if (request.quoteToken !== quote.address) throw new ZeroSeedError("preview_pair_mismatch");
  const instance = { extension: pin.extension as Address, periphery: pin.periphery as Address };
  if (result.token !== predictLaunchToken(instance, owner, request)) throw new ZeroSeedError("preview_token_mismatch");
  const tokenIs0 = validatePair(result, quote);
  const config = poolConfig(pin.extension, request.tickSpacing);
  const [lower, upper] = tokenIs0 ? [request.askTick, request.upperTick] : [-request.upperTick, -request.askTick];
  if (result.poolKey.config !== config || result.positionId !== positionIdOf(lower, upper) ||
    result.initialTick !== (tokenIs0 ? lower : upper)) throw new ZeroSeedError("preview_geometry_mismatch");
  validateInstalledAmounts(result, request);
}

/** The pool pairs the launch token with this launch's quote, sorted; returns whether the launch token is token0. */
function validatePair(result: InstallationInput, quote: LaunchQuote): boolean {
  const tokenIs0 = BigInt(result.token) < BigInt(quote.address);
  const pair = tokenIs0 ? [result.token, quote.address] : [quote.address, result.token];
  if (result.token === quote.address || pair[0] !== result.poolKey.token0 || pair[1] !== result.poolKey.token1) {
    throw new ZeroSeedError("preview_pair_mismatch");
  }
  // A native quote is address(0): always token0, so the launch token is always token1.
  if (quote.kind === "native" && tokenIs0) throw new ZeroSeedError("preview_pair_mismatch");
  return tokenIs0;
}

/** The computed liquidity is within (0, per-tick cap]; the installed supply within (0, requested]. */
function validateInstalledAmounts(result: InstallationInput, request: ParametersInput): void {
  const liquidity = unsigned(BigInt(result.liquidity), 127);
  const cap = ((1n << 128n) - 1n) / ((88722835n / BigInt(request.tickSpacing)) * 2n + 1n);
  const installed = unsigned(BigInt(result.installedSupply), 127);
  if (liquidity === 0n || liquidity > cap || installed === 0n || installed > BigInt(request.supply)) {
    throw new ZeroSeedError("invalid_installation_amounts");
  }
}

/** The one budgeted preview read, as stored for the wallet: periphery.previewInstallation(owner, parameters) at the build block. */
export function readBundle(owner: Address, request: ParametersInput, pin: InstancePin, build: BuildInput) {
  return readCallsBundle({
    chainId: pin.chainId, from: owner, blockParameter: numberToHex(BigInt(build.blockNumber)),
    calls: [functionReadCall({
      id: PREVIEW_ID, to: pin.periphery, data: previewData(owner, request), abi: previewAbi, functionName: "previewInstallation",
    })],
  });
}

function validateSnapshot(result: Awaited<ReturnType<SyntheticPreviewWallet["read"]>>, pin: InstancePin, build: BuildInput): Hex {
  const matches = result.chainId === pin.chainId && result.blockNumber === build.blockNumber &&
    result.blockHash === build.blockHash && result.blockTime === build.blockTime;
  if (!matches) throw new ZeroSeedError("preview_snapshot_mismatch");
  const calls = result.results.filter((call) => call.id === PREVIEW_ID);
  if (result.results.length !== 1 || calls.length !== 1 || !calls[0].success) throw new ZeroSeedError("preview_read_failed");
  return calls[0].data;
}

/**
 * One local budgeted read of periphery.previewInstallation(owner, parameters); no execution plan, runtime, provider
 * or wallet service. The owner is the account that will call create and becomes the launch owner. The result keeps
 * the requested parameters unchanged and reports requested, installed and sink supply and the computed liquidity.
 */
export async function localInstallationPreview(input: {
  owner: Address; request: ParametersInput; pin: InstancePin; build: BuildInput;
}, wallet: SyntheticPreviewWallet, freshTime: () => bigint) {
  // Snapshot caller data before await: concurrent mutation cannot rebind a read.
  const request = Parameters.parse(input.request);
  const build = BuildContext.parse(input.build);
  const pin = { ...input.pin };
  const owner = address.parse(input.owner) as Address;
  const quote = validateParameters(request, pin);
  validateBuild(request, build, freshTime());
  const reference = await wallet.storeRead(readBundle(owner, request, pin, build));
  if (reference.artifact_type !== "read_calls") throw new ZeroSeedError("preview_reference_type");
  const result = await wallet.read(reference);
  const raw = validateSnapshot(result, pin, build);
  const installation = normalizeInstallation(decodePreview(raw));
  validateInstallation(installation, request, pin, quote, owner);
  validateBuild(request, build, freshTime());
  // Display only: create is built from `requested` unchanged and recomputes the same installation.
  return {
    scope: "synthetic-local-non-executable" as const, owner, pin, quote, build, requested: request,
    supply: supplyOf(request, installation), liquidity: installation.liquidity,
    installation, preview: { count: 1 as const, reference, raw }, executionGuaranteed: false as const,
  };
}
