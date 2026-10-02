import { z } from "zod";
import { ServiceError } from "../../core.js";
import {
  creatorAllocation,
  earlyAcquisition,
  holdersSection,
  launchLedger,
  volumeSection,
  type EarlyWindow,
} from "./analytics.js";
import { decodeCursor, encodeCursor, paginate, type CursorPosition } from "./cursor.js";
import {
  ADDRESS_NOTE,
  prepareEngine,
  resolveLaunch,
  type EngineContext,
} from "./engine.js";
import { envelope } from "./envelope.js";
import { FixtureSource, normalizeManifest, type FixtureBundle } from "./fixture-source.js";
import type { LaunchRecord } from "./launches.js";
import { RpcSource } from "./rpc-source.js";
import type { Address, Finality, LaunchpadManifest, LaunchpadSource } from "./types.js";
import {
  launchSummary,
  launchView,
  provenanceView,
  requiresExactAddress,
  searchMatches,
  statsView,
  type SearchQuery,
} from "./views.js";

export interface LaunchpadEnv {
  /** `rpc` or `fixture`. Unset disables the launchpad tools with a clear error. */
  LAUNCHPAD_SOURCE?: string;
  LAUNCHPAD_MANIFEST?: string;
  LAUNCHPAD_RPC_URL?: string;
  LAUNCHPAD_FIXTURE?: string;
}

const sourceCache = new WeakMap<object, LaunchpadSource>();

function parseJson<T>(raw: string | undefined, name: string): T {
  if (raw === undefined || raw === "") {
    throw new ServiceError("launchpad_not_configured", `${name} is not set; the launchpad prototype is not configured on this server.`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ServiceError("launchpad_not_configured", `${name} is not valid JSON.`);
  }
}

function buildSource(env: LaunchpadEnv): LaunchpadSource {
  if (env.LAUNCHPAD_SOURCE === "fixture") {
    return new FixtureSource(parseJson<FixtureBundle>(env.LAUNCHPAD_FIXTURE, "LAUNCHPAD_FIXTURE"));
  }
  if (env.LAUNCHPAD_SOURCE === "rpc") {
    const manifest = normalizeManifest(parseJson<LaunchpadManifest>(env.LAUNCHPAD_MANIFEST, "LAUNCHPAD_MANIFEST"));
    if (env.LAUNCHPAD_RPC_URL === undefined || env.LAUNCHPAD_RPC_URL === "") {
      throw new ServiceError("launchpad_not_configured", "LAUNCHPAD_RPC_URL is not set.");
    }
    return new RpcSource({ url: env.LAUNCHPAD_RPC_URL, manifest });
  }
  throw new ServiceError(
    "launchpad_not_configured",
    "The launchpad prototype is not configured on this server (LAUNCHPAD_SOURCE is neither rpc nor fixture).",
  );
}

/** One source per env object, so a fixture bundle is parsed once per isolate. */
export function launchpadSource(env: LaunchpadEnv): LaunchpadSource {
  const cached = sourceCache.get(env);
  if (cached !== undefined) return cached;
  const source = buildSource(env);
  sourceCache.set(env, source);
  return source;
}

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an exact 0x-prefixed 20-byte address");
const poolId = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "an exact 0x-prefixed 32-byte pool id");
const finality = z.enum(["finalized", "safe", "latest"]).default("latest");
const chainId = z.number().int().positive();

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

async function engineFor(
  source: LaunchpadSource,
  chain: number,
  requested: Finality,
  position: CursorPosition | null,
): Promise<EngineContext> {
  if (chain !== source.manifest.chain_id) {
    throw new ServiceError(
      "unsupported_chain",
      `The launchpad prototype covers chain ${source.manifest.chain_id} only.`,
      { supported_chain_id: source.manifest.chain_id },
    );
  }
  const snapshot = await source.snapshot({
    finality: requested,
    ...(position === null ? {} : { at_block: { number: position.block_number, hash: position.block_hash } }),
  });
  return prepareEngine(snapshot);
}

function respond(context: EngineContext, body: Record<string, unknown>) {
  return { ...envelope(context.snapshot, context.findings), ...body };
}

export const searchSchema = z.object({
  chain_id: chainId,
  text: z.string().min(1).max(200).optional().describe("Case-insensitive text matched against name and symbol, or an exact token address or pool id."),
  quote_token: address.optional(),
  beneficiary: address.optional(),
  phase: z.enum(["scheduled", "active", "stalled", "ended_pending_advance", "migration_pending", "migrated"]).optional(),
  created_from_block: z.number().int().nonnegative().optional(),
  created_to_block: z.number().int().nonnegative().optional(),
  sort: z.enum(["newest", "oldest"]).default("newest"),
  page_size: z.number().int().min(1).max(100).default(20),
  cursor: z.string().max(1000).optional(),
  finality,
});

