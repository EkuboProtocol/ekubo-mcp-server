/**
 * Per-caller admission control for the public MCP endpoint.
 *
 * The server is unauthenticated by design, so there is no account to bill or
 * suspend: the only lever against a caller who is running up third-party
 * invoices, scraping the token and pool catalogs, or saturating `prod-api` is
 * to decide, per request, how much of a shared budget that caller has already
 * spent. Four budgets exist because those failure modes have different shapes
 * and a single request-per-minute number cannot express any two of them at
 * once:
 *
 * - `RATE_LIMITER_BURST` (10s) catches a flood inside ten seconds rather than
 *   after a minute of it.
 * - `RATE_LIMITER` (60s) is the sustained request ceiling, and the only budget
 *   that also covers non-tool traffic: `initialize`, `tools/list`, stored
 *   artifact fetches, and the uncached discovery routes.
 * - `RATE_LIMITER_TOOLS` (60s) is spent in *units* rather than requests,
 *   because `get_tokens` with a thousand identifiers and
 *   `derive_pool_id` are the same one request and nothing alike in what
 *   they cost us. This is the budget that bounds scraping and upstream load.
 * - `RATE_LIMITER_METERED` (60s) is a separate, much smaller ceiling on the
 *   tools that spend metered third-party credit — 0x, Across, LayerZero, and
 *   Dune. It is
 *   deliberately not the same budget as the unit one: a caller must not be
 *   able to reach the invoice by first proving they are under the aggregate
 *   limit, and cheap local calls must not consume the headroom that guards
 *   paid providers.
 *
 * Every binding is optional. An unbound limiter is skipped, and a limiter that
 * throws is treated as a pass: a limiter outage degrades abuse protection,
 * which is recoverable, rather than the endpoint, which is not.
 *
 * The counters Cloudflare keeps for these bindings are per-colo rather than
 * globally consistent. That is the right trade here — a single caller's
 * requests land in a single colo, so a per-caller limit is accurate where it
 * matters, and the distributed case is the edge rule's job, not this file's.
 */

export interface RateLimitBindings {
  RATE_LIMITER?: RateLimit;
  RATE_LIMITER_BURST?: RateLimit;
  RATE_LIMITER_TOOLS?: RateLimit;
  RATE_LIMITER_METERED?: RateLimit;
}

/** Matches `simple.period` on the `RATE_LIMITER_BURST` binding. */
export const BURST_WINDOW_SECONDS = 10;
/** Matches `simple.period` on every other binding. */
export const SUSTAINED_WINDOW_SECONDS = 60;

/**
 * The most one request may ask for. Units are spent by calling `limit()` once
 * per unit — the binding takes no weight argument — so without a ceiling a
 * long batch of expensive calls would fan one request out into hundreds of
 * binding calls.
 *
 * The ceiling is a refusal rather than a clamp. Clamping would mean a batch
 * that costs 160 units is charged 40 and served, which is exactly the hole a
 * cost model is meant to close; refusing means an over-large ask is split into
 * requests that are each priced honestly. It sits above the most expensive
 * single tool, so no individual call can ever be refused by it — a test pins
 * that against the live catalog.
 */
export const MAX_UNITS_PER_REQUEST = 40;

/**
 * The largest MCP request body we will parse. A maximally populated
 * prepare_transfers call needs about 1.3 MiB even before optional ERC-1155
 * callback data, so this accommodates all 4,096 ordinary transfer entries
 * while retaining a hard parsing bound.
 */
export const MAX_MCP_BODY_BYTES = 2 * 1024 * 1024;

/**
 * JSON-RPC batching was removed in protocol revision 2025-06-18, but older
 * clients still send arrays. Accept small ones and reject the rest rather than
 * letting one request carry an arbitrary number of billable tool calls.
 */
export const MAX_BATCH_LENGTH = 20;

/**
 * Tools that spend metered third-party credit on every call. These are the
 * calls that show up on an invoice, so they draw from `RATE_LIMITER_METERED`
 * in addition to their unit cost.
 */
const METERED_TOOLS = new Set([
  // 0x Swap API for the comparison leg, and Across and LayerZero for any
  // cross-chain leg.
  "get_quotes_with_plans",
  // One authenticated LayerZero read per call, and it is polled in a loop
  // while a transfer is in flight.
  "get_value_transfer_status",
  // Dune, plus a refresh this Worker awaits for up to twenty seconds.
  "get_stonx_allocation_recommendation",
]);

/**
 * What one call of each tool costs against `RATE_LIMITER_TOOLS`, in units.
 *
 * The scale is anchored at 1 = one cached-ish `prod-api` read. Everything else
 * is priced relative to that by the load it actually creates: how many
 * upstream requests it fans out to, whether it writes an artifact to R2,
 * whether it pays a third party, and how long it can hold a Worker invocation
 * open. Tools absent from this table are priced by `defaultToolCost`, which is
 * never free — a tool added later without a deliberate entry here should be
 * over-charged, not under-charged.
 */
