import { type Abi, type Address, getAddress, isAddress, zeroAddress } from "viem";
import launchRouterAbiJson from "./abis/LaunchRouter.json";
import lockedLaunchLiquidityAbiJson from "./abis/LockedLaunchLiquidity.json";
import routerAbiJson from "./abis/Router.json";
import scheduledLaunchAbiJson from "./abis/ScheduledLaunch.json";
import abiRevision from "./abis/revision.json";
import { prepareError } from "./templates.js";

/**
 * Compiled ABIs from the contracts revision in `abis/revision.json`, copied
 * byte for byte from the deployment script's output. Calldata is encoded only
 * against these; nothing is written out by hand.
 */
export const launchRouterAbi = launchRouterAbiJson as Abi;
export const scheduledLaunchAbi = scheduledLaunchAbiJson as Abi;
export const lockedLaunchLiquidityAbi = lockedLaunchLiquidityAbiJson as Abi;
export const routerAbi = routerAbiJson as Abi;
export const ABI_REVISION: string = abiRevision.git_revision;

/** `NATIVE_TOKEN_ADDRESS` in the contracts' `math/constants.sol`. */
export const NATIVE_TOKEN = zeroAddress;

const CONTRACT_NAMES = [
  "core",
  "twamm",
  "scheduled_launch",
  "locked_launch_liquidity",
  "launch_router",
  "router",
] as const;

type ContractName = (typeof CONTRACT_NAMES)[number];

export interface PrepareManifest {
  chain_id: number;
  /** First block searched for launch logs. */
  from_block: number;
  git_revision: string;
  contracts: Record<ContractName, Address>;
  /**
   * The hosted quote-asset allowlist: native ETH, plus the test ERC-20 the
   * manifest names in `test_quote_token`, if any.
   */
  quote_allowlist: Address[];
}

export interface PrepareEnv {
  LAUNCHPAD_MANIFEST?: string;
  LAUNCHPAD_RPC_URL?: string;
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

function manifestInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw prepareError("invalid_manifest", { field });
  }
  return value;
}

function contractAddresses(value: unknown): Record<ContractName, Address> {
  const record = (value ?? {}) as Record<string, { address?: unknown } | undefined>;
  return Object.fromEntries(
    CONTRACT_NAMES.map((name) => [name, manifestAddress(record[name]?.address, `contracts.${name}.address`)]),
  ) as Record<ContractName, Address>;
}

function quoteAllowlist(value: unknown): Address[] {
  if (value === undefined || value === null) return [NATIVE_TOKEN];
  return [NATIVE_TOKEN, manifestAddress(value, "test_quote_token")];
}

/**
 * Read the deployment manifest written by the contracts repository. A
 * manifest from any revision other than the bundled ABIs' is refused: the
 * encodings could differ, and a plan built against the wrong ABI is exactly
 * the substitution this module must never produce.
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
  const forkBlock = manifestInteger(raw.fork_block, "fork_block");
  return {
    chain_id: manifestInteger(raw.chain_id, "chain_id"),
    from_block:
      raw.deployment_block === undefined ? forkBlock : manifestInteger(raw.deployment_block, "deployment_block"),
    git_revision: gitRevision,
    contracts: contractAddresses(raw.contracts),
    quote_allowlist: quoteAllowlist(raw.test_quote_token),
  };
}

export function requireChain(manifest: PrepareManifest, chainId: number) {
  if (chainId !== manifest.chain_id) {
    throw prepareError("unsupported_chain", { supported_chain_id: manifest.chain_id });
  }
}
