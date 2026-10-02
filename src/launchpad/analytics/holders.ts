import type { EventOf } from "./decode.js";
import type { Findings } from "./envelope.js";
import type { LaunchRecord } from "./launches.js";
import { ratio, share, sum, type Ratio } from "./numbers.js";
import { terminalAccounting } from "./terminal.js";
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

export interface CoreInputs {
  timestamp: number;
  core_indexed: boolean;
  liquidity_contract: Address;
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
  mean: Ratio | null;
  median: Ratio | null;
  top_n_share: Record<"1" | "5" | "10", Ratio | null>;
}

function median(sorted: readonly bigint[]): Ratio | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return ratio(sorted[middle], 1n);
  return ratio(sorted[middle - 1] + sorted[middle], 2n);
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
    mean: holders.length === 0 ? null : ratio(held, BigInt(holders.length)),
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

/** Launch-token creator fees still in either ledger. Exact from events when Core is indexed. */
export function unclaimedLedgers(launch: LaunchRecord, liquidityContract: Address) {
  const terminal = terminalAccounting(launch, liquidityContract);
  return {
    scheduled_launch: unclaimedExtensionFees(launch),
    locked_launch_liquidity: side(launch, terminal.creator_ledger, "token"),
  };
}

function knownCategories(launch: LaunchRecord, inputs: CoreInputs) {
  const done = finished(launch);
  const unreleased = done ? 0n : launch.config.total_supply - releasedAt(launch.config, inputs.timestamp);
  const reserves = done ? 0n : launch.config.total_supply - deployed(launch);
  if (!inputs.core_indexed) {
    return { unreleased, undeployed: reserves - unreleased, launchPool: null, fees: unclaimedExtensionFees(launch), locked: null };
  }
  const terminal = terminalAccounting(launch, inputs.liquidity_contract);
  const ledgers = unclaimedLedgers(launch, inputs.liquidity_contract);
  return {
    unreleased,
    undeployed: reserves - unreleased,
    launchPool: poolReserve(launch, launch.launch_pool, "token"),
    fees: ledgers.scheduled_launch + ledgers.locked_launch_liquidity,
    locked: poolReserve(launch, launch.terminal_pool, "token") + side(launch, terminal.pending_principal, "token"),
  };
}

/**
 * Split Core's launch-token balance into the contract's categories. Each
 * known category is exact from events; the remainder is "other Core-held".
 * Without Core logs the pool categories, and so the remainder, are unknown.
 */
export function coreComponents(
  launch: LaunchRecord,
  coreBalance: bigint,
  inputs: CoreInputs,
  findings: Findings,
): NonNullable<Exclusion["components"]> {
  const c = knownCategories(launch, inputs);
  const other =
    c.launchPool === null || c.locked === null ? null : coreBalance - c.unreleased - c.launchPool - c.fees - c.locked;
  if (other !== null && other < 0n) {
    findings.incompleteBecause(
      "The categorized Core-held amounts exceed Core's launch-token balance from Transfer logs; logs are missing or inconsistent.",
    );
  }
  return [
    { category: "unreleased_inventory", amount: c.unreleased },
    { category: "launch_pool_liquidity", amount: c.launchPool },
    { category: "unclaimed_creator_fees", amount: c.fees, note: "launch-token fees in the ScheduledLaunch and LockedLaunchLiquidity creator ledgers" },
    {
      category: "locked_terminal_liquidity",
      amount: c.locked,
      note: "terminal-pool reserves (including any third-party positions in that pool) plus principal received but not yet deposited",
    },
    {
      category: "other_core_held",
      amount: other,
      note: `includes ${c.undeployed} raw units of released inventory not yet deployed into the launch pool`,
    },
  ];
}

/** The interface contract's exclusion list for one launch token. */
export function exclusionsFor(
  launch: LaunchRecord,
  ledger: Ledger,
  manifest: LaunchpadManifest,
  inputs: Omit<CoreInputs, "liquidity_contract">,
  findings: Findings,
): Exclusion[] {
  const balance = (address: Address) => ledger.balances.get(address) ?? 0n;
  const core = manifest.contracts.core.address;
  const coreInputs = { ...inputs, liquidity_contract: manifest.contracts.locked_launch_liquidity.address };
  return [
    {
      address: core,
      category: "core",
      amount: balance(core),
      components: coreComponents(launch, balance(core), coreInputs, findings),
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

/** Caller-supplied exclusions (ruling A2), echoed with their balances; duplicates of built-ins are skipped. */
export function callerExclusions(ledger: Ledger, addresses: readonly Address[], builtIn: readonly Exclusion[]): Exclusion[] {
  const taken = new Set(builtIn.map((e) => e.address));
  return [...new Set(addresses)]
    .filter((address) => !taken.has(address))
    .map((address) => ({ address, category: "caller_supplied", amount: ledger.balances.get(address) ?? 0n }));
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
