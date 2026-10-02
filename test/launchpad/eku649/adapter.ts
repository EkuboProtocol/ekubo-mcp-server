/**
 * Fixture adapter for the EKU-649 benchmark bundle (launchpad-benchmark-fixtures-v1).
 *
 * The bundle describes an Auctions-style launch with token Transfer legs and
 * labels; the engine consumes ScheduledLaunch events. The adapter maps only
 * what has a chain-data counterpart and records everything it had to
 * substitute or could not map, so a mismatch is reported rather than forced.
 */
import { encodeAbiParameters, encodeEventTopics, keccak256, stringToHex, type Abi, type AbiEvent } from "viem";
import { erc20Events, scheduledLaunchEvents } from "../../../src/launchpad/analytics/abi.js";
import { FIXTURE_FORMAT, type FixtureBundle } from "../../../src/launchpad/analytics/fixture-source.js";
import type { Address, BlockHeader, Hex, LaunchpadManifest, RawLog } from "../../../src/launchpad/analytics/types.js";
import fixtures from "../../fixtures/launchpad/eku649/benchmark-fixtures-v1.json";

export const BASE = 8453;
const VALID_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface Substitution {
  raw: string;
  placeholder: Address;
  reason: string;
}

export class AddressMap {
  readonly substitutions = new Map<string, Substitution>();

  map(raw: string): Address {
    if (VALID_ADDRESS.test(raw)) return raw.toLowerCase() as Address;
    const existing = this.substitutions.get(raw);
    if (existing !== undefined) return existing.placeholder;
    const placeholder = `0x${keccak256(stringToHex(`eku649:${raw}`)).slice(26)}` as Address;
    const hexDigits = raw.slice(2);
    const reason = /^[0-9a-fA-F]*$/.test(hexDigits)
      ? `${hexDigits.length} hex digits, not 40`
      : "contains non-hex characters";
    this.substitutions.set(raw, { raw, placeholder, reason });
    return placeholder;
  }
}

function label(text: string): Address {
  return `0x${keccak256(stringToHex(`eku649-adapter:${text}`)).slice(26)}` as Address;
}

function eventLog(abi: Abi, name: string, args: Record<string, unknown>): { topics: Hex[]; data: Hex } {
  const event = abi.find((item) => item.type === "event" && item.name === name) as AbiEvent;
  const topics = encodeEventTopics({ abi: [event], eventName: name, args } as never) as Hex[];
  const body = event.inputs.filter((input) => !input.indexed);
  return { topics, data: encodeAbiParameters(body, body.map((input) => args[input.name as string]) as never) };
}

export const BASE_CHAIN = fixtures.chains["8453"];

export interface AdapterReport {
  substitutions: Substitution[];
  synthesized_headers: number;
  timestamp_mismatches: { token: string; fixture: number; synthesized: number }[];
  duplicate_log_positions: { block_number: number; log_index: number; transactions: number }[];
  transfers_before_mint: { block_number: number; tag: string }[];
  unmapped_fields: { field: string; reason: string }[];
}

export const UNMAPPED_FIELDS: AdapterReport["unmapped_fields"] = [
  { field: "tokens[].auction_config.*", reason: "Auctions-model parameters (phase, creator_fee_q32, salt, token_id_derivation, graduation_pool_initialized) have no ScheduledLaunch counterpart." },
  { field: "LaunchConfig: quoteToken, quoteAmount, startTime, endTime, ticks, fees, migration bounds", reason: "Not in the fixture. The adapter emits LaunchCreated with sentinels (native quote, start = launch timestamp, end = start + 1, zero fees and ticks); phase, release, fee and early-window outputs depending on them are not compared." },
  { field: "pools[].tvl_usd", reason: "Off-chain USD figure. The contract reports USD as null without a timestamped price source, so the C1 TVL filter cannot be applied." },
  { field: "pools[].launch_block / launch_timestamp", reason: "Used only for pool_id; for GRAD they disagree with tokens[] (31990000 vs 31800100). LaunchCreated block comes from tokens[]." },
  { field: "tokens[].visibility_priority, tokens[].metadata.image, tokens[].metadata.mutable", reason: "Token-list and off-chain metadata; ScheduledLaunch tokens have only name, symbol and decimals." },
  { field: "transfers[].tag", reason: "Answer labels, not chain data; ignored." },
  { field: "excluded_addresses.vault", reason: "No vesting or vault exists in ScheduledLaunch; the contract's exclusion list has no such category, so the address is a holder under the contract method." },
  { field: "wash_addresses", reason: "Address labels. The contract forbids labelling addresses; round-trip volume is computed from swaps, and the fixture has none." },
  { field: "reorg.expired_reference (http_status_on_fetch 404)", reason: "Execution-plan artifact references belong to the preparation tools and artifact store (EKU-659), not this engine." },
  { field: "auction_states.*", reason: "Auctions model; launch phases here come from ScheduledLaunch events." },
  { field: "chains.42161 and tokens on it", reason: "The engine serves one manifest chain; the adapter builds the Base (8453) bundle." },
  { field: "block hashes and timestamps for blocks not in blocks[]", reason: "Synthesized: hash = keccak256('eku649-adapter:8453:<n>'), timestamp = head_timestamp − (head − n) × block_time_s." },
];

