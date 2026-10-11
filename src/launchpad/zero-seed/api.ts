import { type Address, encodeAbiParameters, type Hex, keccak256, numberToHex } from "viem";
import { z } from "zod";
import { type InstancePin, supportedInstances, unsigned, ZeroSeedError } from "./policy.js";
import { BlockRef, ClaimPage, LaunchDetail, LaunchList, LaunchSummary, SwapPage } from "./schema.js";

type Summary = z.infer<typeof LaunchSummary>;
type Block = z.infer<typeof BlockRef>;
type Page = { cursor?: string; limit?: number };
const chainId = z.string().regex(/^(0|[1-9][0-9]*)$/).refine((value) => BigInt(value) < 1n << 63n);
const poolId = z.string().regex(/^0x[0-9a-f]{64}$/);
const cursor = z.string().regex(/^(0|-?[1-9][0-9]*)$/).refine((value) =>
  BigInt(value) >= -(1n << 63n) && BigInt(value) < 1n << 63n,
);
const pageInput = z.strictObject({ cursor: cursor.optional(), limit: z.number().int().min(1).max(200).optional() });

function supported(row: Summary, pins: readonly InstancePin[]): boolean {
  return pins.some((pin) => pin.chainId === row.chain_id && pin.address === row.pool_key.extension &&
    pin.core === row.pool_key.core_address && pin.quote === row.quote_token.address);
}

function sameBlock(a: Block, b: Block): boolean {
  return a.block_number === b.block_number && a.block_hash === b.block_hash && a.block_time === b.block_time;
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

function validateFee(row: Summary): void {
  const fee = row.fee_schedule;
  const [start, duration, end, initial, final, time] = [fee.trading_start, fee.fee_duration, fee.fee_end,
    fee.initial_fee, fee.final_fee, fee.evaluated_at].map((value) => unsigned(BigInt(value), 64));
  if (start + duration !== end || final > initial || fee.evaluated_at !== row.as_of.block_time) {
    throw new ZeroSeedError("api_fee_identity_mismatch");
  }
  const phase = time < start ? "before_trading_start" : time < end ? "fee_decay" : "final_fee";
  const elapsed = time > start ? time - start : 0n;
  const rate = time >= end ? final : initial - ((initial - final) * elapsed) / duration;
  if (fee.phase !== phase || fee.fee_rate !== rate.toString()) throw new ZeroSeedError("api_fee_identity_mismatch");
}

function validateRow(row: Summary): void {
  validatePool(row);
  validateFee(row);
}

/** Read-only exact API contract. No RPC, log scan, symbol resolution, or stats. */
export class ZeroSeedApi {
  private readonly pins: readonly InstancePin[];
  private readonly base: URL;

  constructor(base: string, private readonly fetcher: typeof fetch, local?: {
    localHarness: boolean; instances: readonly InstancePin[];
  }) {
    this.base = new URL(base);
    this.pins = supportedInstances(local?.instances ?? [], local?.localHarness ?? false);
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

  async list(chain: string, page: Page & { creator?: string } = {}) {
    this.requireSupport(chain);
    const { creator, ...paging } = page;
    const query = this.query(paging, "before_event_id");
    if (creator !== undefined) query.creator = z.string().regex(/^0x[0-9a-fA-F]{40}$/).parse(creator);
    const result = await this.request("/launches", { ...query, chainId: chain }, LaunchList);
    const data = result.data.filter((row) => supported(row, this.pins));
    for (const row of data) {
      validateRow(row);
      if (row.chain_id !== chain || !sameBlock(row.as_of, result.as_of)) throw new ZeroSeedError("api_snapshot_mismatch");
    }
    return { ...result, data };
  }

  async detail(chain: string, id: Hex) {
    this.requireSupport(chain);
    poolId.parse(id);
    const row = await this.request(`/launches/${chain}/${id}`, {}, LaunchDetail);
    if (!supported(row, this.pins)) throw new ZeroSeedError("api_404");
    if (row.chain_id !== chain || row.pool_id !== id) throw new ZeroSeedError("api_pool_identity_mismatch");
    validateRow(row);
    return row;
  }

  async swaps(chain: string, id: Hex, page: Page = {}) {
    const detail = await this.detail(chain, id);
    const result = await this.request(`/launches/${chain}/${id}/swaps`, this.query(page, "after_event_id"), SwapPage);
    this.validateHistory(result, detail);
    return result;
  }

  async claims(chain: string, id: Hex, page: Page = {}) {
    const detail = await this.detail(chain, id);
    const result = await this.request(`/launches/${chain}/${id}/claims`, this.query(page, "after_event_id"), ClaimPage);
    this.validateHistory(result, detail);
    return result;
  }

  private validateHistory(page: { chain_id: string; pool_id: string; as_of: Block }, detail: Summary): void {
    if (page.chain_id !== detail.chain_id || page.pool_id !== detail.pool_id || !sameBlock(page.as_of, detail.as_of)) {
      throw new ZeroSeedError("api_snapshot_mismatch");
    }
  }

  private query(page: Page, cursorKey: string): Record<string, string> {
    const input = pageInput.parse(page);
    return { limit: String(input.limit ?? 50), ...(input.cursor === undefined ? {} : { [cursorKey]: input.cursor }) };
  }
}
