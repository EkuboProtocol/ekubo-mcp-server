import { BENEFICIARY_NOTE, metadataView, type EngineContext } from "./engine.js";
import { figure, volumeBuckets, volumeWindow } from "./analytics.js";
import type { LaunchConfig } from "./decode.js";
import type { LaunchRecord } from "./launches.js";
import { feeView, sum } from "./numbers.js";
import { tickPrice, usdValue } from "./prices.js";
import {
  deltas,
  deployed,
  feeAt,
  launchPoolState,
  phaseAt,
  releasedAt,
  side,
  type Phase,
} from "./state.js";
import { terminalAccounting, type Pair } from "./terminal.js";
import type { Address, Hex, TransactionInfo } from "./types.js";

export type QuoteDecimals = ReadonlyMap<Address, number | null>;

function creationView(context: EngineContext, launch: LaunchRecord) {
  return {
    ...launch.created,
    block_timestamp: context.index.timestamps.get(launch.created.block_number) ?? null,
  };
}

export function launchSummary(context: EngineContext, launch: LaunchRecord) {
  return {
    chain_id: context.snapshot.chain_id,
    token: launch.token,
    pool_id: launch.pool_id,
    quote_token: launch.quote_token,
    launch_block: launch.created.block_number,
    launch_timestamp: context.index.timestamps.get(launch.created.block_number) ?? null,
    beneficiary: launch.beneficiary,
    phase: phaseAt(launch, context.snapshot.as_of.timestamp),
    metadata: metadataView(launch.config),
  };
}

function remainingFeeSchedule(config: LaunchConfig, timestamp: number) {
  if (timestamp >= config.end_time) return { kind: "constant" as const, fee: feeView(config.final_fee) };
  const from = Math.max(timestamp, config.start_time);
  return {
    kind: "linear" as const,
    from_timestamp: from,
    to_timestamp: config.end_time,
    from_fee: feeView(feeAt(config, from)),
    to_fee: feeView(config.final_fee),
    after_end: feeView(config.final_fee),
  };
}

function pairView(launch: LaunchRecord, pair: Pair) {
  return { launch_token: side(launch, pair, "token").toString(), quote: side(launch, pair, "quote").toString() };
}

/** The latest terminal-pool tick, in the launch orientation of the config's ticks. */
function terminalTick(launch: LaunchRecord) {
  const events = [...launch.terminal_pool.swaps, ...launch.terminal_pool.positions].sort(
    (a, b) => a.ref.block_number - b.ref.block_number || a.ref.log_index - b.ref.log_index,
  );
  const last = events.at(-1);
  if (last === undefined) return null;
  return { tick: launch.token_is0 ? last.tick : 0 - last.tick, observed_at: last.ref };
}

function migrationView(context: EngineContext, launch: LaunchRecord, quoteDecimals: number | null) {
  const { migration_tick_lower: lower, migration_tick_upper: upper, decimals } = launch.config;
  const current = context.core_indexed ? terminalTick(launch) : null;
  return {
    bounds: { tick_lower: lower, tick_upper: upper, price_lower: tickPrice(lower, decimals, quoteDecimals), price_upper: tickPrice(upper, decimals, quoteDecimals) },
    price_orientation: "quote per launch token; ticks are powers of 1.000001",
    terminal_pool_id: launch.terminal_pool_id,
    current_terminal_price: current === null ? null : { ...tickPrice(current.tick, decimals, quoteDecimals), observed_at: current.observed_at },
    inside_bounds: current === null ? null : current.tick >= lower && current.tick <= upper,
    note: "Principal is deposited only while the terminal price is inside these bounds and is never withdrawable.",
  };
}

function principalView(context: EngineContext, launch: LaunchRecord) {
  const received = { amount0: sum(launch.principal.map((p) => p.amount0)), amount1: sum(launch.principal.map((p) => p.amount1)) };
  if (!context.core_indexed) {
    return { received: pairView(launch, received), deposited: null, pending: null, liquidity_locked: sum(launch.locks.map((l) => l.liquidity)).toString() };
  }
  const terminal = terminalAccounting(launch, context.snapshot.manifest.contracts.locked_launch_liquidity.address);
  return {
    received: pairView(launch, terminal.principal_received),
    deposited: pairView(launch, terminal.deposited),
    pending: pairView(launch, terminal.pending_principal),
    liquidity_locked: terminal.liquidity_locked.toString(),
  };
}