const manifestFor = (core: Address): LaunchpadManifest => ({
  chain_id: BASE,
  fork_block: 31_700_000,
  git_revision: "eku649-adapter",
  contracts: {
    core: { address: core, code_hash: keccak256(stringToHex("core")) },
    twamm: { address: label("twamm"), code_hash: keccak256(stringToHex("twamm")) },
    scheduled_launch: { address: label("scheduled_launch"), code_hash: keccak256(stringToHex("scheduled_launch")) },
    locked_launch_liquidity: { address: label("locked_launch_liquidity"), code_hash: keccak256(stringToHex("lll")) },
    launch_router: { address: label("launch_router"), code_hash: keccak256(stringToHex("launch_router")) },
    router: { address: label("router"), code_hash: keccak256(stringToHex("router")) },
  },
});

interface HeaderOverrides {
  [number: number]: Hex;
}

class Headers {
  readonly synthesized = new Set<number>();
  private readonly known = new Map<number, BlockHeader>();

  constructor(overrides: HeaderOverrides) {
    for (const block of fixtures.blocks.filter((b) => b.chain_id === BASE)) {
      this.known.set(block.number, { number: block.number, hash: block.hash as Hex, parent_hash: `0x${"00".repeat(32)}`, timestamp: block.timestamp });
    }
    for (const [number, hash] of Object.entries(overrides)) {
      const header = this.get(Number(number));
      this.known.set(Number(number), { ...header, hash });
    }
  }

  timestampAt(number: number): number {
    return BASE_CHAIN.head_timestamp - (BASE_CHAIN.head_block - number) * BASE_CHAIN.block_time_s;
  }

  get(number: number): BlockHeader {
    const existing = this.known.get(number);
    if (existing !== undefined) return existing;
    const header: BlockHeader = {
      number,
      hash: keccak256(stringToHex(`eku649-adapter:8453:${number}`)),
      parent_hash: `0x${"00".repeat(32)}`,
      timestamp: this.timestampAt(number),
    };
    this.synthesized.add(number);
    this.known.set(number, header);
    return header;
  }

  all(): BlockHeader[] {
    return [...this.known.values()].sort((a, b) => a.number - b.number);
  }
}

export interface AdaptOptions {
  /** Last indexed block; defaults to the head. */
  indexed_to?: number;
  /** Replace a block hash, e.g. to replay the E12 stale branch. */
  hash_overrides?: HeaderOverrides;
}

function poolIdFor(token: string): Hex {
  const pool = fixtures.pools.find((p) => p.token.toLowerCase() === token.toLowerCase());
  return (pool?.pool_id ?? keccak256(stringToHex(`eku649-pool:${token}`))) as Hex;
}

type Push = (block: number, tx: string, logIndex: number, address: Address, encoded: { topics: Hex[]; data: Hex }) => void;

interface Context {
  addresses: AddressMap;
  headers: Headers;
  manifest: LaunchpadManifest;
  report: AdapterReport;
  transactions: NonNullable<FixtureBundle["transactions"]>;
  push: Push;
}

function sentinelConfig(token: (typeof fixtures.tokens)[number], owner: Address) {
  return {
    owner,
    quoteToken: "0x0000000000000000000000000000000000000000",
    name: token.name,
    symbol: token.symbol,
    decimals: token.decimals,
    totalSupply: BigInt(token.total_supply_base_units),
    quoteAmount: 0n,
    startTime: BigInt(token.launch_timestamp),
    endTime: BigInt(token.launch_timestamp + 1),
    targetTick: 0,
    upperTick: 0,
    tickSpacing: 0,
    initialFee: 0n,
    finalFee: 0n,
    migrationTickLower: 0,
    migrationTickUpper: 0,
  };
}

