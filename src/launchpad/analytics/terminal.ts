import { logKey } from "./canonical.js";
import type { EventOf } from "./decode.js";
import type { LaunchRecord } from "./launches.js";
import { sum } from "./numbers.js";
import type { Address } from "./types.js";

export interface Pair {
  amount0: bigint;
  amount1: bigint;
}

const ZERO: Pair = { amount0: 0n, amount1: 0n };

function add(a: Pair, b: Pair): Pair {
  return { amount0: a.amount0 + b.amount0, amount1: a.amount1 + b.amount1 };
}

function sub(a: Pair, b: Pair): Pair {
  return { amount0: a.amount0 - b.amount0, amount1: a.amount1 - b.amount1 };
}

function total(pairs: readonly Pair[]): Pair {
  return pairs.reduce(add, ZERO);
}

function deltaPair(e: { delta0: bigint; delta1: bigint }): Pair {
  return { amount0: e.delta0, amount1: e.delta1 };
}

/**
 * LockedLaunchLiquidity bookkeeping reconstructed from events.
 *
 * Fee collections on the locked position go to one of three places, which
 * the contract distinguishes only by call order inside a transaction:
 * `_claim` collects and immediately emits `FeesClaimed` with the same amounts;
 * `_balance` collects into principal right after its rebalancing swap; every
 * other collection (`_collectBeforeRebalance`) goes to the creator ledger. A
 * second `FeesClaimed` in a claim transaction withdraws the ledger.
 */
export interface TerminalAccounting {
  principal_received: Pair;
  deposited: Pair;
  rebalanced: Pair;
  fees_to_principal: Pair;
  /** Undeposited principal saved for the launch. */
  pending_principal: Pair;
  /** LockedLaunchLiquidity creator ledger, not yet claimed. */
  creator_ledger: Pair;
  liquidity_locked: bigint;
}

type FeeRoute = "claimed" | "principal" | "ledger";

function byTransaction<T extends { ref: { transaction_hash: string } }>(events: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const event of events) out.set(event.ref.transaction_hash, [...(out.get(event.ref.transaction_hash) ?? []), event]);
  return out;
}

function sameAmounts(a: Pair, b: Pair): boolean {
  return a.amount0 === b.amount0 && a.amount1 === b.amount1;
}

function routeCollection(
  collect: EventOf<"PositionFeesCollected">,
  swaps: readonly EventOf<"CoreSwap">[],
  claims: readonly EventOf<"FeesClaimed">[],
  claimedKeys: Set<string>,
): FeeRoute {
  const claim = claims.find((c) => c.ref.log_index > collect.ref.log_index && !claimedKeys.has(logKey(c.ref)));
  if (claim !== undefined && sameAmounts(claim, collect)) {
    claimedKeys.add(logKey(claim.ref));
    return "claimed";
  }
  const swapBefore = swaps.some((s) => s.ref.log_index < collect.ref.log_index);
  return swapBefore ? "principal" : "ledger";
}

export function terminalAccounting(launch: LaunchRecord, liquidityContract: Address): TerminalAccounting {
  const mine = <T extends { locker: Address }>(events: readonly T[]) => events.filter((e) => e.locker === liquidityContract);
  const swaps = mine(launch.terminal_pool.swaps);
  const collects = mine(launch.terminal_pool.fees);
  const deposits = mine(launch.terminal_pool.positions).filter((p) => p.liquidity_delta > 0n);
  const swapsByTx = byTransaction(swaps);
  const claimsByTx = byTransaction(launch.liquidity_fee_claims);
  const claimedKeys = new Set<string>();
  const routed: Record<FeeRoute, Pair[]> = { claimed: [], principal: [], ledger: [] };
  for (const collect of collects) {
    const tx = collect.ref.transaction_hash;
    routed[routeCollection(collect, swapsByTx.get(tx) ?? [], claimsByTx.get(tx) ?? [], claimedKeys)].push(collect);
  }
  const ledgerWithdrawals = launch.liquidity_fee_claims.filter((c) => !claimedKeys.has(logKey(c.ref)));
  const received = total(launch.principal);
  const deposited = total(deposits.map(deltaPair));
  const rebalanced = total(swaps.map(deltaPair));
  const toPrincipal = total(routed.principal);
  return {
    principal_received: received,
    deposited,
    rebalanced,
    fees_to_principal: toPrincipal,
    pending_principal: add(sub(sub(received, deposited), rebalanced), toPrincipal),
    creator_ledger: sub(total(routed.ledger), total(ledgerWithdrawals)),
    liquidity_locked: sum(launch.locks.map((l) => l.liquidity)),
  };
}
