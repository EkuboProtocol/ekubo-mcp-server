import { describe, expect, it, spyOn } from "bun:test";
import { toEventSelector, toHex } from "viem";
import { coreEvents, erc20Events, launchRouterEvents, lockedLaunchLiquidityEvents, scheduledLaunchEvents } from "../../src/launchpad/analytics/abi.js";
import type { FixtureBundle } from "../../src/launchpad/analytics/fixture-source.js";
import { ratio } from "../../src/launchpad/analytics/numbers.js";
import { RpcSource } from "../../src/launchpad/analytics/rpc-source.js";
import { launchpadGetLaunch, launchpadSearch } from "../../src/launchpad/analytics/tools.js";
import { PRIVILEGES_REVISION } from "../../src/launchpad/analytics/views.js";
import type { RawLog } from "../../src/launchpad/analytics/types.js";
import { C, ChainBuilder, LaunchSim, MANIFEST, TWAMM, addr, type BlockBuild } from "./chain-builder.js";
import v2 from "../fixtures/launchpad/benchmark-fixtures-v2.json";
import {
  BENEFICIARY,
  BUYER_A,
  BUYER_B,
  E18,
  PAYER,
  SENDER,
  TOKEN,
  fixtureEnv,
  standardLaunch,
  strings,
  tools,
  type Json,
} from "./helpers.js";

describe("B1 volume window boundaries", () => {
  it("excludes as_of − 86400 and includes one second later and as_of itself", async () => {
    const { chain, sim, unit } = standardLaunch();
    const t0 = chain.head.timestamp + 1_000;
    const buy = (payer: `0x${string}`, quote: bigint) => (b: BlockBuild) =>
      sim.buy(b, { payer, quoteIn: quote, tokenOut: 10n * unit, fee: 0n });
    chain.block(buy(addr(0xb1, "b"), 1n), { timestamp: t0 });
    chain.block(buy(addr(0xb2, "b"), 20n), { timestamp: t0 + 1 });
    chain.block(buy(addr(0xb3, "b"), 300n), { timestamp: t0 + 86_400 });
    const result = await tools.analytics(chain.bundle(), { token: TOKEN });
    expect(result.volume.window).toEqual({ from_timestamp_exclusive: t0, to_timestamp_inclusive: t0 + 86_400 });
    expect(result.volume.user_launch).toBe("320");
  });
});

function foreignCopy(log: RawLog, foreign: `0x${string}`, index: number): RawLog {
  return { ...log, address: foreign, log_index: 500 + index };
}

describe("B2 foreign and wrong-chain events", () => {
  it("ignores LaunchCreated and LaunchSwapped from an address outside the manifest", async () => {
    const { chain } = standardLaunch();
    const foreign = addr(0xbad, "c");
    const created = toEventSelector(scheduledLaunchEvents[0]);
    const swapped = toEventSelector(scheduledLaunchEvents[3]);
    const copies = chain.logs
      .filter((l) => l.topics[0] === created || l.topics[0] === swapped)
      .map((l, i) => foreignCopy(l, foreign, i));
    const clean = chain.bundle();
    const polluted = chain.bundle({ logs: [...chain.logs, ...copies] });
    expect(copies.length).toBe(2);
    expect((await tools.search(polluted)).candidate_count).toBe(1);
    expect(await tools.analytics(polluted, { token: TOKEN })).toEqual(await tools.analytics(clean, { token: TOKEN }));
  });

  it("returns not found for a real token queried on another covered chain", async () => {
    const { chain } = standardLaunch();
    const other = new ChainBuilder({ chain_id: 8453, first_block: 500 });
    other.block();
    const a = chain.bundle();
    const b = other.bundle();
    const merged: FixtureBundle = {
      ...a,
      manifest: { revision: a.manifest.revision, contracts: { ...a.manifest.contracts, ...b.manifest.contracts } },
      index: { ...a.index, ...b.index },
      as_of: { ...a.as_of, ...b.as_of },
      blocks: [...a.blocks, ...b.blocks],
      logs: [...a.logs, ...b.logs],
      code_hashes: { ...a.code_hashes, ...b.code_hashes },
    };
    expect((await tools.launch(merged, { token: TOKEN })).launch.token).toBe(TOKEN);
    await expect(tools.launch(merged, { token: TOKEN, chain_id: 8453 })).rejects.toMatchObject({
      code: "launch_not_found",
      details: { chain_id: 8453 },
    });
    expect((await tools.search(merged, { chain_id: 8453, text: TOKEN })).candidate_count).toBe(0);
  });
});

