import {
  type Address,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
  keccak256,
  numberToHex,
  zeroAddress,
} from "viem";
import type { ApiLaunchDetail, LaunchpadApi } from "./api.js";
import type { PrepareContext } from "./context.js";
import { scheduledLaunchAbi } from "./contracts.js";
import { concentratedPoolConfig, type PoolKey, poolId } from "./encoding.js";
import { prepareError } from "./templates.js";

interface LaunchState {
  owner: Address;
  token: Address;
  startTime: bigint;
  endTime: bigint;
  complete: boolean;
  initialFee: bigint;
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
  /** The api's record: identity, config and indexed history. */
  indexed: ApiLaunchDetail;
  /** `ScheduledLaunch.getLaunch` at the pinned block. */
  state: LaunchState;
}

export type LaunchStage = "scheduled" | "launch" | "ended_pending_advance" | "complete";

/** A launch is named by its exact token address or its pool id; never by name or symbol. */
export interface LaunchSelector {
  token?: string;
  pool_id?: string;
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

export async function selectedPoolId(api: LaunchpadApi, chainId: number, selector: LaunchSelector): Promise<Hex> {
  if (selector.pool_id !== undefined) return numberToHex(BigInt(selector.pool_id), { size: 32 });
  if (selector.token === undefined) throw prepareError("launch_not_found");
  return api.poolIdForToken(chainId, getAddress(selector.token));
}

/**
 * The pool key rebuilt on the manifest's extension from the api's record. A
 * record on any other extension or Core, or whose rebuilt key does not hash
 * to the api's pool id, is not found.
 */
function indexedKey(context: PrepareContext, indexed: ApiLaunchDetail, id: Hex, selector: LaunchSelector) {
  const { contracts } = context.manifest;
  const onManifest = indexed.pool_key.extension === contracts.scheduled_launch && indexed.pool_key.core_address === contracts.core;
  const token = indexed.launch_token.address;
  if (!onManifest || (selector.token !== undefined && getAddress(selector.token) !== token)) throw prepareError("launch_not_found");
  const quoteToken = indexed.quote_token.address;
  const tokenIs0 = BigInt(token) < BigInt(quoteToken);
  const key: PoolKey = {
    token0: tokenIs0 ? token : quoteToken,
    token1: tokenIs0 ? quoteToken : token,
    config: concentratedPoolConfig(0n, indexed.tick_spacing, contracts.scheduled_launch),
  };
  if (poolId(key) !== id || indexed.launch_token_is_token1 === tokenIs0) throw prepareError("launch_not_found");
  return { token, quoteToken, tokenIs0, key };
}

/**
 * Find a launch through the api, rebuild its pool key on the manifest's
 * extension, and check the result against the api's pool id and against the
 * extension's own state at the pinned block.
 */
export async function resolveLaunch(context: PrepareContext, selector: LaunchSelector): Promise<ResolvedLaunch> {
  const id = await selectedPoolId(context.api, context.manifest.chain_id, selector);
  const indexed = await context.api.detail(context.manifest.chain_id, id);
  if (indexed === null) throw prepareError("launch_not_found");
  const { token, quoteToken, tokenIs0, key } = indexedKey(context, indexed, id, selector);
  const state = await readLaunch(context, id);
  if (state.owner === zeroAddress || getAddress(state.token) !== token) throw prepareError("launch_not_found");
  return {
    token,
    quoteToken,
    tokenIs0,
    key,
    poolId: id,
    decimals: indexed.launch_token.decimals,
    targetTick: indexed.target_tick,
    upperTick: indexed.upper_tick,
    indexed,
    state,
  };
}

/** Phase at the pinned block, from the extension's state rather than the api's indexed head. */
export function launchStage(launch: ResolvedLaunch, timestamp: bigint): LaunchStage {
  if (timestamp < launch.state.startTime) return "scheduled";
  if (launch.state.complete) return "complete";
  return timestamp < launch.state.endTime ? "launch" : "ended_pending_advance";
}

/**
 * Core's saved-balance slot for `(owner, token0, token1, salt)`:
 * `CoreStorageLayout.savedBalancesSlot`, keccak256 over four words.
 */
export function savedBalancesSlot(owner: Address, token0: Address, token1: Address, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "bytes32" }],
      [owner, token0, token1, salt],
    ),
  );
}

/**
 * Whether locked principal is waiting to be deposited: LockedLaunchLiquidity
 * saves undeposited principal in Core under the launch id, and `migrate`
 * deposits it. One storage read at the pinned block; no log history.
 */
export async function migrationPending(context: PrepareContext, launch: ResolvedLaunch): Promise<{ amount0: bigint; amount1: bigint }> {
  const slot = savedBalancesSlot(context.manifest.contracts.locked_launch_liquidity, launch.key.token0, launch.key.token1, launch.poolId);
  const value = BigInt(await context.chain.storage(context.manifest.contracts.core, slot, context.block));
  return { amount0: value >> 128n, amount1: value & ((1n << 128n) - 1n) };
}
