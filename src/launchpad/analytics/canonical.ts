import type { BlockHeader, Hex, LogRef, RawLog } from "./types.js";

export interface CanonicalLogSet {
  logs: RawLog[];
  /** Logs whose block hash is not the canonical hash at their height. */
  non_canonical: number;
  /** Exact repeats of an event identity, dropped. */
  duplicates: number;
  /** The same identity delivered with different contents. */
  conflicts: LogRef[];
  /** Heights that carry logs but have no header, so canonicity is unknown. */
  unverified_blocks: number[];
}

export function logKey(ref: LogRef): string {
  return `${ref.block_hash}:${ref.transaction_hash}:${ref.log_index}`;
}

export function logRef(log: LogRef): LogRef {
  return {
    block_number: log.block_number,
    block_hash: log.block_hash,
    transaction_hash: log.transaction_hash,
    log_index: log.log_index,
  };
}

function sameLog(a: RawLog, b: RawLog): boolean {
  return (
    a.address === b.address &&
    a.data === b.data &&
    a.topics.length === b.topics.length &&
    a.topics.every((topic, i) => topic === b.topics[i])
  );
}

export function compareRefs(a: LogRef, b: LogRef): number {
  return a.block_number - b.block_number || a.log_index - b.log_index;
}

type Verdict = "keep" | "non_canonical" | "unverified" | "after";

function verdict(
  log: RawLog,
  headers: ReadonlyMap<number, BlockHeader>,
  asOf: number,
): Verdict {
  if (log.removed === true) return "non_canonical";
  if (log.block_number > asOf) return "after";
  const header = headers.get(log.block_number);
  if (header === undefined) return "unverified";
  return header.hash === log.block_hash ? "keep" : "non_canonical";
}

/**
 * Reduce delivered logs to the canonical chain ending at `asOf`, deduplicated
 * by identity and sorted by position. Delivery order, repeats and orphaned
 * branches therefore cannot change a result.
 */
export function canonicalLogs(
  logs: readonly RawLog[],
  headers: readonly BlockHeader[],
  asOf: number,
): CanonicalLogSet {
  const byNumber = new Map(headers.map((header) => [header.number, header]));
  const seen = new Map<string, RawLog>();
  const result: CanonicalLogSet = {
    logs: [],
    non_canonical: 0,
    duplicates: 0,
    conflicts: [],
    unverified_blocks: [],
  };
  const unverified = new Set<number>();
  for (const log of logs) {
    const outcome = verdict(log, byNumber, asOf);
    if (outcome === "non_canonical") result.non_canonical += 1;
    if (outcome === "unverified") unverified.add(log.block_number);
    if (outcome !== "keep") continue;
    const key = logKey(log);
    const previous = seen.get(key);
    if (previous === undefined) {
      seen.set(key, log);
    } else if (sameLog(previous, log)) {
      result.duplicates += 1;
    } else {
      result.conflicts.push(logRef(log));
    }
  }
  result.logs = [...seen.values()].sort(compareRefs);
  result.unverified_blocks = [...unverified].sort((a, b) => a - b);
  return result;
}

export interface IngestResult {
  /** Height from which previously stored blocks were discarded. */
  reorged_from: number | null;
  /** Set when the parent is unknown or differs: fetch and ingest it first. */
  needs_ancestor: number | null;
}

/**
 * Incremental canonical store. Ingesting a block whose hash differs from the
 * stored one at the same height discards that height and everything above
 * it, so the state afterwards equals a clean ingestion of the surviving
 * branch. A block whose parent hash does not match the stored parent is
 * refused until the ancestor is supplied, which walks back to the common
 * ancestor one block at a time.
 */
export class CanonicalChain {
  private readonly headers = new Map<number, BlockHeader>();
  private readonly logsByBlock = new Map<number, RawLog[]>();

  ingest(header: BlockHeader, logs: readonly RawLog[]): IngestResult {
    const parent = this.headers.get(header.number - 1);
    if (parent !== undefined && parent.hash !== header.parent_hash) {
      return { reorged_from: null, needs_ancestor: header.number - 1 };
    }
    const existing = this.headers.get(header.number);
    let reorgedFrom: number | null = null;
    if (existing !== undefined && existing.hash !== header.hash) {
      this.truncateFrom(header.number);
      reorgedFrom = header.number;
    }
    this.headers.set(header.number, header);
    const kept = logs.filter((log) => log.block_hash === header.hash);
    this.logsByBlock.set(header.number, [
      ...(this.logsByBlock.get(header.number) ?? []),
      ...kept,
    ]);
    return { reorged_from: reorgedFrom, needs_ancestor: null };
  }

  hashAt(number: number): Hex | undefined {
    return this.headers.get(number)?.hash;
  }

  allHeaders(): BlockHeader[] {
    return [...this.headers.values()].sort((a, b) => a.number - b.number);
  }

  allLogs(): RawLog[] {
    return [...this.logsByBlock.values()].flat();
  }

  private truncateFrom(number: number): void {
    for (const height of [...this.headers.keys()]) {
      if (height >= number) {
        this.headers.delete(height);
        this.logsByBlock.delete(height);
      }
    }
  }
}