function symbolLaunches(symbols: string[]) {
  const chain = new ChainBuilder();
  chain.block();
  const tokens = symbols.map((symbol, i) => {
    const token = addr(0x300 + i, "d");
    const sim = new LaunchSim(chain, token, { owner: BENEFICIARY, startTime: 1_900_000_000, endTime: 1_900_000_600, symbol, name: `${symbol} token` });
    chain.block((b) => sim.create(b, SENDER));
    return token;
  });
  return { chain, tokens };
}

describe("B3 lookalike symbols", () => {
  it("matches after NFKC and case folding, marks non-ASCII, and states the confusable limitation", async () => {
    const { chain, tokens } = symbolLaunches(["USDC", "ＵＳＤＣ", "usdc", "UЅDC"]);
    const result = await tools.search(chain.bundle(), { text: "usdc", sort: "launch_block_asc" });
    expect(result.candidates.map((c: Json) => c.token)).toEqual(tokens.slice(0, 3));
    expect(result.requires_exact_address).toBe(true);
    expect(result.candidates.map((c: Json) => c.metadata.non_ascii)).toEqual([false, true, false]);
    const all = await tools.search(chain.bundle(), { sort: "launch_block_asc" });
    expect(all.candidates[3].metadata.non_ascii).toBe(true);
    expect(result.limitations.some((l: string) => l.includes("confusable"))).toBe(true);
  });

  it("never accepts a symbol in place of an address", async () => {
    const { chain } = symbolLaunches(["USDC"]);
    await expect(tools.launch(chain.bundle(), { token: "USDC" })).rejects.toBeDefined();
  });
});

describe("B4 decode failure", () => {
  it("keeps the raw log under undecoded and marks the result incomplete", async () => {
    const { chain } = standardLaunch();
    const swapped = chain.logs.find((l) => l.topics[0] === toEventSelector(scheduledLaunchEvents[3]));
    const broken: RawLog = { ...(swapped as RawLog), data: "0x1234", log_index: 900 };
    const result = await tools.analytics(chain.bundle({ logs: [...chain.logs, broken] }), { token: TOKEN });
    expect(result.source.complete).toBe(false);
    expect(result.undecoded).toEqual([
      {
        address: broken.address,
        topics: broken.topics,
        data: "0x1234",
        block_number: broken.block_number,
        block_hash: broken.block_hash,
        transaction_hash: broken.transaction_hash,
        log_index: 900,
        reason: expect.any(String),
      },
    ]);
  });

  it("rejects a Transfer whose data repeats the indexed addresses", async () => {
    const { chain } = standardLaunch();
    const transfer = chain.logs.find((l) => l.topics[0] === toEventSelector(erc20Events[0]) && l.address === TOKEN) as RawLog;
    const padded: RawLog = { ...transfer, data: `0x${"00".repeat(64)}${transfer.data.slice(2)}` as `0x${string}` };
    const logs = chain.logs.map((l) => (l === transfer ? padded : l));
    const result = await tools.analytics(chain.bundle({ logs }), { token: TOKEN });
    expect(result.undecoded).toHaveLength(1);
    expect(result.source.complete).toBe(false);
  });
});

