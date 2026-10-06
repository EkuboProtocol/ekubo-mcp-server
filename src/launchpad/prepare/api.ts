import { type Address, getAddress, type Hex, isAddress, numberToHex } from "viem";
import type { PrepareEnv } from "./contracts.js";
import { prepareError } from "./templates.js";

/**
 * Client for the data API's launch endpoints (EkuboProtocol/api `/launches`).
 * The api reads the production indexer's tables; nothing here scans logs.
 * Responses are checked at the boundary: a field that is missing or not in
 * the documented shape is an `api_invalid_response`, never repaired.
 */

export type Fetcher = typeof fetch;

export type LaunchStatus = "upcoming" | "live" | "ended" | "migrated";

export interface ApiLaunch {
  chain_id: string;
  pool_id: Hex;
  pool_key: { core_address: Address; token0: Address; token1: Address; fee: Hex; tick_spacing: number | null; extension: Address };
  launch_token: { address: Address; name: string; symbol: string; decimals: number; total_supply: string };
  quote_token: { address: Address; name: string | null; symbol: string | null; decimals: number | null };
  launch_token_is_token1: boolean;
  start_time: number;
  end_time: number;
  target_tick: number;
  upper_tick: number;
  tick_spacing: number;
  initial_fee: string;
  final_fee: string;
  migration_tick_lower: number;
  migration_tick_upper: number;
  deployed: string;
  reserve0: string;
  reserve1: string;
  complete: boolean;
  status: LaunchStatus | null;
  status_as_of: number | null;
  owner: Address;
  creator: Address | null;
  created_block_number: string;
  created_transaction_hash: Hex;
  created_time: number;
}

export interface ApiLaunchDetail extends ApiLaunch {
  pool_state: { sqrt_ratio: string; tick: number; liquidity: string } | null;
  latest_advance: { block_number: string; transaction_hash: Hex; time: number } | null;
  terminal: { pool_id: Hex; locked_liquidity: string } | null;
  creator_fees_claimed: { amount0: string; amount1: string };
}

export interface ApiPage<T> {
  data: T[];
  pagination: { page: number; pageSize: number; totalPages: number; totalItems: number };
}

/** The most list pages a token-address lookup reads before giving up: the api has no token filter. */
export const TOKEN_LOOKUP_MAX_PAGES = 10;
export const API_PAGE_SIZE_MAX = 200;

export function apiBase(env: PrepareEnv): string {
  const base = env.LAUNCHPAD_API_URL || env.EKUBO_API_URL;
  if (base === undefined || base === "") throw prepareError("launchpad_not_configured");
  return base.replace(/\/+$/, "");
}

const word = (id: Hex) => numberToHex(BigInt(id), { size: 32 });

function invalid(field: string): never {
  throw prepareError("api_invalid_response", { field });
}

function addressField(value: unknown, field: string): Address {
  // The api renders addresses as minimal hex; pad to 20 bytes before checksumming.
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,40}$/.test(value)) invalid(field);
  const padded = `0x${value.slice(2).padStart(40, "0")}`;
  if (!isAddress(padded, { strict: false })) invalid(field);
  return getAddress(padded);
}

function hashField(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) invalid(field);
  return word(value as Hex);
}

function decimalField(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) invalid(field);
  return value;
}

function intField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) invalid(field);
  return value;
}

function boolField(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field);
  return value;
}

function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

const STATUSES = new Set(["upcoming", "live", "ended", "migrated"]);

function parseKey(raw: unknown): ApiLaunch["pool_key"] {
  const key = (raw ?? {}) as Record<string, unknown>;
  return {
    core_address: addressField(key.core_address, "pool_key.core_address"),
    token0: addressField(key.token0, "pool_key.token0"),
    token1: addressField(key.token1, "pool_key.token1"),
    fee: hashField(key.fee, "pool_key.fee"),
    tick_spacing: nullable(key.tick_spacing, (v) => intField(v, "pool_key.tick_spacing")),
    extension: addressField(key.extension, "pool_key.extension"),
  };
}

