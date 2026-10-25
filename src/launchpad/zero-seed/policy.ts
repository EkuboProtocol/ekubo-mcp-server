import { type Address, getAddress, zeroAddress } from "viem";
import { ServiceError } from "../../core.js";
import { FEE_MODELS, type FeeModel } from "./abi.js";

export type { FeeModel };

// Consumer interfaces of ZeroSeedLaunch(Core) and ZeroSeedLaunchPeriphery(Core, extension), one per fee model. Not
// deployed, released or audited.
/** evm-contracts revision of each fee model. */
export const CONTRACTS_COMMITS: Readonly<Record<FeeModel, string>> = Object.freeze({
  fixed_base_duration_v1: "43d6628841b3ce91dafa048b7ceef64bed55fc8e",
  tick_rate_v2: "3d6378f585591dc7eabeea6976932c30524bb8ea",
});
/** The revision new launches are prepared for. */
export const CONTRACTS_COMMIT = CONTRACTS_COMMITS.tick_rate_v2;
/**
 * sha256 of the compact, key-sorted JSON of each full compiled ABI (`jq -cS .abi`, no trailing newline), per fee
 * model.
 */
export const ABI_SHA256: Readonly<Record<FeeModel, Readonly<{ extension: string; periphery: string }>>> = Object.freeze({
  fixed_base_duration_v1: Object.freeze({
    extension: "efae9388aa6b1342479204ddf436fd2a310df16bf06c80c990b2d22c90d1e41e",
    periphery: "df24d9f07d45323da7e46c0f6e64ce24f8f522442d60cb07880ddf742ebe7305",
  }),
  tick_rate_v2: Object.freeze({
    extension: "89ff4d15e5e8b4f044c4804d460df915e9206bbdbdcef22cf4afe0fbbf4eaadd",
    periphery: "a6d43b362d04eeb4e636ee32a031fc06995a2fd8bb71fb63750f27836a0ddb07",
  }),
});
export const EXTENSION_ABI_SHA256 = ABI_SHA256.tick_rate_v2.extension;
export const PERIPHERY_ABI_SHA256 = ABI_SHA256.tick_rate_v2.periphery;

/** Core's NATIVE_TOKEN_ADDRESS. A native quote has no code, decimals() or approvals and is always token0. */
export const NATIVE_QUOTE = zeroAddress;
export const NATIVE_DECIMALS = 18;
/** zeroSeedLaunchCallPoints(): the extension address must start with this byte for Core to register it. */
export const EXTENSION_CALL_POINTS_BYTE = "51";

/**
 * One launcher-deployed instance: Core, the extension and its periphery, each contract bound by its exact deployed
 * runtime (see runtime.ts for how the immutables inside it are checked), and the block both were deployed in. An
 * instance has no quote: every launch names its own, and one instance serves native and ERC-20 quotes alike.
 */
export interface InstancePin {
  chainId: string;
  feeModel: FeeModel;
  core: string;
  extension: string;
  periphery: string;
  extensionRuntime: string;
  peripheryRuntime: string;
  deploymentBlock: string;
  extensionAbiSha256: string;
  peripheryAbiSha256: string;
}

const CORE = "0x00000000000014aa86c5d3c41765bb24e11bd701";

// The instances deployed on local anvil chains, one per fee model, identically (same deterministic deployer, salts,
// constructor arguments and block) by script/zero-seed-local-chain.ts and by the indexer's replay fixture generator:
// the 43d6628 artifacts (indexer 91a7036, local-chain.json) and the 3d6378f artifacts (indexer 7f373e5,
// local-chain-v2.json). Not live instances, and equal runtime alone is not provenance.
export const LOCAL_INSTANCE_PINS: readonly Readonly<InstancePin>[] = Object.freeze([
  Object.freeze({
    chainId: "31337",
    feeModel: "fixed_base_duration_v1",
    core: CORE,
    extension: "0x519c5f793d3f6cf9ee439e4cc38d8285cf08211f",
    periphery: "0x0df4e2a76640b52e51479b435f52d0eb0e7e8ef4",
    extensionRuntime: "0xd6b4c7ce8da56e9948fdb004a035d9b52dbd3690bcb03c1269bbf2a9981d8ed5",
    peripheryRuntime: "0x2a9329dbb064a2c031115c7c120c8b6a1f31de167f33374180e4dc73d975974b",
    deploymentBlock: "2",
    extensionAbiSha256: ABI_SHA256.fixed_base_duration_v1.extension,
    peripheryAbiSha256: ABI_SHA256.fixed_base_duration_v1.periphery,
  } as const),
  Object.freeze({
    chainId: "31337",
    feeModel: "tick_rate_v2",
    core: CORE,
    extension: "0x5135fd3e9a6056937eaf6b99454bbc2198c2263d",
    periphery: "0xfb2e7927d3e4984dca3e390526d43c6f5a3461e9",
    extensionRuntime: "0xe08ad382497fc9825956c2b4e9ccf463014c4ed65baf50c0a59db8d7b7aedfc3",
    peripheryRuntime: "0xf72d3cd6b99e1b64f0b08c0f6933b4f8adb92464ded48c51bfb7d2805c09d667",
    deploymentBlock: "2",
    extensionAbiSha256: ABI_SHA256.tick_rate_v2.extension,
    peripheryAbiSha256: ABI_SHA256.tick_rate_v2.periphery,
  } as const),
]);