describe("B6 early acquisition with common funding", () => {
  function firstBlockBuys(withFunding: boolean) {
    const chain = new ChainBuilder();
    chain.block();
    const start = chain.options.first_timestamp + 24;
    const quote = addr(0x9e, "a");
    const sim = new LaunchSim(chain, TOKEN, { owner: BENEFICIARY, startTime: start, endTime: start + 1200, quoteToken: quote });
    chain.block((b) => sim.create(b, SENDER, PAYER));
    const funded = [addr(0xf1, "b"), addr(0xf2, "b"), addr(0xf3, "b")];
    const independent = [addr(0x11, "b"), addr(0x12, "b"), addr(0x13, "b")];
    chain.block((b) => {
      if (withFunding) {
        const fund = b.tx(addr(0xfd, "e"), quote);
        for (const to of funded) fund.transfer(quote, addr(0xfd, "e"), to, E18);
      }
      for (const buyer of [...funded, ...independent]) {
        sim.buy(b, { payer: buyer, quoteIn: E18, tokenOut: 1_000n * E18, fee: 0n, deploy: buyer === funded[0] ? 10_000n * E18 : 0n });
      }
    });
    chain.blocksUntil(110);
    return chain;
  }

  it("reports split funded buyers exactly like independent buyers, with no clustering claim", async () => {
    const funded = await tools.analytics(firstBlockBuys(true).bundle(), { token: TOKEN, early_window_blocks: 1 });
    const plain = await tools.analytics(firstBlockBuys(false).bundle(), { token: TOKEN, early_window_blocks: 1 });
    const window = funded.early_acquisition.windows[0];
    expect(window).toMatchObject({
      amount: (6_000n * E18).toString(),
      distinct_buying_recipients: 6,
      largest_single_share_of_total_supply: ratio(1_000n, 1_000_000n),
      confidence: "exact",
    });
    expect(funded.early_acquisition.clustering).toBe("not_computed");
    expect(funded.early_acquisition.unknown).toContain("submission timing (when a transaction was signed or broadcast)");
    expect(funded.early_acquisition).toEqual(plain.early_acquisition);
    expect(strings(funded.early_acquisition).some((s) => /cluster(ed)? (of|with)|same (owner|entity)|coordinated/i.test(s))).toBe(false);
  });
});

describe("B7 volume decomposition", () => {
  function migrated(withTwamm: boolean) {
    const { chain, sim, unit } = standardLaunch();
    chain.block((b) => {
      const release = b.tx(addr(0xadd, "e"), C.scheduled_launch.address);
      const [r0, r1] = sim.pair(100n * unit, -7n);
      release.coreSwap(C.scheduled_launch.address, sim.poolId, r0, r1);
    });
    chain.blocksUntil(116);
    chain.block((b) => {
      const tx = b.tx(addr(0x5a, "e"), C.scheduled_launch.address);
      const [p0, p1] = sim.pair(1_000n * unit, E18);
      tx.principal(sim.poolId, p0, p1);
      tx.advanced(sim.poolId, sim.deployed, true);
      const [s0, s1] = sim.pair(-(1n * unit), 11n);
      tx.coreSwap(C.locked_launch_liquidity.address, sim.terminalId, s0, s1);
      tx.locked(sim.poolId, sim.terminalId, 1n);
    });
    chain.block((b) => {
      const [t0, t1] = sim.pair(1n * unit, -130n);
      b.tx(addr(0x7a, "e"), C.router.address).coreSwap(TWAMM, sim.terminalId, t0, t1);
      const [u0, u1] = sim.pair(-(1n * unit), 1_700n);
      b.tx(BUYER_B, C.router.address).coreSwap(C.router.address, sim.terminalId, u0, u1);
    });
    return chain.bundle({ without_twamm: !withTwamm });
  }

  it("keeps release sales, migration rebalancing and TWAMM execution out of user volume", async () => {
    const result = await tools.analytics(migrated(true), { token: TOKEN });
    expect(result.volume).toMatchObject({
      user_launch: E18.toString(),
      user_terminal: "1700",
      twamm_virtual: "130",
      internal: { release_sales: "7", migration_rebalancing: "11" },
    });
    expect(result.volume.twamm_virtual_method).toContain(TWAMM);
    const stats = await tools.stats(migrated(true));
    expect(stats.rolling_24h_volume[0].user_volume).toBe((E18 + 1_700n).toString());
  });

  it("says so when TWAMM execution cannot be separated", async () => {
    const result = await tools.analytics(migrated(false), { token: TOKEN });
    expect(result.volume.twamm_virtual).toBeNull();
    expect(result.volume.user_terminal).toBe("1830");
    expect(result.limitations.some((l: string) => l.includes("TWAMM") && l.includes("cannot be separated"))).toBe(true);
  });
});

