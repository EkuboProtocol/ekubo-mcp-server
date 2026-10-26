import { type Address, getAddress, type Hex, hexToBytes, keccak256 } from "viem";
import { z } from "zod";
import { RUNTIME_TEMPLATES } from "./abi.js";
import { LaunchpadError, supportDisabled } from "./errors.js";
import { LaunchRpc } from "./rpc.js";

export interface LaunchpadEnv {
  /**
   * JSON array of final-contract deployments, each {chain_id, rpc_url, core, extension, periphery, router,
   * deployment_block}. Absent or empty means launch support is disabled. No deployment is built in: none of the final
   * contracts is deployed.
   */
  LAUNCHPAD_DEPLOYMENTS?: string;
  /** The indexed launch API base URL. */
  LAUNCHPAD_API_URL?: string;
}

export interface Deployment {
  chainId: string;
  rpcUrl: string;
  core: Address;
  extension: Address;
  periphery: Address;
  router: Address;
  /** Decimal block number in which the periphery (deployed after the extension it binds) was deployed. */
  deploymentBlock: string;
}

/** The runtimes the deployment check read: keccak256 of the extension's and the periphery's deployed code. */
export interface DeployedRuntimes {
  extension: Hex;
  periphery: Hex;
}

/**
 * Contracts of earlier launch revisions (fixed-base, tick-rate drafts). They are historical facts, never supported:
 * the final ABI is never attached to them, so a configuration naming one is refused.
 */
const HISTORICAL_LAUNCH_CONTRACTS: ReadonlySet<string> = new Set([
  "0x80b13d3e2615d6bba412f98d12347b2ffac0f6ae",
  "0x51bdfb5ab2076b5220b5067ac29167a56147a139",
  "0x519c5f793d3f6cf9ee439e4cc38d8285cf08211f",
  "0x0df4e2a76640b52e51479b435f52d0eb0e7e8ef4",
  "0x5135fd3e9a6056937eaf6b99454bbc2198c2263d",
  "0xfb2e7927d3e4984dca3e390526d43c6f5a3461e9",
]);

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => getAddress(value));
const DeploymentSchema = z.strictObject({
  chain_id: z.string().regex(/^[1-9][0-9]*$/),
  rpc_url: z.url({ protocol: /^https?$/ }),
  core: addr, extension: addr, periphery: addr, router: addr,
  deployment_block: z.string().regex(/^[1-9][0-9]{0,19}$/),
});

function misconfigured(reason: string): LaunchpadError {
  return new LaunchpadError("launch_deployment_invalid", `The launchpad deployment configuration is invalid (${reason}); launch support stays disabled. This is a server configuration problem, not an input problem.`, { retryable: false });
}

/** The configured deployments; [] when none. A malformed configuration fails closed. */
export function deployments(env: LaunchpadEnv): Deployment[] {
  const raw = env.LAUNCHPAD_DEPLOYMENTS?.trim();
  if (raw === undefined || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw misconfigured("not JSON");
  }
  const result = z.array(DeploymentSchema).safeParse(parsed);
  if (!result.success) throw misconfigured("schema");
  const seen = new Set<string>();
  return result.data.map((entry) => {
    const contracts = [entry.core, entry.extension, entry.periphery, entry.router];
    if (seen.has(entry.chain_id)) throw misconfigured(`duplicate chain ${entry.chain_id}`);
    seen.add(entry.chain_id);
    if (contracts.some((value) => HISTORICAL_LAUNCH_CONTRACTS.has(value.toLowerCase()))) {
      throw misconfigured(`chain ${entry.chain_id} names a historical launch contract`);
    }
    if (new Set(contracts).size !== 4) throw misconfigured(`chain ${entry.chain_id} repeats a contract`);
    return { chainId: entry.chain_id, rpcUrl: entry.rpc_url, core: entry.core, extension: entry.extension,
      periphery: entry.periphery, router: entry.router, deploymentBlock: entry.deployment_block };
  });
}

