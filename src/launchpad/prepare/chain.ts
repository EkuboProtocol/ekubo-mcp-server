import type { Address, Hex } from "viem";
import { prepareError } from "./templates.js";

/** The block every read in one call is pinned to, and that the output states. */
export interface PinnedBlock {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}

export type CallResult = { ok: true; data: Hex } | { ok: false; revert: Hex };

/**
 * The only chain access the launchpad tools have: point reads at one pinned
 * block, against addresses from the manifest or from a launch the api
 * returned. There are no log reads: launch history comes from the api.
 */
export interface PrepareChain {
  latest(): Promise<PinnedBlock>;
  call(request: { from: Address; to: Address; data: Hex; block: PinnedBlock }): Promise<CallResult>;
  code(address: Address, block: PinnedBlock): Promise<Hex>;
  storage(address: Address, slot: Hex, block: PinnedBlock): Promise<Hex>;
}

interface RpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

/** JSON-RPC reads against the configured launchpad node. */
export class RpcChain implements PrepareChain {
  constructor(
    private readonly url: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request(method: string, params: unknown[]): Promise<{ result?: unknown; error?: RpcError }> {
    let response: Response;
    try {
      response = await this.fetcher(this.url, {
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

  code(address: Address, block: PinnedBlock): Promise<Hex> {
    return this.result<Hex>("eth_getCode", [address, { blockHash: block.hash }]);
  }

  storage(address: Address, slot: Hex, block: PinnedBlock): Promise<Hex> {
    return this.result<Hex>("eth_getStorageAt", [address, slot, { blockHash: block.hash }]);
  }
}

/** Revert bytes from a node's execution error, or null for an infrastructure error. */
function revertData(error: RpcError): Hex | null {
  if (typeof error.data === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(error.data)) return error.data as Hex;
  if (error.code === 3 || /revert/i.test(error.message ?? "")) return "0x";
  return null;
}