describe("B8 LaunchSwapped reconciliation and locker reporting", () => {
  it("reconciles every swap transaction against Core's token Transfers", async () => {
    const { chain } = standardLaunch();
    const result = await tools.analytics(chain.bundle(), { token: TOKEN });
    expect(result.reconciliation).toMatchObject({ checked_transactions: 1, mismatched: [] });
  });

  it("sets a limitation when a swap's Transfer does not match", async () => {
    const { chain } = standardLaunch();
    const swapTx = chain.logs.find((l) => l.topics[0] === toEventSelector(scheduledLaunchEvents[3]))?.transaction_hash;
    const logs = chain.logs.filter((l) => !(l.transaction_hash === swapTx && l.address === TOKEN));
    const result = await tools.analytics(chain.bundle({ logs }), { token: TOKEN });
    expect(result.reconciliation.mismatched).toEqual([
      { transaction_hash: swapTx, expected_core_net: expect.any(String), observed_core_net: "0" },
    ]);
    expect(result.limitations.some((l: string) => l.includes("do not reconcile"))).toBe(true);
  });

  it("reports a non-router locker as a locker with no payer, outside round-trip grouping", async () => {
    const { chain, sim, unit } = standardLaunch();
    const locker = addr(0xf0, "e");
    chain.block((b) => sim.buy(b, { payer: BUYER_B, quoteIn: E18, tokenOut: 10n * unit, fee: 0n, locker }));
    chain.block((b) => sim.sell(b, { payer: BUYER_B, from: BUYER_B, tokenIn: 10n * unit, quoteOut: E18, fee: 0n }));
    const result = await tools.analytics(chain.bundle(), { token: TOKEN, early_window_blocks: 10 });
    expect(result.early_acquisition.windows[0]).toMatchObject({ distinct_buying_lockers: 2, buys_without_recipient: 1 });
    expect(result.volume.round_trip.payers).toBe(0);
    expect(result.limitations.some((l: string) => l.includes("no payer"))).toBe(true);
  });
});

describe("L1 privileges and ranking disclosure", () => {
  it("returns the privileges block when the emitter's code hash matches the manifest", async () => {
    const { chain } = standardLaunch();
    const result = await tools.launch(chain.bundle({ revision: PRIVILEGES_REVISION }), { token: TOKEN });
    expect(result.launch.privileges).toEqual({
      verified_at_revision: PRIVILEGES_REVISION,
      emitter_code_hash: MANIFEST.contracts.scheduled_launch.code_hash,
      supply: "fixed",
      mint_authority: "renounced",
      beneficiary_powers: ["claim_creator_fees"],
      principal_withdrawal: "none",
      upgrade: "none",
      pause: "none",
      initial_beneficiary_allocation: "0",
      third_party_liquidity: "not_migrated",
    });
  });

  it("returns null with a limitation on a code-hash mismatch", async () => {
    const { chain } = standardLaunch();
    const bundle = chain.bundle({ code_hashes: { [C.scheduled_launch.address]: `0x${"ab".repeat(32)}` } });
    const result = await tools.launch(bundle, { token: TOKEN });
    expect(result.launch.privileges).toBeNull();
    expect(result.limitations.some((l: string) => l.startsWith("privileges is null"))).toBe(true);
  });

  it("echoes the sort applied and sponsored: false", async () => {
    const { chain } = standardLaunch();
    const result = await tools.search(chain.bundle(), { sort: "quote_raised_desc" });
    expect(result).toMatchObject({ sort_applied: "quote_raised_desc", sponsored: false });
  });
});

