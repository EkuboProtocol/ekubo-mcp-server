import { logKey } from "./canonical.js";
import type { EventOf } from "./decode.js";
import { ADDRESS_NOTE, BENEFICIARY_NOTE, type EngineContext } from "./engine.js";
import type { Findings } from "./envelope.js";
import {
  HOLDERS_METHOD,
  checkLedger,
  distribution,
  exclusionsFor,
  replayTransfers,
  unclaimedExtensionFees,
  type Exclusion,
  type Ledger,
} from "./holders.js";
import type { LaunchRecord } from "./launches.js";
import { abs, maxBig, share, sum } from "./numbers.js";
import {
  attributeSwaps,
  deltas,
  releasedAt,
  side,
  splitLaunchPoolSwaps,
  type SwapAttribution,
} from "./state.js";
import type { Address, BlockHeader, LogRef } from "./types.js";

/** Serialise an amount, refusing to present an incomplete zero as a real zero. */
export function figure(value: bigint | null, findings: Findings): string | null {
  if (value === null) return null;
  if (value === 0n && !findings.complete) return null;
  return value.toString();
}

function exclusionView(exclusion: Exclusion, findings: Findings) {
  return {
    address: exclusion.address,
    category: exclusion.category,
    amount: figure(exclusion.amount, findings),
    ...(exclusion.components === undefined
      ? {}
      : {
          components: exclusion.components.map((c) => ({
            category: c.category,
            amount: c.amount === null ? null : figure(c.amount, findings),
            ...(c.note === undefined ? {} : { note: c.note }),
          })),
        }),
  };
}

export interface HolderPage {
  offset: number;
  size: number;
}

export function launchLedger(context: EngineContext, launch: LaunchRecord): Ledger {
  const ledger = replayTransfers(context.index.transfers.get(launch.token) ?? []);
  checkLedger(launch, ledger, context.findings);
  return ledger;
}

export function holdersSection(
  context: EngineContext,
  launch: LaunchRecord,
  ledger: Ledger,
  page: HolderPage,
) {
  const { findings, snapshot } = context;
  const exclusions = exclusionsFor(
    launch,
    ledger,
    snapshot.manifest,
    snapshot.as_of.timestamp,
    findings,
  );
  const dist = distribution(ledger.balances, exclusions, launch.config.total_supply);
  const section = {
    method: HOLDERS_METHOD,
    decimals: launch.config.decimals,
    total_supply: dist.total_supply.toString(),
    excluded: exclusions.map((e) => exclusionView(e, findings)),
    excluded_total: figure(dist.excluded_total, findings),
    circulating: figure(dist.circulating, findings),
    holder_count: dist.holder_count === 0 && !findings.complete ? null : dist.holder_count,
    holder_count_unit: "addresses with a positive balance, excluding the addresses above",
    mean: dist.mean,
    median: dist.median,
    top_n_share: dist.top_n_share,
    share_basis: "circulating",
    holders: dist.holders.slice(page.offset, page.offset + page.size).map((h, i) => ({
      rank: page.offset + i + 1,
      address: h.address,
      balance: h.balance.toString(),
      share_of_circulating: share(h.balance, dist.circulating),
    })),
    address_note: ADDRESS_NOTE,
    clustering: "not_computed" as const,
  };
  return { section, total_rows: dist.holders.length };
}

function payoutRecipients(launch: LaunchRecord): Map<Address, bigint> {
  const claimed = new Map<Address, bigint>();
  const add = (recipient: Address, amount: bigint) =>
    claimed.set(recipient, (claimed.get(recipient) ?? 0n) + amount);
  for (const claim of launch.creator_fee_claims) add(claim.recipient, side(launch, claim, "token"));
  for (const claim of launch.liquidity_fee_claims) add(claim.recipient, side(launch, claim, "token"));
  return claimed;
}

