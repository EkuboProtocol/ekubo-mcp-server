import { type Address, decodeFunctionResult, encodeFunctionData, getAddress, keccak256 } from "viem";
import { LaunchpadApi, type Fetcher } from "./api.js";
import { type PinnedBlock, type PrepareChain, RpcChain } from "./chain.js";
import { DISCLOSURE_VERSION } from "./content.js";
import {
  CONTRACT_NAMES,
  type PrepareEnv,
  type PrepareManifest,
  launchRouterAbi,
  lockedLaunchLiquidityAbi,
  prepareManifest,
  requireChain,
  scheduledLaunchAbi,
} from "./contracts.js";
import { PROTOTYPE_NOTE, REFERENCE_RECOVERY, prepareError } from "./templates.js";

export interface PrepareContext {
  manifest: PrepareManifest;
  chain: PrepareChain;
  api: LaunchpadApi;
  fetcher: Fetcher;
  block: PinnedBlock;
  sender: Address;
}

/** Tests inject a chain and a fetcher; the hosted server reads the configured endpoints. */
export interface Deps {
  chain: (env: PrepareEnv) => PrepareChain;
  fetch: Fetcher;
}

export const rpcChain = (env: PrepareEnv, fetcher: Fetcher = fetch): PrepareChain => {
  if (env.LAUNCHPAD_RPC_URL === undefined || env.LAUNCHPAD_RPC_URL === "") {
    throw prepareError("launchpad_not_configured");
  }
  return new RpcChain(env.LAUNCHPAD_RPC_URL, fetcher);
};

export function resolveDeps(deps: Partial<Deps> = {}): Deps {
  const fetcher = deps.fetch ?? fetch;
  return { fetch: fetcher, chain: deps.chain ?? ((env) => rpcChain(env, fetcher)) };
}

/**
 * The immutable links between the launchpad contracts, read back at the
 * pinned block. A manifest whose addresses are individually right but wired
 * to other instances is refused like a code-hash mismatch.
 */
const LINKS = [
  { contract: "scheduled_launch", abi: scheduledLaunchAbi, fn: "LIQUIDITY", expected: "locked_launch_liquidity" },
  { contract: "scheduled_launch", abi: scheduledLaunchAbi, fn: "TWAMM", expected: "twamm" },
  { contract: "launch_router", abi: launchRouterAbi, fn: "EXTENSION", expected: "scheduled_launch" },
  { contract: "launch_router", abi: launchRouterAbi, fn: "LIQUIDITY", expected: "locked_launch_liquidity" },
  { contract: "locked_launch_liquidity", abi: lockedLaunchLiquidityAbi, fn: "EXTENSION", expected: "scheduled_launch" },
] as const;

/**
 * Gate C1: every manifest address carries the manifest's runtime code hash at
 * the pinned block, and the launchpad contracts point at each other. Runs
 * before any plan is built; any mismatch refuses the call.
 */
export async function verifyDeployment(manifest: PrepareManifest, chain: PrepareChain, block: PinnedBlock, from: Address) {
  const codes = await Promise.all(CONTRACT_NAMES.map((name) => chain.code(manifest.contracts[name], block)));
  CONTRACT_NAMES.forEach((name, index) => {
    const observed = codes[index] === "0x" ? null : keccak256(codes[index]);
    if (observed !== manifest.code_hashes[name]) {
      throw prepareError("deployment_mismatch", {
        contract: name,
        address: manifest.contracts[name],
        manifest_code_hash: manifest.code_hashes[name],
        observed_code_hash: observed,
      });
    }
  });
  const links = await Promise.all(
    LINKS.map((link) =>
      chain.call({ from, to: manifest.contracts[link.contract], data: encodeFunctionData({ abi: link.abi, functionName: link.fn }), block }),
    ),
  );
  LINKS.forEach((link, index) => {
    const result = links[index];
    const observed = result.ok
      ? getAddress(decodeFunctionResult({ abi: link.abi, functionName: link.fn, data: result.data }) as Address)
      : null;
    if (observed !== manifest.contracts[link.expected]) {
      throw prepareError("deployment_mismatch", {
        contract: link.contract,
        link: link.fn,
        expected: manifest.contracts[link.expected],
        observed,
      });
    }
  });
}

export async function prepareContext(
  env: PrepareEnv,
  input: { chain_id: number; sender: string },
  deps: Partial<Deps> = {},
): Promise<PrepareContext> {
  const manifest = prepareManifest(env);
  requireChain(manifest, input.chain_id);
  const resolved = resolveDeps(deps);
  const chain = resolved.chain(env);
  const block = await chain.latest();
  const sender = getAddress(input.sender);
  await verifyDeployment(manifest, chain, block, sender);
  return { manifest, chain, api: new LaunchpadApi(env, resolved.fetch), fetcher: resolved.fetch, block, sender };
}

/** Fields shared by every preparation output. */
export function outputHeader(context: PrepareContext) {
  return {
    prototype: PROTOTYPE_NOTE,
    as_of: {
      chain_id: context.manifest.chain_id,
      block_number: context.block.number.toString(),
      block_hash: context.block.hash,
      block_timestamp: context.block.timestamp.toString(),
    },
    manifest_revision: context.manifest.git_revision,
    deployment_check: {
      contracts: Object.fromEntries(CONTRACT_NAMES.map((name) => [name, context.manifest.contracts[name]])),
      code_hashes_match_manifest: true,
      at_block: context.block.number.toString(),
    },
    transaction_sender: context.sender,
    disclosure_version: DISCLOSURE_VERSION,
    disclosures_resource: "launchpad://disclosures",
    reference_recovery: REFERENCE_RECOVERY,
  };
}