/** The deployment on a chain, or launch_support_disabled before any upstream request. */
export function deploymentFor(env: LaunchpadEnv, chainId: string): Deployment {
  const found = deployments(env).find((entry) => entry.chainId === chainId);
  if (found === undefined) throw supportDisabled(chainId);
  return found;
}

const word = (address: Address) => hexToBytes(`0x${address.slice(2).toLowerCase().padStart(64, "0")}` as Hex);

/** Runtime equals the frozen template with exactly the expected immutables at the compiler's offsets. */
export function matchesTemplate(code: Hex, template: { length: number; template_keccak256: string; immutables: Record<string, number[]> },
  values: Record<string, Address>): boolean {
  const bytes = hexToBytes(code);
  if (bytes.length !== template.length) return false;
  const zeroed = bytes.slice();
  for (const [role, offsets] of Object.entries(template.immutables)) {
    const expected = word(values[role]);
    for (const offset of offsets) {
      if (bytes.subarray(offset, offset + 32).some((byte, index) => byte !== expected[index])) return false;
      zeroed.fill(0, offset, offset + 32);
    }
  }
  return keccak256(zeroed) === template.template_keccak256;
}

const verified = new Map<string, DeployedRuntimes>();

function mismatch(deployment: Deployment, what: string): LaunchpadError {
  return new LaunchpadError("launch_deployment_mismatch", `The configured chain ${deployment.chainId} deployment ${what}. Nothing was prepared; launch support stays disabled there.`, { retryable: false });
}

/** Both contracts have code at the deployment block, and the periphery, deployed last, has none in the block before. */
async function checkDeploymentBlock(rpc: LaunchRpc, deployment: Deployment, codes: [Hex, Hex]): Promise<void> {
  const block = BigInt(deployment.deploymentBlock);
  const [extensionAt, peripheryAt, peripheryBefore] = await Promise.all([
    rpc.code(deployment.extension, block), rpc.code(deployment.periphery, block), rpc.code(deployment.periphery, block - 1n),
  ]);
  if (extensionAt !== codes[0] || peripheryAt !== codes[1] || peripheryBefore !== "0x") {
    throw mismatch(deployment, `was not deployed in block ${deployment.deploymentBlock} (deployment_block)`);
  }
}

/**
 * The deployment's RPC and deployed runtime hashes, after checking once per isolate that it serves the configured
 * chain, that the extension and periphery run the frozen final runtime bound to the configured Core and extension,
 * and that the periphery was deployed in deployment_block.
 */
export async function verifiedRpc(deployment: Deployment, fetcher: typeof fetch = fetch): Promise<{ rpc: LaunchRpc; runtimes: DeployedRuntimes }> {
  const rpc = new LaunchRpc(deployment.rpcUrl, fetcher);
  const key = JSON.stringify(deployment);
  const cached = verified.get(key);
  if (cached !== undefined) return { rpc, runtimes: cached };
  const [chain, extensionCode, peripheryCode] = await Promise.all([
    rpc.chainId(), rpc.code(deployment.extension), rpc.code(deployment.periphery),
  ]);
  if (chain.toString() !== deployment.chainId ||
    !matchesTemplate(extensionCode, RUNTIME_TEMPLATES.ZeroSeedLaunch, { core: deployment.core }) ||
    !matchesTemplate(peripheryCode, RUNTIME_TEMPLATES.ZeroSeedLaunchPeriphery, { core: deployment.core, extension: deployment.extension })) {
    throw mismatch(deployment, "does not run the final launch contracts");
  }
  await checkDeploymentBlock(rpc, deployment, [extensionCode, peripheryCode]);
  const runtimes = { extension: keccak256(extensionCode), periphery: keccak256(peripheryCode) };
  verified.set(key, runtimes);
  return { rpc, runtimes };
}