/** Verified against the code at this revision of evm-contracts (PR #380 head). */
export const PRIVILEGES_REVISION = "3e4ffad2446c7777c26e74caa809c3f77ee054e1";

function privilegesView(context: EngineContext, launch: LaunchRecord, observed: Hex | null) {
  const pinned = context.snapshot.manifest.contracts.scheduled_launch.code_hash;
  if (pinned === null || observed === null || observed !== pinned) {
    context.findings.note(
      "privileges is null: the emitting contract's code hash could not be matched to the manifest, so the code the privileges were read from is not established.",
    );
    return null;
  }
  if (context.snapshot.manifest.revision !== PRIVILEGES_REVISION) {
    context.findings.note(
      `privileges were read from evm-contracts ${PRIVILEGES_REVISION}; the manifest's revision is ${context.snapshot.manifest.revision}.`,
    );
  }
  return {
    verified_at_revision: PRIVILEGES_REVISION,
    emitter_code_hash: observed,
    supply: "fixed",
    mint_authority: "renounced",
    beneficiary_powers: ["claim_creator_fees"],
    principal_withdrawal: "none",
    upgrade: "none",
    pause: "none",
    initial_beneficiary_allocation: "0",
    third_party_liquidity: "rejected",
  };
}

export interface LaunchInputs {
  quote_decimals: number | null;
  emitter_code_hash: Hex | null;
}

export function launchView(context: EngineContext, launch: LaunchRecord, inputs: LaunchInputs) {
  const timestamp = context.snapshot.as_of.timestamp;
  const config = launch.config;
  const released = releasedAt(config, timestamp);
  const advance = launch.advances.at(-1) ?? null;
  if (!context.core_indexed) {
    context.findings.note("Without Core logs the launch-pool price is unknown, so the stalled phase cannot be detected.");
  }
  return {
    ...launchSummary(context, launch),
    method: { id: "launch_state", version: 2 },
    beneficiary_note: BENEFICIARY_NOTE,
    decimals: config.decimals,
    total_supply: config.total_supply.toString(),
    quote: { asset: launch.quote_token, decimals: inputs.quote_decimals },
    schedule: { start_time: config.start_time, end_time: config.end_time },
    fees: {
      initial: feeView(config.initial_fee),
      final: feeView(config.final_fee),
      now: { ...feeView(feeAt(config, timestamp)), at_timestamp: timestamp },
      remaining_schedule: remainingFeeSchedule(config, timestamp),
      charged_on: "the calculated side of each launch swap; buy fees are paid in the launch token",
    },
    released: released.toString(),
    unreleased: (config.total_supply - released).toString(),
    deployed: deployed(launch).toString(),
    deployed_as_of: advance?.ref ?? null,
    complete_flag: advance?.complete ?? false,
    launch_pool_state: context.core_indexed ? launchPoolState(launch) : null,
    migration: migrationView(context, launch, inputs.quote_decimals),
    principal: principalView(context, launch),
    privileges: privilegesView(context, launch, inputs.emitter_code_hash),
    created: creationView(context, launch),
    phase_definitions: PHASE_DEFINITIONS,
  };
}

const PHASE_DEFINITIONS: Record<Phase, string> = {
  scheduled: "before start_time; swaps revert",
  active: "between start_time and end_time with released inventory tradable",
  stalled:
    "between start_time and end_time, released inventory not yet deployed, and the last observed price beyond the launch range",
  ended_pending_advance: "end_time passed and the launch has not completed; anyone may call advance",
  migration_pending: "completed; principal received but no terminal liquidity locked yet",
  migrated: "terminal liquidity locked in the full-range TWAMM pool",
};

const DOES_NOT_PROVE = [
  "who the people or organization behind any address are",
  "that the beneficiary created, endorses or controls the token",
  "that the name or symbol refers to any real project, brand or person",
  "that this is the first, original or official token with this name or symbol",
  "anything about future behavior of any address",
];

/** Search key only: NFKC, then case folding. Never an identifier. */
export function symbolKey(symbol: string): string {
  return symbol.normalize("NFKC").toLowerCase().normalize("NFKC").trim();
}

