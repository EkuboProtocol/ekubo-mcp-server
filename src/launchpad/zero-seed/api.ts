import { type Address, getAddress, type Hex } from "viem";
import { z } from "zod";
import { LaunchpadError } from "./errors.js";

// Thin adapter for the indexed launch API (final contract revision). Only this file knows the wire shape; the tools
// consume the normalized objects below. Addresses arrive in any case and leave checksummed; amounts and Q-format
// values stay exact decimal strings.

const API_TIMEOUT_MS = 10_000;
const U = z.string().regex(/^(0|[1-9][0-9]*)$/);
const Addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => getAddress(value));
const Bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase() as Hex);
const Tick = z.number().int().min(-88722835).max(88722835);

const Token = z.looseObject({
  address: Addr,
  name: z.string().nullable(),
  symbol: z.string().nullable(),
  decimals: z.number().int().min(0).max(255).nullable(),
});
const Market = z.looseObject({
  price: z.string().nullable().optional(),
  market_cap: z.string().nullable().optional(),
  market_cap_usd: z.string().nullable().optional(),
  raised: z.string().nullable().optional(),
  sold_share: z.string().nullable().optional(),
  trades: z.number().int().nonnegative().nullable().optional(),
});

export const LaunchSchema = z.looseObject({
  chain_id: U,
  pool_id: Bytes32,
  token: Token,
  quote_token: Token,
  controller: Addr,
  owner: Addr,
  creator: Addr,
  logo_url: z.string().nullable(),
  parameters: z.looseObject({
    supply: U, initial_fee: U, final_fee: U, decay_rate_x32: U,
    ask_tick: Tick.optional(), upper_tick: Tick.optional(),
  }),
  tick_spacing: z.number().int().min(1).max(698605),
  ask_tick: Tick,
  upper_tick: Tick,
  trading_start: U,
  status: z.enum(["upcoming", "trading"]),
  market: Market.nullable().optional(),
});
export type Launch = z.infer<typeof LaunchSchema>;

const Totals = z.looseObject({ launches: z.number().int().nonnegative() }).nullable().optional();
const ListSchema = z.looseObject({ data: z.array(LaunchSchema), next_cursor: z.string().nullable(), totals: Totals });
const EventRow = z.looseObject({ transaction_hash: Bytes32, log_index: z.number().int().nonnegative() });
const PageSchema = z.looseObject({ data: z.array(EventRow), next_cursor: z.string().nullable() });

export type Status = "all" | "trading" | "upcoming";
export interface ListQuery {
  chainId?: string;
  status: Status;
  owner?: Address;
  sort: "newest" | "market_cap_usd";
  cursor?: string;
  limit: number;
}
export interface PageQuery {
  cursor?: string;
  limit: number;
}

function upstreamError(status: number): LaunchpadError {
  return new LaunchpadError("upstream_error", `The launch API answered HTTP ${status}. Nothing was prepared; retry the same call later.`, { retryable: status >= 500 || status === 429, upstream: "launch_api", status });
}

export class LaunchApi {
  private readonly base: URL;

  constructor(base: string, private readonly fetcher: typeof fetch = fetch) {
    this.base = new URL(base.endsWith("/") ? base : `${base}/`);
  }

  private async get<T>(path: string, query: Record<string, string | undefined>, schema: z.ZodType<T>): Promise<T | null> {
    const url = new URL(path, this.base);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await this.fetcher(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new LaunchpadError("upstream_timeout", "The launch API did not respond in time. Retry the same call shortly.", { retryable: true, upstream: "launch_api" });
      }
      throw new LaunchpadError("upstream_error", "The launch API could not be reached. Retry the same call later.", { retryable: true, upstream: "launch_api" });
    }
    if (response.status === 404) return null;
    if (!response.ok) throw upstreamError(response.status);
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      throw new LaunchpadError("invalid_upstream_response", "The launch API returned a response this server does not accept. Retry later; do not reuse partial data.", { retryable: true, upstream: "launch_api" });
    }
    return parsed.data;
  }

  async list(query: ListQuery) {
    const result = await this.get("launches", {
      chain_id: query.chainId, status: query.status === "all" ? undefined : query.status, owner: query.owner,
      sort: query.sort, cursor: query.cursor, limit: String(query.limit),
    }, ListSchema);
    if (result === null) throw upstreamError(404);
    // Every row must sit inside the requested filters: a row outside them is an upstream fault, never shown.
    const outside = result.data.some((row) => (query.chainId !== undefined && row.chain_id !== query.chainId) ||
      (query.status !== "all" && row.status !== query.status) || (query.owner !== undefined && row.owner !== query.owner));
    if (outside) {
      throw new LaunchpadError("invalid_upstream_response", "The launch API returned rows outside the requested filters. Retry later.", { retryable: true, upstream: "launch_api" });
    }
    return result;
  }

  async launch(chainId: string, poolId: Hex): Promise<Launch> {
    const row = await this.get(`launches/${chainId}/${poolId}`, {}, LaunchSchema);
    if (row === null) {
      throw new LaunchpadError("launch_not_found", `No launch ${poolId} is indexed on chain ${chainId}. Check pool_id and chain_id (launchpad_list_launches lists them); a launch created moments ago may not be indexed yet.`, { argument: "pool_id", retryable: true });
    }
    if (row.chain_id !== chainId || row.pool_id !== poolId) {
      throw new LaunchpadError("invalid_upstream_response", "The launch API returned a different launch than requested. Retry later.", { retryable: true, upstream: "launch_api" });
    }
    return row;
  }

  /** swaps, claims or owners of one launch, oldest first. Claims are deduplicated on (transaction_hash, log_index). */
  async history(chainId: string, poolId: Hex, kind: "swaps" | "claims" | "owners", page: PageQuery) {
    const result = await this.get(`launches/${chainId}/${poolId}/${kind}`, { cursor: page.cursor, limit: String(page.limit) }, PageSchema);
    if (result === null) {
      throw new LaunchpadError("launch_not_found", `No launch ${poolId} is indexed on chain ${chainId}.`, { argument: "pool_id", retryable: true });
    }
    if (kind !== "claims") return result;
    const seen = new Set<string>();
    const data = result.data.filter((row) => {
      const key = `${row.transaction_hash}:${row.log_index}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...result, data };
  }
}