export function creatorAllocation(
  context: EngineContext,
  launch: LaunchRecord,
  ledger: Ledger,
) {
  const { findings } = context;
  const balance = (address: Address) => ledger.balances.get(address) ?? 0n;
  const beneficiaryBalance = balance(launch.beneficiary);
  const extensionFees = unclaimedExtensionFees(launch);
  const migrated = launch.locks.length > 0;
  if (migrated) {
    findings.note(
      "Unclaimed creator fees in the LockedLaunchLiquidity ledger and uncollected terminal-position fees are not derivable from v1 events; terminal_ledger is null and the total is a lower bound.",
    );
  }
  const recipients = [...payoutRecipients(launch)]
    .filter(([address]) => address !== launch.beneficiary)
    .map(([address, claimed]) => ({
      address,
      launch_token_claimed: claimed.toString(),
      current_balance: balance(address).toString(),
    }));
  const total =
    beneficiaryBalance + extensionFees + sum(recipients.map((r) => BigInt(r.current_balance)));
  return {
    method: { id: "creator_allocation.beneficiary_fees_payouts", version: 1 },
    beneficiary: launch.beneficiary,
    beneficiary_note: BENEFICIARY_NOTE,
    beneficiary_wallet_balance: figure(beneficiaryBalance, findings),
    unclaimed_launch_token_fees: {
      scheduled_launch_ledger: figure(extensionFees, findings),
      terminal_ledger: migrated ? null : "0",
    },
    fee_payout_recipients: recipients,
    total: figure(total, findings),
    total_is_lower_bound: migrated || !findings.complete,
    share_of_total_supply: share(total, launch.config.total_supply),
  };
}

export type EarlyWindow =
  | { kind: "blocks"; blocks: number; first_block: BlockHeader; end_block: BlockHeader | null }
  | { kind: "seconds"; seconds: number; start_time: number };

function inEarlyWindow(
  window: EarlyWindow,
  ref: LogRef,
  timestamp: number | null,
): boolean {
  if (window.kind === "blocks") {
    const from = window.first_block.number;
    return ref.block_number >= from && ref.block_number < from + window.blocks;
  }
  return (
    timestamp !== null &&
    timestamp >= window.start_time &&
    timestamp < window.start_time + window.seconds
  );
}

interface Acquisition {
  bought: bigint;
  sold: bigint;
  per_key: Map<string, bigint>;
  lockers: Set<Address>;
  recipients: Set<Address>;
  unattributed_buys: number;
}

function tally(
  acc: Acquisition,
  launch: LaunchRecord,
  swap: EventOf<"LaunchSwapped">,
  attribution: SwapAttribution | null,
): void {
  const tokenDelta = side(launch, deltas(swap), "token");
  const key = attribution?.recipient ?? `locker:${swap.locker}`;
  acc.per_key.set(key, (acc.per_key.get(key) ?? 0n) - tokenDelta);
  if (tokenDelta >= 0n) {
    acc.sold += tokenDelta;
    return;
  }
  acc.bought += -tokenDelta;
  acc.lockers.add(swap.locker);
  if (attribution === null) acc.unattributed_buys += 1;
  else acc.recipients.add(attribution.recipient);
}

function windowEnd(window: EarlyWindow): number | null {
  if (window.kind === "seconds") return window.start_time + window.seconds;
  return window.end_block?.timestamp ?? null;
}

