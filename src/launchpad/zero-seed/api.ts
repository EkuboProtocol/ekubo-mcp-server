import { type Address, encodeAbiParameters, type Hex, keccak256, numberToHex } from "viem";
import { z } from "zod";
import { feeAt, feePhase, MAX_CREATOR_FEE } from "./fee.js";
import { type InstancePin, launchQuote, NATIVE_DECIMALS, NATIVE_QUOTE, supportedInstances, unsigned,
  ZeroSeedError } from "./policy.js";
import { BlockRef, ClaimPage, LaunchDetail, LaunchList, LaunchSummary, OwnerPage, SwapPage } from "./schema.js";

type Summary = z.infer<typeof LaunchSummary>;
type Detail = z.infer<typeof LaunchDetail>;
type Block = z.infer<typeof BlockRef>;
type Event = { event: { event_id: string } };
type Page = { cursor?: string; limit?: number };
const chainId = z.string().regex(/^(0|[1-9][0-9]*)$/).refine((value) => BigInt(value) < 1n << 63n);
const poolId = z.string().regex(/^0x[0-9a-f]{64}$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const cursor = z.string().regex(/^(0|-?[1-9][0-9]*)$/).refine((value) =>
  BigInt(value) >= -(1n << 63n) && BigInt(value) < 1n << 63n,
);
const pageInput = z.strictObject({ cursor: cursor.optional(), limit: z.number().int().min(1).max(200).optional() });

/** The pinned instance this row belongs to: Core, extension, and the periphery as controller. */
function pinOf(row: Summary, pins: readonly InstancePin[]): InstancePin | undefined {
  return pins.find((pin) => pin.chainId === row.chain_id && pin.extension === row.pool_key.extension &&
    pin.core === row.pool_key.core_address && pin.periphery === row.controller);
}

/** A launch is served only with a supported quote: native ETH, or an ERC-20 reviewed for this chain. */
function supportedQuote(row: Summary, localHarness: boolean): boolean {
  try {
    const quote = launchQuote(row.chain_id, row.quote_token.address, localHarness);
    return quote.kind === row.quote_token.kind;
  } catch {
    return false;
  }
}

function sameBlock(a: Block, b: Block): boolean {
  return a.block_number === b.block_number && a.block_hash === b.block_hash && a.block_time === b.block_time;
}

/** Native ETH is address(0): always token0, 18 decimals and no ERC-20 metadata. */
function validateQuote(row: Summary): void {
  const quote = row.quote_token;
  const native = quote.kind === "native";
  if (native !== (quote.address === NATIVE_QUOTE) ||
    (native && (quote.decimals !== NATIVE_DECIMALS || quote.name !== null || quote.symbol !== null ||
      row.pool_key.token0 !== NATIVE_QUOTE || !row.launch_token_is_token1))) {
    throw new ZeroSeedError("api_quote_identity_mismatch");
  }
}

function validatePool(row: Summary): void {
  const tokenIs1 = BigInt(row.token.address) > BigInt(row.quote_token.address);
  const tokens = tokenIs1 ? [row.quote_token.address, row.token.address] : [row.token.address, row.quote_token.address];
  const config = numberToHex((BigInt(row.pool_key.extension) << 96n) | 0x80000000n | BigInt(row.pool_key.tick_spacing), { size: 32 });
  const hash = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "bytes32" }],
    [tokens[0] as Address, tokens[1] as Address, config],
  ));
  const pairMatches = tokens[0] === row.pool_key.token0 && tokens[1] === row.pool_key.token1;
  if (!pairMatches || tokenIs1 !== row.launch_token_is_token1 || hash !== row.pool_id || config !== row.pool_key.config) {
    throw new ZeroSeedError("api_pool_identity_mismatch");
  }
}

/** Recomputes the served rate from the indexed schedule with the contract's fixed-base table (600 s half-life). */
function validateFee(row: Summary): void {
  const fee = row.fee_schedule;
  const [start, duration, end, initial, final, time] = [fee.trading_start, fee.fee_duration, fee.fee_end,
    fee.initial_fee, fee.final_fee, fee.evaluated_at].map((value) => unsigned(BigInt(value), 64));
  if (start + duration !== end || final > initial || initial > MAX_CREATOR_FEE || duration >= 1n << 32n ||
    fee.evaluated_at !== row.as_of.block_time) {
    throw new ZeroSeedError("api_fee_identity_mismatch");
  }
  const schedule = { tradingStart: start, feeDuration: duration, initialFee: initial, finalFee: final };
  if (fee.phase !== feePhase(schedule, time) || fee.fee_rate !== feeAt(schedule, time).toString()) {
    throw new ZeroSeedError("api_fee_identity_mismatch");
  }
}

