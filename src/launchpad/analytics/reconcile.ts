import type { EventOf } from "./decode.js";
import type { LaunchIndex, LaunchRecord } from "./launches.js";
import { sum } from "./numbers.js";
import { deltas, side } from "./state.js";
import type { Address, Hex } from "./types.js";

export const RECONCILIATION_METHOD = { id: "launch_swapped.core_transfer_reconciliation", version: 1 } as const;

export interface Mismatch {
  transaction_hash: Hex;
  expected_core_net: string;
  observed_core_net: string;
}

function inTx<T extends { ref: { transaction_hash: Hex } }>(events: readonly T[], tx: Hex): T[] {
  return events.filter((e) => e.ref.transaction_hash === tx);
}

/**
 * Every transaction with a `LaunchSwapped` must move the launch token in and
 * out of Core by exactly the swap's fee-inclusive token deltas, plus any
 * creator-fee withdrawals in the same transaction. The token is the only side
 * checked: quote Transfers are not read, and native ETH has none.
 */
export function reconcileSwaps(
  launch: LaunchRecord,
  index: LaunchIndex,
  core: Address,
): { checked: number; mismatched: Mismatch[] } {
  const transfers: EventOf<"Transfer">[] = index.transfers.get(launch.token) ?? [];
  const txs = [...new Set(launch.launch_swaps.map((s) => s.ref.transaction_hash))];
  const mismatched: Mismatch[] = [];
  for (const tx of txs) {
    const expected =
      sum(inTx(launch.launch_swaps, tx).map((s) => side(launch, deltas(s), "token"))) -
      sum(inTx(launch.creator_fee_claims, tx).map((c) => side(launch, c, "token"))) -
      sum(inTx(launch.liquidity_fee_claims, tx).map((c) => side(launch, c, "token")));
    const moved = inTx(transfers, tx);
    const observed =
      sum(moved.filter((t) => t.to === core).map((t) => t.value)) -
      sum(moved.filter((t) => t.from === core).map((t) => t.value));
    if (expected !== observed) {
      mismatched.push({ transaction_hash: tx, expected_core_net: expected.toString(), observed_core_net: observed.toString() });
    }
  }
  return { checked: txs.length, mismatched };
}