const TOOL_COST: Record<string, number> = {
  // Pure local derivation. No network, no storage; the request-level budgets
  // already bound how often it can be called at all.
  derive_pool_id: 0,
  decode_pool_config: 0,
  get_aave_v3_markets: 0,
  get_morpho_vaults: 0,
  get_sky_savings_deployment: 0,
  get_lido_deployment: 0,
  get_merkl_deployment: 0,

  // One upstream read.
  get_token: 1,
  get_pool: 1,
  get_pool_liquidity: 1,
  list_pool_keys: 1,
  list_tokens: 1,
  get_positions_by_owner: 1,
  get_rewards_claims_by_owner: 1,

  // Reads that fan out across several upstream calls, join metadata and USD
  // prices, or walk a whole chain's catalog. These are the scraping surface.
  get_tokens: 4,
  export_tokens: 4,
  get_position: 3,
  get_position_pool_candidates: 3,
  get_ve33_allocations: 3,
  get_liquidity_opportunities: 4,

  // Metered third parties. Priced so that a caller who does nothing else still
  // runs out of units at a rate a person driving an agent will not reach.
  get_quotes_with_plans: 10,
  get_stonx_allocation_recommendation: 20,
  // Polled repeatedly by design, so it is priced to stay affordable across a
  // transfer's lifetime while still drawing on the metered budget.
  get_value_transfer_status: 2,

  // Preparations that fan out over every position, vote, or fee balance an
  // owner holds before they can produce a plan.
  prepare_ve33_reinvest: 8,
  prepare_ve33_claim_all_fees: 6,
  prepare_ve33_reallocation: 6,
};

/**
 * A tool with no table entry. Preparations write an artifact body to R2 and
 * usually read chain and index state first, so they are charged as if they
 * did; anything else is charged as a small fan-out read.
 */
function defaultToolCost(name: string): number {
  return name.startsWith("prepare_") ? 3 : 2;
}

export function toolCost(name: string): number {
  const configured = TOOL_COST[name];
  return configured === undefined ? defaultToolCost(name) : configured;
}

/** What one MCP request will draw from each budget if it is admitted. */
export interface RequestCharge {
  units: number;
  meteredCalls: number;
}

/**
 * Which budget rejected a request, and how long the caller should wait. The
 * scope travels in the error body so an agent reading it can tell "you are
 * asking too fast" apart from "you have used this hour's paid quotes", which
 * are different things for it to do next.
 */
export interface RateLimitRejection {
  scope: "burst" | "sustained" | "tool_units" | "metered_providers";
  retryAfterSeconds: number;
  message: string;
}

/**
 * The caller a budget is kept for.
 *
 * `cf-connecting-ip` is set by Cloudflare on the way in and cannot be spoofed
 * by the client; `x-forwarded-for` can be, and is deliberately not consulted.
 * A single IPv6 address is not an identity — the smallest allocation a
 * residential or cloud customer gets is a /64, and a scraper that limited
 * itself to one address out of eighteen quintillion would be doing us a
 * favour — so v6 callers are bucketed by prefix.
 */
export function rateLimitActor(request: Request): string {
  const address = request.headers.get("cf-connecting-ip");
  if (address === null || address.length === 0) return "anonymous";
  return address.includes(":") ? ipv6Prefix(address) : address;
}

function ipv6Prefix(address: string): string {
  const [head, tail = ""] = address.split("::");
  const headGroups = head.split(":").filter((group) => group.length > 0);
  const tailGroups = tail.split(":").filter((group) => group.length > 0);
  const groups = address.includes("::")
    ? [
        ...headGroups,
        ...Array<string>(Math.max(8 - headGroups.length - tailGroups.length, 0)).fill(
          "0",
        ),
        ...tailGroups,
      ]
    : headGroups;
  const prefix = groups
    .slice(0, 4)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":");
  return `${prefix}::/64`;
}

export type McpBodyCharge =
  | { ok: true; charge: RequestCharge; id: string | number | null }
  | { ok: false; reason: "unparseable" | "too_many_calls" | "too_expensive" };

/**
 * Read the JSON-RPC body of an MCP POST and price it.
 *
 * A body we will not serve at all — unparseable, or an over-long batch — is
 * rejected here, before the MCP handler allocates anything for it. A body that
 * parses but contains no `tools/call` prices to zero: `initialize`,
 * `tools/list`, and notifications are covered by the request-level budgets
 * alone. The id comes back so a rejection can be answered as a JSON-RPC error
 * the client will attach to the call it made, rather than as a bare HTTP
 * status it has to correlate itself.
 */
export function chargeForMcpBody(body: string): McpBodyCharge {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (messages.length > MAX_BATCH_LENGTH) {
    return { ok: false, reason: "too_many_calls" };
  }

  let units = 0;
  let meteredCalls = 0;
  for (const message of messages) {
    const name = toolCallName(message);
    if (name === null) continue;
    units += toolCost(name);
    if (METERED_TOOLS.has(name)) meteredCalls += 1;
  }
  if (units > MAX_UNITS_PER_REQUEST) {
    return { ok: false, reason: "too_expensive" };
  }
  return {
    ok: true,
    charge: { units, meteredCalls },
    // Only a lone message has an id worth echoing; a batch has several, and
    // the error that replaces it belongs to none of them in particular.
    id: messages.length === 1 ? jsonRpcId(messages[0]) : null,
  };
}

