import type { EventOf } from "./decode.js";
import type { Findings } from "./envelope.js";
import type { LaunchRecord } from "./launches.js";
import { decimalString, share, sum } from "./numbers.js";
import {
  deployed,
  finished,
  poolReserve,
  releasedAt,
  side,
} from "./state.js";
import type { Address, LaunchpadManifest } from "./types.js";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead" as Address;

export const HOLDERS_METHOD = { id: "holders.transfer_replay", version: 1 } as const;

export interface Ledger {
  balances: Map<Address, bigint>;
  minted: bigint;
  burned_to_zero: bigint;
  /** Addresses whose running balance went negative: logs are missing or out of scope. */
  negative: { address: Address; block_number: number; log_index: number }[];
}

function credit(ledger: Ledger, address: Address, amount: bigint): bigint {
  const next = (ledger.balances.get(address) ?? 0n) + amount;
  ledger.balances.set(address, next);
  return next;
}

/** Replay `Transfer` logs in canonical order into balances. */
export function replayTransfers(
  transfers: readonly EventOf<"Transfer">[],
): Ledger {
  const ledger: Ledger = {
    balances: new Map(),
    minted: 0n,
    burned_to_zero: 0n,
    negative: [],
  };
  for (const transfer of transfers) {
    if (transfer.from === ZERO_ADDRESS) ledger.minted += transfer.value;
    else if (credit(ledger, transfer.from, -transfer.value) < 0n) {
      ledger.negative.push({
        address: transfer.from,
        block_number: transfer.ref.block_number,
        log_index: transfer.ref.log_index,
      });
    }
    if (transfer.to === ZERO_ADDRESS) ledger.burned_to_zero += transfer.value;
    else credit(ledger, transfer.to, transfer.value);
  }
  return ledger;
}

export interface Exclusion {
  address: Address;
  category: string;
  amount: bigint;
  components?: { category: string; amount: bigint | null; note?: string }[];
}

export interface HolderRow {
  address: Address;
  balance: bigint;
}

export interface Distribution {
  total_supply: bigint;
  excluded_total: bigint;
  circulating: bigint;
  holders: HolderRow[];
  holder_count: number;
  mean: string | null;
  median: string | null;
  top_n_share: Record<"1" | "5" | "10", string | null>;
}

function median(sorted: readonly bigint[]): string | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle].toString();
  return decimalString(sorted[middle - 1] + sorted[middle], 2n);
}

/**
 * Address-level distribution over everything not excluded. Pure: the caller
 * chooses the exclusions, the function only does arithmetic, so the
 * definition in the interface contract lives entirely in `exclusionsFor`.
 */
export function distribution(
  balances: ReadonlyMap<Address, bigint>,
  exclusions: readonly Exclusion[],
  totalSupply: bigint,
): Distribution {
  const excluded = new Set(exclusions.map((e) => e.address));
  const holders = [...balances]
    .filter(([address, balance]) => !excluded.has(address) && balance > 0n)
    .map(([address, balance]) => ({ address, balance }))
    .sort((a, b) =>
      a.balance === b.balance
        ? a.address < b.address
          ? -1
          : 1
        : a.balance > b.balance
          ? -1
          : 1,
    );
  const excludedTotal = sum(exclusions.map((e) => e.amount));
  const circulating = totalSupply - excludedTotal;
  const held = sum(holders.map((h) => h.balance));
  const ascending = holders.map((h) => h.balance).reverse();
  const top = (n: number) =>
    share(sum(holders.slice(0, n).map((h) => h.balance)), circulating);
  return {
    total_supply: totalSupply,
    excluded_total: excludedTotal,
    circulating,
    holders,
    holder_count: holders.length,
    mean: holders.length === 0 ? null : decimalString(held, BigInt(holders.length)),
    median: median(ascending),
    top_n_share: { "1": top(1), "5": top(5), "10": top(10) },
  };
}

function launchSideFees(launch: LaunchRecord): bigint {
  const charged = sum(
    launch.launch_swaps
      .filter((swap) => swap.fee_is_token1 !== launch.token_is0)
      .map((swap) => swap.fee_amount),
  );
  const donated = sum(launch.launch_pool.fees.map((e) => side(launch, e, "token")));
  const claimed = sum(launch.creator_fee_claims.map((e) => side(launch, e, "token")));
  return charged + donated - claimed;
}

