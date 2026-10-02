import { BENEFICIARY_NOTE, metadataView, type EngineContext } from "./engine.js";
import { figure, volumeBuckets, volumeWindow } from "./analytics.js";
import type { LaunchRecord } from "./launches.js";
import { feeView, sum } from "./numbers.js";
import {
  deployed,
  feeAt,
  launchPoolState,
  phaseAt,
  releasedAt,
  side,
  type Phase,
} from "./state.js";
import type { Address, Hex, TransactionInfo } from "./types.js";

export function launchSummary(context: EngineContext, launch: LaunchRecord) {
  const timestamp = context.snapshot.as_of.timestamp;
  return {
    chain_id: context.snapshot.chain_id,
    token: launch.token,
    pool_id: launch.pool_id,
    quote_token: launch.quote_token,
    launch_block: launch.created.block_number,
    launch_timestamp: context.index.timestamps.get(launch.created.block_number) ?? null,
    beneficiary: launch.beneficiary,
    phase: phaseAt(launch, timestamp),
    metadata: metadataView(launch.config),
  };
}

function pendingPrincipal(context: EngineContext, launch: LaunchRecord) {
  if (launch.locks.length > 0) {
    context.findings.note(
      "pending_principal is null after the first deposit: rebalancing and fee collection change the saved principal without events the v1 engine consumes.",
    );
    return null;
  }
  return {
    launch_token: sum(launch.principal.map((e) => side(launch, e, "token"))).toString(),
    quote: sum(launch.principal.map((e) => side(launch, e, "quote"))).toString(),
  };
}

