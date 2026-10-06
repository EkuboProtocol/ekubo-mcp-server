import { type Abi, type Address, decodeErrorResult, getAddress, type Hex, isAddress, zeroAddress } from "viem";
import launchRouterAbiJson from "./abis/LaunchRouter.json";
import lockedLaunchLiquidityAbiJson from "./abis/LockedLaunchLiquidity.json";
import scheduledLaunchAbiJson from "./abis/ScheduledLaunch.json";
import abiRevision from "./abis/revision.json";
import { prepareError } from "./templates.js";

/**
 * Compiled ABIs from the contracts revision in `abis/revision.json`, copied
 * byte for byte from the build output. Calldata is encoded only against these
 * and the Yul router SDK; nothing is written out by hand.
 */
export const launchRouterAbi = launchRouterAbiJson as Abi;
export const scheduledLaunchAbi = scheduledLaunchAbiJson as Abi;
export const lockedLaunchLiquidityAbi = lockedLaunchLiquidityAbiJson as Abi;
export const ABI_REVISION: string = abiRevision.git_revision;

type AbiError = Extract<Abi[number], { type: "error" }>;

/**
 * Every custom error the three launchpad contracts declare, once per
 * signature. Errors bubble up through Core, so a LaunchRouter call can
 * revert with a ScheduledLaunch error; revert decoding needs all of them.
 */
export const launchpadErrorsAbi: Abi = [
  ...new Map(
    [launchRouterAbi, scheduledLaunchAbi, lockedLaunchLiquidityAbi]
      .flat()
      .filter((item): item is AbiError => item.type === "error")
      .map((item) => [`${item.name}(${item.inputs.map((input) => input.type).join(",")})`, item]),
  ).values(),
];

/** The custom error name in revert bytes, or null when they match none of the contracts' errors. */
export function revertErrorName(revert: Hex): string | null {
  try {
    return decodeErrorResult({ abi: launchpadErrorsAbi, data: revert }).errorName;
  } catch {
    return null;
  }
}

/** `NATIVE_TOKEN_ADDRESS` in the contracts' `math/constants.sol`. */
export const NATIVE_TOKEN = zeroAddress;

/**
 * The six addresses whose runtime code hash is checked before any plan is
 * built (gate C1). `router` is the production Yul router every trade targets.
 */
export const CONTRACT_NAMES = [
  "core",
  "twamm",
  "router",
  "scheduled_launch",
  "locked_launch_liquidity",
  "launch_router",
] as const;

export type ContractName = (typeof CONTRACT_NAMES)[number];

export interface ManifestContract {
  address: Address;
  code_hash: Hex;
}

export interface PrepareManifest {
  chain_id: number;
  git_revision: string;
  contracts: Record<ContractName, Address>;
  code_hashes: Record<ContractName, Hex>;
  /** The hosted quote-asset allowlist: native ETH only. */
  quote_allowlist: Address[];
}

export interface PrepareEnv {
  LAUNCHPAD_MANIFEST?: string;
  /** JSON-RPC endpoint of the manifest's chain, for the direct chain reads. */
  LAUNCHPAD_RPC_URL?: string;
  /** The Ekubo data API serving `/launches`. Falls back to EKUBO_API_URL. */
  LAUNCHPAD_API_URL?: string;
  EKUBO_API_URL?: string;
  /** quoter-service. Falls back to EKUBO_QUOTER_URL. */
  LAUNCHPAD_QUOTER_URL?: string;
  EKUBO_QUOTER_URL?: string;
}

function parseRaw(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw === "") throw prepareError("launchpad_not_configured");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // Reported below as one invalid_manifest error.
  }
  throw prepareError("invalid_manifest", { field: "manifest" });
}

function manifestAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value)) throw prepareError("invalid_manifest", { field });
  return getAddress(value);
}

function manifestHash(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw prepareError("invalid_manifest", { field });
  return value.toLowerCase() as Hex;
}

function manifestInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw prepareError("invalid_manifest", { field });
  }
  return value;
}

function contractEntries(value: unknown) {
  const record = (value ?? {}) as Record<string, { address?: unknown; code_hash?: unknown } | undefined>;
  const contracts = {} as Record<ContractName, Address>;
  const codeHashes = {} as Record<ContractName, Hex>;
  for (const name of CONTRACT_NAMES) {
    contracts[name] = manifestAddress(record[name]?.address, `contracts.${name}.address`);
    codeHashes[name] = manifestHash(record[name]?.code_hash, `contracts.${name}.code_hash`);
  }
  return { contracts, codeHashes };
}

/**
 * Read the deployment manifest written by the contracts repository. A
 * manifest from any revision other than the bundled ABIs' is refused: the
 * encodings could differ, and a plan built against the wrong ABI is exactly
 * the substitution this module must never produce. The hosted rules are
 * fixed here, not configured: a test quote token or a reference tier in the
 * manifest is refused rather than honoured.
 */
export function prepareManifest(env: PrepareEnv): PrepareManifest {
  const raw = parseRaw(env.LAUNCHPAD_MANIFEST);
  const gitRevision = typeof raw.git_revision === "string" ? raw.git_revision : "";
  if (gitRevision !== ABI_REVISION) {
    throw prepareError("abi_revision_mismatch", {
      manifest_revision: gitRevision,
      abi_revision: ABI_REVISION,
    });
  }
  if (raw.test_quote_token !== undefined) throw prepareError("invalid_manifest", { field: "test_quote_token" });
  if (raw.reference_tier !== undefined && raw.reference_tier !== null) {
    throw prepareError("invalid_manifest", { field: "reference_tier" });
  }
  const { contracts, codeHashes } = contractEntries(raw.contracts);
  return {
    chain_id: manifestInteger(raw.chain_id, "chain_id"),
    git_revision: gitRevision,
    contracts,
    code_hashes: codeHashes,
    quote_allowlist: [NATIVE_TOKEN],
  };
}

export function requireChain(manifest: PrepareManifest, chainId: number) {
  if (chainId !== manifest.chain_id) {
    throw prepareError("unsupported_chain", { supported_chain_id: manifest.chain_id });
  }
}
