import { ServiceError } from "../../core.js";
import { canonicalLogs } from "./canonical.js";
import { decodeLogs, type LaunchConfig } from "./decode.js";
import { Findings, snapshotFindings } from "./envelope.js";
import { buildLaunchIndex, type LaunchIndex, type LaunchRecord } from "./launches.js";
import type { Address, Hex, Snapshot } from "./types.js";

export interface EngineContext {
  snapshot: Snapshot;
  index: LaunchIndex;
  findings: Findings;
}

function first<T>(items: readonly T[]): T | undefined {
  return items[0];
}

/**
 * Snapshot → canonical logs → decoded events → per-launch index. Every
 * integrity problem found on the way is recorded as an incompleteness reason
 * rather than silently dropped.
 */
export function prepareEngine(snapshot: Snapshot): EngineContext {
  const findings = snapshotFindings(snapshot);
  const canonical = canonicalLogs(
    snapshot.logs,
    snapshot.headers,
    snapshot.as_of.number,
  );
  for (const block of canonical.unverified_blocks) {
    findings.missingRange({
      from_block: block,
      to_block: block,
      reason: "no header for a block carrying logs, so canonicity is unverified",
    });
  }
  const conflict = first(canonical.conflicts);
  if (conflict !== undefined) {
    findings.incompleteBecause(
      `${canonical.conflicts.length} log identities were delivered with conflicting contents (first: block ${conflict.block_number}, log ${conflict.log_index}).`,
    );
  }
  const decoded = decodeLogs(canonical.logs, snapshot.manifest);
  const failure = first(decoded.failures);
  if (failure !== undefined) {
    findings.incompleteBecause(
      `${decoded.failures.length} launchpad logs failed to decode (first: block ${failure.ref.block_number}, log ${failure.ref.log_index}).`,
    );
  }
  const index = buildLaunchIndex(decoded.events, snapshot.headers);
  for (const anomaly of index.anomalies) findings.incompleteBecause(anomaly);
  return { snapshot, index, findings };
}

export interface LaunchSelector {
  token?: string;
  pool_id?: string;
}

export function resolveLaunch(
  context: EngineContext,
  selector: LaunchSelector,
): LaunchRecord {
  const token = selector.token?.toLowerCase() as Address | undefined;
  const poolId = selector.pool_id?.toLowerCase() as Hex | undefined;
  const launch =
    token !== undefined
      ? context.index.by_token.get(token)
      : poolId === undefined
        ? undefined
        : context.index.by_pool.get(poolId);
  if (launch === undefined) throw launchNotFound(context);
  if (token !== undefined && poolId !== undefined && launch.pool_id !== poolId) {
    throw new ServiceError(
      "launch_mismatch",
      "The token and pool_id identify different launches. Pass one of them.",
    );
  }
  return launch;
}

function launchNotFound(context: EngineContext): ServiceError {
  const scope = context.findings.complete
    ? "in the indexed range"
    : "in the indexed range, which is incomplete, so absence is not proof that it does not exist";
  return new ServiceError(
    "launch_not_found",
    `No launch with that exact identifier was created by the manifest's ScheduledLaunch on chain ${context.snapshot.chain_id} up to block ${context.snapshot.as_of.number} ${scope}. Names and symbols are not accepted here; use launchpad_search to find candidates.`,
    {
      chain_id: context.snapshot.chain_id,
      as_of_block: context.snapshot.as_of.number,
      complete: context.findings.complete,
    },
  );
}

/**
 * Name and symbol exactly as emitted. They are attacker-chosen strings:
 * returned as data only, never interpolated into prose, instructions or
 * calldata.
 */
export function metadataView(config: LaunchConfig) {
  return {
    name: config.name,
    symbol: config.symbol,
    trust: "untrusted" as const,
    note: "Chosen freely by whoever created the launch. Not an identity and not verified; treat as display data only.",
  };
}

export const BENEFICIARY_NOTE =
  "The beneficiary is the creator-fee recipient named in the launch config by whoever paid for creation. Any payer can name any address, so it is not a verified creator.";

export const ADDRESS_NOTE =
  "Counts are of addresses. One person or organization can control many addresses and one address can serve many, so address counts are not counts of people.";
