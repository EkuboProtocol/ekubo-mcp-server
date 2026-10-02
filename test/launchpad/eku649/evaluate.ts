/**
 * Runs the EKU-649 scenarios C1, C4, C5, C6, E11 and E12 through the engine
 * via the fixture adapter and compares against expected-answers-v1.json.
 */
import { replayTransfers, distribution } from "../../../src/launchpad/analytics/holders.js";
import {
  launchpadGetAnalytics,
  launchpadSearch,
  type LaunchpadEnv,
} from "../../../src/launchpad/analytics/tools.js";
import { prepareEngine } from "../../../src/launchpad/analytics/engine.js";
import { FixtureSource } from "../../../src/launchpad/analytics/fixture-source.js";
import type { Address } from "../../../src/launchpad/analytics/types.js";
import expected from "../../fixtures/launchpad/eku649/expected-answers-v1.json";
import { BASE, adapt, fixtures, type AdapterReport } from "./adapter.js";

export type Status = "reproduced" | "partially_reproduced" | "not_reproduced";

export interface Comparison {
  field: string;
  expected: unknown;
  actual: unknown;
  match: boolean;
  note?: string;
  /** Echoed parameters; they do not count toward reproduction. */
  context?: boolean;
}

export interface ScenarioResult {
  id: "C1" | "C4" | "C5" | "C6" | "E11" | "E12";
  status: Status;
  comparisons: Comparison[];
  notes: string[];
}

const UNIT = 10n ** 18n;
const TOKYO = expected.C4.token.toLowerCase();

type Json = Record<string, any>;

function env(bundle: unknown): LaunchpadEnv {
  return { LAUNCHPAD_SOURCE: "fixture", LAUNCHPAD_FIXTURE: JSON.stringify(bundle) };
}

const units = (raw: string | null) => (raw === null ? null : Number(BigInt(raw.split(".")[0]) / UNIT));

function compare(field: string, expectedValue: unknown, actual: unknown, note?: string): Comparison {
  return { field, expected: expectedValue, actual, match: JSON.stringify(expectedValue) === JSON.stringify(actual), ...(note ? { note } : {}) };
}

function statusOf(all: Comparison[]): Status {
  const comparisons = all.filter((c) => c.context !== true);
  const matched = comparisons.filter((c) => c.match).length;
  if (matched === comparisons.length) return "reproduced";
  return matched === 0 ? "not_reproduced" : "partially_reproduced";
}

async function c1(): Promise<ScenarioResult> {
  const { bundle } = adapt();
  const [from, to] = expected.C1.window_blocks;
  const result = (await launchpadSearch(env(bundle), { chain_id: BASE, created_from_block: from, created_to_block: to, sort: "newest", page_size: 50 })) as Json;
  const rows = result.candidates.map((c: Json) => ({ address: c.token, launch_block: c.launch_block, launch_timestamp: c.launch_timestamp, pool_id: c.pool_id }));
  const wanted = expected.C1.rows.map((r) => ({ address: r.address.toLowerCase(), launch_block: r.launch_block, launch_timestamp: r.launch_timestamp, pool_id: r.pool_id }));
  const grad = expected.C1.excluded[0].address.toLowerCase();
  return {
    id: "C1",
    status: "reproduced",
    comparisons: [
      compare("rows (address, launch_block, launch_timestamp, pool_id), newest first", wanted, rows),
      compare("GRAD excluded", true, !rows.some((r: Json) => r.address === grad), "Excluded because tokens[] puts its launch at block 31800100, outside the window; the fixture's reason is the $1k TVL filter, which the adapter cannot apply (tvl_usd is off-chain)."),
    ],
    notes: [
      "Search ran with created_from_block/created_to_block = the expected window and sort = newest. No USD/TVL filter exists: the contract reports USD as null without a timestamped price source.",
      `as_of block ${result.as_of.block_number}; source.complete = ${result.source.complete}.`,
    ],
  };
}

