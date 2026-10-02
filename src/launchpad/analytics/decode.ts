import { decodeEventLog, hexToBigInt, toEventSelector, type Abi } from "viem";
import {
  CORE_SWAP_LOG_BYTES,
  PROTOCOL_EVENT_ABIS,
  TRANSFER_TOPIC,
  erc20Events,
} from "./abi.js";
import { logRef } from "./canonical.js";
import type { Address, Hex, LaunchpadManifest, LogRef, RawLog } from "./types.js";

export interface LaunchConfig {
  owner: Address;
  quote_token: Address;
  /** Untrusted metadata. Never interpreted. */
  name: string;
  /** Untrusted metadata. Never interpreted. */
  symbol: string;
  decimals: number;
  total_supply: bigint;
  quote_amount: bigint;
  start_time: number;
  end_time: number;
  target_tick: number;
  upper_tick: number;
  tick_spacing: number;
  initial_fee: bigint;
  final_fee: bigint;
  migration_tick_lower: number;
  migration_tick_upper: number;
}

interface Base {
  ref: LogRef;
  emitter: Address;
}

export type LaunchEvent = Base &
  (
    | {
        kind: "LaunchCreated";
        pool_id: Hex;
        token: Address;
        owner: Address;
        config: LaunchConfig;
      }
    | { kind: "LaunchAdvanced"; pool_id: Hex; deployed: bigint; complete: boolean }
    | {
        kind: "CreatorFeesClaimed";
        pool_id: Hex;
        recipient: Address;
        amount0: bigint;
        amount1: bigint;
      }
    | {
        kind: "LaunchSwapped";
        pool_id: Hex;
        locker: Address;
        delta0: bigint;
        delta1: bigint;
        fee_amount: bigint;
        fee_is_token1: boolean;
      }
    | { kind: "PrincipalReceived"; launch_id: Hex; amount0: bigint; amount1: bigint }
    | {
        kind: "LiquidityLocked";
        launch_id: Hex;
        terminal_pool_id: Hex;
        liquidity: bigint;
      }
    | {
        kind: "FeesClaimed";
        launch_id: Hex;
        recipient: Address;
        amount0: bigint;
        amount1: bigint;
      }
    | { kind: "LaunchRouted"; pool_id: Hex; payer: Address; recipient: Address }
    | { kind: "Transfer"; token: Address; from: Address; to: Address; value: bigint }
    | {
        kind: "CoreSwap";
        locker: Address;
        pool_id: Hex;
        delta0: bigint;
        delta1: bigint;
        tick: number;
        liquidity: bigint;
      }
    | {
        kind: "PositionUpdated";
        locker: Address;
        pool_id: Hex;
        position_id: Hex;
        liquidity_delta: bigint;
        delta0: bigint;
        delta1: bigint;
        tick: number;
      }
    | {
        kind: "PositionFeesCollected";
        locker: Address;
        pool_id: Hex;
        position_id: Hex;
        amount0: bigint;
        amount1: bigint;
      }
  );

export type EventOf<K extends LaunchEvent["kind"]> = Extract<
  LaunchEvent,
  { kind: K }
>;

export interface Undecoded {
  log: RawLog;
  reason: string;
}

export interface DecodedLogs {
  events: LaunchEvent[];
  /** Logs from launchpad contracts with a known topic that failed to decode, kept raw. */
  undecoded: Undecoded[];
}

const INT128_SIGN = 1n << 127n;
const UINT128 = 1n << 128n;

function signed128(value: bigint): bigint {
  return value >= INT128_SIGN ? value - UINT128 : value;
}

/** Split a packed `PoolBalanceUpdate` word into (delta0, delta1). */
export function splitBalanceUpdate(word: Hex): [bigint, bigint] {
  const value = hexToBigInt(word);
  return [signed128(value >> 128n), signed128(value & (UINT128 - 1n))];
}

function stateTick(word: bigint): number {
  const raw = Number((word >> 128n) & 0xffffffffn);
  return raw >= 0x80000000 ? raw - 0x100000000 : raw;
}

