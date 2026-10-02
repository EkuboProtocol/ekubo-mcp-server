import { keccak256, toEventSelector, toHex } from "viem";
import { ServiceError } from "../../core.js";
import { TRANSFER_TOPIC, scheduledLaunchEvents } from "./abi.js";
import { staleCursor } from "./cursor.js";
import { address, data, hash, quantity } from "./validate.js";
import type {
  Address,
  BlockHeader,
  BlockRange,
  Hex,
  LaunchpadManifest,
  LaunchpadSource,
  MissingRange,
  RawLog,
  Snapshot,
  SnapshotRequest,
  TransactionInfo,
} from "./types.js";

export interface RpcSourceOptions {
  url: string;
  manifest: LaunchpadManifest;
  fetch?: typeof fetch;
  /** Blocks per `eth_getLogs` request. */
  max_block_range?: number;
  now?: () => Date;
}

interface RpcBlock {
  number: Hex;
  hash: Hex;
  parentHash: Hex;
  timestamp: Hex;
}

interface RpcLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: Hex;
  removed?: boolean;
}

interface LogFilter {
  address: Address[];
  topics?: Hex[];
}

const LAUNCH_CREATED_TOPIC = toEventSelector(scheduledLaunchEvents[0]);
const DECIMALS_SELECTOR = "0x313ce567";
const ADDRESS_CHUNK = 100;
const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const HEADER_BATCH = 100;

function header(block: RpcBlock): BlockHeader {
  return {
    number: quantity(block.number, "block.number"),
    hash: hash(block.hash, "block.hash"),
    parent_hash: hash(block.parentHash, "block.parentHash"),
    timestamp: quantity(block.timestamp, "block.timestamp"),
  };
}

