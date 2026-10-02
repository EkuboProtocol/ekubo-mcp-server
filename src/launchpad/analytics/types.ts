/**
 * Shared shapes for the launchpad analytics engine (EKU-645 interface
 * contract, sections 2 to 5 and 8 to 9). Addresses and hashes are validated
 * and lowercased at the source boundary; amounts stay `bigint` until they are
 * serialised as decimal strings.
 */

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export type Finality = "finalized" | "safe" | "latest";

export interface BlockRange {
  from_block: number;
  to_block: number;
}

export interface MissingRange extends BlockRange {
  reason: string;
}

/** Event identity. The block hash is part of it, so a reorged log is distinct. */
export interface LogRef {
  block_number: number;
  block_hash: Hex;
  transaction_hash: Hex;
  log_index: number;
}

export interface RawLog extends LogRef {
  address: Address;
  topics: Hex[];
  data: Hex;
  removed?: boolean;
}

export interface BlockHeader {
  number: number;
  hash: Hex;
  parent_hash: Hex;
  timestamp: number;
}

export interface TransactionInfo {
  hash: Hex;
  from: Address;
  to: Address | null;
}

export interface ManifestContract {
  address: Address;
  /** Runtime code hash pinned by the manifest; null when the manifest pins none. */
  code_hash: Hex | null;
}

export const REQUIRED_CONTRACTS = [
  "core",
  "scheduled_launch",
  "locked_launch_liquidity",
  "launch_router",
  "router",
] as const;

export type RequiredContract = (typeof REQUIRED_CONTRACTS)[number];

export interface LaunchpadManifest {
  chain_id: number;
  revision: string;
  /** First block that can hold launchpad logs. */
  deployment_block: number;
  contracts: Record<RequiredContract, ManifestContract>;
  /** The TWAMM extension of terminal pools; null when the manifest does not name it. */
  twamm: ManifestContract | null;
}

export interface PinnedPrice {
  asset: Address;
  decimals: number;
  /** USD per whole unit, as a decimal string. */
  price_usd: string;
  as_of: number;
  source: string;
}

/**
 * Everything one request computes from. A snapshot is immutable: the engine
 * is a pure function of it, so two snapshots with the same canonical logs give
 * byte-identical results.
 */
export interface Snapshot {
  kind: "fixture" | "rpc";
  chain_id: number;
  manifest: LaunchpadManifest;
  finality: Finality;
  as_of: BlockHeader;
  head: { number: number; timestamp: number | null };
  indexed_range: BlockRange;
  missing_ranges: MissingRange[];
  /** Canonical headers, at least one for every block that carries a log. */
  headers: BlockHeader[];
  logs: RawLog[];
  /** When the source read the chain (ISO 8601); null when a fixture does not record it. */
  retrieved_at: string | null;
  prices: PinnedPrice[];
}

export interface SnapshotRequest {
  finality: Finality;
  /** Pin the snapshot to this block (cursor continuation). */
  at_block?: { number: number; hash: Hex };
}

export interface LaunchpadSource {
  readonly kind: "fixture" | "rpc";
  readonly manifest: LaunchpadManifest;
  snapshot(request: SnapshotRequest): Promise<Snapshot>;
  block(number: number): Promise<BlockHeader | null>;
  firstBlockAtOrAfter(
    timestamp: number,
    within: BlockRange,
  ): Promise<BlockHeader | null>;
  transaction(hash: Hex): Promise<TransactionInfo | null>;
  codeHash(address: Address, blockNumber: number): Promise<Hex | null>;
  /** ERC-20 decimals, 18 for the native asset, null when unreadable. */
  tokenDecimals(address: Address, blockNumber: number): Promise<number | null>;
}

/** Every chain the configured launchpad covers, keyed by chain id. */
export type LaunchpadSources = ReadonlyMap<number, LaunchpadSource>;