describe("A1 search filters, sort and rows", () => {
  function three() {
    const chain = new ChainBuilder();
    chain.block();
    const start = chain.options.first_timestamp + 24;
    const sims = [0x401, 0x402, 0x403].map(
      (n) => new LaunchSim(chain, addr(n, "d"), { owner: BENEFICIARY, startTime: start, endTime: start + 1200 }),
    );
    for (const sim of sims) chain.block((b) => sim.create(b, SENDER));
    chain.block((b) => {
      sims[0].buy(b, { payer: BUYER_A, quoteIn: 3n * E18, tokenOut: 10n * E18, fee: 0n, deploy: 100n * E18 });
      sims[2].buy(b, { payer: BUYER_A, quoteIn: 5n * E18, tokenOut: 10n * E18, fee: 0n, deploy: 100n * E18 });
    });
    return { chain, sims };
  }

  it("filters by launch time, quote asset and quote raised, and sorts by quote raised", async () => {
    const { chain, sims } = three();
    const prices = [{ asset: "0x0000000000000000000000000000000000000000" as const, decimals: 18, price_usd: "2000.00", as_of: chain.head.timestamp, source: "fixture-pinned-price-v1" }];
    const bundle = chain.bundle({ prices });
    const byRaised = await tools.search(bundle, { sort: "quote_raised_desc" });
    expect(byRaised.candidates.map((c: Json) => c.token)).toEqual([sims[2].token, sims[0].token, sims[1].token]);
    expect(byRaised.candidates[0].quote_raised).toEqual({
      amount: (5n * E18).toString(),
      decimals: 18,
      method: expect.any(String),
      usd: { value: "10000", price_usd: "2000.00", source: "fixture-pinned-price-v1", price_as_of: chain.head.timestamp },
    });
    expect(byRaised.candidates[0].creation).toMatchObject({ block_number: chain.blocks[3].number, block_hash: chain.blocks[3].hash, block_timestamp: chain.blocks[3].timestamp });
    const ranged = await tools.search(bundle, { quote_asset: "0x0000000000000000000000000000000000000000", min_quote_raised: (4n * E18).toString() });
    expect(ranged.candidates.map((c: Json) => c.token)).toEqual([sims[2].token]);
    const recent = await tools.search(bundle, { launched_after: chain.blocks[1].timestamp });
    expect(recent.candidates.map((c: Json) => c.token)).toEqual([sims[2].token, sims[1].token]);
    await expect(tools.search(bundle, { min_quote_raised: "1" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("leaves USD null without a price source", async () => {
    const { chain } = three();
    const result = await tools.search(chain.bundle(), {});
    expect(result.candidates[0].quote_raised.usd).toBeNull();
  });
});

describe("A2 and A3 holder exclusions", () => {
  it("echoes caller-supplied exclusions and never drops the beneficiary or a round-tripper", async () => {
    const { chain, sim, unit } = standardLaunch();
    chain.block((b) => b.tx(BUYER_A, TOKEN).transfer(TOKEN, BUYER_A, BENEFICIARY, 1_000n * unit));
    chain.block((b) => sim.buy(b, { payer: BUYER_B, quoteIn: E18, tokenOut: 2_000n * unit, fee: 0n }));
    chain.block((b) => sim.sell(b, { payer: BUYER_B, tokenIn: 1_990n * unit, quoteOut: E18, fee: 0n }));
    const base = await tools.analytics(chain.bundle(), { token: TOKEN });
    const holders = base.holders.holders.map((h: Json) => h.address);
    expect(holders).toContain(BENEFICIARY);
    expect(holders).toContain(BUYER_B);
    expect(base.volume.round_trip.payers).toBe(1);
    const excluded = await tools.analytics(chain.bundle(), { token: TOKEN, additional_exclusions: [BUYER_A] });
    expect(excluded.holders.excluded.at(-1)).toEqual({ address: BUYER_A, category: "caller_supplied", amount: (44_000n * unit).toString() });
    expect(excluded.holders.holder_count).toBe(base.holders.holder_count - 1);
  });
});

describe("A2 (CSO) no remote metadata", () => {
  it("makes no outbound request other than the configured RPC for URL-like names", async () => {
    const chain = new ChainBuilder();
    chain.block();
    const sim = new LaunchSim(chain, TOKEN, {
      owner: BENEFICIARY,
      startTime: 1_900_000_000,
      endTime: 1_900_000_600,
      name: "https://metadata.example/token.json",
      symbol: "ipfs://bafyexample",
    });
    chain.block((b) => sim.create(b, SENDER));
    const urls: string[] = [];
    const node = (async (url: string, init: RequestInit) => {
      urls.push(String(url));
      const body = JSON.parse(init.body as string);
      const answer = (r: { id: number; method: string; params: unknown[] }) => ({ jsonrpc: "2.0", id: r.id, result: rpcAnswer(chain, r.method, r.params) });
      return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
    }) as unknown as typeof fetch;
    const global = spyOn(globalThis, "fetch");
    const rpc = new RpcSource({ url: "http://anvil.test", manifest: MANIFEST, fetch: node });
    const snapshot = await rpc.snapshot({ finality: "latest" });
    expect(snapshot.logs.length).toBeGreaterThan(0);
    await launchpadSearch(fixtureEnv(chain.bundle()), { chain_id: 31337 } as never);
    await launchpadGetLaunch(fixtureEnv(chain.bundle()), { chain_id: 31337, token: TOKEN } as never);
    expect(new Set(urls)).toEqual(new Set(["http://anvil.test"]));
    expect(global).not.toHaveBeenCalled();
    global.mockRestore();
  });
});

function rpcAnswer(chain: ChainBuilder, method: string, params: unknown[]): unknown {
  const header = (n: number) => {
    const h = chain.blocks.find((b) => b.number === n);
    return h && { number: toHex(h.number), hash: h.hash, parentHash: h.parent_hash, timestamp: toHex(h.timestamp) };
  };
  if (method === "eth_chainId") return toHex(chain.options.chain_id);
  if (method === "eth_getBlockByNumber") {
    const tag = params[0] as string;
    return header(tag.startsWith("0x") ? Number(tag) : chain.head.number) ?? null;
  }
  if (method === "eth_getLogs") {
    const filter = params[0] as { address: string[]; fromBlock: string; toBlock: string; topics?: string[] };
    return chain.logs
      .filter((l) => filter.address.includes(l.address) && l.block_number >= Number(filter.fromBlock) && l.block_number <= Number(filter.toBlock))
      .filter((l) => filter.topics === undefined || l.topics[0] === filter.topics[0])
      .map((l) => ({ ...l, blockNumber: toHex(l.block_number), blockHash: l.block_hash, transactionHash: l.transaction_hash, logIndex: toHex(l.log_index) }));
  }
  return null;
}

describe("v2 benchmark bundle (EKU-662), read directly", () => {
  const env = fixtureEnv(v2 as unknown as FixtureBundle);

  it("records topic0 values that match the engine's event signatures", () => {
    const ours = new Map<string, string>(
      [...scheduledLaunchEvents, ...lockedLaunchLiquidityEvents, ...launchRouterEvents, ...erc20Events, ...coreEvents].map((e) => [e.name, toEventSelector(e)]),
    );
    for (const entry of (v2 as { event_topics: { event: string; topic0: string }[] }).event_topics) {
      expect(ours.get(entry.event)).toBe(entry.topic0);
    }
  });

  it("loads both chains, decodes every log and reports only the declared indexer gap", async () => {
    const expected = [
      { chain: 1, candidates: 4, complete: false },
      { chain: 8453, candidates: 2, complete: true },
    ];
    for (const { chain, candidates, complete } of expected) {
      const search = (await launchpadSearch(env, { chain_id: chain } as never)) as Json;
      expect(search.candidate_count).toBe(candidates);
      expect(search.source.complete).toBe(complete);
      expect(search.undecoded).toEqual([]);
      for (const candidate of search.candidates) {
        const launch = (await launchpadGetLaunch(env, { chain_id: chain, token: candidate.token } as never)) as Json;
        expect(launch.as_of.chain_id).toBe(chain);
      }
    }
  });

  it("matches the certified C5 and E11 answers for L1", async () => {
    const result = await tools.analytics(v2 as unknown as FixtureBundle, {
      chain_id: 1,
      token: "0xcc66bba06465371b9f675a127fdf2aa32bfe6280",
      early_window_blocks: 5,
      early_window_seconds: 300,
    });
    expect(result.reconciliation.mismatched).toEqual([]);
    const [byBlocks, bySeconds] = result.early_acquisition.windows;
    const supply = 10n ** 27n;
    const largest = ratio(180399999999999998908945669n, supply);
    expect(byBlocks).toMatchObject({
      amount: "288219999999999998349111371",
      share_of_total_supply: ratio(288219999999999998349111371n, supply),
      share_of_released_by_window_end: ratio(288219999999999998349111371n, 444444444444444444444444444n),
      distinct_buying_lockers: 1,
      distinct_buying_recipients: 4,
      largest_single_share_of_total_supply: largest,
    });
    expect(bySeconds).toMatchObject({
      amount: "271399999999999998412597914",
      share_of_total_supply: ratio(271399999999999998412597914n, supply),
      share_of_released_by_window_end: ratio(271399999999999998412597914n, 333333333333333333333333333n),
      distinct_buying_lockers: 1,
      distinct_buying_recipients: 2,
      largest_single_share_of_total_supply: largest,
    });
    expect(result.volume.user_launch).toBe("109471119999999999982");
    expect(result.volume.round_trip).toMatchObject({ volume: "10471119999999999982", payers: 2 });
  });
});

