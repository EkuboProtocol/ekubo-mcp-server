import { logKey } from "./canonical.js";
import type { EventOf } from "./decode.js";
import { ADDRESS_NOTE, BENEFICIARY_NOTE, type EngineContext } from "./engine.js";
import type { Findings } from "./envelope.js";
import {
  HOLDERS_METHOD,
  callerExclusions,
  checkLedger,
  distribution,
  exclusionsFor,
  replayTransfers,
  unclaimedExtensionFees,
  unclaimedLedgers,
  type Exclusion,
  type Ledger,
} from "./holders.js";
import type { LaunchRecord } from "./launches.js";
import { abs, maxBig, share, sum } from "./numbers.js";
import { RECONCILIATION_METHOD, reconcileSwaps } from "./reconcile.js";
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
            amount: figure(c.amount, findings),
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
  additional: readonly Address[],
) {
  const { findings, snapshot } = context;
  const builtIn = exclusionsFor(
    launch,
    ledger,
    snapshot.manifest,
    { timestamp: snapshot.as_of.timestamp, core_indexed: context.core_indexed },
    findings,
  );
  const exclusions = [...builtIn, ...callerExclusions(ledger, additional, builtIn)];
  const dist = distribution(ledger.balances, exclusions, launch.config.total_supply);
  const section = {
    method: HOLDERS_METHOD,
    decimals: launch.config.decimals,
    denominators: {
      total_supply: dist.total_supply.toString(),
      excluded_total: figure(dist.excluded_total, findings),
      circulating: figure(dist.circulating, findings),
    },
    excluded: exclusions.map((e) => exclusionView(e, findings)),
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
    economic_ownership: "unknown" as const,
    economic_ownership_note:
      "Balances are per address. Who economically owns or controls each address is unknown; no address is merged with another or dropped by a heuristic.",
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

export function creatorAllocation(context: EngineContext, launch: LaunchRecord, ledger: Ledger) {
  const { findings, snapshot } = context;
  const balance = (address: Address) => ledger.balances.get(address) ?? 0n;
  const beneficiaryBalance = balance(launch.beneficiary);
  const ledgers = context.core_indexed
    ? unclaimedLedgers(launch, snapshot.manifest.contracts.locked_launch_liquidity.address)
    : { scheduled_launch: unclaimedExtensionFees(launch), locked_launch_liquidity: null };
  const migrated = launch.locks.length > 0;
  if (migrated) {
    findings.note(
      "Fees accrued to the locked terminal position but not yet collected need the pool's fee growth, which no event carries; they are excluded and the creator allocation total is a lower bound.",
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
    beneficiaryBalance +
    ledgers.scheduled_launch +
    (ledgers.locked_launch_liquidity ?? 0n) +
    sum(recipients.map((r) => BigInt(r.current_balance)));
  return {
    method: { id: "creator_allocation.beneficiary_fees_payouts", version: 2 },
    decimals: launch.config.decimals,
    beneficiary: launch.beneficiary,
    beneficiary_note: BENEFICIARY_NOTE,
    beneficiary_wallet_balance: figure(beneficiaryBalance, findings),
    unclaimed_launch_token_fees: {
      scheduled_launch_ledger: figure(ledgers.scheduled_launch, findings),
      locked_launch_liquidity_ledger: figure(ledgers.locked_launch_liquidity, findings),
      uncollected_terminal_position_fees: migrated ? null : "0",
    },
    fee_payout_recipients: recipients,
    total: figure(total, findings),
    total_is_lower_bound: migrated || ledgers.locked_launch_liquidity === null || !findings.complete,
    share_of_total_supply: share(total, launch.config.total_supply),
  };
}

export type EarlyWindow =
  | { kind: "blocks"; blocks: number; first_block: BlockHeader; end_block: BlockHeader | null }
  | { kind: "seconds"; seconds: number; start_time: number };

function inEarlyWindow(window: EarlyWindow, ref: LogRef, timestamp: number | null): boolean {
  if (window.kind === "blocks") {
    const from = window.first_block.number;
    return ref.block_number >= from && ref.block_number < from + window.blocks;
  }
  return timestamp !== null && timestamp >= window.start_time && timestamp < window.start_time + window.seconds;
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
  const key = attribution === null ? `locker:${swap.locker}` : `recipient:${attribution.recipient}`;
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

function windowView(window: EarlyWindow, end: number | null) {
  return window.kind === "blocks"
    ? {
        kind: "blocks",
        blocks: window.blocks,
        from_block: window.first_block.number,
        to_block: window.first_block.number + window.blocks - 1,
        end_timestamp: end,
      }
    : { kind: "seconds", seconds: window.seconds, from_timestamp: window.start_time, to_timestamp_exclusive: end };
}

function earlyWindowFigures(context: EngineContext, launch: LaunchRecord, window: EarlyWindow) {
  const { findings, index, snapshot } = context;
  const attribution = attributeSwaps(launch, snapshot.manifest.contracts.launch_router.address);
  const acc: Acquisition = { bought: 0n, sold: 0n, per_key: new Map(), lockers: new Set(), recipients: new Set(), unattributed_buys: 0 };
  for (const swap of launch.launch_swaps) {
    const timestamp = index.timestamps.get(swap.ref.block_number) ?? null;
    if (!inEarlyWindow(window, swap.ref, timestamp)) continue;
    tally(acc, launch, swap, attribution.get(logKey(swap.ref)) ?? null);
  }
  const net = acc.bought - acc.sold;
  const end = windowEnd(window);
  const open = end === null || end > snapshot.as_of.timestamp;
  // An open window is measured up to as_of, so release is too.
  const measuredAt = open ? snapshot.as_of.timestamp : end;
  const released = releasedAt(launch.config, measuredAt);
  const largest = [...acc.per_key.values()].reduce(maxBig, 0n);
  return {
    window: windowView(window, end),
    window_closed: !open,
    net_acquired: figure(net, findings),
    gross_bought: figure(acc.bought, findings),
    sold: figure(acc.sold, findings),
    share_of_total_supply: share(net, launch.config.total_supply),
    share_of_released_by_window_end: share(net, released),
    released_by_window_end: released.toString(),
    released_measured_at: measuredAt,
    distinct_buying_lockers: acc.lockers.size,
    distinct_buying_recipients: acc.recipients.size,
    buys_without_recipient: acc.unattributed_buys,
    largest_single_share_of_total_supply: share(largest, launch.config.total_supply),
    largest_single_basis: "router recipient, or the locker for a swap without a router recipient",
    confidence: "exact" as const,
  };
}

export function earlyAcquisition(context: EngineContext, launch: LaunchRecord, windows: EarlyWindow[]) {
  const figures = windows.map((w) => earlyWindowFigures(context, launch, w));
  if (figures.some((f) => !f.window_closed)) {
    context.findings.note(
      "An early-acquisition window extends past the as_of block; its figures cover only the part that has elapsed.",
    );
  }
  return {
    method: { id: "early_acquisition.launch_swapped_net", version: 2 },
    decimals: launch.config.decimals,
    start_time: launch.config.start_time,
    windows: figures,
    attribution:
      "Lockers are reported as lockers: the contract that forwarded the swap, never the trader. Recipients come only from LaunchRouted in the same transaction. Amounts are net of the creator fee.",
    clustering: "not_computed" as const,
    unknown: [
      "submission timing (when a transaction was signed or broadcast)",
      "private order flow and builder or sequencer ordering",
      "whether separate addresses share control or funding",
    ],
    address_note: ADDRESS_NOTE,
  };
}

export const ROUND_TRIP_METHOD = { id: "volume.round_trip_near_zero_net", version: 2 } as const;

export interface VolumeWindow {
  from_exclusive: number;
  to_inclusive: number;
}

export interface VolumeBucket {
  quote_asset: Address;
  user_launch: bigint;
  user_terminal: bigint | null;
  twamm_virtual: bigint | null;
  internal_release_sales: bigint | null;
  internal_migration: bigint | null;
  round_trip: bigint;
  round_trip_payers: number;
  swaps_without_payer: number;
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

function roundTrip(traders: Map<Address, Trader>, thresholdBps: number) {
  let volume = 0n;
  let payers = 0;
  for (const trader of traders.values()) {
    if (trader.bought === 0n || trader.sold === 0n) continue;
    const gross = maxBig(trader.bought, trader.sold);
    if (abs(trader.bought - trader.sold) * 10_000n > BigInt(thresholdBps) * gross) continue;
    volume += trader.quote;
    payers += 1;
  }
  return { volume, payers };
}

type QuoteOf = (e: { delta0: bigint; delta1: bigint }) => bigint;

function launchSwapVolume(
  context: EngineContext,
  launch: LaunchRecord,
  bucket: VolumeBucket,
  inWindow: (ref: LogRef) => boolean,
  thresholdBps: number,
): void {
  const quote: QuoteOf = (e) => abs(side(launch, deltas(e), "quote"));
  const attribution = attributeSwaps(launch, context.snapshot.manifest.contracts.launch_router.address);
  const payers = new Map<Address, Trader>();
  for (const swap of launch.launch_swaps.filter((s) => inWindow(s.ref))) {
    bucket.user_launch += quote(swap);
    const payer = attribution.get(logKey(swap.ref))?.payer;
    if (payer === undefined) {
      bucket.swaps_without_payer += 1;
      continue;
    }
    const trader = payers.get(payer) ?? { bought: 0n, sold: 0n, quote: 0n };
    const tokenDelta = side(launch, deltas(swap), "token");
    if (tokenDelta < 0n) trader.bought += -tokenDelta;
    else trader.sold += tokenDelta;
    trader.quote += quote(swap);
    payers.set(payer, trader);
  }
  const trips = roundTrip(payers, thresholdBps);
  bucket.round_trip += trips.volume;
  bucket.round_trip_payers += trips.payers;
}

const plus = (a: bigint | null, b: bigint) => (a === null ? null : a + b);

function coreSwapVolume(
  context: EngineContext,
  launch: LaunchRecord,
  bucket: VolumeBucket,
  inWindow: (ref: LogRef) => boolean,
): void {
  const quote: QuoteOf = (e) => abs(side(launch, deltas(e), "quote"));
  const internal = splitLaunchPoolSwaps(launch).internal.filter((s) => inWindow(s.ref));
  bucket.internal_release_sales = plus(bucket.internal_release_sales, sum(internal.map(quote)));
  const liquidity = context.snapshot.manifest.contracts.locked_launch_liquidity.address;
  const twamm = context.snapshot.manifest.twamm?.address ?? null;
  for (const swap of launch.terminal_pool.swaps.filter((s) => inWindow(s.ref))) {
    if (swap.locker === liquidity) bucket.internal_migration = plus(bucket.internal_migration, quote(swap));
    else if (twamm !== null && swap.locker === twamm) bucket.twamm_virtual = plus(bucket.twamm_virtual, quote(swap));
    else bucket.user_terminal = plus(bucket.user_terminal, quote(swap));
  }
}

function emptyBucket(context: EngineContext, quoteAsset: Address): VolumeBucket {
  const core = context.core_indexed ? 0n : null;
  return {
    quote_asset: quoteAsset,
    user_launch: 0n,
    user_terminal: core,
    twamm_virtual: context.snapshot.manifest.twamm === null ? null : core,
    internal_release_sales: core,
    internal_migration: core,
    round_trip: 0n,
    round_trip_payers: 0,
    swaps_without_payer: 0,
  };
}

/**
 * Without Core logs, terminal volume is still known to be zero for a quote
 * asset none of whose launches has locked terminal liquidity: no terminal
 * pool is attributed to the launchpad before LiquidityLocked names it.
 */
function settleWithoutTerminalPools(
  context: EngineContext,
  launches: readonly LaunchRecord[],
  buckets: Map<Address, VolumeBucket>,
): void {
  for (const bucket of buckets.values()) {
    const terminal = launches.some((l) => l.quote_token === bucket.quote_asset && l.terminal_pool_id !== null);
    if (terminal) continue;
    bucket.user_terminal = 0n;
    bucket.internal_migration = 0n;
    if (context.snapshot.manifest.twamm !== null) bucket.twamm_virtual = 0n;
  }
}

export function volumeBuckets(
  context: EngineContext,
  launches: readonly LaunchRecord[],
  window: VolumeWindow,
  thresholdBps: number,
): VolumeBucket[] {
  const buckets = new Map<Address, VolumeBucket>();
  const inWindow = (ref: LogRef) => inVolumeWindow(context, ref, window);
  for (const launch of launches) {
    const bucket = buckets.get(launch.quote_token) ?? emptyBucket(context, launch.quote_token);
    launchSwapVolume(context, launch, bucket, inWindow, thresholdBps);
    if (context.core_indexed) coreSwapVolume(context, launch, bucket, inWindow);
    buckets.set(launch.quote_token, bucket);
  }
  if (!context.core_indexed) settleWithoutTerminalPools(context, launches, buckets);
  return [...buckets.values()].sort((a, b) => (a.quote_asset < b.quote_asset ? -1 : 1));
}

export function volumeWindow(context: EngineContext): VolumeWindow {
  const to = context.snapshot.as_of.timestamp;
  return { from_exclusive: to - 86_400, to_inclusive: to };
}

function twammNote(context: EngineContext): string {
  const twamm = context.snapshot.manifest.twamm;
  if (twamm === null) {
    context.findings.note(
      "The manifest names no TWAMM extension, so swaps executed by TWAMM virtual orders cannot be separated from user_terminal; twamm_virtual is null.",
    );
    return "not separable: the manifest names no TWAMM extension";
  }
  return `terminal-pool Core swaps whose locker is the TWAMM extension ${twamm.address}: TWAMM executes virtual orders inside its own Core lock, so Core's swap log names it as the locker`;
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
  if (bucket.swaps_without_payer > 0) {
    findings.note(
      `${bucket.swaps_without_payer} launch swaps in the window were not routed through the launch router, so they have no payer and are left out of the round-trip grouping. They remain in user_launch.`,
    );
  }
  return {
    method: { id: "volume.rolling_24h", version: 2 },
    window: { from_timestamp_exclusive: window.from_exclusive, to_timestamp_inclusive: window.to_inclusive },
    quote_asset: launch.quote_token,
    quote_decimals: quoteDecimals,
    user_launch: figure(bucket.user_launch, findings),
    user_terminal: figure(bucket.user_terminal, findings),
    twamm_virtual: figure(bucket.twamm_virtual, findings),
    twamm_virtual_method: twammNote(context),
    internal: {
      release_sales: figure(bucket.internal_release_sales, findings),
      migration_rebalancing: figure(bucket.internal_migration, findings),
      note: "Protocol-initiated swaps. Reported separately and never added to user volume.",
    },
    round_trip: {
      ...ROUND_TRIP_METHOD,
      confidence: "heuristic" as const,
      volume: figure(bucket.round_trip, findings),
      payers: bucket.round_trip_payers,
      threshold_bps: thresholdBps,
      definition:
        "Quote volume of routed launch swaps whose router payer both bought and sold in the window and ended with |bought − sold| ≤ threshold_bps of the larger side. A heuristic: it says nothing about intent, and gross volume is not reduced by it.",
    },
    usd: null,
    usd_note: "No timestamped price source is applied to volume, so USD values are null.",
    units: "raw quote units, fee-inclusive",
  };
}

export function reconciliationSection(context: EngineContext, launch: LaunchRecord) {
  const result = reconcileSwaps(launch, context.index, context.snapshot.manifest.contracts.core.address);
  const first = result.mismatched[0];
  if (first !== undefined) {
    context.findings.note(
      `${result.mismatched.length} transactions with LaunchSwapped do not reconcile with the launch token's Transfers to and from Core (first: ${first.transaction_hash}). Holder, early-acquisition and volume figures include them; treat those figures as unverified.`,
    );
  }
  return {
    ...RECONCILIATION_METHOD,
    side: "launch token only; quote Transfers are not read",
    checked_transactions: result.checked,
    mismatched: result.mismatched,
  };
}
