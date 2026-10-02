import { ServiceError } from "../../core.js";
import {
  REQUIRED_CONTRACTS,
  type Address,
  type Hex,
  type LaunchpadManifest,
  type ManifestContract,
} from "./types.js";

/**
 * Source-boundary validation. Malformed addresses, hashes and log data are
 * rejected, never repaired: a 41-digit "address" is not silently truncated
 * into a different account.
 */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/;

export function rejected(where: string, what: string): ServiceError {
  return new ServiceError("invalid_source_data", `${where} is not ${what}; the source is rejected rather than repaired.`, { field: where });
}

export function address(value: unknown, where: string): Address {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw rejected(where, "a 20-byte hex address");
  return value.toLowerCase() as Address;
}

export function hash(value: unknown, where: string): Hex {
  if (typeof value !== "string" || !HASH.test(value)) throw rejected(where, "a 32-byte hex hash");
  return value.toLowerCase() as Hex;
}

export function data(value: unknown, where: string): Hex {
  if (typeof value !== "string" || !DATA.test(value)) throw rejected(where, "whole-byte hex data");
  return value.toLowerCase() as Hex;
}

/** A non-negative safe integer given as a number, a decimal string or a 0x quantity. */
export function quantity(value: unknown, where: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^(?:0x[0-9a-fA-F]+|\d+)$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw rejected(where, "a non-negative integer");
  return parsed;
}

function contract(raw: unknown, where: string): ManifestContract {
  if (typeof raw === "string") return { address: address(raw, where), code_hash: null };
  const entry = (raw ?? {}) as { address?: unknown; code_hash?: unknown };
  return {
    address: address(entry.address, `${where}.address`),
    code_hash: entry.code_hash === undefined || entry.code_hash === null ? null : hash(entry.code_hash, `${where}.code_hash`),
  };
}

export interface ManifestInput {
  chain_id: unknown;
  revision: unknown;
  deployment_block: unknown;
  contracts: Record<string, unknown>;
}

/** Accepts contracts as addresses or `{address, code_hash}`; TWAMM is optional. */
export function manifest(input: ManifestInput, where = "manifest"): LaunchpadManifest {
  const contracts = Object.fromEntries(
    REQUIRED_CONTRACTS.map((name) => [name, contract(input.contracts[name], `${where}.contracts.${name}`)]),
  ) as LaunchpadManifest["contracts"];
  const twamm = input.contracts.twamm;
  if (typeof input.revision !== "string" || input.revision === "") throw rejected(`${where}.revision`, "a revision string");
  return {
    chain_id: quantity(input.chain_id, `${where}.chain_id`),
    revision: input.revision,
    deployment_block: quantity(input.deployment_block, `${where}.deployment_block`),
    contracts,
    twamm: twamm === undefined || twamm === null ? null : contract(twamm, `${where}.contracts.twamm`),
  };
}

/** The deployment manifest written by the evm-contracts launchpad script (EKU-657). */
export function deploymentManifest(raw: unknown): LaunchpadManifest {
  const input = (raw ?? {}) as Record<string, unknown>;
  return manifest({
    chain_id: input.chain_id,
    revision: input.git_revision,
    deployment_block: input.deployment_block ?? input.fork_block,
    contracts: (input.contracts ?? {}) as Record<string, unknown>,
  });
}