function lower(value: string): Address {
  return value.toLowerCase() as Address;
}

function decodeCoreSwap(log: RawLog): LaunchEvent {
  const body = log.data.slice(2);
  const [delta0, delta1] = splitBalanceUpdate(`0x${body.slice(104, 168)}`);
  const state = BigInt(`0x${body.slice(168, 232)}`);
  return {
    kind: "CoreSwap",
    ref: logRef(log),
    emitter: log.address,
    locker: lower(`0x${body.slice(0, 40)}`),
    pool_id: `0x${body.slice(40, 104)}`,
    delta0,
    delta1,
    tick: stateTick(state),
    liquidity: state & (UINT128 - 1n),
  };
}

type Args = Record<string, unknown>;

function configFrom(raw: Args): LaunchConfig {
  return {
    owner: lower(raw.owner as string),
    quote_token: lower(raw.quoteToken as string),
    name: raw.name as string,
    symbol: raw.symbol as string,
    decimals: Number(raw.decimals),
    total_supply: raw.totalSupply as bigint,
    quote_amount: raw.quoteAmount as bigint,
    start_time: Number(raw.startTime),
    end_time: Number(raw.endTime),
    target_tick: Number(raw.targetTick),
    upper_tick: Number(raw.upperTick),
    tick_spacing: Number(raw.tickSpacing),
    initial_fee: raw.initialFee as bigint,
    final_fee: raw.finalFee as bigint,
    migration_tick_lower: Number(raw.migrationTickLower),
    migration_tick_upper: Number(raw.migrationTickUpper),
  };
}

const SHAPERS: Record<string, (args: Args) => Record<string, unknown>> = {
  LaunchCreated: (a) => ({
    pool_id: a.poolId,
    token: lower(a.token as string),
    owner: lower(a.owner as string),
    config: configFrom(a.config as Args),
  }),
  LaunchAdvanced: (a) => ({ pool_id: a.poolId, deployed: a.deployed, complete: a.complete }),
  CreatorFeesClaimed: (a) => ({
    pool_id: a.poolId,
    recipient: lower(a.recipient as string),
    amount0: a.amount0,
    amount1: a.amount1,
  }),
  LaunchSwapped: (a) => ({
    pool_id: a.poolId,
    locker: lower(a.locker as string),
    delta0: a.delta0,
    delta1: a.delta1,
    fee_amount: a.feeAmount,
    fee_is_token1: a.feeIsToken1,
  }),
  PrincipalReceived: (a) => ({ launch_id: a.launchId, amount0: a.amount0, amount1: a.amount1 }),
  LiquidityLocked: (a) => ({
    launch_id: a.launchId,
    terminal_pool_id: a.terminalPoolId,
    liquidity: a.liquidity,
  }),
  FeesClaimed: (a) => ({
    launch_id: a.launchId,
    recipient: lower(a.recipient as string),
    amount0: a.amount0,
    amount1: a.amount1,
  }),
  LaunchRouted: (a) => ({
    pool_id: a.poolId,
    payer: lower(a.payer as string),
    recipient: lower(a.recipient as string),
  }),
  PositionUpdated: (a) => {
    const [delta0, delta1] = splitBalanceUpdate(a.balanceUpdate as Hex);
    return {
      locker: lower(a.locker as string),
      pool_id: a.poolId,
      position_id: a.positionId,
      liquidity_delta: a.liquidityDelta,
      delta0,
      delta1,
      tick: stateTick(hexToBigInt(a.stateAfter as Hex)),
    };
  },
  PositionFeesCollected: (a) => ({
    locker: lower(a.locker as string),
    pool_id: a.poolId,
    position_id: a.positionId,
    amount0: a.amount0,
    amount1: a.amount1,
  }),
  Transfer: (a) => ({
    from: lower(a.from as string),
    to: lower(a.to as string),
    value: a.value,
  }),
};