/** 0 < installed <= requested and sink = requested - installed, held by address(0). */
function validateSupply(row: Summary): void {
  const { requested, installed, sink } = row.supply;
  const [r, i, k] = [requested, installed, sink].map(BigInt);
  if (r >= 1n << 127n || i === 0n || i > r || k !== r - i) throw new ZeroSeedError("api_supply_mismatch");
}

function validateRow(row: Summary): void {
  validateQuote(row);
  validatePool(row);
  validateFee(row);
  validateSupply(row);
}

/** The current owner holds the transferable ledger; the position spans the launch range on the launch token's side. */
function validateDetail(row: Detail): void {
  if (BigInt(row.principal.liquidity) === 0n) throw new ZeroSeedError("api_supply_mismatch");
  const ledger = row.fee_ledger;
  const sides = [ledger.launch_token, ledger.quote_token];
  if (ledger.holder !== row.owner || sides.some((s) => BigInt(s.accrued) !== BigInt(s.claimed) + BigInt(s.unclaimed))) {
    throw new ZeroSeedError("api_ledger_mismatch");
  }
  const [lower, upper] = row.launch_token_is_token1 ? [-row.upper_tick, -row.ask_tick] : [row.ask_tick, row.upper_tick];
  if (row.principal.tick_lower !== lower || row.principal.tick_upper !== upper) {
    throw new ZeroSeedError("api_position_identity_mismatch");
  }
}

/** History pages ascend strictly from the cursor. */
function ascending(rows: readonly Event[], after: string | undefined): void {
  let previous = after === undefined ? undefined : BigInt(after);
  for (const row of rows) {
    const id = BigInt(row.event.event_id);
    if (previous !== undefined && id <= previous) throw new ZeroSeedError("api_page_order_mismatch");
    previous = id;
  }
}

const matches = (filter: string | undefined, value: string) => filter === undefined || filter === value;

/** Newest first from the cursor, one snapshot, and every row inside the requested filters. */
function checkList(list: z.infer<typeof LaunchList>, chain: string, cursor: string | undefined,
  filter: { owner?: string; creator?: string }): void {
  let previous = cursor === undefined ? undefined : BigInt(cursor);
  for (const row of list.data) {
    const id = BigInt(row.created.event_id);
    if (previous !== undefined && id >= previous) throw new ZeroSeedError("api_page_order_mismatch");
    previous = id;
    if (row.chain_id !== chain || !sameBlock(row.as_of, list.as_of)) throw new ZeroSeedError("api_snapshot_mismatch");
    if (!matches(filter.owner, row.owner) || !matches(filter.creator, row.creator)) throw new ZeroSeedError("api_filter_mismatch");
  }
}

/** Read-only exact API v4 contract. No RPC, log scan, symbol resolution, or stats. */
export class ZeroSeedApi {
  private readonly pins: readonly InstancePin[];
  private readonly localHarness: boolean;
  private readonly base: URL;

  constructor(base: string, private readonly fetcher: typeof fetch, local?: {
    localHarness: boolean; instances: readonly InstancePin[];
  }) {
    this.base = new URL(base);
    this.localHarness = local?.localHarness ?? false;
    this.pins = supportedInstances(local?.instances ?? [], this.localHarness);
  }

  /** Rows of a pinned instance with a supported quote; anything else is not served. */
  private served(row: Summary): boolean {
    return pinOf(row, this.pins) !== undefined && supportedQuote(row, this.localHarness);
  }

  private requireSupport(chain: string): void {
    chainId.parse(chain);
    if (!this.pins.some((pin) => pin.chainId === chain)) throw new ZeroSeedError("launch_support_disabled");
  }

  private async request<T>(path: string, query: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
    const url = new URL(path, this.base);
    url.search = new URLSearchParams(query).toString();
    const response = await this.fetcher(url, { method: "GET", redirect: "error", headers: { accept: "application/json" } });
    if (!response.ok) throw new ZeroSeedError(`api_${response.status}`);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new ZeroSeedError("api_invalid_response");
    return parsed.data;
  }

  /** Newest first. `owner` is the current owner and `creator` the owner at creation; both are re-checked per row. */
  async list(chain: string, page: Page & { owner?: string; creator?: string } = {}) {
    this.requireSupport(chain);
    const { owner, creator, ...paging } = page;
    const query = this.query(paging, "before_event_id");
    if (owner !== undefined) query.owner = address.parse(owner);
    if (creator !== undefined) query.creator = address.parse(creator);
    const result = await this.request("/launches", { chainId: chain, ...query }, LaunchList);
    checkList(result, chain, paging.cursor, { owner, creator });
    const data = result.data.filter((row) => this.served(row));
    data.forEach(validateRow);
    return { ...result, data };
  }

