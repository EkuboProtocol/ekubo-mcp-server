import { z } from "zod";
import { ServiceError } from "../../core.js";
import {
  creatorAllocation,
  earlyAcquisition,
  holdersSection,
  launchLedger,
  reconciliationSection,
  volumeSection,
  type EarlyWindow,
} from "./analytics.js";
import { decodeCursor, encodeCursor, paginate, type CursorPosition } from "./cursor.js";
import { ADDRESS_NOTE, prepareEngine, resolveLaunch, type EngineContext } from "./engine.js";
import { envelope } from "./envelope.js";
import { fixtureSources, type FixtureBundle } from "./fixture-source.js";
import type { LaunchRecord } from "./launches.js";
import { RpcSource } from "./rpc-source.js";
import type { Address, Finality, LaunchpadSource, LaunchpadSources } from "./types.js";
import { deploymentManifest } from "./validate.js";
import {
  launchView,
  provenanceView,
  requiresExactAddress,
  searchMatches,
  searchRow,
  statsView,
  type QuoteDecimals,
  type SearchQuery,
} from "./views.js";

export interface LaunchpadEnv {
  /** `rpc` or `fixture`. Unset disables the launchpad tools with a clear error. */
  LAUNCHPAD_SOURCE?: string;
  /** The evm-contracts deployment manifest (`launchpad-manifest.json`), for `rpc`. */
  LAUNCHPAD_MANIFEST?: string;
  LAUNCHPAD_RPC_URL?: string;
  /** An eth_getLogs-shaped bundle (EKU-662 v2 format), for `fixture`. */
  LAUNCHPAD_FIXTURE?: string;
}

const sourceCache = new WeakMap<object, LaunchpadSources>();

function notConfigured(message: string): ServiceError {
  return new ServiceError("launchpad_not_configured", message);
}

function parseJson<T>(raw: string | undefined, name: string): T {
  if (raw === undefined || raw === "") throw notConfigured(`${name} is not set; the launchpad prototype is not configured on this server.`);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw notConfigured(`${name} is not valid JSON.`);
  }
}

function buildSources(env: LaunchpadEnv): LaunchpadSources {
  if (env.LAUNCHPAD_SOURCE === "fixture") {
    return fixtureSources(parseJson<FixtureBundle>(env.LAUNCHPAD_FIXTURE, "LAUNCHPAD_FIXTURE"));
  }
  if (env.LAUNCHPAD_SOURCE === "rpc") {
    const manifest = deploymentManifest(parseJson<unknown>(env.LAUNCHPAD_MANIFEST, "LAUNCHPAD_MANIFEST"));
    if (env.LAUNCHPAD_RPC_URL === undefined || env.LAUNCHPAD_RPC_URL === "") throw notConfigured("LAUNCHPAD_RPC_URL is not set.");
    return new Map([[manifest.chain_id, new RpcSource({ url: env.LAUNCHPAD_RPC_URL, manifest })]]);
  }
  throw notConfigured("The launchpad prototype is not configured on this server (LAUNCHPAD_SOURCE is neither rpc nor fixture).");
}

/** One source set per env object, so a fixture bundle is parsed once per isolate. */
export function launchpadSources(env: LaunchpadEnv): LaunchpadSources {
  const cached = sourceCache.get(env);
  if (cached !== undefined) return cached;
  const sources = buildSources(env);
  sourceCache.set(env, sources);
  return sources;
}

/**
 * The source for one chain. A chain the launchpad does not cover is reported
 * as not found: a lookup never falls back to a match from another chain.
 */
function sourceFor(env: LaunchpadEnv, chainId: number, code: "launch_not_found" | "chain_not_covered"): LaunchpadSource {
  const sources = launchpadSources(env);
  const source = sources.get(chainId);
  if (source !== undefined) return source;
  throw new ServiceError(
    code,
    `The launchpad prototype has no data for chain ${chainId}; nothing on another chain is matched instead.`,
    { chain_id: chainId, covered_chain_ids: [...sources.keys()] },
  );
}

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an exact 0x-prefixed 20-byte address");
const poolId = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "an exact 0x-prefixed 32-byte pool id");
const rawAmount = z.string().regex(/^\d{1,78}$/, "a raw amount as a decimal string");
const finality = z.enum(["finalized", "safe", "latest"]).default("latest");
const chainId = z.number().int().positive();
const phase = z.enum(["scheduled", "active", "stalled", "ended_pending_advance", "migration_pending", "migrated"]);

