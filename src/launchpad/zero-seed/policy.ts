import { type Address, getAddress, zeroAddress } from "viem";
import { ServiceError } from "../../core.js";

// Consumer interface of evm-contracts 550afc4: ZeroSeedLaunch(Core) and ZeroSeedLaunchPeriphery(Core, extension).
// Not deployed, released or audited.
export const CONTRACTS_COMMIT = "550afc40280423128c02eb5ffd213aa959b34e2a";
/** sha256 of the compact, key-sorted JSON of each full compiled ABI (`jq -cS .abi`, no trailing newline). */
export const EXTENSION_ABI_SHA256 = "efae9388aa6b1342479204ddf436fd2a310df16bf06c80c990b2d22c90d1e41e";
export const PERIPHERY_ABI_SHA256 = "df24d9f07d45323da7e46c0f6e64ce24f8f522442d60cb07880ddf742ebe7305";

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

// The one instance deployed on a local anvil chain from the 550afc4 artifacts, identically (same deterministic
// deployer, salts, constructor arguments and block) by script/zero-seed-local-chain.ts and by the indexer's replay
// fixture generator (indexer c78a48e, scripts/zeroSeedLaunchFixture.ts).
// Not a live instance, and equal runtime alone is not provenance.
export const LOCAL_INSTANCE_PINS: readonly Readonly<InstancePin>[] = Object.freeze([
  Object.freeze({
    chainId: "31337",
    core: CORE,
    extension: "0x511b4327c2a2b6fd803b4ae85f2f9d831e046d8b",
    periphery: "0x2f0be2fc5a2825cecd23dbf6ed33ed8ff823ef64",
    extensionRuntime: "0xb8c6d15f45c41e9dc43ac0e6ab8ea941dc833514cdb0b82f381c65f42f73a858",
    peripheryRuntime: "0x49988478ba70cc8d2587eb63141b333c7ef0a67c4639c3a2ee25de4c4597999e",
    deploymentBlock: "2",
    extensionAbiSha256: EXTENSION_ABI_SHA256,
    peripheryAbiSha256: PERIPHERY_ABI_SHA256,
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
  "chainId", "core", "extension", "periphery", "extensionRuntime", "peripheryRuntime", "deploymentBlock",
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

function pinnedArtifacts(pin: InstancePin): boolean {
  return [pin.extensionRuntime, pin.peripheryRuntime].every((h) => typeof h === "string" && BYTES32.test(h)) &&
    pin.extensionAbiSha256 === EXTENSION_ABI_SHA256 && pin.peripheryAbiSha256 === PERIPHERY_ABI_SHA256 &&
    /^[1-9][0-9]*$/.test(pin.chainId) && /^(0|[1-9][0-9]*)$/.test(pin.deploymentBlock);
}

/**
 * Structural identity rules every pin must meet: exactly the pin fields, distinct nonzero Core, extension and
 * periphery, an extension address that encodes the launch call points, and the pinned ABIs.
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
