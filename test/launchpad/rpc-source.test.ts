import { describe, expect, it } from "bun:test";
import { keccak256, toHex } from "viem";
import { prepareEngine } from "../../src/launchpad/analytics/engine.js";
import { RpcSource } from "../../src/launchpad/analytics/rpc-source.js";
import type { BlockHeader, Hex, RawLog } from "../../src/launchpad/analytics/types.js";
import { C, MANIFEST, type ChainBuilder } from "./chain-builder.js";
import { E18, TOKEN, BUYER_B, standardLaunch } from "./helpers.js";

const CODE: Hex = "0x6080604052";

interface MockOptions {
  failLogsAt?: number;
  /** Serve this block's logs under a stale hash, as a node mid-reorg might. */
  staleLogsAt?: number;
}

function rpcBlock(header: BlockHeader) {
  return { number: toHex(header.number), hash: header.hash, parentHash: header.parent_hash, timestamp: toHex(header.timestamp) };
}

function rpcLog(log: RawLog, stale: boolean) {
  return {
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber: toHex(log.block_number),
    blockHash: stale ? (`0x${"ee".repeat(32)}` as Hex) : log.block_hash,
    transactionHash: log.transaction_hash,
    logIndex: toHex(log.log_index),
    removed: false,
  };
}

interface Filter {
  address: string[];
  fromBlock: Hex;
  toBlock: Hex;
  topics?: Hex[];
}

function mockNode(chain: ChainBuilder, options: MockOptions = {}) {
  const calls: string[] = [];
  const block = (tag: string) => {
    const number = tag.startsWith("0x") ? Number(tag) : chain.head.number;
    const header = chain.blocks.find((b) => b.number === number);
    return header === undefined ? null : rpcBlock(header);
  };
  const logs = (filter: Filter) => {
    const from = Number(filter.fromBlock);
    const to = Number(filter.toBlock);
    if (options.failLogsAt !== undefined && from <= options.failLogsAt && options.failLogsAt <= to) {
      return { error: { code: -32005, message: "limit exceeded" } };
    }
    const addresses = new Set(filter.address.map((a) => a.toLowerCase()));
    const result = chain.logs
      .filter((l) => addresses.has(l.address) && l.block_number >= from && l.block_number <= to)
      .filter((l) => filter.topics === undefined || l.topics[0] === filter.topics[0])
      .map((l) => rpcLog(l, l.block_number === options.staleLogsAt));
    return { result };
  };
  const methods: Record<string, (params: unknown[]) => unknown> = {
    eth_chainId: () => ({ result: toHex(chain.options.chain_id) }),
    eth_getBlockByNumber: (p) => ({ result: block(p[0] as string) }),
    eth_getLogs: (p) => logs(p[0] as Filter),
    eth_getTransactionByHash: (p) => ({ result: chain.transactions.find((t) => t.hash === p[0]) ?? null }),
    eth_getCode: () => ({ result: CODE }),
    eth_call: () => ({ result: toHex(18, { size: 32 }) }),
  };
  const answer = (request: { id: number; method: string; params: unknown[] }) => {
    calls.push(request.method);
    return { jsonrpc: "2.0", id: request.id, ...(methods[request.method]?.(request.params) as object) };
  };
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const manifest = {
  ...MANIFEST,
  contracts: { ...MANIFEST.contracts, scheduled_launch: { address: C.scheduled_launch.address, code_hash: keccak256(CODE) } },
};

function source(chain: ChainBuilder, options: MockOptions = {}, maxRange = 3) {
  const node = mockNode(chain, options);
  return {
    node,
    source: new RpcSource({ url: "http://anvil.test", manifest, fetch: node.fetcher, max_block_range: maxRange, now: () => new Date("2026-10-02T00:00:00Z") }),
  };
}

function scenario() {
  const { chain, sim, unit } = standardLaunch();
  chain.block((b) => sim.buy(b, { payer: BUYER_B, quoteIn: E18, tokenOut: 2_000n * unit, fee: 100n * unit }));
  chain.blocksUntil(112);
  return chain;
}

describe("JSON-RPC source", () => {
  it("reads logs in chunks and matches the fixture source", async () => {
    const chain = scenario();
    const { source: rpc, node } = source(chain);
    const snapshot = await rpc.snapshot({ finality: "latest" });
    expect(snapshot).toMatchObject({ kind: "rpc", indexed_range: { from_block: 100, to_block: 112 }, missing_ranges: [], retrieved_at: "2026-10-02T00:00:00.000Z" });
    expect(node.calls.filter((m) => m === "eth_getLogs").length).toBe(10);
    const fromRpc = prepareEngine(snapshot);
    const fromFixture = prepareEngine({ ...snapshot, kind: "fixture", logs: chain.logs, headers: chain.blocks });
    expect(snapshot.prices).toEqual([]);
    expect(fromRpc.findings.complete).toBe(true);
    expect([...fromRpc.index.by_token.keys()]).toEqual([TOKEN]);
    expect(fromRpc.index.transfers.get(TOKEN)?.length).toBe(fromFixture.index.transfers.get(TOKEN)?.length);
    expect(await rpc.codeHash(C.scheduled_launch.address, 112)).toBe(manifest.contracts.scheduled_launch.code_hash);
    expect(await rpc.tokenDecimals(C.core.address, 112)).toBe(18);
  });

  it("records a failed range as missing instead of returning zero logs", async () => {
    const chain = scenario();
    const { source: rpc } = source(chain, { failLogsAt: 106 });
    const snapshot = await rpc.snapshot({ finality: "latest" });
    expect(snapshot.missing_ranges).toContainEqual({ from_block: 106, to_block: 108, reason: "eth_getLogs failed (-32005)" });
    const engine = prepareEngine(snapshot);
    expect(engine.findings.complete).toBe(false);
  });

  it("marks a block reorganized while reading as missing", async () => {
    const chain = scenario();
    const { source: rpc } = source(chain, { staleLogsAt: 107 });
    const snapshot = await rpc.snapshot({ finality: "latest" });
    expect(snapshot.missing_ranges).toContainEqual({
      from_block: 107,
      to_block: 107,
      reason: "reorganized while reading; this block's canonical logs were not read",
    });
    expect(prepareEngine(snapshot).findings.complete).toBe(false);
  });

  it("finds the first block at or after a timestamp by binary search", async () => {
    const chain = scenario();
    const { source: rpc } = source(chain);
    const target = chain.blocks[5];
    expect(await rpc.firstBlockAtOrAfter(target.timestamp - 1, { from_block: 100, to_block: 112 })).toEqual(target);
  });

  it("rejects a pinned block whose hash changed", async () => {
    const chain = scenario();
    const { source: rpc } = source(chain);
    await expect(rpc.snapshot({ finality: "latest", at_block: { number: 110, hash: `0x${"aa".repeat(32)}` } })).rejects.toMatchObject({
      code: "stale_cursor",
    });
  });
});