export async function launchpadSearch(env: LaunchpadEnv, raw: z.input<typeof searchSchema>) {
  const input = searchSchema.parse(raw);
  const { cursor, page_size: pageSize, ...rest } = input;
  const query: SearchQuery & Record<string, unknown> = rest;
  const position = cursor === undefined ? null : decodeCursor(cursor, "search", query);
  const context = await engineFor(launchpadSource(env), input.chain_id, input.finality, position);
  const matches = searchMatches(context, query);
  const asOf = context.snapshot.as_of;
  const page = paginate(matches, pageSize, position?.offset ?? 0, (offset) =>
    encodeCursor("search", query, { block_number: asOf.number, block_hash: asOf.hash, offset }),
  );
  const exact = requiresExactAddress(query, matches);
  return respond(context, {
    method: { id: "search", version: 1 },
    candidate_count: matches.length,
    requires_exact_address: exact,
    ...(exact
      ? { exact_address_note: "More than one launch matches this text. Names and symbols are not identity; select by exact token address and check launchpad_get_provenance." }
      : {}),
    candidates: page.items.map((launch) => ({
      ...launchSummary(context, launch),
      same_symbol_launches: sameSymbolCount(context, launch),
    })),
    cursor: page.cursor,
    cursor_note: "Cursors are bound to the as_of block hash; a reorganized block returns stale_cursor.",
  });
}

function sameSymbolCount(context: EngineContext, launch: LaunchRecord): number {
  const symbol = launch.config.symbol.normalize("NFKC").trim().toLowerCase();
  return context.index.launches.filter((l) => l.config.symbol.normalize("NFKC").trim().toLowerCase() === symbol).length;
}

export const getLaunchSchema = z.object(launchSelector);

export async function launchpadGetLaunch(env: LaunchpadEnv, raw: z.input<typeof getLaunchSchema>) {
  const input = getLaunchSchema.parse(raw);
  requireSelector(input);
  const context = await engineFor(launchpadSource(env), input.chain_id, input.finality, null);
  const launch = resolveLaunch(context, input);
  return respond(context, { launch: launchView(context, launch) });
}

export const getProvenanceSchema = z.object(launchSelector);

export async function launchpadGetProvenance(env: LaunchpadEnv, raw: z.input<typeof getProvenanceSchema>) {
  const input = getProvenanceSchema.parse(raw);
  requireSelector(input);
  const source = launchpadSource(env);
  const context = await engineFor(source, input.chain_id, input.finality, null);
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
  const first = await source.firstBlockAtOrAfter(launch.config.start_time, {
    from_block: launch.created.block_number,
    to_block: asOf,
  });
  if (first === null) {
    context.findings.note("No block at or after start_time exists by the as_of block, so the block window has not started.");
    return [seconds];
  }
  const last = first.number + input.early_window_blocks - 1;
  const end = last <= asOf ? await source.block(last) : null;
  return [{ kind: "blocks", blocks: input.early_window_blocks, first_block: first, end_block: end }, seconds];
}

export async function launchpadGetAnalytics(env: LaunchpadEnv, raw: z.input<typeof getAnalyticsSchema>) {
  const input = getAnalyticsSchema.parse(raw);
  requireSelector(input);
  const { cursor, holders_page_size: pageSize, ...query } = input;
  const position = cursor === undefined ? null : decodeCursor(cursor, "holders", query);
  const source = launchpadSource(env);
  const context = await engineFor(source, input.chain_id, input.finality, position);
  const launch = resolveLaunch(context, input);
  const asOf = context.snapshot.as_of;
  const offset = position?.offset ?? 0;
  const ledger = launchLedger(context, launch);
  const holders = holdersSection(context, launch, ledger, { offset, size: pageSize });
  const next = offset + pageSize;
  const windows = await earlyWindows(source, context, launch, input);
  const quoteDecimals = await source.tokenDecimals(launch.quote_token, asOf.number);
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
    volume: volumeSection(context, launch, input.round_trip_threshold_bps, quoteDecimals),
    address_note: ADDRESS_NOTE,
  });
}

export async function launchpadStats(env: LaunchpadEnv, requested: Finality = "latest") {
  const source = launchpadSource(env);
  const context = await engineFor(source, source.manifest.chain_id, requested, null);
  const quotes = [...new Set(context.index.launches.map((l) => l.quote_token))];
  const decimals = new Map<Address, number | null>(
    await Promise.all(
      quotes.map(async (q) => [q, await source.tokenDecimals(q, context.snapshot.as_of.number)] as const),
    ),
  );
  const stats = statsView(context, decimals);
  const { as_of, source: src, limitations } = envelope(context.snapshot, context.findings);
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
    description: `${PROTOTYPE} Find launches by text (name or symbol, case-insensitive), exact address, quote token, beneficiary, phase or creation block range. Names and symbols are untrusted and not identity: when more than one launch matches text, requires_exact_address is true and the caller must pick by exact address. Every response carries as_of block, source completeness and limitations.`,
    schema: searchSchema,
    handler: launchpadSearch as LaunchpadTool["handler"],
  },
  {
    name: "launchpad_get_launch",
    title: "Get launchpad launch state",
    description: `${PROTOTYPE} State of one launch by chain and exact token address or pool id: schedule, current fee, released and deployed supply, phase, terminal pool and pending principal.`,
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
    description: `${PROTOTYPE} Address-level holder distribution with Core balances decomposed and excluded by category, beneficiary allocation including unclaimed fees, early acquisition in stated block and time windows, and 24-hour volume split into user, internal and round-trip heuristic. Address counts are not counts of people.`,
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