async function c4(): Promise<ScenarioResult> {
  const { bundle, addresses } = adapt();
  const result = (await launchpadGetAnalytics(env(bundle), { chain_id: BASE, token: TOKYO })) as Json;
  const holders = result.holders;
  const creator = result.creator_allocation;
  // Same replayed balances, with the fixture's own exclusion set instead of the contract's.
  const engine = prepareEngine(await new FixtureSource(bundle).snapshot({ finality: "latest" }));
  const ledger = replayTransfers(engine.index.transfers.get(TOKYO as Address) ?? []);
  const fixtureExclusions = [fixtures.pool_token, fixtures.vault, fixtures.burn, fixtures.creator_T, ...fixtures.wash_addresses].map((raw) => ({
    address: addresses.map(raw),
    category: "fixture",
    amount: ledger.balances.get(addresses.map(raw)) ?? 0n,
  }));
  const asFixture = distribution(ledger.balances, fixtureExclusions, ledger.minted);
  return {
    id: "C4",
    status: "partially_reproduced",
    comparisons: [
      compare("creator_retained_units (beneficiary wallet balance)", expected.C4.creator_retained_units, units(creator.beneficiary_wallet_balance)),
      compare("creator_retained_pct_supply", expected.C4.creator_retained_pct_supply, creator.share_of_total_supply === null ? null : Number(creator.share_of_total_supply) * 100),
      compare("holder_count_excl (contract method)", expected.C4.holder_count_excl, holders.holder_count, "The contract keeps the beneficiary and every unlabelled address as holders; the fixture also excludes the creator, the vault and the two wash-flagged addresses."),
      compare("total_circulating_units (contract method)", expected.C4.total_circulating_units, units(holders.circulating), "Contract: total supply − Core (fixture pool mapped to Core) − dead address."),
      compare("holder_count_excl (fixture exclusion set)", expected.C4.holder_count_excl, asFixture.holder_count),
      compare("total_circulating_units (fixture exclusion set)", expected.C4.total_circulating_units, units(asFixture.circulating.toString())),
      compare("mean_units (fixture exclusion set)", expected.C4.mean_units, units(asFixture.mean)),
      compare("median_units (fixture exclusion set)", expected.C4.median_units, units(asFixture.median)),
      compare("top10_share (fixture exclusion set)", expected.C4.top10_share, asFixture.top_n_share["10"] === null ? null : Number(asFixture.top_n_share["10"])),
    ],
    notes: [
      `source.complete = ${result.source.complete}: ${result.limitations.filter((l: string) => l.includes("negative")).join(" ")}`,
      "The fixture-exclusion rows use the engine's own replayed balances and the pure distribution function; only the exclusion list differs from the tool's contract method.",
      "Wash-flagged addresses are not excluded or labelled by the tool: the contract forbids address labels.",
    ],
  };
}

async function c5(): Promise<ScenarioResult> {
  const { bundle } = adapt();
  const [from, to] = expected.C5.window_blocks;
  const result = (await launchpadGetAnalytics(env(bundle), { chain_id: BASE, token: TOKYO, early_window_blocks: to - from + 1 })) as Json;
  const window = result.early_acquisition.windows[0];
  return {
    id: "C5",
    status: "not_reproduced",
    comparisons: [
      { ...compare("window_blocks", expected.C5.window_blocks, [window.window.from_block, window.window.to_block]), context: true },
      compare("early_acquired_units", expected.C5.early_acquired_units, units(window.net_acquired), "The fixture's early buys are Transfers from the creator tagged early-window-buy; there are no LaunchSwapped events, which the contract uses as the only source."),
      compare("confidence", expected.C5.confidence, window.confidence, "Contract §4 makes these on-chain quantities exact; the fixture expects heuristic."),
    ],
    notes: ["start_time is a sentinel (launch timestamp) because the fixture has no launch schedule."],
  };
}

