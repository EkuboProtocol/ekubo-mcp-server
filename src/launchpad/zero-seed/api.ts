import { type Address, getAddress, type Hex } from "viem";
import { z } from "zod";
import { LaunchpadError } from "./errors.js";

// Thin adapter for the indexed launch API, response contract zero-seed-launch-api/v7 (final contract revision only).
// Only this file knows the wire shape. The API serves lowercase addresses; they leave here checksummed. Amounts,
// Q-format values and event ids stay exact decimal strings.

export const API_SCHEMA_VERSION = "zero-seed-launch-api/v7";
const API_TIMEOUT_MS = 10_000;
/** The API's offset ceiling for the launch list. */
export const MAX_LIST_OFFSET = 100_000;
const U = z.string().regex(/^(0|[1-9][0-9]*)$/);
const I = z.string().regex(/^(0|-?[1-9][0-9]*)$/);
const Addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => getAddress(value));
const Bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase() as Hex);
const Tick = z.number().int().min(-88722835).max(88722835);
const Spacing = z.number().int().min(1).max(698605);
const Seconds = z.number().int().nonnegative();
const Count = z.number().int().nonnegative();
const Version = z.literal(API_SCHEMA_VERSION);

const BlockRef = z.looseObject({ block_number: U, block_hash: Bytes32, block_time: Seconds });
const EventRef = BlockRef.extend({ event_id: I, transaction_index: Count, event_index: Count, transaction_hash: Bytes32 });
const Token = z.looseObject({ address: Addr, name: z.string().nullable(), symbol: z.string().nullable(), decimals: z.literal(18) });
const QuoteToken = z.looseObject({
  address: Addr, name: z.string().nullable(), symbol: z.string().nullable(),
  decimals: z.number().int().min(0).max(255).nullable(), kind: z.enum(["native", "erc20"]),
});
const PoolKeyWire = z.looseObject({
  core_address: Addr, token0: Addr, token1: Addr, config: Bytes32, fee: z.literal("0"), tick_spacing: Spacing, extension: Addr,
});
const Parameters = z.looseObject({
  name: Bytes32, symbol: Bytes32, supply: U, quote_token: Addr, ask_tick: I, upper_tick: I,
  trading_start: U, decay_rate_x32: U, initial_fee: U, final_fee: U, salt: Bytes32,
});
const Range = z.looseObject({
  tick_spacing: Spacing, aligned_ask_tick: Tick, aligned_upper_tick: Tick, pool_tick_lower: Tick, pool_tick_upper: Tick,
});
const Supply = z.looseObject({ requested: U, installed: U, sink: U, sink_holder: Addr });
const FeeSchedule = z.looseObject({
  trading_start: Seconds, initial_fee: U, final_fee: U, decay_rate_x32: U,
  half_life_seconds: z.string().nullable(), saturation_elapsed_seconds: U.nullable(),
  phase: z.enum(["before_trading_start", "decaying", "at_floor", "constant"]), fee_rate: U, evaluated_at: Seconds,
});
// USD with exactly 6 decimals, from the API's indexed quote price.
const Usd = z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{6}$/);
const Market = z.looseObject({
  price_tick: Tick, price_x128: U, market_cap: U, market_cap_usd: Usd.nullable(),
  raised: U, sold: U, sold_share: z.string(), trade_count: Count, volume: U, volume_usd: Usd.nullable(),
});

export const LaunchSchema = z.looseObject({
  schema_version: Version,
  chain_id: U,
  pool_id: Bytes32,
  pool_key: PoolKeyWire,
  token: Token,
  quote_token: QuoteToken,
  launch_token_is_token1: z.boolean(),
  controller: Addr,
  creator: Addr,
  owner: Addr,
  logo_url: z.string().nullable(),
  parameters: Parameters,
  range: Range,
  supply: Supply,
  trading_start: Seconds,
  status: z.enum(["upcoming", "trading"]),
  fee_schedule: FeeSchedule,
  market: Market,
  created: EventRef,
  as_of: BlockRef,
});
export type Launch = z.infer<typeof LaunchSchema>;

const LedgerSide = z.looseObject({ accrued: U, claimed: U, unclaimed: U });
export const LaunchDetailSchema = LaunchSchema.extend({
  principal: z.looseObject({ position_id: Bytes32, liquidity: U }),
  fee_ledger: z.looseObject({
    holder: Addr, launch_token: LedgerSide, quote_token: LedgerSide,
    swap_count: Count, claim_count: Count, owner_change_count: Count, last_event_id: I,
  }),
});
export type LaunchDetail = z.infer<typeof LaunchDetailSchema>;

// Raw amounts per (chain, quote token), never summed across quotes; USD only over priced quotes.
const QuoteAggregate = z.looseObject({
  chain_id: U, quote_token: Addr, launch_count: Count, trade_count: Count, volume: U, market_cap: U,
  usd_priced: z.boolean(), volume_usd: Usd.nullable(), market_cap_usd: Usd.nullable(),
});
export type QuoteAggregate = z.infer<typeof QuoteAggregate>;
const Aggregates = z.looseObject({
  launch_count: Count, trade_count: Count, by_quote: z.array(QuoteAggregate),
  usd: z.looseObject({ volume: Usd.nullable(), market_cap: Usd.nullable(), priced_launch_count: Count, excluded_launch_count: Count }),
});

