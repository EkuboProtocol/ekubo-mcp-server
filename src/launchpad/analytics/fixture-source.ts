import { ServiceError } from "../../core.js";
import { staleCursor } from "./cursor.js";
import type {
  Address,
  BlockHeader,
  BlockRange,
  Finality,
  Hex,
  LaunchpadManifest,
  LaunchpadSource,
  MissingRange,
  PinnedPrice,
  RawLog,
  Snapshot,
  SnapshotRequest,
  TransactionInfo,
} from "./types.js";
import { address, data, hash, manifest as parseManifest, quantity, rejected } from "./validate.js";

/**
 * A pinned chain capture in `eth_getLogs` shape (the EKU-662 v2 benchmark
 * format). It may cover several chains. Logs can include orphaned-branch
 * entries, repeats and any order, as a node might deliver them; `reorgs`
 * names the canonical hash wherever two headers share a height.
 */
export interface FixtureBundle {
  bundle?: string;
  retrieved_at?: string;
  manifest: { revision: string; contracts: Record<string, Record<string, unknown>> };
  index: Record<string, { indexed_range: BlockRange; missing_ranges?: MissingRange[]; head_block: number }>;
  as_of: Record<string, { block_number: number; block_hash: string; block_timestamp: number; finality: Finality }>;
  reorgs?: { chain_id: string | number; number: number; canonical_hash: string; reorged_hashes: string[] }[];
  pinned_prices?: { asset: string; decimals: number; price_usd: string; as_of: number; source: string; symbol?: string }[];
  blocks: { chain_id: string | number; number: number; hash: string; parent_hash: string; timestamp: number }[];
  logs: {
    chain_id: string | number;
    block_number: number;
    block_hash: string;
    transaction_hash: string;
    transaction_index?: number;
    log_index: number;
    address: string;
    topics: string[];
    data: string;
    removed?: boolean;
  }[];
  transactions?: { hash: string; from: string; to: string | null; block_number?: number }[];
  /** Observed runtime code hashes by chain and address. */
  code_hashes?: Record<string, Record<string, string>>;
  /** ERC-20 decimals by chain and address, for quote assets without a pinned price. */
  token_decimals?: Record<string, Record<string, number>>;
}

const NATIVE = new Set(["0x0000000000000000000000000000000000000000", "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"]);

const FINALITIES = new Set<Finality>(["finalized", "safe", "latest"]);

function finality(value: unknown, where: string): Finality {
  if (!FINALITIES.has(value as Finality)) throw rejected(where, "finalized, safe or latest");
  return value as Finality;
}

function header(raw: FixtureBundle["blocks"][number], where: string): BlockHeader {
  return {
    number: quantity(raw.number, `${where}.number`),
    hash: hash(raw.hash, `${where}.hash`),
    parent_hash: hash(raw.parent_hash, `${where}.parent_hash`),
    timestamp: quantity(raw.timestamp, `${where}.timestamp`),
  };
}

function log(raw: FixtureBundle["logs"][number], where: string): RawLog {
  if (!Array.isArray(raw.topics) || raw.topics.length > 4) throw rejected(`${where}.topics`, "a list of at most four topics");
  return {
    address: address(raw.address, `${where}.address`),
    topics: raw.topics.map((t, i) => hash(t, `${where}.topics[${i}]`)),
    data: data(raw.data, `${where}.data`),
    block_number: quantity(raw.block_number, `${where}.block_number`),
    block_hash: hash(raw.block_hash, `${where}.block_hash`),
    transaction_hash: hash(raw.transaction_hash, `${where}.transaction_hash`),
    log_index: quantity(raw.log_index, `${where}.log_index`),
    removed: raw.removed === true,
  };
}

function price(raw: NonNullable<FixtureBundle["pinned_prices"]>[number], where: string): PinnedPrice {
  if (typeof raw.price_usd !== "string" || !/^\d+(?:\.\d+)?$/.test(raw.price_usd)) throw rejected(`${where}.price_usd`, "a decimal string");
  if (typeof raw.source !== "string" || raw.source === "") throw rejected(`${where}.source`, "a source name");
  return {
    asset: address(raw.asset, `${where}.asset`),
    decimals: quantity(raw.decimals, `${where}.decimals`),
    price_usd: raw.price_usd,
    as_of: quantity(raw.as_of, `${where}.as_of`),
    source: raw.source,
  };
}

