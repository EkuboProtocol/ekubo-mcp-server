import { type Address, decodeFunctionResult, encodeFunctionData, erc20Abi, getAddress, type Hex, zeroAddress } from "viem";
import { abiFunction, extensionAbi, peripheryAbi } from "./abi.js";
import { LaunchApi, type Launch } from "./api.js";
import { type PoolKey, launchPoolConfig, poolIdOf } from "./codec.js";
import { type Deployment, deploymentFor, type LaunchpadEnv, verifiedRpc } from "./deployment.js";
import { LaunchpadError } from "./errors.js";
import type { FeeSchedule } from "./fee.js";
import { type Block, type LaunchRpc, Reverted } from "./rpc.js";

export interface ChainContext {
  deployment: Deployment;
  rpc: LaunchRpc;
}

/** The chain's deployment and verified RPC; launch_support_disabled before any request when none is configured. */
export async function chainContext(env: LaunchpadEnv, chainId: string): Promise<ChainContext> {
  const deployment = deploymentFor(env, chainId);
  return { deployment, rpc: await verifiedRpc(deployment) };
}

export function launchApi(env: LaunchpadEnv): LaunchApi {
  const base = env.LAUNCHPAD_API_URL?.trim();
  if (base === undefined || base === "") {
    throw new LaunchpadError("launch_api_not_configured", "No indexed launch API is configured, so launches cannot be listed or resolved by pool id here. Nothing was requested.", { retryable: false });
  }
  return new LaunchApi(base);
}

/** The pool key the extension installed, from the indexed launch; its id must be the requested pool id. */
export function poolKeyOf(launch: Launch, deployment: Deployment): PoolKey {
  const [token0, token1] = BigInt(launch.token.address) < BigInt(launch.quote_token.address)
    ? [launch.token.address, launch.quote_token.address]
    : [launch.quote_token.address, launch.token.address];
  const key = { token0, token1, config: launchPoolConfig(deployment.extension, launch.range.tick_spacing) };
  const wire = launch.pool_key;
  const sameKey = wire.token0 === token0 && wire.token1 === token1 && wire.config === key.config.toLowerCase() &&
    wire.extension === deployment.extension && wire.core_address === deployment.core;
  if (!sameKey || poolIdOf(key) !== launch.pool_id) {
    throw new LaunchpadError("invalid_upstream_response", "The indexed launch does not hash to its pool id on this deployment. Nothing was prepared; retry later.", { retryable: true, upstream: "launch_api" });
  }
  return key;
}

async function read(rpc: LaunchRpc, to: Address, abi: typeof extensionAbi, name: string, args: readonly unknown[], block?: Block) {
  const fn = abiFunction(abi, name);
  const data = await rpc.call(to, encodeFunctionData({ abi: [fn], functionName: name, args }), { block });
  return decodeFunctionResult({ abi: [fn], functionName: name, data }) as unknown;
}

export interface OnchainLaunch {
  controller: Address;
  schedule: FeeSchedule;
  tickLower: number;
  tickUpper: number;
}

/** extension.getLaunch(poolId); launch_not_found when the extension has no launch with this id. */
export async function getLaunch(context: ChainContext, poolId: Hex, block?: Block): Promise<OnchainLaunch> {
  let result: Record<string, bigint | number | string>;
  try {
    result = await read(context.rpc, context.deployment.extension, extensionAbi, "getLaunch", [poolId], block) as typeof result;
  } catch (error) {
    if (error instanceof Reverted && error.errorName === "UnknownLaunch") throw notFound(context, poolId);
    throw error;
  }
  if (result.controller === zeroAddress) throw notFound(context, poolId);
  return {
    controller: getAddress(result.controller as string),
    schedule: {
      tradingStart: BigInt(result.tradingStart), decayRateX32: BigInt(result.decayRateX32),
      initialFee: BigInt(result.initialFee), finalFee: BigInt(result.finalFee),
    },
    tickLower: Number(result.tickLower), tickUpper: Number(result.tickUpper),
  };
}

function notFound(context: ChainContext, poolId: Hex): LaunchpadError {
  return new LaunchpadError("launch_not_found", `No launch ${poolId} exists on chain ${context.deployment.chainId}. Check pool_id and chain_id.`, { argument: "pool_id", retryable: false });
}

export async function launchOwner(context: ChainContext, poolId: Hex, block?: Block): Promise<Address> {
  return getAddress(await read(context.rpc, context.deployment.periphery, peripheryAbi, "launchOwner", [poolId], block) as string);
}

export async function feeAtBlock(context: ChainContext, poolId: Hex, block: Block): Promise<bigint> {
  return await read(context.rpc, context.deployment.extension, extensionAbi, "feeAt", [poolId, block.timestamp], block) as bigint;
}

export async function creatorFees(context: ChainContext, key: PoolKey, block: Block): Promise<[bigint, bigint]> {
  return await read(context.rpc, context.deployment.extension, extensionAbi, "creatorFees", [key], block) as [bigint, bigint];
}

export async function erc20Read(context: ChainContext, token: Address, name: "decimals" | "allowance", args: readonly unknown[], block?: Block) {
  const data = await context.rpc.call(token, encodeFunctionData({ abi: erc20Abi, functionName: name, args } as never), { block });
  return decodeFunctionResult({ abi: erc20Abi, functionName: name, data } as never) as unknown as bigint | number;
}

export const blockSummary = (block: Block) => ({
  number: block.number.toString(), hash: block.hash, timestamp: block.timestamp.toString(),
});
