import {
  type Address,
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  getAbiItem,
  getAddress,
  type Hex,
  pad,
  toEventSelector,
  zeroAddress,
} from "viem";
import type { ChainLog } from "./chain.js";
import type { PrepareContext } from "./context.js";
import { lockedLaunchLiquidityAbi, scheduledLaunchAbi } from "./contracts.js";
import { concentratedPoolConfig, type PoolKey, poolId } from "./encoding.js";
import { prepareError } from "./templates.js";

const LAUNCH_CREATED = toEventSelector(getAbiItem({ abi: scheduledLaunchAbi, name: "LaunchCreated" }) as never);
const PRINCIPAL_RECEIVED = toEventSelector(getAbiItem({ abi: lockedLaunchLiquidityAbi, name: "PrincipalReceived" }) as never);
const LIQUIDITY_LOCKED = toEventSelector(getAbiItem({ abi: lockedLaunchLiquidityAbi, name: "LiquidityLocked" }) as never);

interface CreatedConfig {
  owner: Address;
  quoteToken: Address;
  decimals: number;
  targetTick: number;
  upperTick: number;
  tickSpacing: number;
}

interface LaunchState {
  owner: Address;
  token: Address;
  startTime: bigint;
  endTime: bigint;
  complete: boolean;
  finalFee: bigint;
}

export interface ResolvedLaunch {
  token: Address;
  quoteToken: Address;
  /** Launch token is token0 of the pool key. */
  tokenIs0: boolean;
  key: PoolKey;
  poolId: Hex;
  decimals: number;
  targetTick: number;
  upperTick: number;
  state: LaunchState;
}

export type LaunchStage = "scheduled" | "launch" | "ended_pending_advance" | "complete";

async function createdLog(context: PrepareContext, token: Address): Promise<ChainLog> {
  const logs = await context.chain.logs({
    address: context.manifest.contracts.scheduled_launch,
    topics: [LAUNCH_CREATED, null, pad(token)],
    fromBlock: BigInt(context.manifest.from_block),
    block: context.block,
  });
  const log = logs[0];
  if (log === undefined) throw prepareError("launch_not_found");
  return log;
}

function decodeCreated(log: ChainLog): { poolId: Hex; config: CreatedConfig } {
  const decoded = decodeEventLog({
    abi: scheduledLaunchAbi,
    eventName: "LaunchCreated",
    topics: log.topics as [Hex, ...Hex[]],
    data: log.data,
  }) as unknown as { args: { poolId: Hex; config: CreatedConfig } };
  return decoded.args;
}

async function readLaunch(context: PrepareContext, id: Hex): Promise<LaunchState> {
  const result = await context.chain.call({
    from: context.sender,
    to: context.manifest.contracts.scheduled_launch,
    data: encodeFunctionData({ abi: scheduledLaunchAbi, functionName: "getLaunch", args: [id] }),
    block: context.block,
  });
  if (!result.ok) throw prepareError("launch_not_found");
  return decodeFunctionResult({ abi: scheduledLaunchAbi, functionName: "getLaunch", data: result.data }) as unknown as LaunchState;
}

/**
 * Find a launch by its exact token address on the manifest's extension, and
 * check the pool key rebuilt from its creation log against both the logged
 * pool ID and the extension's own state at the pinned block.
 */
export async function resolveLaunch(context: PrepareContext, tokenInput: string): Promise<ResolvedLaunch> {
  const token = getAddress(tokenInput);
  const created = decodeCreated(await createdLog(context, token));
  const quoteToken = getAddress(created.config.quoteToken);
  const tokenIs0 = BigInt(token) < BigInt(quoteToken);
  const key: PoolKey = {
    token0: tokenIs0 ? token : quoteToken,
    token1: tokenIs0 ? quoteToken : token,
    config: concentratedPoolConfig(0n, created.config.tickSpacing, context.manifest.contracts.scheduled_launch),
  };
  const id = poolId(key);
  if (id !== created.poolId) throw prepareError("launch_not_found");
  const state = await readLaunch(context, id);
  if (state.owner === zeroAddress || getAddress(state.token) !== token) throw prepareError("launch_not_found");
  return {
    token,
    quoteToken,
    tokenIs0,
    key,
    poolId: id,
    decimals: created.config.decimals,
    targetTick: created.config.targetTick,
    upperTick: created.config.upperTick,
    state,
  };
}

export function launchStage(launch: ResolvedLaunch, timestamp: bigint): LaunchStage {
  if (timestamp < launch.state.startTime) return "scheduled";
  if (timestamp < launch.state.endTime) return "launch";
  return launch.state.complete ? "complete" : "ended_pending_advance";
}

const order = (log: ChainLog) => log.blockNumber * 1_000_000n + BigInt(log.logIndex);

/**
 * Whether locked principal is waiting to be deposited: some principal arrived
 * after the last time liquidity was locked, or liquidity was never locked.
 */
export async function migrationPending(context: PrepareContext, launch: ResolvedLaunch): Promise<boolean> {
  const read = (topic: Hex) =>
    context.chain.logs({
      address: context.manifest.contracts.locked_launch_liquidity,
      topics: [topic, launch.poolId],
      fromBlock: BigInt(context.manifest.from_block),
      block: context.block,
    });
  const [received, locked] = await Promise.all([read(PRINCIPAL_RECEIVED), read(LIQUIDITY_LOCKED)]);
  const lastReceived = received.map(order).reduce((a, b) => (a > b ? a : b), -1n);
  const lastLocked = locked.map(order).reduce((a, b) => (a > b ? a : b), -1n);
  return lastReceived > lastLocked;
}