const launchSelector = {
  chain_id: chainId,
  token: address.optional().describe("Exact launch token address."),
  pool_id: poolId.optional().describe("Exact launch pool id."),
  finality,
};

function requireSelector(input: { token?: string; pool_id?: string }): void {
  if (input.token === undefined && input.pool_id === undefined) {
    throw new ServiceError("invalid_input", "Pass the exact token address or pool_id. Names and symbols are accepted only by launchpad_search.");
  }
}

async function engineFor(source: LaunchpadSource, requested: Finality, position: CursorPosition | null): Promise<EngineContext> {
  const snapshot = await source.snapshot({
    finality: requested,
    ...(position === null ? {} : { at_block: { number: position.block_number, hash: position.block_hash } }),
  });
  return prepareEngine(snapshot);
}

function respond(context: EngineContext, body: Record<string, unknown>) {
  const { as_of, source, limitations, undecoded } = envelope(context.snapshot, context.findings, context.undecoded);
  return { as_of, source, limitations, undecoded, ...body };
}

async function quoteDecimals(source: LaunchpadSource, context: EngineContext, launches: readonly LaunchRecord[]): Promise<QuoteDecimals> {
  const quotes = [...new Set(launches.map((l) => l.quote_token))];
  const block = context.snapshot.as_of.number;
  return new Map(await Promise.all(quotes.map(async (q) => [q, await source.tokenDecimals(q, block)] as const)));
}

export const searchSchema = z.object({
    chain_id: chainId,
    text: z.string().min(1).max(200).optional().describe("Matched against name and symbol after NFKC normalization and case folding, or an exact token address or pool id. A search key only, never an identifier."),
    launched_after: z.number().int().nonnegative().optional().describe("Unix seconds; matches launches whose creation block timestamp is later."),
    phase: phase.optional(),
    quote_asset: address.optional(),
    min_quote_raised: rawAmount.optional().describe("Raw quote units; requires quote_asset."),
    max_quote_raised: rawAmount.optional().describe("Raw quote units; requires quote_asset."),
    sort: z.enum(["launch_block_desc", "launch_block_asc", "quote_raised_desc"]).default("launch_block_desc"),
    page_size: z.number().int().min(1).max(100).default(20),
    cursor: z.string().max(1000).optional(),
    finality,
});

function requireQuoteAssetForRaised(query: { quote_asset?: string; min_quote_raised?: string; max_quote_raised?: string }): void {
  if (query.quote_asset === undefined && (query.min_quote_raised !== undefined || query.max_quote_raised !== undefined)) {
    throw new ServiceError("invalid_input", "min_quote_raised and max_quote_raised are raw quote units and require quote_asset.");
  }
}

export async function launchpadSearch(env: LaunchpadEnv, raw: z.input<typeof searchSchema>) {
  const input = searchSchema.parse(raw);
  requireQuoteAssetForRaised(input);
  const { cursor, page_size: pageSize, ...rest } = input;
  const query: SearchQuery & Record<string, unknown> = rest;
  const position = cursor === undefined ? null : decodeCursor(cursor, "search", query);
  const source = sourceFor(env, input.chain_id, "chain_not_covered");
  const context = await engineFor(source, input.finality, position);
  const matches = searchMatches(context, query);
  const asOf = context.snapshot.as_of;
  const page = paginate(matches, pageSize, position?.offset ?? 0, (offset) =>
    encodeCursor("search", query, { block_number: asOf.number, block_hash: asOf.hash, offset }),
  );
  const decimals = await quoteDecimals(source, context, page.items);
  const exact = requiresExactAddress(query, matches);
  context.findings.note("Lookalike detection is limited to NFKC normalization and case folding; visually confusable characters are not detected. Rows with non_ascii: true contain characters outside printable ASCII.");
  return respond(context, {
    method: { id: "search", version: 2 },
    sort_applied: input.sort,
    sponsored: false,
    ordering_note: "Ordering is the stated sort key only. No paid, sponsored or curated placement exists.",
    candidate_count: matches.length,
    requires_exact_address: exact,
    ...(exact
      ? { exact_address_note: "More than one launch matches this text. Names and symbols are not identity; select by exact token address and check launchpad_get_provenance." }
      : {}),
    candidates: page.items.map((launch) => searchRow(context, launch, decimals)),
    cursor: page.cursor,
    cursor_note: "Cursors are bound to the as_of block hash; a reorganized block returns stale_cursor.",
  });
}

