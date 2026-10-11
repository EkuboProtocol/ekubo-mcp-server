import { type Address, getAddress, zeroAddress } from "viem";

export const ABI_SHA256 = "189ff93c0f6fb64f6e7dd0675872bf6686692f8303e6218b8c2521bfa5ced215";
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
    address: "0x510d7c117adeeb89bb33b9acb53995f3280eaa3a",
    core: CORE,
    quote: "0xffffffffffffffffffffffffffffffffffffffff",
    runtime: "0x8d8839b97583f275a84aaf26cd6a5fa3ba21a7be04731a65f6140fc5040477c4",
    quoteRuntime: WETH_RUNTIME,
    abiSha256: ABI_SHA256,
  }),
  Object.freeze({
    chainId: "31337",
    address: "0x5195c03d30c11be73485ab76a35eb6f59fc52072",
    core: CORE,
    quote: "0x0000000000000000000000000000000000010000",
    runtime: "0x8751bab213ba226c4e45f6441b9df2db1f9c8ee9e9335320e180f3b348646014",
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

export class ZeroSeedError extends Error {
  constructor(public readonly code: string) {
    super(code);
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
  const address = getAddress(recipient);
  const refused = [zeroAddress, sinks.core, sinks.extension, sinks.token0, sinks.token1].map(getAddress);
  if (refused.includes(address)) throw new ZeroSeedError("invalid_recipient");
}

/** The accepted quoter estimate must never be converted to an execution budget. */
export function refuseExecutableUse(): never {
  throw new ZeroSeedError("executable_budget_not_proven");
}