  async detail(chain: string, id: Hex) {
    this.requireSupport(chain);
    poolId.parse(id);
    const row = await this.request(`/launches/${chain}/${id}`, {}, LaunchDetail);
    if (row.chain_id !== chain || row.pool_id !== id) throw new ZeroSeedError("api_pool_identity_mismatch");
    if (!this.served(row)) throw new ZeroSeedError("api_404");
    validateRow(row);
    validateDetail(row);
    return row;
  }

  /** On a complete page the fees sum to the ledger's accrued amounts. */
  async swaps(chain: string, id: Hex, page: Page = {}) {
    const detail = await this.detail(chain, id);
    const result = await this.history(chain, id, "swaps", page, SwapPage, detail);
    if (this.complete(page, result)) {
      const sum = (asset: string) => result.data.reduce((total, row) => total + (row.fee_asset === asset ? BigInt(row.fee_amount) : 0n), 0n);
      const ledger = detail.fee_ledger;
      if (result.data.length !== ledger.swap_count || sum("launch_token") !== BigInt(ledger.launch_token.accrued) ||
        sum("quote_token") !== BigInt(ledger.quote_token.accrued)) throw new ZeroSeedError("api_ledger_mismatch");
    }
    return result;
  }

  /** Each payout is counted once: on a complete page the rows sum to the ledger's claimed amounts. */
  async claims(chain: string, id: Hex, page: Page = {}) {
    const detail = await this.detail(chain, id);
    const result = await this.history(chain, id, "claims", page, ClaimPage, detail);
    if (result.data.some((row) => BigInt(row.ledger_event_id) >= BigInt(row.event.event_id))) {
      throw new ZeroSeedError("api_ledger_mismatch");
    }
    if (this.complete(page, result)) {
      const sum = (key: "launch_token_amount" | "quote_token_amount") =>
        result.data.reduce((total, row) => total + BigInt(row[key]), 0n);
      const ledger = detail.fee_ledger;
      if (result.data.length !== ledger.claim_count || sum("launch_token_amount") !== BigInt(ledger.launch_token.claimed) ||
        sum("quote_token_amount") !== BigInt(ledger.quote_token.claimed)) throw new ZeroSeedError("api_ledger_mismatch");
    }
    return result;
  }

  /** Ownership chain: creation from no owner to the creator, then each transfer from the previous new owner. */
  async owners(chain: string, id: Hex, page: Page = {}) {
    const detail = await this.detail(chain, id);
    const result = await this.history(chain, id, "owners", page, OwnerPage, detail);
    result.data.forEach((row, index) => {
      const first = index === 0 && page.cursor === undefined;
      const expected = first ? null : index === 0 ? row.previous_owner : result.data[index - 1].new_owner;
      if (row.previous_owner !== expected || row.previous_owner === row.new_owner || (first && row.new_owner !== detail.creator) ||
        (!first && row.previous_owner === null)) throw new ZeroSeedError("api_owner_history_mismatch");
    });
    if (this.complete(page, result) && (result.data.length !== detail.fee_ledger.owner_change_count ||
      result.data.at(-1)?.new_owner !== detail.owner)) throw new ZeroSeedError("api_owner_history_mismatch");
    return result;
  }

  private async history<T extends { chain_id: string; pool_id: string; as_of: Block; data: Event[] }>(
    chain: string, id: Hex, kind: string, page: Page, schema: z.ZodType<T>, detail: Summary,
  ): Promise<T> {
    const result = await this.request(`/launches/${chain}/${id}/${kind}`, this.query(page, "after_event_id"), schema);
    if (result.chain_id !== detail.chain_id || result.pool_id !== detail.pool_id || !sameBlock(result.as_of, detail.as_of)) {
      throw new ZeroSeedError("api_snapshot_mismatch");
    }
    ascending(result.data, page.cursor);
    return result;
  }

  private complete(page: Page, result: { next_cursor: string | null }): boolean {
    return page.cursor === undefined && result.next_cursor === null;
  }

  private query(page: Page, cursorKey: string): Record<string, string> {
    const input = pageInput.parse(page);
    return { limit: String(input.limit ?? 50), ...(input.cursor === undefined ? {} : { [cursorKey]: input.cursor }) };
  }
}