function addLaunches(ctx: Context): void {
  for (const token of fixtures.tokens.filter((t) => t.chain_id === BASE)) {
    const address = ctx.addresses.map(token.address);
    const synthesized = ctx.headers.get(token.launch_block).timestamp;
    if (synthesized !== token.launch_timestamp) {
      ctx.report.timestamp_mismatches.push({ token: token.address, fixture: token.launch_timestamp, synthesized });
    }
    const config = sentinelConfig(token, ctx.addresses.map(token.creator));
    ctx.push(token.launch_block, token.deploy_tx, 1000, ctx.manifest.contracts.scheduled_launch.address,
      eventLog(scheduledLaunchEvents as Abi, "LaunchCreated", { poolId: poolIdFor(token.address), token: address, owner: config.owner, config }));
    ctx.transactions.push({ hash: token.deploy_tx as Hex, from: config.owner, to: ctx.manifest.contracts.scheduled_launch.address });
  }
}

function addTransfers(ctx: Context): void {
  const positions = new Map<string, Set<string>>();
  const transfers = fixtures.transfers.filter((t) => t.chain_id === BASE);
  const mintBlock = new Map(transfers.filter((t) => t.tag === "mint").map((t) => [t.token, t.block_number]));
  for (const transfer of transfers) {
    const key = `${transfer.block_number}:${transfer.log_index}`;
    positions.set(key, (positions.get(key) ?? new Set()).add(transfer.tx_hash));
    if (transfer.block_number < (mintBlock.get(transfer.token) ?? 0)) {
      ctx.report.transfers_before_mint.push({ block_number: transfer.block_number, tag: transfer.tag });
    }
    ctx.push(transfer.block_number, transfer.tx_hash, transfer.log_index, ctx.addresses.map(transfer.token),
      eventLog(erc20Events as Abi, "Transfer", { from: ctx.addresses.map(transfer.from), to: ctx.addresses.map(transfer.to), value: BigInt(transfer.amount_base_units) }));
  }
  for (const [key, txs] of positions) {
    if (txs.size < 2) continue;
    const [block, index] = key.split(":").map(Number);
    ctx.report.duplicate_log_positions.push({ block_number: block, log_index: index, transactions: txs.size });
  }
}

export function adapt(options: AdaptOptions = {}): { bundle: FixtureBundle; report: AdapterReport; addresses: AddressMap } {
  const addresses = new AddressMap();
  const headers = new Headers(options.hash_overrides ?? {});
  const manifest = manifestFor(addresses.map(fixtures.pool_token));
  const logs: RawLog[] = [];
  const report: AdapterReport = {
    substitutions: [],
    synthesized_headers: 0,
    timestamp_mismatches: [],
    duplicate_log_positions: [],
    transfers_before_mint: [],
    unmapped_fields: UNMAPPED_FIELDS,
  };
  const ctx: Context = {
    addresses,
    headers,
    manifest,
    report,
    transactions: [],
    push: (block, tx, logIndex, address, encoded) => {
      logs.push({ address, ...encoded, block_number: block, block_hash: headers.get(block).hash, transaction_hash: tx as Hex, log_index: logIndex });
    },
  };
  addLaunches(ctx);
  addTransfers(ctx);
  const head = headers.get(BASE_CHAIN.head_block);
  for (const number of [fixtures.index_snapshot.snapshot_block, fixtures.reorg.reorged_block]) headers.get(number);
  report.synthesized_headers = headers.synthesized.size;
  report.substitutions = [...addresses.substitutions.values()];
  return {
    addresses,
    report,
    bundle: {
      format: FIXTURE_FORMAT,
      chain_id: BASE,
      manifest,
      retrieved_at: fixtures.pinned_at_utc,
      head_block: head.number,
      indexed_range: { from_block: 31_700_000, to_block: options.indexed_to ?? head.number },
      blocks: headers.all(),
      logs,
      transactions: ctx.transactions,
      code_hashes: {},
      token_decimals: {},
    },
  };
}

export { fixtures };