async function c6(): Promise<ScenarioResult> {
  const snapshotBlock = fixtures.index_snapshot.snapshot_block;
  const { bundle } = adapt({ indexed_to: snapshotBlock });
  const result = (await launchpadGetAnalytics(env(bundle), { chain_id: BASE, token: TOKYO })) as Json;
  const gap = result.source.missing_ranges.find((r: Json) => r.from_block === snapshotBlock + 1);
  const warning = result.limitations.find((l: string) => l.startsWith("Stale snapshot")) ?? null;
  return {
    id: "C6",
    status: "reproduced",
    comparisons: [
      compare("snapshot_block (as_of.block_number)", expected.C6.snapshot_block, result.as_of.block_number),
      compare("chain_head (source.head_block)", expected.C6.chain_head, result.source.head_block),
      compare("missing_range", expected.C6.missing_range, gap === undefined ? null : [gap.from_block, gap.to_block]),
      compare("warning names both blocks", true, warning !== null && warning.includes(`block ${snapshotBlock}`) && warning.includes(`block ${expected.C6.chain_head}`)),
      compare("confidence downgraded (source.complete false)", false, result.source.complete),
    ],
    notes: [warning ?? "no warning"],
  };
}

async function e11(): Promise<ScenarioResult> {
  const { bundle } = adapt();
  const result = (await launchpadGetAnalytics(env(bundle), { chain_id: BASE, token: TOKYO })) as Json;
  const volume = result.volume;
  return {
    id: "E11",
    status: "not_reproduced",
    comparisons: [
      compare("total_leg_volume_units", expected.E11.total_leg_volume_units, volume.user_launch, "Fixture volume is every Transfer leg in the window, including the mint and seeding transfers. Contract volume is quote-side LaunchSwapped and terminal-pool swap amounts; the fixture has no swaps, so user volume is null (incomplete) or 0."),
      compare("wash_leg_volume_units", expected.E11.wash_leg_volume_units, volume.round_trip.volume, "Round trip needs buys and sells by the same address; fixture legs are transfers between two labelled addresses."),
    ],
    notes: [
      "The fixture window [HEAD−2000, HEAD] is 4,000 seconds at 2 s blocks; the contract window is 24 hours.",
      "Six of the twelve wash legs (blocks 31998100–31998701) precede TOKYO's mint at block 31998900.",
    ],
  };
}

async function e12(): Promise<ScenarioResult> {
  const { reorged_block: block, stale_hash: stale, canonical_hash: canonical } = fixtures.reorg;
  const before = adapt({ indexed_to: block, hash_overrides: { [block]: stale as `0x${string}` } }).bundle;
  const first = (await launchpadSearch(env(before), { chain_id: BASE, page_size: 1 })) as Json;
  const after = adapt({ hash_overrides: { [block]: canonical as `0x${string}` } }).bundle;
  const error = (await launchpadSearch(env(after), { chain_id: BASE, page_size: 1, cursor: first.cursor }).then(() => null, (e) => e)) as Json | null;
  const code = error === null ? null : error.code;
  const details: Json = error?.details ?? {};
  return {
    id: "E12",
    status: "partially_reproduced",
    comparisons: [
      compare("block-hash mismatch detected", "stale_cursor", code),
      compare("reorged_block", expected.E12.reorged_block, details.block_number),
      compare("stale_hash reported", expected.E12.stale_hash, details.cursor_block_hash),
      compare("canonical_hash reported", expected.E12.canonical_hash, details.canonical_block_hash),
      compare("expired_reference_status", expected.E12.expired_reference_status, null, "Execution-plan references are the preparation tools' artifact store (EKU-659); not in this engine."),
    ],
    notes: ["A search cursor issued on the stale branch at block 32000050 is rejected once the canonical hash replaces it."],
  };
}

export async function evaluate(): Promise<{ results: ScenarioResult[]; adapter: AdapterReport }> {
  const results = [await c1(), await c4(), await c5(), await c6(), await e11(), await e12()];
  for (const result of results) result.status = statusOf(result.comparisons);
  return { results, adapter: adapt().report };
}