function parseLaunchToken(raw: unknown): ApiLaunch["launch_token"] {
  const token = (raw ?? {}) as Record<string, unknown>;
  if (typeof token.name !== "string" || typeof token.symbol !== "string") invalid("launch_token");
  return {
    address: addressField(token.address, "launch_token.address"),
    name: token.name,
    symbol: token.symbol,
    decimals: intField(token.decimals, "launch_token.decimals"),
    total_supply: decimalField(token.total_supply, "launch_token.total_supply"),
  };
}

function parseQuoteToken(raw: unknown): ApiLaunch["quote_token"] {
  const quote = (raw ?? {}) as Record<string, unknown>;
  return {
    address: addressField(quote.address, "quote_token.address"),
    name: typeof quote.name === "string" ? quote.name : null,
    symbol: typeof quote.symbol === "string" ? quote.symbol : null,
    decimals: nullable(quote.decimals, (v) => intField(v, "quote_token.decimals")),
  };
}

function parseStatus(value: unknown): LaunchStatus | null {
  if (value !== null && !STATUSES.has(value as string)) invalid("status");
  return value as LaunchStatus | null;
}

export function parseLaunch(raw: unknown): ApiLaunch {
  const r = (raw ?? {}) as Record<string, any>;
  return {
    chain_id: decimalField(r.chain_id, "chain_id"),
    pool_id: hashField(r.pool_id, "pool_id"),
    pool_key: parseKey(r.pool_key),
    launch_token: parseLaunchToken(r.launch_token),
    quote_token: parseQuoteToken(r.quote_token),
    launch_token_is_token1: boolField(r.launch_token_is_token1, "launch_token_is_token1"),
    start_time: intField(r.start_time, "start_time"),
    end_time: intField(r.end_time, "end_time"),
    target_tick: intField(r.target_tick, "target_tick"),
    upper_tick: intField(r.upper_tick, "upper_tick"),
    tick_spacing: intField(r.tick_spacing, "tick_spacing"),
    initial_fee: decimalField(r.initial_fee, "initial_fee"),
    final_fee: decimalField(r.final_fee, "final_fee"),
    migration_tick_lower: intField(r.migration_tick_lower, "migration_tick_lower"),
    migration_tick_upper: intField(r.migration_tick_upper, "migration_tick_upper"),
    deployed: decimalField(r.deployed, "deployed"),
    reserve0: decimalField(r.reserve0, "reserve0"),
    reserve1: decimalField(r.reserve1, "reserve1"),
    complete: boolField(r.complete, "complete"),
    status: parseStatus(r.status),
    status_as_of: nullable(r.status_as_of, (v) => intField(v, "status_as_of")),
    owner: addressField(r.owner, "owner"),
    creator: nullable(r.creator, (v) => addressField(v, "creator")),
    created_block_number: decimalField(r.created_block_number, "created_block_number"),
    created_transaction_hash: hashField(r.created_transaction_hash, "created_transaction_hash"),
    created_time: intField(r.created_time, "created_time"),
  };
}

function parseDetail(raw: unknown): ApiLaunchDetail {
  const r = (raw ?? {}) as Record<string, any>;
  const claimed = (r.creator_fees_claimed ?? {}) as Record<string, unknown>;
  return {
    ...parseLaunch(raw),
    pool_state: nullable(r.pool_state, (v: any) => ({
      sqrt_ratio: decimalField(v?.sqrt_ratio, "pool_state.sqrt_ratio"),
      tick: intField(v?.tick, "pool_state.tick"),
      liquidity: decimalField(v?.liquidity, "pool_state.liquidity"),
    })),
    latest_advance: nullable(r.latest_advance, (v: any) => ({
      block_number: decimalField(v?.block_number, "latest_advance.block_number"),
      transaction_hash: hashField(v?.transaction_hash, "latest_advance.transaction_hash"),
      time: intField(v?.time, "latest_advance.time"),
    })),
    terminal: nullable(r.terminal, (v: any) => ({
      pool_id: hashField(v?.pool_id, "terminal.pool_id"),
      locked_liquidity: decimalField(v?.locked_liquidity, "terminal.locked_liquidity"),
    })),
    creator_fees_claimed: {
      amount0: decimalField(claimed.amount0, "creator_fees_claimed.amount0"),
      amount1: decimalField(claimed.amount1, "creator_fees_claimed.amount1"),
    },
  };
}