/** Unclaimed launch-token creator fees in the extension's ledger. Exact from events. */
export function unclaimedExtensionFees(launch: LaunchRecord): bigint {
  return launchSideFees(launch);
}

function pendingPrincipalToken(launch: LaunchRecord): bigint | null {
  if (launch.locks.length > 0) return null;
  return sum(launch.principal.map((e) => side(launch, e, "token")));
}

/**
 * Split Core's launch-token balance into the contract's categories. Each
 * known category is exact from events; the remainder is "other Core-held".
 */
export function coreComponents(
  launch: LaunchRecord,
  coreBalance: bigint,
  timestamp: number,
  findings: Findings,
): NonNullable<Exclusion["components"]> {
  const done = finished(launch);
  const unreleased = done ? 0n : launch.config.total_supply - releasedAt(launch.config, timestamp);
  const reserves = done ? 0n : launch.config.total_supply - deployed(launch);
  const launchPool = poolReserve(launch, launch.launch_pool, "token");
  const fees = unclaimedExtensionFees(launch);
  const terminalPool = poolReserve(launch, launch.terminal_pool, "token");
  const pending = pendingPrincipalToken(launch);
  const known = unreleased + launchPool + fees + terminalPool + (pending ?? 0n);
  const other = coreBalance - known;
  if (other < 0n) {
    findings.incompleteBecause(
      "The categorized Core-held amounts exceed Core's launch-token balance from Transfer logs; logs are missing or inconsistent.",
    );
  }
  if (pending === null) {
    findings.note(
      "After migration, undeposited principal and terminal-ledger creator fees are not separable from events in v1; they are included in other_core_held.",
    );
  }
  return [
    { category: "unreleased_inventory", amount: unreleased },
    { category: "launch_pool_liquidity", amount: launchPool },
    { category: "unclaimed_creator_fees", amount: fees, note: "launch-token fees in the ScheduledLaunch creator ledger" },
    {
      category: "locked_terminal_liquidity",
      amount: terminalPool + (pending ?? 0n),
      note: "terminal-pool reserves (including any third-party positions in that pool) plus principal received but not yet deposited",
    },
    {
      category: "other_core_held",
      amount: other,
      note: `includes ${reserves - unreleased} raw units of released inventory not yet deployed into the launch pool`,
    },
  ];
}

/** The interface contract's exclusion list for one launch token. */
export function exclusionsFor(
  launch: LaunchRecord,
  ledger: Ledger,
  manifest: LaunchpadManifest,
  timestamp: number,
  findings: Findings,
): Exclusion[] {
  const balance = (address: Address) => ledger.balances.get(address) ?? 0n;
  const core = manifest.contracts.core.address;
  return [
    {
      address: core,
      category: "core",
      amount: balance(core),
      components: coreComponents(launch, balance(core), timestamp, findings),
    },
    { address: ZERO_ADDRESS, category: "zero_address", amount: ledger.burned_to_zero },
    { address: DEAD_ADDRESS, category: "dead_address", amount: balance(DEAD_ADDRESS) },
    {
      address: manifest.contracts.launch_router.address,
      category: "launch_router",
      amount: balance(manifest.contracts.launch_router.address),
    },
    {
      address: manifest.contracts.router.address,
      category: "router",
      amount: balance(manifest.contracts.router.address),
    },
  ];
}

/** Integrity checks that turn a holder result incomplete. */
export function checkLedger(
  launch: LaunchRecord,
  ledger: Ledger,
  findings: Findings,
): void {
  const negative = ledger.negative[0];
  if (negative !== undefined) {
    findings.incompleteBecause(
      `Replaying Transfer logs drove ${ledger.negative.length} balances negative (first: ${negative.address} at block ${negative.block_number}, log ${negative.log_index}); logs are missing or out of order at the source.`,
    );
  }
  if (ledger.minted !== launch.config.total_supply) {
    findings.incompleteBecause(
      `Minted amount in Transfer logs (${ledger.minted}) differs from the configured total supply (${launch.config.total_supply}).`,
    );
  }
}