interface ChainCapture {
  manifest: LaunchpadManifest;
  headers: Map<number, BlockHeader>;
  ambiguous: number[];
  logs: RawLog[];
  transactions: Map<Hex, TransactionInfo>;
  codes: Map<string, Hex>;
  decimals: Map<string, number>;
  prices: PinnedPrice[];
  index: { indexed_range: BlockRange; missing_ranges: MissingRange[]; head_block: number };
  as_of: { number: number; hash: Hex; timestamp: number; finality: Finality };
  retrieved_at: string | null;
}

function canonicalHeaders(bundle: FixtureBundle, chain: string) {
  const byNumber = new Map<number, BlockHeader[]>();
  bundle.blocks.forEach((raw, i) => {
    if (String(raw.chain_id) !== chain) return;
    const parsed = header(raw, `blocks[${i}]`);
    byNumber.set(parsed.number, [...(byNumber.get(parsed.number) ?? []), parsed]);
  });
  const marked = new Map(
    (bundle.reorgs ?? [])
      .filter((r) => String(r.chain_id) === chain)
      .map((r, i) => [quantity(r.number, `reorgs[${i}].number`), hash(r.canonical_hash, `reorgs[${i}].canonical_hash`)]),
  );
  const headers = new Map<number, BlockHeader>();
  const ambiguous: number[] = [];
  for (const [number, candidates] of byNumber) {
    const chosen = candidates.length === 1 ? candidates[0] : candidates.find((c) => c.hash === marked.get(number));
    if (chosen === undefined) ambiguous.push(number);
    else headers.set(number, chosen);
  }
  return { headers, ambiguous: ambiguous.sort((a, b) => a - b) };
}

function perChain<T>(record: Record<string, Record<string, T>> | undefined, chain: string): Map<string, T> {
  return new Map(Object.entries(record?.[chain] ?? {}).map(([k, v]) => [address(k, `per-chain key ${k}`), v]));
}

function captureFor(bundle: FixtureBundle, chain: string): ChainCapture {
  const index = bundle.index[chain];
  const asOf = bundle.as_of[chain];
  if (index === undefined || asOf === undefined) throw rejected(`index/as_of for chain ${chain}`, "present");
  const indexed = {
    from_block: quantity(index.indexed_range?.from_block, `index.${chain}.indexed_range.from_block`),
    to_block: quantity(index.indexed_range?.to_block, `index.${chain}.indexed_range.to_block`),
  };
  const { headers, ambiguous } = canonicalHeaders(bundle, chain);
  return {
    manifest: parseManifest({ chain_id: chain, revision: bundle.manifest.revision, deployment_block: indexed.from_block, contracts: bundle.manifest.contracts[chain] ?? {} }),
    headers,
    ambiguous,
    logs: bundle.logs.flatMap((raw, i) => (String(raw.chain_id) === chain ? [log(raw, `logs[${i}]`)] : [])),
    transactions: new Map(
      (bundle.transactions ?? []).map((t, i) => {
        const parsed = { hash: hash(t.hash, `transactions[${i}].hash`), from: address(t.from, `transactions[${i}].from`), to: t.to === null ? null : address(t.to, `transactions[${i}].to`) };
        return [parsed.hash, parsed];
      }),
    ),
    codes: new Map([...perChain(bundle.code_hashes, chain)].map(([k, v]) => [k, hash(v, `code_hashes.${chain}.${k}`)])),
    decimals: perChain(bundle.token_decimals, chain),
    prices: (bundle.pinned_prices ?? []).map((p, i) => price(p, `pinned_prices[${i}]`)),
    index: {
      indexed_range: indexed,
      missing_ranges: (index.missing_ranges ?? []).map((r, i) => ({
        from_block: quantity(r.from_block, `index.${chain}.missing_ranges[${i}].from_block`),
        to_block: quantity(r.to_block, `index.${chain}.missing_ranges[${i}].to_block`),
        reason: String(r.reason),
      })),
      head_block: quantity(index.head_block, `index.${chain}.head_block`),
    },
    as_of: {
      number: quantity(asOf.block_number, `as_of.${chain}.block_number`),
      hash: hash(asOf.block_hash, `as_of.${chain}.block_hash`),
      timestamp: quantity(asOf.block_timestamp, `as_of.${chain}.block_timestamp`),
      finality: finality(asOf.finality, `as_of.${chain}.finality`),
    },
    retrieved_at: typeof bundle.retrieved_at === "string" ? bundle.retrieved_at : null,
  };
}