export function sameSymbolEarlier(context: EngineContext, launch: LaunchRecord) {
  const key = symbolKey(launch.config.symbol);
  const position = (l: LaunchRecord) => [l.created.block_number, l.created.log_index];
  const [block, index] = position(launch);
  return context.index.launches
    .filter((other) => {
      const [b, i] = position(other);
      return other !== launch && symbolKey(other.config.symbol) === key && (b < block || (b === block && i < index));
    })
    .map((other) => ({
      token: other.token,
      pool_id: other.pool_id,
      launch_block: other.created.block_number,
      beneficiary: other.beneficiary,
    }));
}

export interface ProvenanceInputs {
  transaction: TransactionInfo | null;
  observed_code_hash: Hex | null;
}

function payerOf(launch: LaunchRecord): Address | null {
  const route = launch.routes.find((r) => r.ref.transaction_hash === launch.created.transaction_hash);
  return route?.payer ?? null;
}

function provenanceFindings(context: EngineContext, inputs: ProvenanceInputs, payer: Address | null) {
  if (inputs.transaction === null) {
    context.findings.note("The creation transaction was not available from the source, so transaction_sender is null.");
  }
  if (payer === null) {
    context.findings.note(
      "No LaunchRouted log in the creation transaction: the launch was not created through the manifest's launch router, so the payer is not in the logs and is null.",
    );
  }
  if (inputs.observed_code_hash === null || context.snapshot.manifest.contracts.scheduled_launch.code_hash === null) {
    context.findings.note("The emitting contract's code hash could not be compared with the manifest, so it is unverified.");
  }
}

function codeHashMatch(expected: Hex | null, observed: Hex | null): boolean | null {
  return expected === null || observed === null ? null : expected === observed;
}

export function provenanceView(context: EngineContext, launch: LaunchRecord, inputs: ProvenanceInputs) {
  const payer = payerOf(launch);
  provenanceFindings(context, inputs, payer);
  const expected = context.snapshot.manifest.contracts.scheduled_launch;
  const sender = inputs.transaction?.from ?? null;
  const { name: _name, symbol: _symbol, owner: _owner, ...numeric } = launch.config;
  return {
    ...launchSummary(context, launch),
    method: { id: "provenance", version: 2 },
    creation: creationView(context, launch),
    transaction_sender: sender,
    payer,
    beneficiary_differs_from_sender: sender === null ? null : sender !== launch.beneficiary,
    roles_note: `${BENEFICIARY_NOTE} The transaction sender signed the creation transaction; the payer is the address the launch router charged. The three can all differ.`,
    emitting_contract: {
      address: launch.emitter,
      manifest_name: "scheduled_launch",
      address_matches_manifest: launch.emitter === expected.address,
      manifest_code_hash: expected.code_hash,
      observed_code_hash: inputs.observed_code_hash,
      code_hash_matches_manifest: codeHashMatch(expected.code_hash, inputs.observed_code_hash),
    },
    config_excerpt: Object.fromEntries(Object.entries(numeric).map(([key, value]) => [key, String(value)])),
    same_symbol_earlier_launches: sameSymbolEarlier(context, launch),
    same_symbol_basis: "symbols compared after Unicode NFKC normalization and case folding; full confusable detection is not performed",
    does_not_prove: DOES_NOT_PROVE,
  };
}

export type SearchSort = "launch_block_desc" | "launch_block_asc" | "quote_raised_desc";

export interface SearchQuery {
  text?: string;
  launched_after?: number;
  phase?: Phase;
  quote_asset?: string;
  min_quote_raised?: string;
  max_quote_raised?: string;
  sort: SearchSort;
}

/** Net quote paid in by buyers through LaunchSwapped, fee-inclusive (sells subtract). */
export function quoteRaised(launch: LaunchRecord): bigint {
  return sum(launch.launch_swaps.map((s) => side(launch, deltas(s), "quote")));
}

const ADDRESS_OR_ID = /^0x([0-9a-f]{40}|[0-9a-f]{64})$/;

