import type { EventOf, LaunchConfig, LaunchEvent } from "./decode.js";
import type { Address, BlockHeader, Hex, LogRef } from "./types.js";

export interface PoolActivity {
  swaps: EventOf<"CoreSwap">[];
  positions: EventOf<"PositionUpdated">[];
  fees: EventOf<"PositionFeesCollected">[];
}

export interface LaunchRecord {
  pool_id: Hex;
  token: Address;
  /** The fee beneficiary named in the config. Not a verified creator. */
  beneficiary: Address;
  quote_token: Address;
  token_is0: boolean;
  config: LaunchConfig;
  created: LogRef;
  emitter: Address;
  advances: EventOf<"LaunchAdvanced">[];
  creator_fee_claims: EventOf<"CreatorFeesClaimed">[];
  launch_swaps: EventOf<"LaunchSwapped">[];
  routes: EventOf<"LaunchRouted">[];
  principal: EventOf<"PrincipalReceived">[];
  locks: EventOf<"LiquidityLocked">[];
  liquidity_fee_claims: EventOf<"FeesClaimed">[];
  terminal_pool_id: Hex | null;
  launch_pool: PoolActivity;
  terminal_pool: PoolActivity;
}

export interface LaunchIndex {
  launches: LaunchRecord[];
  by_pool: Map<Hex, LaunchRecord>;
  by_token: Map<Address, LaunchRecord>;
  transfers: Map<Address, EventOf<"Transfer">[]>;
  timestamps: Map<number, number>;
  /** Integrity problems found while indexing; any entry makes results incomplete. */
  anomalies: string[];
}

function emptyActivity(): PoolActivity {
  return { swaps: [], positions: [], fees: [] };
}

function newRecord(event: EventOf<"LaunchCreated">): LaunchRecord {
  const quote = event.config.quote_token;
  return {
    pool_id: event.pool_id,
    token: event.token,
    beneficiary: event.owner,
    quote_token: quote,
    token_is0: BigInt(event.token) < BigInt(quote),
    config: event.config,
    created: event.ref,
    emitter: event.emitter,
    advances: [],
    creator_fee_claims: [],
    launch_swaps: [],
    routes: [],
    principal: [],
    locks: [],
    liquidity_fee_claims: [],
    terminal_pool_id: null,
    launch_pool: emptyActivity(),
    terminal_pool: emptyActivity(),
  };
}

type Attach = (index: LaunchIndex, event: LaunchEvent) => void;

function launchFor(index: LaunchIndex, poolId: Hex): LaunchRecord | undefined {
  return index.by_pool.get(poolId);
}

const ATTACH: Partial<Record<LaunchEvent["kind"], Attach>> = {
  LaunchAdvanced: (index, e) => {
    const event = e as EventOf<"LaunchAdvanced">;
    launchFor(index, event.pool_id)?.advances.push(event);
  },
  CreatorFeesClaimed: (index, e) => {
    const event = e as EventOf<"CreatorFeesClaimed">;
    launchFor(index, event.pool_id)?.creator_fee_claims.push(event);
  },
  LaunchSwapped: (index, e) => {
    const event = e as EventOf<"LaunchSwapped">;
    launchFor(index, event.pool_id)?.launch_swaps.push(event);
  },
  LaunchRouted: (index, e) => {
    const event = e as EventOf<"LaunchRouted">;
    launchFor(index, event.pool_id)?.routes.push(event);
  },
  PrincipalReceived: (index, e) => {
    const event = e as EventOf<"PrincipalReceived">;
    launchFor(index, event.launch_id)?.principal.push(event);
  },
  LiquidityLocked: (index, e) => {
    const event = e as EventOf<"LiquidityLocked">;
    const launch = launchFor(index, event.launch_id);
    if (launch === undefined) return;
    launch.locks.push(event);
    launch.terminal_pool_id ??= event.terminal_pool_id;
  },
  FeesClaimed: (index, e) => {
    const event = e as EventOf<"FeesClaimed">;
    launchFor(index, event.launch_id)?.liquidity_fee_claims.push(event);
  },
  Transfer: (index, e) => {
    const event = e as EventOf<"Transfer">;
    const list = index.transfers.get(event.token) ?? [];
    list.push(event);
    index.transfers.set(event.token, list);
  },
};

type PoolEvent = EventOf<"CoreSwap" | "PositionUpdated" | "PositionFeesCollected">;

function poolActivityFor(
  launch: LaunchRecord,
  poolId: Hex,
): PoolActivity | undefined {
  if (poolId === launch.pool_id) return launch.launch_pool;
  if (poolId === launch.terminal_pool_id) return launch.terminal_pool;
  return undefined;
}

function attachPoolEvent(
  pools: Map<Hex, LaunchRecord>,
  event: PoolEvent,
): void {
  const launch = pools.get(event.pool_id);
  if (launch === undefined) return;
  const activity = poolActivityFor(launch, event.pool_id);
  if (activity === undefined) return;
  if (event.kind === "CoreSwap") activity.swaps.push(event);
  else if (event.kind === "PositionUpdated") activity.positions.push(event);
  else activity.fees.push(event);
}

function isPoolEvent(event: LaunchEvent): event is PoolEvent {
  return (
    event.kind === "CoreSwap" ||
    event.kind === "PositionUpdated" ||
    event.kind === "PositionFeesCollected"
  );
}

function registerLaunch(
  index: LaunchIndex,
  event: EventOf<"LaunchCreated">,
): void {
  if (index.by_pool.has(event.pool_id) || index.by_token.has(event.token)) {
    index.anomalies.push(
      `Duplicate LaunchCreated for pool ${event.pool_id} at block ${event.ref.block_number} log ${event.ref.log_index}; the first is used.`,
    );
    return;
  }
  const record = newRecord(event);
  index.launches.push(record);
  index.by_pool.set(record.pool_id, record);
  index.by_token.set(record.token, record);
}

/**
 * Build per-launch state from canonical, ordered events. Pool-level Core
 * events are attached in a second pass, because a terminal pool is only
 * known once `LiquidityLocked` names it.
 */
export function buildLaunchIndex(
  events: readonly LaunchEvent[],
  headers: readonly BlockHeader[],
): LaunchIndex {
  const index: LaunchIndex = {
    launches: [],
    by_pool: new Map(),
    by_token: new Map(),
    transfers: new Map(),
    timestamps: new Map(headers.map((h) => [h.number, h.timestamp])),
    anomalies: [],
  };
  for (const event of events) {
    if (event.kind === "LaunchCreated") registerLaunch(index, event);
    else ATTACH[event.kind]?.(index, event);
  }
  const pools = new Map<Hex, LaunchRecord>();
  for (const launch of index.launches) {
    pools.set(launch.pool_id, launch);
    if (launch.terminal_pool_id !== null) pools.set(launch.terminal_pool_id, launch);
  }
  for (const event of events) {
    if (isPoolEvent(event)) attachPoolEvent(pools, event);
  }
  return index;
}

export function timestampOf(index: LaunchIndex, ref: LogRef): number | null {
  return index.timestamps.get(ref.block_number) ?? null;
}