export class LaunchpadApi {
  readonly base: string;
  /** Requests this client made, for the per-call request counts. */
  requests = 0;

  constructor(
    env: PrepareEnv,
    private readonly fetcher: Fetcher = fetch,
  ) {
    this.base = apiBase(env);
  }

  private async get(path: string, params: Record<string, string | number | undefined> = {}): Promise<unknown | null> {
    const url = new URL(`${this.base}${path}`);
    for (const [name, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(name, String(value));
    this.requests += 1;
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), { headers: { accept: "application/json" } });
    } catch {
      throw prepareError("api_unavailable");
    }
    if (response.status === 404) return null;
    if (!response.ok) throw prepareError("api_unavailable", { status: response.status });
    try {
      return await response.json();
    } catch {
      throw prepareError("api_invalid_response", { field: "body" });
    }
  }

  async list(query: {
    chainId: number;
    status?: LaunchStatus;
    creator?: Address;
    page?: number;
    pageSize?: number;
  }): Promise<ApiPage<ApiLaunch>> {
    const body = (await this.get("/launches", {
      chainId: query.chainId,
      status: query.status,
      creator: query.creator,
      page: query.page,
      pageSize: query.pageSize,
    })) as { data?: unknown; pagination?: Record<string, unknown> } | null;
    if (body === null || !Array.isArray(body.data)) invalid("data");
    const p = body.pagination ?? {};
    return {
      data: body.data.map(parseLaunch),
      pagination: {
        page: intField(p.page, "pagination.page"),
        pageSize: intField(p.pageSize, "pagination.pageSize"),
        totalPages: intField(p.totalPages, "pagination.totalPages"),
        totalItems: intField(p.totalItems, "pagination.totalItems"),
      },
    };
  }

  async detail(chainId: number, poolId: Hex): Promise<ApiLaunchDetail | null> {
    const body = await this.get(`/launches/${chainId}/${word(poolId)}`);
    return body === null ? null : parseDetail(body);
  }

  async stats(chainId: number, poolId: Hex): Promise<Record<string, unknown> | null> {
    const body = await this.get(`/launches/${chainId}/${word(poolId)}/stats`);
    if (body === null) return null;
    if (typeof body !== "object") invalid("body");
    return body as Record<string, unknown>;
  }

  async swaps(chainId: number, poolId: Hex, cursor: string | undefined, limit: number): Promise<Record<string, unknown> | null> {
    const body = await this.get(`/launches/${chainId}/${word(poolId)}/swaps`, { cursor, limit });
    if (body === null) return null;
    if (typeof body !== "object" || !Array.isArray((body as { swaps?: unknown }).swaps)) invalid("swaps");
    return body as Record<string, unknown>;
  }

  /**
   * The pool id of a launch by its exact token address. The api has no token
   * filter, so this pages the chain's list newest first, at most
   * TOKEN_LOOKUP_MAX_PAGES pages.
   */
  async poolIdForToken(chainId: number, token: Address): Promise<Hex> {
    for (let page = 1; page <= TOKEN_LOOKUP_MAX_PAGES; page += 1) {
      const result = await this.list({ chainId, page, pageSize: API_PAGE_SIZE_MAX });
      const match = result.data.find((launch) => launch.launch_token.address === token);
      if (match !== undefined) return match.pool_id;
      if (page >= result.pagination.totalPages) break;
    }
    throw prepareError("launch_not_found", { lookup_page_limit: TOKEN_LOOKUP_MAX_PAGES, page_size: API_PAGE_SIZE_MAX });
  }
}