/** No env switch, provider read, or caller-supplied address can enable live support. */
export const LIVE_INSTANCE_PINS: readonly InstancePin[] = Object.freeze([]);

/** An ERC-20 quote reviewed for one chain, bound to its exact runtime codehash. */
export interface ReviewedQuote {
  chainId: string;
  address: string;
  runtime: string;
}

/**
 * The quote is per launch, and supporting it is a separate decision from supporting the instance: native ETH is
 * always eligible (behind the same instance gates), an ERC-20 only when it is reviewed here. Live: none.
 */
export const LIVE_REVIEWED_ERC20_QUOTES: readonly ReviewedQuote[] = Object.freeze([]);

/** The local chains' plain 18-decimal test ERC-20 (evm-contracts test/TestToken.sol), relocated to 0xff..ff. */
export const LOCAL_REVIEWED_ERC20_QUOTES: readonly Readonly<ReviewedQuote>[] = Object.freeze([
  Object.freeze({
    chainId: "31337",
    address: "0xffffffffffffffffffffffffffffffffffffffff",
    runtime: "0xe8ccd7c4eb891208d5e04a27a31dfaf2b9bce01e083d7b36f10b6dd6ea643e63",
  } as const),
]);

/** The quote of one launch: native ETH at address(0) with no runtime, or a reviewed ERC-20 and its runtime. */
export type LaunchQuote = Readonly<
  { kind: "native"; address: typeof NATIVE_QUOTE; runtime: null } | { kind: "erc20"; address: string; runtime: string }
>;
const NATIVE: LaunchQuote = Object.freeze({ kind: "native", address: NATIVE_QUOTE, runtime: null });

const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const PIN_KEYS = [
  "chainId", "feeModel", "core", "extension", "periphery", "extensionRuntime", "peripheryRuntime", "deploymentBlock",
  "extensionAbiSha256", "peripheryAbiSha256",
] as const satisfies readonly (keyof InstancePin)[];

/**
 * Resolves a launch's quote token on a chain. Anything but native ETH or a reviewed ERC-20 refuses with
 * unsupported_quote; outside the local harness the reviewed list is empty.
 */
export function launchQuote(chainId: string, quote: string, localHarness: boolean): LaunchQuote {
  if (typeof quote !== "string" || !ADDRESS.test(quote)) throw new ZeroSeedError("unsupported_quote");
  if (quote === NATIVE_QUOTE) return NATIVE;
  const reviewed = (localHarness ? LOCAL_REVIEWED_ERC20_QUOTES : LIVE_REVIEWED_ERC20_QUOTES)
    .find((entry) => entry.chainId === chainId && entry.address === quote);
  if (reviewed === undefined) throw new ZeroSeedError("unsupported_quote");
  return Object.freeze({ kind: "erc20", address: reviewed.address, runtime: reviewed.runtime });
}

/** A reviewed ERC-20 is reviewed only at its exact runtime: different code at the same address is unsupported. */
export function verifyQuoteRuntime(quote: LaunchQuote, runtimeKeccak: string | null): void {
  if (quote.runtime !== runtimeKeccak) throw new ZeroSeedError("unsupported_quote");
}

function exactKeys(pin: InstancePin): boolean {
  const keys = Object.keys(pin);
  return keys.length === PIN_KEYS.length && PIN_KEYS.every((key) => keys.includes(key));
}

