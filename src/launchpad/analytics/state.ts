import { logKey } from "./canonical.js";
import type { EventOf, LaunchConfig } from "./decode.js";
import type { LaunchRecord, PoolActivity } from "./launches.js";
import type { Address, LogRef } from "./types.js";
import { sum } from "./numbers.js";

/** `ScheduledLaunch.released`: cumulative released supply at `timestamp`. */
export function releasedAt(config: LaunchConfig, timestamp: number): bigint {
  if (timestamp <= config.start_time) return 0n;
  if (timestamp >= config.end_time) return config.total_supply;
  return (
    (config.total_supply * BigInt(timestamp - config.start_time)) /
    BigInt(config.end_time - config.start_time)
  );
}

/** `ScheduledLaunch.feeAt`: the creator fee charged at `timestamp`. */
export function feeAt(config: LaunchConfig, timestamp: number): bigint {
  if (timestamp <= config.start_time) return config.initial_fee;
  if (timestamp >= config.end_time) return config.final_fee;
  return (
    config.initial_fee -
    ((config.initial_fee - config.final_fee) *
      BigInt(timestamp - config.start_time)) /
      BigInt(config.end_time - config.start_time)
  );
}

export function latestAdvance(
  launch: LaunchRecord,
): EventOf<"LaunchAdvanced"> | null {
  return launch.advances.at(-1) ?? null;
}

export function deployed(launch: LaunchRecord): bigint {
  return latestAdvance(launch)?.deployed ?? 0n;
}

/** `_finish` always forwards principal, so a `PrincipalReceived` marks that the end was processed. */
export function finished(launch: LaunchRecord): boolean {
  return launch.principal.length > 0;
}

/** Pick the launch-token or quote side of a (delta0, delta1) pair. */
export function side(
  launch: LaunchRecord,
  pair: { amount0: bigint; amount1: bigint },
  which: "token" | "quote",
): bigint {
  const tokenSide = launch.token_is0 ? pair.amount0 : pair.amount1;
  const quoteSide = launch.token_is0 ? pair.amount1 : pair.amount0;
  return which === "token" ? tokenSide : quoteSide;
}

export function deltas(event: { delta0: bigint; delta1: bigint }) {
  return { amount0: event.delta0, amount1: event.delta1 };
}

/**
 * Core-held amount of one side of a pool: swap deltas plus position deltas,
 * less collected fees. Every term is a Core event, so this is exact for the
 * pools the engine tracks.
 */
export function poolReserve(
  launch: LaunchRecord,
  activity: PoolActivity,
  which: "token" | "quote",
): bigint {
  const swaps = sum(activity.swaps.map((e) => side(launch, deltas(e), which)));
  const positions = sum(
    activity.positions.map((e) => side(launch, deltas(e), which)),
  );
  const fees = sum(activity.fees.map((e) => side(launch, e, which)));
  return swaps + positions - fees;
}

/** Pool-orientation bounds of the launch position. */
export function launchRange(launch: LaunchRecord): {
  lower: number;
  upper: number;
  initial: number;
} {
  const { target_tick: target, upper_tick: upper } = launch.config;
  return launch.token_is0
    ? { lower: target, upper, initial: target }
    : { lower: -upper, upper: -target, initial: -target };
}

export interface PoolStateView {
  tick: number;
  liquidity: string | null;
  observed_at: LogRef | null;
  basis: "last_core_swap" | "initialization";
}

export function launchPoolState(launch: LaunchRecord): PoolStateView {
  const last = launch.launch_pool.swaps.at(-1);
  if (last === undefined) {
    return {
      tick: launchRange(launch).initial,
      liquidity: null,
      observed_at: null,
      basis: "initialization",
    };
  }
  return {
    tick: last.tick,
    liquidity: last.liquidity.toString(),
    observed_at: last.ref,
    basis: "last_core_swap",
  };
}

/** Bought out beyond the far bound of the launch range, so no released inventory can trade. */
export function beyondLaunchRange(launch: LaunchRecord, tick: number): boolean {
  const range = launchRange(launch);
  return launch.token_is0 ? tick >= range.upper : tick <= range.lower;
}

export type Phase =
  | "scheduled"
  | "active"
  | "stalled"
  | "ended_pending_advance"
  | "migration_pending"
  | "migrated";

function livePhase(launch: LaunchRecord, timestamp: number): Phase {
  const pending = releasedAt(launch.config, timestamp) - deployed(launch);
  const state = launchPoolState(launch);
  return pending > 0n && beyondLaunchRange(launch, state.tick)
    ? "stalled"
    : "active";
}

export function phaseAt(launch: LaunchRecord, timestamp: number): Phase {
  if (timestamp < launch.config.start_time) return "scheduled";
  if (timestamp < launch.config.end_time) return livePhase(launch, timestamp);
  if (!finished(launch) || latestAdvance(launch)?.complete !== true) {
    return "ended_pending_advance";
  }
  return launch.locks.length === 0 ? "migration_pending" : "migrated";
}

export interface SwapAttribution {
  payer: Address;
  recipient: Address;
}

/**
 * Pair router-forwarded swaps with the router's `LaunchRouted` log in the same
 * transaction, in log order. Swaps forwarded by any other locker have no
 * payer or recipient in the logs and map to `null`.
 */
export function attributeSwaps(
  launch: LaunchRecord,
  launchRouter: Address,
): Map<string, SwapAttribution | null> {
  const routesByTx = new Map<string, EventOf<"LaunchRouted">[]>();
  for (const route of launch.routes) {
    const list = routesByTx.get(route.ref.transaction_hash) ?? [];
    list.push(route);
    routesByTx.set(route.ref.transaction_hash, list);
  }
  const used = new Map<string, number>();
  const result = new Map<string, SwapAttribution | null>();
  for (const swap of launch.launch_swaps) {
    const tx = swap.ref.transaction_hash;
    const routes = routesByTx.get(tx) ?? [];
    const position = used.get(tx) ?? 0;
    const route = swap.locker === launchRouter ? routes[position] : undefined;
    if (route !== undefined) used.set(tx, position + 1);
    result.set(
      logKey(swap.ref),
      route === undefined ? null : { payer: route.payer, recipient: route.recipient },
    );
  }
  return result;
}

/**
 * Launch-pool Core swaps split into the user swap behind each
 * `LaunchSwapped` (the nearest earlier Core swap on the pool in the same
 * transaction) and internal release sales (every other one).
 */
export function splitLaunchPoolSwaps(launch: LaunchRecord): {
  user: Map<string, EventOf<"CoreSwap">>;
  internal: EventOf<"CoreSwap">[];
} {
  const matched = new Set<string>();
  const user = new Map<string, EventOf<"CoreSwap">>();
  for (const swap of launch.launch_swaps) {
    const candidate = launch.launch_pool.swaps
      .filter(
        (core) =>
          core.ref.transaction_hash === swap.ref.transaction_hash &&
          core.ref.log_index < swap.ref.log_index &&
          !matched.has(logKey(core.ref)),
      )
      .at(-1);
    if (candidate === undefined) continue;
    matched.add(logKey(candidate.ref));
    user.set(logKey(swap.ref), candidate);
  }
  const internal = launch.launch_pool.swaps.filter(
    (core) => !matched.has(logKey(core.ref)),
  );
  return { user, internal };
}
