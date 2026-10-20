import { type Address, getAddress, zeroAddress } from "viem";
import { ServiceError } from "../../core.js";

// Draft exponential creator-fee decay ABI (evm-contracts b1cbb1c, not released or audited).
export const ABI_SHA256 = "bc51b39284a5a2a0970d3a804420762ce291dc01f9c21ddf31840e354a3792bb";
export const POLICY_SHA256 = "7864a2d33a0fa8964922a5225653ed19842c590091f289eb4e29306feac6f6e1";
export const FREEZE_REVISION = "ceebe872-8deb-4858-a192-8c013516def1";

export interface InstancePin {
  chainId: string;
  address: string;
  core: string;
  quote: string;
  runtime: string;
  quoteRuntime: string;
  abiSha256: string;
}

const CORE = "0x00000000000014aa86c5d3c41765bb24e11bd701";
const WETH_RUNTIME = "0x8a3a1f6a9f9dce633117adee5b458245835a8645a8c8726a26382a4622508b1c";

// Actual emitted indexer instances, NOT the relocated extension address in
// the protocol's arithmetic fixture. Equal runtime alone is not provenance.
export const LOCAL_INSTANCE_PINS: readonly Readonly<InstancePin>[] = Object.freeze([
  Object.freeze({
    chainId: "31337",
    address: "0x5142e167b32877ca3cf3060010a0a1418e3ef1b9",
    core: CORE,
    quote: "0xffffffffffffffffffffffffffffffffffffffff",
    runtime: "0x8fb360bb48006819049e6b9a53679ccaa01264e61465ce8e8cd2e8b185d3a8d1",
    quoteRuntime: WETH_RUNTIME,
    abiSha256: ABI_SHA256,
  }),
  Object.freeze({
    chainId: "31337",
    address: "0x51174b5db84c81a906ec55445070fd84c8c8e655",
    core: CORE,
    quote: "0x0000000000000000000000000000000000010000",
    runtime: "0xa951db07ad354ea45df3ff1b720b69c7cc588c4feb44aaea79cd79639da61f6e",
    quoteRuntime: WETH_RUNTIME,
    abiSha256: ABI_SHA256,
  }),
]);

/** No env switch, provider read, or caller-supplied address can enable live support. */
export const LIVE_INSTANCE_PINS: readonly InstancePin[] = Object.freeze([]);

export function supportedInstances(requested: readonly InstancePin[], localHarness: boolean): readonly InstancePin[] {
  if (!localHarness) return LIVE_INSTANCE_PINS;
  return requested.filter((request) => LOCAL_INSTANCE_PINS.some((pin) =>
    (Object.keys(pin) as (keyof InstancePin)[]).every((key) => pin[key] === request[key]),
  )).map((pin) => Object.freeze({ ...pin }));
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

export function validateClaimRecipient(recipient: Address, sinks: {
  core: Address; extension: Address; token0: Address; token1: Address;
}): void {
  // Explicit callback: Array#map's index argument would become getAddress's EIP-1191 chain id.
  const address = getAddress(recipient);
  const refused = [zeroAddress, sinks.core, sinks.extension, sinks.token0, sinks.token1].map((sink) => getAddress(sink));
  if (refused.includes(address)) throw new ZeroSeedError("invalid_recipient");
}

/** The accepted quoter estimate must never be converted to an execution budget. */
export function refuseExecutableUse(): never {
  throw new ZeroSeedError("executable_budget_not_proven");
}