function earlyWindowFigures(
  context: EngineContext,
  launch: LaunchRecord,
  window: EarlyWindow,
) {
  const { findings, index, snapshot } = context;
  const attribution = attributeSwaps(launch, snapshot.manifest.contracts.launch_router.address);
  const acc: Acquisition = {
    bought: 0n,
    sold: 0n,
    per_key: new Map(),
    lockers: new Set(),
    recipients: new Set(),
    unattributed_buys: 0,
  };
  for (const swap of launch.launch_swaps) {
    const timestamp = index.timestamps.get(swap.ref.block_number) ?? null;
    if (!inEarlyWindow(window, swap.ref, timestamp)) continue;
    tally(acc, launch, swap, attribution.get(logKey(swap.ref)) ?? null);
  }
  const net = acc.bought - acc.sold;
  const end = windowEnd(window);
  const open = end === null || end > snapshot.as_of.timestamp;
  // An open window is measured up to as_of, so release is too.
  const released = releasedAt(launch.config, open ? snapshot.as_of.timestamp : end);
  const largest = [...acc.per_key.values()].reduce(maxBig, 0n);
  return {
    window:
      window.kind === "blocks"
        ? {
            kind: "blocks",
            blocks: window.blocks,
            from_block: window.first_block.number,
            to_block: window.first_block.number + window.blocks - 1,
            end_timestamp: end,
          }
        : {
            kind: "seconds",
            seconds: window.seconds,
            from_timestamp: window.start_time,
            to_timestamp_exclusive: end,
          },
    window_closed: !open,
    net_acquired: figure(net, findings),
    gross_bought: figure(acc.bought, findings),
    sold: figure(acc.sold, findings),
    share_of_total_supply: share(net, launch.config.total_supply),
    share_of_released_by_window_end: share(net, released),
    released_by_window_end: released.toString(),
    released_measured_at: open ? snapshot.as_of.timestamp : end,
    distinct_buying_lockers: acc.lockers.size,
    distinct_buying_recipients: acc.recipients.size,
    buys_without_recipient: acc.unattributed_buys,
    largest_single_share_of_total_supply: share(largest, launch.config.total_supply),
    confidence: "exact" as const,
  };
}

export function earlyAcquisition(
  context: EngineContext,
  launch: LaunchRecord,
  windows: EarlyWindow[],
) {
  const figures = windows.map((w) => earlyWindowFigures(context, launch, w));
  if (figures.some((f) => !f.window_closed)) {
    context.findings.note(
      "An early-acquisition window extends past the as_of block; its figures cover only the part that has elapsed.",
    );
  }
  return {
    method: { id: "early_acquisition.launch_swapped_net", version: 1 },
    decimals: launch.config.decimals,
    start_time: launch.config.start_time,
    windows: figures,
    attribution:
      "Lockers come from LaunchSwapped. Recipients come only from LaunchRouted in the same transaction; swaps forwarded by other lockers have no recipient in the logs. Amounts are net of the creator fee.",
    clustering: "not_computed" as const,
    unknown: [
      "submission timing (when a transaction was signed or broadcast)",
      "private order flow and builder or sequencer ordering",
      "whether separate addresses share control",
    ],
    address_note: ADDRESS_NOTE,
  };
}

export const ROUND_TRIP_METHOD = { id: "volume.round_trip_near_zero_net", version: 1 } as const;

export interface VolumeWindow {
  from_exclusive: number;
  to_inclusive: number;
}

export interface VolumeBucket {
  quote_asset: Address;
  user_launch: bigint;
  user_terminal: bigint;
  internal_release_sales: bigint;
  internal_migration: bigint;
  round_trip: bigint;
  round_trip_addresses: number;
}

function inVolumeWindow(context: EngineContext, ref: LogRef, window: VolumeWindow): boolean {
  const timestamp = context.index.timestamps.get(ref.block_number);
  return timestamp !== undefined && timestamp > window.from_exclusive && timestamp <= window.to_inclusive;
}

interface Trader {
  bought: bigint;
  sold: bigint;
  quote: bigint;
}

function traderKey(swap: EventOf<"LaunchSwapped">, attribution: SwapAttribution | null): string {
  return attribution === null ? `locker:${swap.locker}` : `payer:${attribution.payer}`;
}

function roundTrip(traders: Map<string, Trader>, thresholdBps: number) {
  let volume = 0n;
  let addresses = 0;
  for (const trader of traders.values()) {
    if (trader.bought === 0n || trader.sold === 0n) continue;
    const gross = maxBig(trader.bought, trader.sold);
    if (abs(trader.bought - trader.sold) * 10_000n > BigInt(thresholdBps) * gross) continue;
    volume += trader.quote;
    addresses += 1;
  }
  return { volume, addresses };
}

