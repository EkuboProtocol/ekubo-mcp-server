import { type Address, getAddress, zeroAddress } from "viem";
import { ServiceError } from "../../core.js";

// Consumer interface of evm-contracts 4f1a306: ZeroSeedLaunch(Core, quote) and ZeroSeedLaunchPeriphery(Core,
// extension). Not deployed, released or audited.
export const CONTRACTS_COMMIT = "4f1a3060b099e8a50469848118f44c0c65cfab9a";
/** sha256 of the compact, key-sorted JSON of each full compiled ABI (`jq -cS .abi`, no trailing newline). */
export const EXTENSION_ABI_SHA256 = "21f9e2c0166ab28ce8573c481de5b0fc2f37dd7595d496d326f0a2d1a544254e";
export const PERIPHERY_ABI_SHA256 = "5c563488b843aee923d0d819a66489eeee543dd20d1582de1f5df643f5d08a75";

/** Core's NATIVE_TOKEN_ADDRESS. A native quote has no code, decimals() or approvals and is always token0. */
export const NATIVE_QUOTE = zeroAddress;
export const NATIVE_DECIMALS = 18;
/** zeroSeedLaunchCallPoints(): the extension address must start with this byte for Core to register it. */
export const EXTENSION_CALL_POINTS_BYTE = "51";

/**
 * One launcher-deployed instance: the extension, its periphery, Core and the extension's constructor quote, each
 * bound by the exact deployed runtime (see runtime.ts for how the immutables inside it are checked). An ERC-20
 * quote also pins its runtime; a native quote has none.
 */
export interface InstancePin {
  chainId: string;
  core: string;
  extension: string;
  periphery: string;
  quote: string;
  quoteKind: "native" | "erc20";
  quoteRuntime: string | null;
  extensionRuntime: string;
  peripheryRuntime: string;
  extensionAbiSha256: string;
  peripheryAbiSha256: string;
}

const CORE = "0x00000000000014aa86c5d3c41765bb24e11bd701";

// Instances deployed by script/zero-seed-local-chain.ts on a local anvil chain from the 4f1a306 artifacts. They
// are not live instances and equal runtime alone is not provenance.
export const LOCAL_INSTANCE_PINS: readonly Readonly<InstancePin>[] = Object.freeze([
  Object.freeze({
    chainId: "31337",
    core: CORE,
    extension: "0x5114703a4cf4256f0acb68f992c861d8c4d1b173",
    periphery: "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0",
    quote: NATIVE_QUOTE,
    quoteKind: "native",
    quoteRuntime: null,
    extensionRuntime: "0x846786a63ba1a2c976f748fdc94b8cbc8f76dc64f07452333d36ff564f281bf7",
    peripheryRuntime: "0x57d0ee27c634ac08d08b60bf8e6c2f185c7e9444613ccfde5ac9bbb5e3f84f2a",
    extensionAbiSha256: EXTENSION_ABI_SHA256,
    peripheryAbiSha256: PERIPHERY_ABI_SHA256,
  } as const),
  Object.freeze({
    chainId: "31337",
    core: CORE,
    extension: "0x519435a42752da78e395999218d0ecc4fdcbcf4b",
    periphery: "0xdc64a140aa3e981100a9beca4e685f962f0cf6c9",
    quote: "0xffffffffffffffffffffffffffffffffffffffff",
    quoteKind: "erc20",
    quoteRuntime: "0x8a3a1f6a9f9dce633117adee5b458245835a8645a8c8726a26382a4622508b1c",
    extensionRuntime: "0x56e32aeac03464c3babd754fc21e0594c42d82db9d9c0cc3dd1ce1ec20273750",
    peripheryRuntime: "0xb78ea649f2e1817c851f7417a604d1565a346c6bec022abc821e3f1110739ac8",
    extensionAbiSha256: EXTENSION_ABI_SHA256,
    peripheryAbiSha256: PERIPHERY_ABI_SHA256,
  } as const),
]);

// The same two instances deployed separately by the indexer's replay fixture generator (indexer 2006846,
// scripts/zeroSeedLaunchFixture.ts), whose chain the backend API golden and the quoter router probes read. Only the
// peripheries' addresses differ; every runtime is identical. Local only, like the pins above.
export const BACKEND_REPLAY_PINS: readonly Readonly<InstancePin>[] = Object.freeze([
  Object.freeze({ ...LOCAL_INSTANCE_PINS[0], periphery: "0xb27e16c3d01850191c1e027f7a3372cd2e1fb324" }),
  Object.freeze({ ...LOCAL_INSTANCE_PINS[1], periphery: "0x94e1b338def908449e6ea7c7d254630b45d27562" }),
]);

const LOCAL_HARNESS_PINS = [...LOCAL_INSTANCE_PINS, ...BACKEND_REPLAY_PINS];

/** No env switch, provider read, or caller-supplied address can enable live support. */
export const LIVE_INSTANCE_PINS: readonly InstancePin[] = Object.freeze([]);

const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const PIN_KEYS = [
  "chainId", "core", "extension", "periphery", "quote", "quoteKind", "quoteRuntime", "extensionRuntime",
  "peripheryRuntime", "extensionAbiSha256", "peripheryAbiSha256",
] as const satisfies readonly (keyof InstancePin)[];

function exactKeys(pin: InstancePin): boolean {
  const keys = Object.keys(pin);
  return keys.length === PIN_KEYS.length && PIN_KEYS.every((key) => keys.includes(key));
}

function distinctIdentity(pin: InstancePin): boolean {
  const contracts = [pin.core, pin.extension, pin.periphery];
  const all = [...contracts, pin.quote];
  return all.every((a) => typeof a === "string" && ADDRESS.test(a)) && new Set(all).size === 4 &&
    !contracts.includes(NATIVE_QUOTE) && pin.extension.slice(2, 4) === EXTENSION_CALL_POINTS_BYTE;
}

function pinnedArtifacts(pin: InstancePin): boolean {
  return [pin.extensionRuntime, pin.peripheryRuntime].every((h) => BYTES32.test(h)) &&
    pin.extensionAbiSha256 === EXTENSION_ABI_SHA256 && pin.peripheryAbiSha256 === PERIPHERY_ABI_SHA256 &&
    /^[1-9][0-9]*$/.test(pin.chainId);
}

function quoteProvenance(pin: InstancePin): boolean {
  if (pin.quoteKind === "native") return pin.quote === NATIVE_QUOTE && pin.quoteRuntime === null;
  return pin.quoteKind === "erc20" && pin.quote !== NATIVE_QUOTE && typeof pin.quoteRuntime === "string" &&
    BYTES32.test(pin.quoteRuntime);
}

/**
 * Structural identity rules every pin must meet: distinct Core, extension, periphery and quote; an extension address
 * that encodes the launch call points; a native quote exactly when the quote is address(0), with no quote runtime.
 */
export function wellFormedPin(pin: InstancePin): boolean {
  return exactKeys(pin) && distinctIdentity(pin) && pinnedArtifacts(pin) && quoteProvenance(pin);
}

export function samePin(a: InstancePin, b: InstancePin): boolean {
  return Object.keys(a).length === PIN_KEYS.length && Object.keys(b).length === PIN_KEYS.length &&
    PIN_KEYS.every((key) => a[key] === b[key]);
}

export function supportedInstances(requested: readonly InstancePin[], localHarness: boolean): readonly InstancePin[] {
  if (!localHarness) return LIVE_INSTANCE_PINS;
  return requested.filter((request) => wellFormedPin(request) && LOCAL_HARNESS_PINS.some((pin) => samePin(pin, request)))
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
