import { type Address, decodeFunctionResult, encodeFunctionResult, type Hex, numberToHex } from "viem";
import { z } from "zod";
import { functionReadCall, readCallsBundle } from "../../abi-decode.js";
import type { ArtifactReference } from "../../artifact-store.js";
import { zeroSeedAbi } from "./abi.js";
import { address, BuildContext, type BuildInput, bytes32, decimal, Parameters, type ParametersInput,
  previewData, validateBuild, validateParameters } from "./installation.js";
import { type InstancePin, unsigned, ZeroSeedError } from "./policy.js";
import { predictLaunchToken } from "./token.js";

export const PREVIEW_ID = "zero_seed_installation";
const PoolKey = z.strictObject({ token0: address, token1: address, config: bytes32 });
export const Installation = z.strictObject({
  token: address, poolKey: PoolKey, positionId: bytes32, initialTick: z.number().int(),
  liquidity: decimal, installedSupply: decimal,
});
export type InstallationInput = z.infer<typeof Installation>;

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
  const result = decodeFunctionResult({ abi: zeroSeedAbi, functionName: "previewInstallation", data });
  const canonical = encodeFunctionResult({ abi: zeroSeedAbi, functionName: "previewInstallation", result });
  if (data !== canonical) throw new ZeroSeedError("preview_noncanonical_bytes");
  return result;
}

function positionId(lower: number, upper: number): Hex {
  return numberToHex((BigInt.asUintN(32, BigInt(lower)) << 32n) | BigInt.asUintN(32, BigInt(upper)), { size: 32 });
}

export function validateInstallation(
  result: InstallationInput, request: ParametersInput, pin: InstancePin, creator: Address,
): void {
  Installation.parse(result);
  if (result.token !== predictLaunchToken(pin.address as Address, creator, request)) throw new ZeroSeedError("preview_token_mismatch");
  const tokenIs0 = validatePair(result, pin);
  const config = numberToHex((BigInt(pin.address) << 96n) | 0x80000000n | BigInt(request.tickSpacing), { size: 32 });
  const [lower, upper] = tokenIs0 ? [request.askTick, request.upperTick] : [-request.upperTick, -request.askTick];
  if (result.poolKey.config !== config || result.positionId !== positionId(lower, upper) ||
    result.initialTick !== (tokenIs0 ? lower : upper)) throw new ZeroSeedError("preview_geometry_mismatch");
  validateInstalledAmounts(result, request);
}

function validatePair(result: InstallationInput, pin: InstancePin): boolean {
  const tokenIs0 = BigInt(result.token) < BigInt(pin.quote);
  const pair = tokenIs0 ? [result.token, pin.quote] : [pin.quote, result.token];
  if (result.token === pin.quote || pair[0] !== result.poolKey.token0 || pair[1] !== result.poolKey.token1) {
    throw new ZeroSeedError("preview_pair_mismatch");
  }
  return tokenIs0;
}

function validateInstalledAmounts(result: InstallationInput, request: ParametersInput): void {
  const liquidity = unsigned(BigInt(result.liquidity), 127);
  const cap = ((1n << 128n) - 1n) / ((88722835n / BigInt(request.tickSpacing)) * 2n + 1n);
  const supply = unsigned(BigInt(result.installedSupply), 127);
  if (liquidity === 0n || liquidity > cap || supply === 0n || supply > BigInt(request.supply)) {
    throw new ZeroSeedError("invalid_installation_amounts");
  }
}

function readBundle(creator: Address, request: ParametersInput, pin: InstancePin, build: BuildInput) {
  return readCallsBundle({
    chainId: pin.chainId, from: creator, blockParameter: numberToHex(BigInt(build.blockNumber)),
    calls: [functionReadCall({
      id: PREVIEW_ID, to: pin.address, data: previewData(creator, request), abi: zeroSeedAbi, functionName: "previewInstallation",
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

/** One local budgeted read; no execution plan, runtime, provider or wallet service. */
export async function localInstallationPreview(input: {
  creator: Address; request: ParametersInput; pin: InstancePin; build: BuildInput;
}, wallet: SyntheticPreviewWallet, freshTime: () => bigint) {
  // Snapshot caller data before await: concurrent mutation cannot rebind a read.
  const request = Parameters.parse(input.request);
  const build = BuildContext.parse(input.build);
  const pin = { ...input.pin };
  const creator = address.parse(input.creator) as Address;
  validateParameters(request, pin);
  validateBuild(request, build, freshTime());
  if (request.liquidity !== "0") throw new ZeroSeedError("preview_liquidity_must_be_zero");
  const reference = await wallet.storeRead(readBundle(creator, request, pin, build));
  if (reference.artifact_type !== "read_calls") throw new ZeroSeedError("preview_reference_type");
  const result = await wallet.read(reference);
  const raw = validateSnapshot(result, pin, build);
  const installation = normalizeInstallation(decodePreview(raw));
  validateInstallation(installation, request, pin, creator);
  validateBuild(request, build, freshTime());
  const actual = { ...request, supply: installation.installedSupply, liquidity: installation.liquidity };
  return {
    scope: "synthetic-local-non-executable" as const, creator, pin, build, requested: request, actual,
    installation, preview: { count: 1 as const, reference, raw }, executionGuaranteed: false as const,
  };
}