function distinctIdentity(pin: InstancePin): boolean {
  const contracts = [pin.core, pin.extension, pin.periphery];
  return contracts.every((a) => typeof a === "string" && ADDRESS.test(a)) && new Set(contracts).size === 3 &&
    !contracts.includes(NATIVE_QUOTE) && pin.extension.slice(2, 4) === EXTENSION_CALL_POINTS_BYTE;
}

/** The pin's ABIs are exactly its fee model's. */
function pinnedArtifacts(pin: InstancePin): boolean {
  const hashes = (FEE_MODELS as readonly string[]).includes(pin.feeModel) ? ABI_SHA256[pin.feeModel] : undefined;
  return hashes !== undefined &&
    [pin.extensionRuntime, pin.peripheryRuntime].every((h) => typeof h === "string" && BYTES32.test(h)) &&
    pin.extensionAbiSha256 === hashes.extension && pin.peripheryAbiSha256 === hashes.periphery &&
    /^[1-9][0-9]*$/.test(pin.chainId) && /^(0|[1-9][0-9]*)$/.test(pin.deploymentBlock);
}

/**
 * Structural identity rules every pin must meet: exactly the pin fields, distinct nonzero Core, extension and
 * periphery, an extension address that encodes the launch call points, a known fee model and that model's ABIs.
 */
export function wellFormedPin(pin: InstancePin): boolean {
  return exactKeys(pin) && distinctIdentity(pin) && pinnedArtifacts(pin);
}

export function samePin(a: InstancePin, b: InstancePin): boolean {
  return Object.keys(a).length === PIN_KEYS.length && Object.keys(b).length === PIN_KEYS.length &&
    PIN_KEYS.every((key) => a[key] === b[key]);
}

export function supportedInstances(requested: readonly InstancePin[], localHarness: boolean): readonly InstancePin[] {
  if (!localHarness) return LIVE_INSTANCE_PINS;
  return requested.filter((request) => wellFormedPin(request) && LOCAL_INSTANCE_PINS.some((pin) => samePin(pin, request)))
    .map((pin) => Object.freeze({ ...pin }));
}

/** A ServiceError, so MCP callers receive the stable code rather than unexpected_error. */
export class ZeroSeedError extends ServiceError {
  constructor(code: string) {
    super(code, code);
    this.name = "ZeroSeedError";
  }
}

export function unsigned(value: bigint, bits: number): bigint {
  if (value < 0n || value >= 1n << BigInt(bits)) throw new ZeroSeedError("unsigned_domain");
  return value;
}

export interface CreationTiming {
  buildTime: bigint;
  tradingStart: bigint;
  executionExpiry: bigint;
}

/** Shared by producer and owner decoder; all boundaries are exact. */
export function validateCreationTiming(timing: CreationTiming, freshTime: bigint): void {
  const { buildTime, tradingStart, executionExpiry } = timing;
  [buildTime, tradingStart, executionExpiry, freshTime].forEach((value) => unsigned(value, 64));
  const minimum = unsigned(buildTime + 300n, 64);
  const maximum = unsigned(buildTime + 86400n, 64);
  if (tradingStart < minimum || tradingStart > maximum) throw new ZeroSeedError("invalid_trading_start");
  if (executionExpiry <= buildTime || executionExpiry > tradingStart) throw new ZeroSeedError("invalid_execution_expiry");
  if (freshTime < buildTime || freshTime >= executionExpiry) throw new ZeroSeedError("expired_or_future_plan");
}

export function validateMetadata(value: string): void {
  if (new TextEncoder().encode(value).byteLength > 31) throw new ZeroSeedError("metadata_too_long");
}

/** The periphery refuses exactly these recipients with InvalidRecipient(); for a native quote token0 is address(0). */
export function validateClaimRecipient(recipient: Address, sinks: {
  core: Address; extension: Address; periphery: Address; token0: Address; token1: Address;
}): void {
  // Explicit callback: Array#map's index argument would become getAddress's EIP-1191 chain id.
  const address = getAddress(recipient);
  const refused = [zeroAddress, sinks.core, sinks.extension, sinks.periphery, sinks.token0, sinks.token1]
    .map((sink) => getAddress(sink));
  if (refused.includes(address)) throw new ZeroSeedError("invalid_recipient");
}

/** The accepted quoter estimate must never be converted to an execution budget. */
export function refuseExecutableUse(): never {
  throw new ZeroSeedError("executable_budget_not_proven");
}
