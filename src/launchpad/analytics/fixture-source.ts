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
  RawLog,
  Snapshot,
  SnapshotRequest,
  TransactionInfo,
} from "./types.js";
import { MANIFEST_CONTRACTS } from "./types.js";

export const FIXTURE_FORMAT = "ekubo-launchpad-fixture/1";

/**
 * A pinned chain capture. `blocks` is the canonical chain; logs may include
 * orphaned-branch entries, repeats and any order, exactly as a node might
 * deliver them, and the engine must cope.
 */
export interface FixtureBundle {
  format: typeof FIXTURE_FORMAT;
  chain_id: number;
  manifest: LaunchpadManifest;
  retrieved_at: string;
  head_block: number;
  finalized_block?: number;
  safe_block?: number;
  indexed_range: BlockRange;
  missing_ranges?: MissingRange[];
  blocks: BlockHeader[];
  logs: RawLog[];
  transactions?: TransactionInfo[];
  code_hashes?: Record<string, Hex>;
  token_decimals?: Record<string, number>;
}

const lower = <T extends string>(value: T): T => value.toLowerCase() as T;

function normalizeLog(log: RawLog): RawLog {
  return {
    ...log,
    address: lower(log.address),
    block_hash: lower(log.block_hash),
    transaction_hash: lower(log.transaction_hash),
    topics: log.topics.map(lower),
    data: lower(log.data),
  };
}

function normalizeHeader(header: BlockHeader): BlockHeader {
  return { ...header, hash: lower(header.hash), parent_hash: lower(header.parent_hash) };
}

export function normalizeManifest(manifest: LaunchpadManifest): LaunchpadManifest {
  const contracts = Object.fromEntries(
    MANIFEST_CONTRACTS.map((name) => {
      const contract = manifest.contracts[name];
      if (contract === undefined) {
        throw new ServiceError("invalid_manifest", `The launchpad manifest has no ${name} contract.`);
      }
      return [name, { address: lower(contract.address), code_hash: lower(contract.code_hash) }];
    }),
  ) as LaunchpadManifest["contracts"];
  return { ...manifest, contracts };
}

function lowerKeys<T>(record: Record<string, T> | undefined): Map<string, T> {
  return new Map(Object.entries(record ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
}

export class FixtureSource implements LaunchpadSource {
  readonly kind = "fixture" as const;
  readonly manifest: LaunchpadManifest;
  private readonly bundle: FixtureBundle;
  private readonly headers: Map<number, BlockHeader>;
  private readonly logs: RawLog[];
  private readonly transactions: Map<string, TransactionInfo>;
  private readonly codes: Map<string, Hex>;
  private readonly decimals: Map<string, number>;

  constructor(bundle: FixtureBundle) {
    if (bundle.format !== FIXTURE_FORMAT) {
      throw new ServiceError("invalid_fixture", `Unsupported fixture format; expected ${FIXTURE_FORMAT}.`);
    }
    this.bundle = bundle;
    this.manifest = normalizeManifest(bundle.manifest);
    this.headers = new Map(bundle.blocks.map((b) => [b.number, normalizeHeader(b)]));
    this.logs = bundle.logs.map(normalizeLog);
    this.transactions = new Map(
      (bundle.transactions ?? []).map((t) => [
        lower(t.hash),
        { hash: lower(t.hash), from: lower(t.from), to: t.to === null ? null : lower(t.to) },
      ]),
    );
    this.codes = lowerKeys(bundle.code_hashes);
    this.decimals = lowerKeys(bundle.token_decimals);
  }

  private header(number: number): BlockHeader {
    const header = this.headers.get(number);
    if (header === undefined) {
      throw new ServiceError("source_unavailable", `The fixture has no header for block ${number}.`);
    }
    return header;
  }

  private finalityBlock(finality: Finality): number {
    if (finality === "finalized") return this.bundle.finalized_block ?? this.bundle.head_block;
    if (finality === "safe") return this.bundle.safe_block ?? this.bundle.head_block;
    return this.bundle.head_block;
  }

  private target(request: SnapshotRequest): { number: number; gap: MissingRange | null } {
    const pinned = request.at_block;
    if (pinned !== undefined) {
      const canonical = this.headers.get(pinned.number)?.hash ?? null;
      if (canonical !== pinned.hash) throw staleCursor({ block_number: pinned.number, block_hash: pinned.hash, offset: 0 }, canonical);
      return { number: pinned.number, gap: null };
    }
    const wanted = this.finalityBlock(request.finality);
    const indexedTo = this.bundle.indexed_range.to_block;
    if (indexedTo >= wanted) return { number: wanted, gap: null };
    return {
      number: indexedTo,
      gap: { from_block: indexedTo + 1, to_block: wanted, reason: "not indexed: the snapshot ends before the requested block" },
    };
  }

  async snapshot(request: SnapshotRequest): Promise<Snapshot> {
    const { number, gap } = this.target(request);
    const missing = (this.bundle.missing_ranges ?? []).filter((r) => r.from_block <= number);
    return {
      kind: "fixture",
      chain_id: this.bundle.chain_id,
      manifest: this.manifest,
      finality: request.finality,
      as_of: this.header(number),
      head: this.header(this.bundle.head_block),
      indexed_range: {
        from_block: this.bundle.indexed_range.from_block,
        to_block: Math.min(number, this.bundle.indexed_range.to_block),
      },
      missing_ranges: gap === null ? missing : [...missing, gap],
      headers: [...this.headers.values()].filter((h) => h.number <= number),
      logs: this.logs.filter((l) => l.block_number <= number),
      retrieved_at: this.bundle.retrieved_at,
    };
  }

  async block(number: number): Promise<BlockHeader | null> {
    return this.headers.get(number) ?? null;
  }

  async firstBlockAtOrAfter(timestamp: number, within: BlockRange): Promise<BlockHeader | null> {
    const candidates = [...this.headers.values()]
      .filter((h) => h.number >= within.from_block && h.number <= within.to_block && h.timestamp >= timestamp)
      .sort((a, b) => a.number - b.number);
    return candidates[0] ?? null;
  }

  async transaction(hash: Hex): Promise<TransactionInfo | null> {
    return this.transactions.get(hash.toLowerCase()) ?? null;
  }

  async codeHash(address: Address): Promise<Hex | null> {
    return this.codes.get(address.toLowerCase()) ?? null;
  }

  async tokenDecimals(address: Address): Promise<number | null> {
    if (BigInt(address) === 0n) return 18;
    return this.decimals.get(address.toLowerCase()) ?? null;
  }
}