function jsonRpcId(message: unknown): string | number | null {
  if (typeof message !== "object" || message === null) return null;
  const { id } = message as { id?: unknown };
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function toolCallName(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const { method, params } = message as { method?: unknown; params?: unknown };
  if (method !== "tools/call") return null;
  if (typeof params !== "object" || params === null) return null;
  const { name } = params as { name?: unknown };
  // An unnamed tools/call will fail downstream, but it still cost us the parse
  // and the dispatch, so price it as an average tool rather than as free.
  return typeof name === "string" && name.length > 0 ? name : "";
}

/**
 * Draw one request from the two request-level budgets. Applies to every route
 * the Worker serves, not just `/mcp`: a stored-artifact fetch costs an R2 read
 * and `/tools` rebuilds the catalog, so neither is free to hammer.
 *
 * Those are also the routes where this actually bites, because every one of
 * them sends `no-store` and so always reaches the Worker. The routes that do
 * carry a `max-age` — `/`, `/openapi.json`, `/llms.txt`, `/robots.txt` — are
 * mostly absorbed by the edge cache before this code runs. Measured against
 * production: 45 requests to `/?cachebust=<n>`, every one with a distinct
 * query string, produced 6 Worker invocations. A unique query string is not
 * the cache bypass it is often assumed to be, so do not reason about this
 * budget as though it meters those routes; it meters the ones that cost
 * something, which is what it is for.
 *
 * Both budgets are drawn even when the first one rejects. They are per-request
 * counters over different windows, and a caller parked just under the burst
 * limit must still age into the minute limit rather than riding the short
 * window indefinitely.
 */
export async function enforceRequestRate(
  bindings: RateLimitBindings,
  actor: string,
): Promise<RateLimitRejection | null> {
  const [burstOk, sustainedOk] = await Promise.all([
    draw(bindings.RATE_LIMITER_BURST, `burst:${actor}`, 1),
    draw(bindings.RATE_LIMITER, `mcp:${actor}`, 1),
  ]);
  if (!burstOk) {
    return {
      scope: "burst",
      retryAfterSeconds: BURST_WINDOW_SECONDS,
      message:
        "Too many requests in a few seconds. Wait for Retry-After and resume at a steady rate.",
    };
  }
  if (!sustainedOk) {
    return {
      scope: "sustained",
      retryAfterSeconds: SUSTAINED_WINDOW_SECONDS,
      message:
        "Request quota for this minute is exhausted. Wait for Retry-After before retrying.",
    };
  }
  return null;
}

/**
 * Draw a priced tool call from the two per-tool budgets. Called only after
 * `enforceRequestRate` has admitted the request, so a caller who is already
 * being throttled does not also burn their paid-provider headroom.
 */
export async function enforceToolRate(
  bindings: RateLimitBindings,
  actor: string,
  charge: RequestCharge,
): Promise<RateLimitRejection | null> {
  if (charge.units === 0 && charge.meteredCalls === 0) return null;

  const [meteredOk, unitsOk] = await Promise.all([
    draw(
      bindings.RATE_LIMITER_METERED,
      `metered:${actor}`,
      charge.meteredCalls,
    ),
    draw(bindings.RATE_LIMITER_TOOLS, `tools:${actor}`, charge.units),
  ]);
  if (!meteredOk) {
    return {
      scope: "metered_providers",
      retryAfterSeconds: SUSTAINED_WINDOW_SECONDS,
      message:
        "Quota for quote and recommendation providers is exhausted for this minute. Reuse the quote you already hold, or wait for Retry-After.",
    };
  }
  if (!unitsOk) {
    return {
      scope: "tool_units",
      retryAfterSeconds: SUSTAINED_WINDOW_SECONDS,
      message:
        "Tool budget for this minute is exhausted. Batch identifiers into one call, narrow filters instead of paging the catalog, and wait for Retry-After.",
    };
  }
  return null;
}

/**
 * Spend `units` from one budget. The binding counts one request per `limit()`
 * call and takes no weight, so weight is expressed as repeated calls against
 * the same key; they are issued together because they are one decision.
 *
 * An unbound limiter admits everything, which is what makes `wrangler dev` and
 * a preview deployment usable without provisioning namespaces. A limiter that
 * throws also admits, and says so in the log: losing the counter must not lose
 * the endpoint.
 */
async function draw(
  limiter: RateLimit | undefined,
  key: string,
  units: number,
): Promise<boolean> {
  if (limiter === undefined || units <= 0) return true;
  // Pricing already refuses anything above this, so the clamp is a backstop
  // against a future caller that draws without going through it.
  const draws = Math.min(units, MAX_UNITS_PER_REQUEST);
  try {
    const outcomes = await Promise.all(
      Array.from({ length: draws }, () => limiter.limit({ key })),
    );
    return outcomes.every((outcome) => outcome.success);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "rate_limiter_unavailable",
        key,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return true;
  }
}