export function launchView(context: EngineContext, launch: LaunchRecord) {
  const timestamp = context.snapshot.as_of.timestamp;
  const config = launch.config;
  const released = releasedAt(config, timestamp);
  const advance = launch.advances.at(-1) ?? null;
  return {
    ...launchSummary(context, launch),
    method: { id: "launch_state", version: 1 },
    beneficiary_note: BENEFICIARY_NOTE,
    decimals: config.decimals,
    total_supply: config.total_supply.toString(),
    schedule: {
      start_time: config.start_time,
      end_time: config.end_time,
      initial_fee: feeView(config.initial_fee),
      final_fee: feeView(config.final_fee),
    },
    fee_now: { ...feeView(feeAt(config, timestamp)), at_timestamp: timestamp },
    released: released.toString(),
    unreleased: (config.total_supply - released).toString(),
    deployed: deployed(launch).toString(),
    deployed_as_of: advance?.ref ?? null,
    complete_flag: advance?.complete ?? false,
    launch_pool_state: launchPoolState(launch),
    terminal_pool_id: launch.terminal_pool_id,
    pending_principal: pendingPrincipal(context, launch),
    created: launch.created,
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

function normalizedSymbol(symbol: string): string {
  return symbol.normalize("NFKC").trim().toLowerCase();
}

export function sameSymbolEarlier(
  context: EngineContext,
  launch: LaunchRecord,
) {
  const symbol = normalizedSymbol(launch.config.symbol);
  return context.index.launches
    .filter(
      (other) =>
        other !== launch &&
        normalizedSymbol(other.config.symbol) === symbol &&
        other.created.block_number <= launch.created.block_number &&
        (other.created.block_number < launch.created.block_number ||
          other.created.log_index < launch.created.log_index),
    )
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
  const route = launch.routes.find(
    (r) => r.ref.transaction_hash === launch.created.transaction_hash,
  );
  return route?.payer ?? null;
}

function senderFindings(context: EngineContext, inputs: ProvenanceInputs, payer: Address | null) {
  if (inputs.transaction === null) {
    context.findings.note("The creation transaction was not available from the source, so transaction_sender is null.");
  }
  if (payer === null) {
    context.findings.note(
      "No LaunchRouted log in the creation transaction: the launch was not created through the manifest's launch router, so the payer is not in the logs and is null.",
    );
  }
  if (inputs.observed_code_hash === null) {
    context.findings.note("The emitting contract's code was not available from the source, so its code hash is unverified.");
  }
}

export function provenanceView(
  context: EngineContext,
  launch: LaunchRecord,
  inputs: ProvenanceInputs,
) {
  const payer = payerOf(launch);
  senderFindings(context, inputs, payer);
  const expected = context.snapshot.manifest.contracts.scheduled_launch;
  const sender = inputs.transaction?.from ?? null;
  const { name: _name, symbol: _symbol, owner: _owner, ...numeric } = launch.config;
  return {
    ...launchSummary(context, launch),
    method: { id: "provenance", version: 1 },
    creation: {
      ...launch.created,
      block_timestamp: context.index.timestamps.get(launch.created.block_number) ?? null,
    },
    transaction_sender: sender,
    payer,
    fee_beneficiary: launch.beneficiary,
    beneficiary_differs_from_sender: sender === null ? null : sender !== launch.beneficiary,
    roles_note: `${BENEFICIARY_NOTE} The transaction sender signed the creation transaction; the payer is the address the launch router charged. The three can all differ.`,
    emitting_contract: {
      address: launch.emitter,
      manifest_name: "scheduled_launch",
      address_matches_manifest: launch.emitter === expected.address,
      manifest_code_hash: expected.code_hash,
      observed_code_hash: inputs.observed_code_hash,
      code_hash_matches_manifest:
        inputs.observed_code_hash === null ? null : inputs.observed_code_hash === expected.code_hash,
    },
    config_excerpt: Object.fromEntries(
      Object.entries(numeric).map(([key, value]) => [key, String(value)]),
    ),
    same_symbol_earlier_launches: sameSymbolEarlier(context, launch),
    same_symbol_basis: "symbols compared after Unicode NFKC normalization, trimming and lowercasing",
    does_not_prove: DOES_NOT_PROVE,
  };
}

export interface SearchQuery {
  text?: string;
  quote_token?: string;
  beneficiary?: string;
  phase?: Phase;
  created_from_block?: number;
  created_to_block?: number;
  sort: "newest" | "oldest";
}

const ADDRESS_OR_ID = /^0x([0-9a-f]{40}|[0-9a-f]{64})$/;

function textMatches(launch: LaunchRecord, text: string): boolean {
  const needle = text.toLowerCase();
  if (ADDRESS_OR_ID.test(needle)) return launch.token === needle || launch.pool_id === needle;
  const haystacks = [launch.config.name, launch.config.symbol].map((s) => s.normalize("NFKC").toLowerCase());
  const normalized = needle.normalize("NFKC");
  return haystacks.some((h) => h.includes(normalized));
}

function filterMatches(context: EngineContext, launch: LaunchRecord, query: SearchQuery): boolean {
  const block = launch.created.block_number;
  const checks = [
    query.text === undefined || textMatches(launch, query.text),
    query.quote_token === undefined || launch.quote_token === query.quote_token.toLowerCase(),
    query.beneficiary === undefined || launch.beneficiary === query.beneficiary.toLowerCase(),
    query.created_from_block === undefined || block >= query.created_from_block,
    query.created_to_block === undefined || block <= query.created_to_block,
    query.phase === undefined || phaseAt(launch, context.snapshot.as_of.timestamp) === query.phase,
  ];
  return checks.every(Boolean);
}

export function searchMatches(context: EngineContext, query: SearchQuery): LaunchRecord[] {
  const matches = context.index.launches.filter((l) => filterMatches(context, l, query));
  return query.sort === "newest" ? [...matches].reverse() : matches;
}

export function requiresExactAddress(query: SearchQuery, matches: readonly LaunchRecord[]): boolean {
  const byText = query.text !== undefined && !ADDRESS_OR_ID.test(query.text.toLowerCase());
  return byText && matches.length > 1;
}

export function statsView(context: EngineContext, quoteDecimals: ReadonlyMap<Address, number | null>) {
  const { findings, snapshot, index } = context;
  const buckets = volumeBuckets(context, index.launches, volumeWindow(context), 100);
  const extension = snapshot.manifest.contracts.scheduled_launch.address;
  return {
    tokens_created: {
      value: index.launches.length === 0 && !findings.complete ? null : index.launches.length,
      method: "count of LaunchCreated from the manifest's extension",
      extension,
    },
    rolling_24h_volume: buckets.map((b) => ({
      quote_asset: b.quote_asset,
      decimals: quoteDecimals.get(b.quote_asset) ?? null,
      user_volume: figure(b.user_launch + b.user_terminal, findings),
      method: "fee-inclusive quote amounts of LaunchSwapped plus non-protocol terminal-pool swaps, in the 24 hours ending at as_of; protocol release sales and migration rebalancing excluded",
    })),
    scope: `chain ${snapshot.chain_id}; launches created by ScheduledLaunch ${extension} (manifest revision ${snapshot.manifest.git_revision}) and their launch and terminal pools on Core ${snapshot.manifest.contracts.core.address}`,
  };
}