function textMatches(launch: LaunchRecord, text: string): boolean {
  const needle = text.toLowerCase();
  if (ADDRESS_OR_ID.test(needle)) return launch.token === needle || launch.pool_id === needle;
  const key = symbolKey(text);
  return [launch.config.name, launch.config.symbol].some((value) => symbolKey(value).includes(key));
}

function raisedInRange(launch: LaunchRecord, query: SearchQuery): boolean {
  const raised = quoteRaised(launch);
  const min = query.min_quote_raised === undefined || raised >= BigInt(query.min_quote_raised);
  const max = query.max_quote_raised === undefined || raised <= BigInt(query.max_quote_raised);
  return min && max;
}

function filterMatches(context: EngineContext, launch: LaunchRecord, query: SearchQuery): boolean {
  const launchedAt = context.index.timestamps.get(launch.created.block_number) ?? null;
  const checks = [
    query.text === undefined || textMatches(launch, query.text),
    query.launched_after === undefined || (launchedAt !== null && launchedAt > query.launched_after),
    query.phase === undefined || phaseAt(launch, context.snapshot.as_of.timestamp) === query.phase,
    query.quote_asset === undefined || launch.quote_token === query.quote_asset.toLowerCase(),
    raisedInRange(launch, query),
  ];
  return checks.every(Boolean);
}

const byPosition = (a: LaunchRecord, b: LaunchRecord) =>
  a.created.block_number - b.created.block_number || a.created.log_index - b.created.log_index;

const SORTS: Record<SearchSort, (a: LaunchRecord, b: LaunchRecord) => number> = {
  launch_block_desc: (a, b) => byPosition(b, a),
  launch_block_asc: byPosition,
  quote_raised_desc: (a, b) => {
    const [x, y] = [quoteRaised(a), quoteRaised(b)];
    return x === y ? byPosition(b, a) : x > y ? -1 : 1;
  },
};

export function searchMatches(context: EngineContext, query: SearchQuery): LaunchRecord[] {
  return context.index.launches.filter((l) => filterMatches(context, l, query)).sort(SORTS[query.sort]);
}

export function requiresExactAddress(query: SearchQuery, matches: readonly LaunchRecord[]): boolean {
  const byText = query.text !== undefined && !ADDRESS_OR_ID.test(query.text.toLowerCase());
  return byText && matches.length > 1;
}

export function searchRow(context: EngineContext, launch: LaunchRecord, decimals: QuoteDecimals) {
  const raised = quoteRaised(launch);
  return {
    ...launchSummary(context, launch),
    creation: creationView(context, launch),
    quote_raised: {
      amount: figure(raised, context.findings),
      decimals: decimals.get(launch.quote_token) ?? null,
      method: "net quote paid in through LaunchSwapped, fee-inclusive; sells subtract",
      usd: usdValue(raised, launch.quote_token, context.snapshot.prices),
    },
    same_symbol_launches: context.index.launches.filter((l) => symbolKey(l.config.symbol) === symbolKey(launch.config.symbol)).length,
  };
}

export function statsView(context: EngineContext, quoteDecimals: QuoteDecimals) {
  const { findings, snapshot, index } = context;
  const buckets = volumeBuckets(context, index.launches, volumeWindow(context), 100);
  const extension = snapshot.manifest.contracts.scheduled_launch.address;
  const userVolume = (b: (typeof buckets)[number]) =>
    b.user_terminal === null ? null : b.user_launch + b.user_terminal;
  return {
    tokens_created: {
      value: index.launches.length === 0 && !findings.complete ? null : index.launches.length,
      method: "count of LaunchCreated from the manifest's extension",
      extension,
    },
    rolling_24h_volume: buckets.map((b) => ({
      quote_asset: b.quote_asset,
      decimals: quoteDecimals.get(b.quote_asset) ?? null,
      user_volume: figure(userVolume(b), findings),
      user_launch: figure(b.user_launch, findings),
      method:
        "fee-inclusive quote amounts of LaunchSwapped plus user terminal-pool swaps, in the 24 hours ending at as_of; protocol release sales, migration rebalancing and TWAMM virtual execution excluded",
    })),
    scope: `chain ${snapshot.chain_id}; launches created by ScheduledLaunch ${extension} (manifest revision ${snapshot.manifest.revision}) and their launch and terminal pools on Core ${snapshot.manifest.contracts.core.address}`,
  };
}