const ListSchema = z.looseObject({
  schema_version: Version,
  data: z.array(LaunchSchema),
  total: Count,
  totals: z.looseObject({ all: Count, trading: Count, upcoming: Count }),
  aggregates: Aggregates,
  next_offset: z.number().int().positive().nullable(),
  evaluated_at: Seconds,
  heads: z.array(BlockRef.extend({ chain_id: U })),
});

const Swap = z.looseObject({
  event: EventRef, forwarding_locker: Addr, direction: z.enum(["buy", "sell", "zero_fill"]),
  launch_token_delta: I, quote_token_delta: I, fee_rate: U, fee_amount: U, fee_asset: z.enum(["launch_token", "quote_token"]),
});
const Claim = z.looseObject({
  event: EventRef, payout_event_id: I, owner: Addr, recipient: Addr, launch_token_amount: U, quote_token_amount: U,
});
const OwnerChange = z.looseObject({ event: EventRef, previous_owner: Addr.nullable(), new_owner: Addr });
const page = <T extends z.ZodType>(row: T) => z.looseObject({
  schema_version: Version, chain_id: U, pool_id: Bytes32, next_cursor: I.nullable(), as_of: BlockRef, data: z.array(row),
});
const PAGES = {
  swaps: page(Swap),
  claims: page(Claim).extend({ totals: z.looseObject({ launch_token: U, quote_token: U }) }),
  owners: page(OwnerChange),
};
export type HistoryKind = keyof typeof PAGES;
type HistoryPage = z.infer<(typeof PAGES)[HistoryKind]>;

export type Status = "all" | "trading" | "upcoming";
/** The API's order_by: descending over the whole filtered set, ties newest first. */
export type ListOrder = "market_cap" | "volume" | "sold_share" | "trade_count" | "created";
export interface ListQuery {
  chainId?: string;
  status: Status;
  owner?: Address;
  creator?: Address;
  orderBy: ListOrder;
  offset: number;
  limit: number;
}
export interface PageQuery {
  /** next_cursor of the previous page: the API's after_event_id. */
  cursor?: string;
  limit: number;
}

const ApiError = z.looseObject({ error: z.string() });

async function upstreamError(response: Response): Promise<LaunchpadError> {
  const status = response.status;
  const body = ApiError.safeParse(await response.json().catch(() => undefined));
  const detail = body.success ? { upstream_message: body.data.error.slice(0, 300) } : {};
  return new LaunchpadError("upstream_error", `The launch API answered HTTP ${status}. Nothing was prepared; retry the same call later.`, { retryable: status >= 500 || status === 429, upstream: "launch_api", status, ...detail });
}

const invalidResponse = (reason: string) =>
  new LaunchpadError("invalid_upstream_response", `The launch API ${reason}. Retry later; do not reuse partial data.`, { retryable: true, upstream: "launch_api" });

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
    if (!response.ok) throw await upstreamError(response);
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw invalidResponse(`returned a response that is not ${API_SCHEMA_VERSION}`);
    return parsed.data;
  }

  /** GET /launches: offset paging in order_by order, with aggregates over the whole filtered set. */
  async list(query: ListQuery) {
    const result = await this.get("launches", {
      chainId: query.chainId, status: query.status, owner: query.owner, creator: query.creator,
      order_by: query.orderBy, offset: String(query.offset), limit: String(query.limit),
    }, ListSchema);
    if (result === null) throw new LaunchpadError("upstream_error", "The launch API answered HTTP 404 for the launch list: launch support is off there. Retry later.", { retryable: true, upstream: "launch_api", status: 404 });
    // Every row must sit inside the requested filters: a row outside them is an upstream fault, never shown.
    const outside = result.data.some((row) => (query.chainId !== undefined && row.chain_id !== query.chainId) ||
      (query.status !== "all" && row.status !== query.status) || (query.owner !== undefined && row.owner !== query.owner) ||
      (query.creator !== undefined && row.creator !== query.creator));
    if (outside) throw invalidResponse("returned rows outside the requested filters");
    return result;
  }

  /** GET /launches/{chainId}/{poolId}: the launch with its principal and fee ledger. */
  async launch(chainId: string, poolId: Hex): Promise<LaunchDetail> {
    const row = await this.get(`launches/${chainId}/${poolId}`, {}, LaunchDetailSchema);
    if (row === null) {
      throw new LaunchpadError("launch_not_found", `No launch ${poolId} is indexed on chain ${chainId}. Check pool_id and chain_id (launchpad_list_launches lists them); a launch created moments ago may not be indexed yet.`, { argument: "pool_id", retryable: true });
    }
    if (row.chain_id !== chainId || row.pool_id !== poolId) throw invalidResponse("returned a different launch than requested");
    return row;
  }

  /** swaps, claims or owners of one launch, oldest first, paged by after_event_id. Claims are one row per extension event. */
  async history(chainId: string, poolId: Hex, kind: HistoryKind, page: PageQuery): Promise<HistoryPage> {
    const schema: z.ZodType<HistoryPage> = PAGES[kind];
    const result = await this.get(`launches/${chainId}/${poolId}/${kind}`, { after_event_id: page.cursor, limit: String(page.limit) }, schema);
    if (result === null) {
      throw new LaunchpadError("launch_not_found", `No launch ${poolId} is indexed on chain ${chainId}.`, { argument: "pool_id", retryable: true });
    }
    if (result.chain_id !== chainId || result.pool_id !== poolId) throw invalidResponse("returned a different launch than requested");
    const seen = new Set<string>();
    const data = (result.data as { event: { event_id: string } }[]).filter((row) => {
      const key = row.event.event_id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...result, data } as HistoryPage;
  }
}