export const getLaunchSchema = z.object(launchSelector);

export async function launchpadGetLaunch(env: LaunchpadEnv, raw: z.input<typeof getLaunchSchema>) {
  const input = getLaunchSchema.parse(raw);
  requireSelector(input);
  const source = sourceFor(env, input.chain_id, "launch_not_found");
  const context = await engineFor(source, input.finality, null);
  const launch = resolveLaunch(context, input);
  const block = context.snapshot.as_of.number;
  const [decimals, emitterCodeHash] = await Promise.all([
    source.tokenDecimals(launch.quote_token, block),
    source.codeHash(launch.emitter, block),
  ]);
  return respond(context, { launch: launchView(context, launch, { quote_decimals: decimals, emitter_code_hash: emitterCodeHash }) });
}

export const getProvenanceSchema = z.object(launchSelector);

export async function launchpadGetProvenance(env: LaunchpadEnv, raw: z.input<typeof getProvenanceSchema>) {
  const input = getProvenanceSchema.parse(raw);
  requireSelector(input);
  const source = sourceFor(env, input.chain_id, "launch_not_found");
  const context = await engineFor(source, input.finality, null);
  const launch = resolveLaunch(context, input);
  const [transaction, observedCodeHash] = await Promise.all([
    source.transaction(launch.created.transaction_hash),
    source.codeHash(launch.emitter, context.snapshot.as_of.number),
  ]);
  return respond(context, {
    provenance: provenanceView(context, launch, { transaction, observed_code_hash: observedCodeHash }),
  });
}

export const getAnalyticsSchema = z.object({
  ...launchSelector,
  early_window_blocks: z.number().int().min(1).max(100_000).default(50).describe("First n blocks from the first block at or after start_time."),
  early_window_seconds: z.number().int().min(1).max(30 * 86_400).default(300).describe("First m seconds from start_time."),
  round_trip_threshold_bps: z.number().int().min(0).max(10_000).default(100),
  additional_exclusions: z.array(address).max(50).default([]).describe("Addresses to exclude from holder figures; each is echoed with category caller_supplied."),
  holders_page_size: z.number().int().min(1).max(200).default(25),
  cursor: z.string().max(1000).optional().describe("Continue the holder list."),
});

async function earlyWindows(
  source: LaunchpadSource,
  context: EngineContext,
  launch: LaunchRecord,
  input: { early_window_blocks: number; early_window_seconds: number },
): Promise<EarlyWindow[]> {
  const asOf = context.snapshot.as_of.number;
  const seconds: EarlyWindow = { kind: "seconds", seconds: input.early_window_seconds, start_time: launch.config.start_time };
  const first = await source.firstBlockAtOrAfter(launch.config.start_time, { from_block: launch.created.block_number, to_block: asOf });
  if (first === null) {
    context.findings.note("No block at or after start_time exists by the as_of block, so the block window has not started.");
    return [seconds];
  }
  const last = first.number + input.early_window_blocks - 1;
  const end = last <= asOf ? await source.block(last) : null;
  if (last <= asOf && end === null) {
    context.findings.note(`The source has no header for block ${last}, the end of the block window, so its end time and released supply are measured at as_of.`);
  }
  return [{ kind: "blocks", blocks: input.early_window_blocks, first_block: first, end_block: end }, seconds];
}