function rawLog(log: RpcLog): RawLog {
  return {
    address: address(log.address, "log.address"),
    topics: log.topics.map((t) => hash(t, "log.topics")),
    data: data(log.data, "log.data"),
    block_number: quantity(log.blockNumber, "log.blockNumber"),
    block_hash: hash(log.blockHash, "log.blockHash"),
    transaction_hash: hash(log.transactionHash, "log.transactionHash"),
    log_index: quantity(log.logIndex, "log.logIndex"),
    removed: log.removed === true,
  };
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function failureCode(error: unknown): string | number {
  if (error instanceof RpcError) return error.code;
  return error instanceof ServiceError ? "malformed response" : "fetch_failed";
}

class RpcError extends Error {
  constructor(readonly code: number | string) {
    super(`JSON-RPC error ${code}`);
  }
}

/**
 * Reads the manifest's chain directly. Nothing is cached between requests:
 * each snapshot is a fresh read that the engine replays from the deployment
 * block, which is adequate for a local prototype chain and keeps reorg
 * handling trivially correct.
 */
export class RpcSource implements LaunchpadSource {
  readonly kind = "rpc" as const;
  readonly manifest: LaunchpadManifest;
  private readonly options: RpcSourceOptions;
  private id = 0;

  constructor(options: RpcSourceOptions) {
    this.options = options;
    this.manifest = options.manifest;
  }

  private async post(body: unknown): Promise<unknown> {
    const fetcher = this.options.fetch ?? fetch;
    const response = await fetcher(this.options.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new RpcError(`http_${response.status}`);
    return response.json();
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const reply = (await this.post({ jsonrpc: "2.0", id: ++this.id, method, params })) as {
      result?: T;
      error?: { code: number };
    };
    if (reply.error !== undefined) throw new RpcError(reply.error.code);
    return reply.result as T;
  }

  private async blockBy(tag: string): Promise<BlockHeader | null> {
    const block = await this.call<RpcBlock | null>("eth_getBlockByNumber", [tag, false]);
    return block === null ? null : header(block);
  }

  async block(number: number): Promise<BlockHeader | null> {
    return this.blockBy(toHex(number));
  }

  private async required(tag: string): Promise<BlockHeader> {
    const block = await this.blockBy(tag).catch(() => null);
    if (block === null) {
      throw new ServiceError("source_unavailable", `The chain RPC did not return block ${tag}.`);
    }
    return block;
  }

  private async target(request: SnapshotRequest): Promise<BlockHeader> {
    const pinned = request.at_block;
    if (pinned === undefined) return this.required(request.finality);
    const block = await this.block(pinned.number).catch(() => null);
    if (block?.hash !== pinned.hash) throw staleCursor({ block_number: pinned.number, block_hash: pinned.hash, offset: 0 }, block?.hash ?? null);
    return block;
  }

  private async logsInRange(filter: LogFilter, range: BlockRange): Promise<RpcLog[]> {
    const results: RpcLog[] = [];
    for (const addresses of chunks(filter.address, ADDRESS_CHUNK)) {
      const logs = await this.call<RpcLog[]>("eth_getLogs", [
        {
          address: addresses,
          fromBlock: toHex(range.from_block),
          toBlock: toHex(range.to_block),
          ...(filter.topics === undefined ? {} : { topics: filter.topics }),
        },
      ]);
      results.push(...logs);
    }
    return results;
  }

  private async logs(filter: LogFilter, from: number, to: number) {
    const step = this.options.max_block_range ?? 10_000;
    const logs: RawLog[] = [];
    const missing: MissingRange[] = [];
    for (let start = from; start <= to; start += step) {
      const range = { from_block: start, to_block: Math.min(to, start + step - 1) };
      try {
        logs.push(...(await this.logsInRange(filter, range)).map(rawLog));
      } catch (error) {
        missing.push({ ...range, reason: `eth_getLogs failed (${failureCode(error)})` });
      }
    }
    return { logs, missing };
  }

  private async headers(numbers: readonly number[]): Promise<Map<number, BlockHeader>> {
    const out = new Map<number, BlockHeader>();
    for (const batch of chunks(numbers, HEADER_BATCH)) {
      const replies = (await this.post(
        batch.map((n, i) => ({ jsonrpc: "2.0", id: i, method: "eth_getBlockByNumber", params: [toHex(n), false] })),
      ).catch(() => [])) as { result?: RpcBlock | null }[];
      for (const reply of Array.isArray(replies) ? replies : []) {
        const parsed = reply.result == null ? null : safeHeader(reply.result);
        if (parsed !== null) out.set(parsed.number, parsed);
      }
    }
    return out;
  }

  private async checkChain(): Promise<void> {
    const reported = await this.call<Hex>("eth_chainId", []).catch(() => null);
    if (reported === null || Number(reported) !== this.manifest.chain_id) {
      throw new ServiceError(
        "source_unavailable",
        `The configured RPC does not report chain ${this.manifest.chain_id}, the manifest's chain.`,
      );
    }
  }

  async snapshot(request: SnapshotRequest): Promise<Snapshot> {
    await this.checkChain();
    const head = await this.required("latest");
    const asOf = await this.target(request);
    const contracts = this.manifest.contracts;
    const from = this.manifest.deployment_block;
    const protocol = await this.logs(
      {
        address: [
          contracts.core.address,
          contracts.scheduled_launch.address,
          contracts.locked_launch_liquidity.address,
          contracts.launch_router.address,
        ],
      },
      from,
      asOf.number,
    );
    const tokens = launchTokens(protocol.logs, contracts.scheduled_launch.address);
    const transfers =
      tokens.length === 0
        ? { logs: [], missing: [] }
        : await this.logs({ address: tokens, topics: [TRANSFER_TOPIC] }, from, asOf.number);
    const logs = [...protocol.logs, ...transfers.logs];
    const numbers = [...new Set([...logs.map((l) => l.block_number), asOf.number])].sort((a, b) => a - b);
    const headers = await this.headers(numbers);
    headers.set(asOf.number, asOf);
    return {
      kind: "rpc",
      chain_id: this.manifest.chain_id,
      manifest: this.manifest,
      finality: request.finality,
      as_of: asOf,
      head: { number: head.number, timestamp: head.timestamp },
      indexed_range: { from_block: from, to_block: asOf.number },
      missing_ranges: [...protocol.missing, ...transfers.missing, ...reorgedDuringFetch(logs, headers)],
      headers: [...headers.values()],
      logs,
      retrieved_at: (this.options.now?.() ?? new Date()).toISOString(),
      prices: [],
    };
  }

  async firstBlockAtOrAfter(timestamp: number, within: BlockRange): Promise<BlockHeader | null> {
    let low = within.from_block;
    let high = within.to_block;
    let found: BlockHeader | null = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const block = await this.block(middle);
      if (block === null) return null;
      if (block.timestamp >= timestamp) {
        found = block;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }
    return found;
  }

  async transaction(txHash: Hex): Promise<TransactionInfo | null> {
    const tx = await this.call<{ hash: Hex; from: Hex; to: Hex | null } | null>(
      "eth_getTransactionByHash",
      [txHash],
    ).catch(() => null);
    if (tx === null) return null;
    return {
      hash: hash(tx.hash, "transaction.hash"),
      from: address(tx.from, "transaction.from"),
      to: tx.to === null ? null : address(tx.to, "transaction.to"),
    };
  }

  async codeHash(contract: Address, blockNumber: number): Promise<Hex | null> {
    const code = await this.call<Hex>("eth_getCode", [contract, toHex(blockNumber)]).catch(() => null);
    if (code === null || code === "0x") return null;
    return keccak256(code);
  }

  async tokenDecimals(token: Address, blockNumber: number): Promise<number | null> {
    if (BigInt(token) === 0n || token === NATIVE_SENTINEL) return 18;
    const result = await this.call<Hex>("eth_call", [
      { to: token, data: DECIMALS_SELECTOR },
      toHex(blockNumber),
    ]).catch(() => null);
    if (result === null || result.length !== 66) return null;
    const value = BigInt(result);
    return value <= 255n ? Number(value) : null;
  }
}

/** A malformed header is left out, so its block's logs count as unverified. */
function safeHeader(block: RpcBlock): BlockHeader | null {
  try {
    return header(block);
  } catch {
    return null;
  }
}

function launchTokens(logs: readonly RawLog[], extension: Address): Address[] {
  const tokens = new Set<Address>();
  for (const log of logs) {
    if (log.address === extension && log.topics[0] === LAUNCH_CREATED_TOPIC && log.topics[2] !== undefined) {
      tokens.add(`0x${log.topics[2].slice(26)}` as Address);
    }
  }
  return [...tokens];
}

/**
 * A log whose block hash differs from the header fetched afterwards came from
 * a branch that was replaced mid-read. The engine drops it as non-canonical;
 * the replacement block's logs were not read, so the block is missing.
 */
function reorgedDuringFetch(logs: readonly RawLog[], headers: ReadonlyMap<number, BlockHeader>): MissingRange[] {
  const blocks = new Set<number>();
  for (const log of logs) {
    const canonical = headers.get(log.block_number);
    if (canonical !== undefined && canonical.hash !== log.block_hash) blocks.add(log.block_number);
  }
  return [...blocks]
    .sort((a, b) => a - b)
    .map((n) => ({ from_block: n, to_block: n, reason: "reorganized while reading; this block's canonical logs were not read" }));
}