export class FixtureSource implements LaunchpadSource {
  readonly kind = "fixture" as const;
  readonly manifest: LaunchpadManifest;
  private readonly capture: ChainCapture;

  constructor(capture: ChainCapture) {
    this.capture = capture;
    this.manifest = capture.manifest;
  }

  private headerAt(number: number): BlockHeader | null {
    const known = this.capture.headers.get(number);
    if (known !== undefined) return known;
    const asOf = this.capture.as_of;
    if (number !== asOf.number) return null;
    return { number, hash: asOf.hash, parent_hash: `0x${"00".repeat(32)}`, timestamp: asOf.timestamp };
  }

  private target(request: SnapshotRequest): { number: number; gap: MissingRange | null } {
    const pinned = request.at_block;
    if (pinned !== undefined) {
      const canonical = this.headerAt(pinned.number)?.hash ?? null;
      if (canonical !== pinned.hash) throw staleCursor({ block_number: pinned.number, block_hash: pinned.hash, offset: 0 }, canonical);
      return { number: pinned.number, gap: null };
    }
    const { index, as_of: asOf } = this.capture;
    const wanted = Math.max(asOf.number, index.head_block);
    const indexedTo = Math.min(index.indexed_range.to_block, asOf.number);
    if (indexedTo >= wanted) return { number: wanted, gap: null };
    return {
      number: indexedTo,
      gap: { from_block: indexedTo + 1, to_block: wanted, reason: "not indexed: the snapshot ends before the chain head" },
    };
  }

  async snapshot(request: SnapshotRequest): Promise<Snapshot> {
    const { number, gap } = this.target(request);
    const asOf = this.headerAt(number);
    if (asOf === null) throw new ServiceError("source_unavailable", `The fixture has no header for block ${number}.`);
    const { index, ambiguous } = this.capture;
    const missing = [
      ...index.missing_ranges.filter((r) => r.from_block <= number),
      ...ambiguous
        .filter((n) => n <= number)
        .map((n) => ({ from_block: n, to_block: n, reason: "several headers at this height and no canonical marker" })),
    ];
    const head = this.headerAt(index.head_block);
    return {
      kind: "fixture",
      chain_id: this.manifest.chain_id,
      manifest: this.manifest,
      finality: this.capture.as_of.finality,
      as_of: asOf,
      head: { number: index.head_block, timestamp: head?.timestamp ?? null },
      indexed_range: { from_block: index.indexed_range.from_block, to_block: Math.min(number, index.indexed_range.to_block) },
      missing_ranges: gap === null ? missing : [...missing, gap],
      headers: [...this.capture.headers.values(), asOf].filter((h) => h.number <= number),
      logs: this.capture.logs.filter((l) => l.block_number <= number),
      retrieved_at: this.capture.retrieved_at,
      prices: this.capture.prices,
    };
  }

  async block(number: number): Promise<BlockHeader | null> {
    return this.headerAt(number);
  }

  async firstBlockAtOrAfter(timestamp: number, within: BlockRange): Promise<BlockHeader | null> {
    const candidates = [...this.capture.headers.values()]
      .filter((h) => h.number >= within.from_block && h.number <= within.to_block && h.timestamp >= timestamp)
      .sort((a, b) => a.number - b.number);
    return candidates[0] ?? null;
  }

  async transaction(txHash: Hex): Promise<TransactionInfo | null> {
    return this.capture.transactions.get(txHash) ?? null;
  }

  async codeHash(contract: Address): Promise<Hex | null> {
    return this.capture.codes.get(contract) ?? null;
  }

  async tokenDecimals(token: Address): Promise<number | null> {
    if (NATIVE.has(token)) return 18;
    const pinned = this.capture.prices.find((p) => p.asset === token)?.decimals;
    return this.capture.decimals.get(token) ?? pinned ?? null;
  }
}

/** One source per chain in the bundle. The whole bundle is validated up front. */
export function fixtureSources(bundle: FixtureBundle): Map<number, FixtureSource> {
  if (bundle === null || typeof bundle !== "object" || typeof bundle.index !== "object") {
    throw new ServiceError("invalid_source_data", "The fixture is not an eth_getLogs-shaped launchpad bundle.");
  }
  const sources = new Map<number, FixtureSource>();
  for (const chain of Object.keys(bundle.index)) {
    const source = new FixtureSource(captureFor(bundle, chain));
    sources.set(source.manifest.chain_id, source);
  }
  return sources;
}