function launchVolume(
  context: EngineContext,
  launch: LaunchRecord,
  window: VolumeWindow,
  bucket: VolumeBucket,
  thresholdBps: number,
): void {
  const quote = (e: { delta0: bigint; delta1: bigint }) => abs(side(launch, deltas(e), "quote"));
  const inWindow = (ref: LogRef) => inVolumeWindow(context, ref, window);
  const attribution = attributeSwaps(launch, context.snapshot.manifest.contracts.launch_router.address);
  const traders = new Map<string, Trader>();
  for (const swap of launch.launch_swaps.filter((s) => inWindow(s.ref))) {
    bucket.user_launch += quote(swap);
    const key = traderKey(swap, attribution.get(logKey(swap.ref)) ?? null);
    const trader = traders.get(key) ?? { bought: 0n, sold: 0n, quote: 0n };
    const tokenDelta = side(launch, deltas(swap), "token");
    if (tokenDelta < 0n) trader.bought += -tokenDelta;
    else trader.sold += tokenDelta;
    trader.quote += quote(swap);
    traders.set(key, trader);
  }
  const trips = roundTrip(traders, thresholdBps);
  bucket.round_trip += trips.volume;
  bucket.round_trip_addresses += trips.addresses;
  const internal = splitLaunchPoolSwaps(launch).internal.filter((s) => inWindow(s.ref));
  bucket.internal_release_sales += sum(internal.map(quote));
  const liquidity = context.snapshot.manifest.contracts.locked_launch_liquidity.address;
  for (const swap of launch.terminal_pool.swaps.filter((s) => inWindow(s.ref))) {
    if (swap.locker === liquidity) bucket.internal_migration += quote(swap);
    else bucket.user_terminal += quote(swap);
  }
}

export function volumeBuckets(
  context: EngineContext,
  launches: readonly LaunchRecord[],
  window: VolumeWindow,
  thresholdBps: number,
): VolumeBucket[] {
  const buckets = new Map<Address, VolumeBucket>();
  for (const launch of launches) {
    const bucket = buckets.get(launch.quote_token) ?? {
      quote_asset: launch.quote_token,
      user_launch: 0n,
      user_terminal: 0n,
      internal_release_sales: 0n,
      internal_migration: 0n,
      round_trip: 0n,
      round_trip_addresses: 0,
    };
    launchVolume(context, launch, window, bucket, thresholdBps);
    buckets.set(launch.quote_token, bucket);
  }
  return [...buckets.values()].sort((a, b) => (a.quote_asset < b.quote_asset ? -1 : 1));
}

export function volumeWindow(context: EngineContext): VolumeWindow {
  const to = context.snapshot.as_of.timestamp;
  return { from_exclusive: to - 86_400, to_inclusive: to };
}

export function volumeSection(
  context: EngineContext,
  launch: LaunchRecord,
  thresholdBps: number,
  quoteDecimals: number | null,
) {
  const { findings } = context;
  const window = volumeWindow(context);
  const [bucket] = volumeBuckets(context, [launch], window, thresholdBps);
  return {
    method: { id: "volume.rolling_24h", version: 1 },
    window: { from_timestamp_exclusive: window.from_exclusive, to_timestamp_inclusive: window.to_inclusive },
    quote_asset: launch.quote_token,
    quote_decimals: quoteDecimals,
    user_launch: figure(bucket.user_launch, findings),
    user_terminal: figure(bucket.user_terminal, findings),
    internal: {
      release_sales: figure(bucket.internal_release_sales, findings),
      migration_rebalancing: figure(bucket.internal_migration, findings),
      note: "Protocol-initiated swaps. Reported separately and never added to user volume.",
    },
    round_trip: {
      ...ROUND_TRIP_METHOD,
      volume: figure(bucket.round_trip, findings),
      addresses: bucket.round_trip_addresses,
      threshold_bps: thresholdBps,
      definition:
        "Quote volume of launch swaps by addresses (router payer, else locker) that both bought and sold in the window and ended with |bought − sold| ≤ threshold_bps of the larger side. A heuristic: it says nothing about intent, and gross volume is not reduced by it.",
    },
    usd: null,
    usd_note: "No timestamped price source is configured, so USD values are null.",
    units: "raw quote units, fee-inclusive",
  };
}
