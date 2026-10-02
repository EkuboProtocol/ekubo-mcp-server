import type { Address, Hex } from "viem";
import { prepareError } from "./templates.js";

/** The block every read in one preparation call is pinned to, and that the output states. */
export interface PinnedBlock {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}

export type CallResult = { ok: true; data: Hex } | { ok: false; revert: Hex };

export interface ChainLog {
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  logIndex: number;
}

/**
 * The only chain access the preparation tools have: reads at one pinned
 * block, against addresses from the manifest. There is no generic fetch.
 */
export interface PrepareChain {
  latest(): Promise<PinnedBlock>;
  call(request: { from: Address; to: Address; data: Hex; block: PinnedBlock }): Promise<CallResult>;
  logs(filter: { address: Address; topics: (Hex | null)[]; fromBlock: bigint; block: PinnedBlock }): Promise<ChainLog[]>;
}

interface RpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

const hex = (value: bigint): Hex => `0x${value.toString(16)}`;

/** JSON-RPC reads against the configured launchpad node. */
export class RpcChain implements PrepareChain {
  constructor(private readonly url: string) {}

  private async request(method: string, params: unknown[]): Promise<{ result?: unknown; error?: RpcError }> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    } catch {
      throw prepareError("rpc_unavailable");
    }
    if (!response.ok) throw prepareError("rpc_unavailable");
    return (await response.json()) as { result?: unknown; error?: RpcError };
  }

  private async result<T>(method: string, params: unknown[]): Promise<T> {
    const body = await this.request(method, params);
    if (body.error !== undefined || body.result === undefined || body.result === null) {
      throw prepareError("rpc_unavailable");
    }
    return body.result as T;
  }

  async latest(): Promise<PinnedBlock> {
    const block = await this.result<{ number: Hex; hash: Hex; timestamp: Hex }>("eth_getBlockByNumber", ["latest", false]);
    return { number: BigInt(block.number), hash: block.hash, timestamp: BigInt(block.timestamp) };
  }

  async call(request: { from: Address; to: Address; data: Hex; block: PinnedBlock }): Promise<CallResult> {
    // EIP-1898: pin by hash so a reorg between reads cannot mix two blocks.
    const body = await this.request("eth_call", [
      { from: request.from, to: request.to, data: request.data },
      { blockHash: request.block.hash },
    ]);
    if (body.error === undefined) return { ok: true, data: body.result as Hex };
    const data = revertData(body.error);
    if (data === null) throw prepareError("rpc_unavailable");
    return { ok: false, revert: data };
  }

  async logs(filter: { address: Address; topics: (Hex | null)[]; fromBlock: bigint; block: PinnedBlock }): Promise<ChainLog[]> {
    const logs = await this.result<{ topics: Hex[]; data: Hex; blockNumber: Hex; logIndex: Hex; removed?: boolean }[]>(
      "eth_getLogs",
      [{ address: filter.address, topics: filter.topics, fromBlock: hex(filter.fromBlock), toBlock: hex(filter.block.number) }],
    );
    return logs
      .filter((log) => log.removed !== true)
      .map((log) => ({
        topics: log.topics,
        data: log.data,
        blockNumber: BigInt(log.blockNumber),
        logIndex: Number(BigInt(log.logIndex)),
      }));
  }
}

/** Revert bytes from a node's execution error, or null for an infrastructure error. */
function revertData(error: RpcError): Hex | null {
  if (typeof error.data === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(error.data)) return error.data as Hex;
  if (error.code === 3 || /revert/i.test(error.message ?? "")) return "0x";
  return null;
}
