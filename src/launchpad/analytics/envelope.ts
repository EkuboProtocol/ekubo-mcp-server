import type { MissingRange, Snapshot } from "./types.js";

export const ENGINE_VERSION = "ekubo-launchpad-analytics/1.0.0";

/**
 * Limitations and completeness collected while computing one response. Any
 * reason recorded with `incomplete` turns `source.complete` false; the
 * message is also listed as a limitation so the caller can see why.
 */
export class Findings {
  readonly limitations: string[] = [];
  readonly incomplete: string[] = [];
  readonly missing: MissingRange[] = [];

  note(limitation: string): void {
    if (!this.limitations.includes(limitation)) this.limitations.push(limitation);
  }

  incompleteBecause(reason: string): void {
    if (!this.incomplete.includes(reason)) this.incomplete.push(reason);
    this.note(reason);
  }

  missingRange(range: MissingRange): void {
    this.missing.push(range);
    this.incompleteBecause(
      `Blocks ${range.from_block}–${range.to_block} are missing (${range.reason}).`,
    );
  }

  get complete(): boolean {
    return this.incomplete.length === 0;
  }
}

/** Record the snapshot's own gaps and freshness before any figure is computed. */
export function snapshotFindings(snapshot: Snapshot): Findings {
  const findings = new Findings();
  for (const range of snapshot.missing_ranges) findings.missingRange(range);
  const lag = snapshot.head.number - snapshot.as_of.number;
  const unindexed = snapshot.missing_ranges.some(
    (range) => range.to_block > snapshot.as_of.number,
  );
  if (unindexed) {
    findings.incompleteBecause(
      `Stale snapshot: figures are as of block ${snapshot.as_of.number} (${snapshot.as_of.hash}, timestamp ${snapshot.as_of.timestamp}) while the chain head is block ${snapshot.head.number}, ${lag} blocks later. Activity after block ${snapshot.as_of.number} is not included.`,
    );
  }
  if (snapshot.finality !== "finalized") {
    findings.note(
      `Computed on a ${snapshot.finality} block that is not finalized; a reorganization can change these figures.`,
    );
  }
  return findings;
}

export function envelope(snapshot: Snapshot, findings: Findings) {
  const missing = [...findings.missing];
  return {
    as_of: {
      chain_id: snapshot.chain_id,
      block_number: snapshot.as_of.number,
      block_hash: snapshot.as_of.hash,
      block_timestamp: snapshot.as_of.timestamp,
      finality: snapshot.finality,
    },
    source: {
      kind: snapshot.kind,
      indexed_range: snapshot.indexed_range,
      complete: findings.complete,
      missing_ranges: missing,
      head_block: snapshot.head.number,
      head_block_timestamp: snapshot.head.timestamp,
      lag_blocks: snapshot.head.number - snapshot.as_of.number,
      retrieved_at: snapshot.retrieved_at,
      engine_version: ENGINE_VERSION,
      manifest_revision: snapshot.manifest.git_revision,
    },
    limitations: [...findings.limitations],
  };
}
