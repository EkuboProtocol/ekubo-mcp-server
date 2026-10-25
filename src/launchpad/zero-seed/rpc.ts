import { type Address, decodeErrorResult, type Hex, hexToBigInt } from "viem";
import { extensionAbi, launchTokenAbi, peripheryAbi } from "./abi.js";
import { LaunchpadError } from "./errors.js";

const RPC_TIMEOUT_MS = 10_000;

export interface Block {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}

/** A contract revert with its decoded frozen-ABI error name when known. */
export class Reverted extends Error {
  constructor(readonly data: Hex, readonly errorName: string | null, readonly args: readonly unknown[]) {
    super(errorName ?? "execution reverted");
  }
}

function decodeRevert(data: Hex): Reverted {
  for (const abi of [extensionAbi, peripheryAbi, launchTokenAbi]) {
    try {
      const decoded = decodeErrorResult({ abi, data });
      return new Reverted(data, decoded.errorName, decoded.args ?? []);
    } catch {
      // Not an error of this ABI.
    }
  }
  return new Reverted(data, null, []);
}

function revertData(error: { data?: unknown; message?: string }): Hex | null {
  if (typeof error.data === "string" && /^0x[0-9a-fA-F]*$/.test(error.data)) return error.data as Hex;
  if (/revert/i.test(error.message ?? "")) return "0x";
  return null;
}

function result<T>(body: { result?: T; error?: { data?: unknown; message?: string } } | null): T {
  if (body === null || (body.result === undefined && body.error === undefined)) {
    throw new LaunchpadError("invalid_upstream_response", "The chain RPC returned a malformed response. Retry later.", { retryable: true, upstream: "rpc" });
  }
  if (body.error !== undefined) {
    const data = revertData(body.error);
    if (data !== null) throw decodeRevert(data);
    throw new LaunchpadError("upstream_error", "The chain RPC refused the read. Retry the same call later.", { retryable: true, upstream: "rpc" });
  }
  return body.result as T;
}

/** Minimal JSON-RPC client for the configured deployment's own RPC; reads only. */
export class LaunchRpc {
  constructor(private readonly url: string, private readonly fetcher: typeof fetch = fetch) {}

  private async request<T>(method: string, params: unknown[]): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new LaunchpadError("upstream_timeout", "The chain RPC did not respond in time. Nothing was prepared; retry the same call shortly.", { retryable: true, upstream: "rpc" });
      }
      throw new LaunchpadError("upstream_error", "The chain RPC could not be reached. Nothing was prepared; retry the same call later.", { retryable: true, upstream: "rpc" });
    }
    if (!response.ok) {
      throw new LaunchpadError("upstream_error", `The chain RPC answered HTTP ${response.status}. Nothing was prepared; retry the same call later.`, { retryable: true, upstream: "rpc", status: response.status });
    }
    return result<T>(await response.json().catch(() => null) as Parameters<typeof result<T>>[0]);
  }

  async latestBlock(): Promise<Block> {
    const block = await this.request<{ number: Hex; hash: Hex; timestamp: Hex } | null>("eth_getBlockByNumber", ["latest", false]);
    if (block === null || typeof block.hash !== "string") {
      throw new LaunchpadError("invalid_upstream_response", "The chain RPC returned no latest block. Retry later.", { retryable: true, upstream: "rpc" });
    }
    return { number: hexToBigInt(block.number), hash: block.hash, timestamp: hexToBigInt(block.timestamp) };
  }

  async chainId(): Promise<bigint> {
    return hexToBigInt(await this.request<Hex>("eth_chainId", []));
  }

  async code(address: Address): Promise<Hex> {
    return this.request<Hex>("eth_getCode", [address, "latest"]);
  }

  /** eth_call at a block (hash-pinned when given); a revert throws Reverted with the decoded frozen-ABI error. */
  async call(to: Address, data: Hex, options: { from?: Address; value?: bigint; block?: Block } = {}): Promise<Hex> {
    const tx = {
      to, data,
      ...(options.from === undefined ? {} : { from: options.from }),
      ...(options.value === undefined ? {} : { value: `0x${options.value.toString(16)}` }),
    };
    const tag = options.block === undefined ? "latest" : `0x${options.block.number.toString(16)}`;
    return this.request<Hex>("eth_call", [tx, tag]);
  }
}