export async function launchpadGetAnalytics(env: LaunchpadEnv, raw: z.input<typeof getAnalyticsSchema>) {
  const input = getAnalyticsSchema.parse(raw);
  requireSelector(input);
  const { cursor, holders_page_size: pageSize, ...query } = input;
  const position = cursor === undefined ? null : decodeCursor(cursor, "holders", query);
  const source = sourceFor(env, input.chain_id, "launch_not_found");
  const context = await engineFor(source, input.finality, position);
  const launch = resolveLaunch(context, input);
  const asOf = context.snapshot.as_of;
  const offset = position?.offset ?? 0;
  const ledger = launchLedger(context, launch);
  const additional = input.additional_exclusions.map((a) => a.toLowerCase() as Address);
  const holders = holdersSection(context, launch, ledger, { offset, size: pageSize }, additional);
  const next = offset + pageSize;
  const windows = await earlyWindows(source, context, launch, input);
  const decimals = await source.tokenDecimals(launch.quote_token, asOf.number);
  return respond(context, {
    token: launch.token,
    pool_id: launch.pool_id,
    holders: {
      ...holders.section,
      cursor:
        next < holders.total_rows
          ? encodeCursor("holders", query, { block_number: asOf.number, block_hash: asOf.hash, offset: next })
          : null,
      total_rows: holders.total_rows,
    },
    creator_allocation: creatorAllocation(context, launch, ledger),
    early_acquisition: earlyAcquisition(context, launch, windows),
    volume: volumeSection(context, launch, input.round_trip_threshold_bps, decimals),
    reconciliation: reconciliationSection(context, launch),
    address_note: ADDRESS_NOTE,
  });
}

/** Covered chain ids, for the stats endpoint's chain selection. */
export function launchpadChains(env: LaunchpadEnv): number[] {
  return [...launchpadSources(env).keys()];
}

export async function launchpadStats(env: LaunchpadEnv, chain: number, requested: Finality = "latest") {
  const source = sourceFor(env, chain, "chain_not_covered");
  const context = await engineFor(source, requested, null);
  const decimals = await quoteDecimals(source, context, context.index.launches);
  const stats = statsView(context, decimals);
  const { as_of, source: src, limitations } = envelope(context.snapshot, context.findings, context.undecoded);
  return { ...stats, as_of, source: src, limitations };
}

interface LaunchpadTool {
  name: string;
  title: string;
  description: string;
  schema: z.ZodObject;
  handler: (env: LaunchpadEnv, input: never) => Promise<unknown>;
}

const PROTOTYPE = "Non-production launchpad prototype on a local chain.";

export const launchpadAnalyticsTools: LaunchpadTool[] = [
  {
    name: "launchpad_search",
    title: "Search launchpad launches",
    description: `${PROTOTYPE} Find launches on one chain by text (name or symbol after NFKC and case folding), exact address, launch time, phase, quote asset or quote raised, sorted by launch block or quote raised. Names and symbols are untrusted search keys, not identity: when more than one launch matches text, requires_exact_address is true and the caller must pick by exact address. Every response carries as_of block, source completeness and limitations.`,
    schema: searchSchema,
    handler: launchpadSearch as LaunchpadTool["handler"],
  },
  {
    name: "launchpad_get_launch",
    title: "Get launchpad launch state",
    description: `${PROTOTYPE} State of one launch by chain and exact token address or pool id: exact fee schedule, released and deployed supply, phase, quote asset, migration bounds beside the current terminal price, principal locked and deposited, and the privileges block when the code hash matches the manifest.`,
    schema: getLaunchSchema,
    handler: launchpadGetLaunch as LaunchpadTool["handler"],
  },
  {
    name: "launchpad_get_provenance",
    title: "Get launchpad launch provenance",
    description: `${PROTOTYPE} Creation transaction, block, transaction sender, router payer and fee beneficiary reported separately, emitting contract and code hash against the manifest, config excerpt, earlier launches with the same symbol, and what this evidence does not prove.`,
    schema: getProvenanceSchema,
    handler: launchpadGetProvenance as LaunchpadTool["handler"],
  },
  {
    name: "launchpad_get_analytics",
    title: "Get launchpad launch analytics",
    description: `${PROTOTYPE} Address-level holder distribution with Core balances decomposed and excluded by category (plus optional caller-supplied exclusions), beneficiary allocation including unclaimed fees, early acquisition in stated block and time windows, 24-hour volume split into user, TWAMM, internal and round-trip heuristic, and swap reconciliation. Address counts are not counts of people.`,
    schema: getAnalyticsSchema,
    handler: launchpadGetAnalytics as LaunchpadTool["handler"],
  },
];

export const launchpadAnalyticsCatalog = launchpadAnalyticsTools.map(({ name, title, description, schema }) => ({
  name,
  title,
  description,
  inputSchema: z.toJSONSchema(schema, { io: "input" }),
}));