function decodeWith(abi: Abi, log: RawLog): LaunchEvent {
  const decoded = decodeEventLog({
    abi,
    data: log.data,
    topics: log.topics as [Hex, ...Hex[]],
    strict: true,
  }) as unknown as { eventName: string; args: Args };
  const shaped = SHAPERS[decoded.eventName](decoded.args);
  const extra =
    decoded.eventName === "Transfer" ? { token: log.address } : {};
  return {
    kind: decoded.eventName,
    ref: logRef(log),
    emitter: log.address,
    ...shaped,
    ...extra,
  } as LaunchEvent;
}

function protocolAbi(
  log: RawLog,
  manifest: LaunchpadManifest,
): Abi | undefined {
  for (const [name, abi] of Object.entries(PROTOCOL_EVENT_ABIS)) {
    const contract =
      manifest.contracts[name as keyof typeof PROTOCOL_EVENT_ABIS];
    if (contract.address === log.address) return abi as Abi;
  }
  return undefined;
}

/** Topics this decoder recognises for an emitter, so unrelated events are skipped quietly. */
const selectorCache = new WeakMap<Abi, Set<Hex>>();

function recognised(abi: Abi, topic: Hex | undefined): boolean {
  if (topic === undefined) return false;
  let selectors = selectorCache.get(abi);
  if (selectors === undefined) {
    selectors = new Set(
      abi
        .filter((item) => item.type === "event")
        .map((item) =>
          toEventSelector(item as Parameters<typeof toEventSelector>[0]),
        ),
    );
    selectorCache.set(abi, selectors);
  }
  return selectors.has(topic);
}

function isCoreSwap(log: RawLog, manifest: LaunchpadManifest): boolean {
  return (
    log.address === manifest.contracts.core.address &&
    log.topics.length === 0 &&
    (log.data.length - 2) / 2 === CORE_SWAP_LOG_BYTES
  );
}

function abiFor(
  log: RawLog,
  manifest: LaunchpadManifest,
  tokens: ReadonlySet<Address>,
): Abi | undefined {
  const protocol = protocolAbi(log, manifest);
  if (protocol !== undefined) return protocol;
  if (tokens.has(log.address) && log.topics[0] === TRANSFER_TOPIC) {
    return erc20Events as Abi;
  }
  return undefined;
}

function decodeOne(
  log: RawLog,
  manifest: LaunchpadManifest,
  tokens: ReadonlySet<Address>,
): LaunchEvent | null {
  if (isCoreSwap(log, manifest)) return decodeCoreSwap(log);
  const abi = abiFor(log, manifest, tokens);
  if (abi === undefined || !recognised(abi, log.topics[0])) return null;
  return decodeWith(abi, log);
}

/**
 * Decode canonical logs. A log from a launchpad contract whose topic matches
 * a known event but fails to decode is a failure, which marks every result
 * incomplete; logs the engine does not consume are skipped.
 */
export function decodeLogs(
  logs: readonly RawLog[],
  manifest: LaunchpadManifest,
): DecodedLogs {
  const result: DecodedLogs = { events: [], undecoded: [] };
  const created = launchTokens(logs, manifest);
  for (const log of logs) {
    try {
      const event = decodeOne(log, manifest, created);
      if (event !== null) result.events.push(event);
    } catch (error) {
      result.undecoded.push({
        log,
        reason: error instanceof Error ? error.name : "decode_failed",
      });
    }
  }
  return result;
}

/** Launch tokens are the indexed `token` topic of the extension's `LaunchCreated`. */
function launchTokens(
  logs: readonly RawLog[],
  manifest: LaunchpadManifest,
): Set<Address> {
  const createdTopic = toEventSelector(PROTOCOL_EVENT_ABIS.scheduled_launch[0]);
  const tokens = new Set<Address>();
  for (const log of logs) {
    if (
      log.address === manifest.contracts.scheduled_launch.address &&
      log.topics[0] === createdTopic &&
      log.topics[2] !== undefined
    ) {
      tokens.add(lower(`0x${log.topics[2].slice(26)}`));
    }
  }
  return tokens;
}
