import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { encodeQuoteCalldata, encodeRoutes, MAX_SQRT_RATIO, MIN_SQRT_RATIO, YUL_ROUTER_ABI } from "@ekubo/yul-router-sdk";
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, type Hex, zeroAddress } from "viem";
import { launchpadPrepareAdvance } from "../../src/launchpad/prepare/advance.js";
import { launchpadPrepareClaim } from "../../src/launchpad/prepare/claim.js";
import { launchRouterAbi, scheduledLaunchAbi } from "../../src/launchpad/prepare/contracts.js";
import { launchpadPrepareCreate } from "../../src/launchpad/prepare/create.js";
import { concentratedPoolConfig } from "../../src/launchpad/prepare/encoding.js";
import { launchpadPrepareTrade } from "../../src/launchpad/prepare/trade.js";

/**
 * Runs against the local anvil fork written by the contracts repository's
 * `script/launchpad-local.sh` (KEEP_ANVIL=1), which deploys the launchpad
 * next to the forked chain's Core, TWAMM and Yul router. Set
 * LAUNCHPAD_ANVIL_RPC and LAUNCHPAD_ANVIL_MANIFEST; skipped otherwise. Never
 * point it at a live chain: it advances the node's clock and sends from
 * anvil's unlocked account 0.
 *
 * The data API and quoter-service are stood in for by this test, in their
 * documented response shapes: the api detail from the creation receipt, and
 * the quote from the Yul router's own `quote` at the latest block for one
 * forwarded launch-pool hop.
 */
const RPC = process.env.LAUNCHPAD_ANVIL_RPC;
const MANIFEST_PATH = process.env.LAUNCHPAD_ANVIL_MANIFEST;
const SENDER = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"); // anvil development account 0
const E18 = 10n ** 18n;
const API = "https://api.anvil.test";
const QUOTER = "https://quoter.anvil.test";

// Plain JSON-RPC results.
type Json = any;

async function rpc(method: string, params: unknown[]): Promise<Json> {
  const response = await fetch(RPC!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: { message: string; data?: unknown } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message} ${JSON.stringify(body.error.data ?? "")}`);
  return body.result;
}

const hex = (value: bigint | string) => `0x${BigInt(value).toString(16)}`;

async function callSteps(plan: Json): Promise<Hex[]> {
  const results: Hex[] = [];
  for (const { transaction } of plan.ordered_steps) {
    results.push(await rpc("eth_call", [{ from: transaction.from, to: transaction.to, data: transaction.data, value: hex(transaction.value) }, "latest"]));
  }
  return results;
}

async function sendSteps(plan: Json): Promise<Json[]> {
  const receipts: Json[] = [];
  for (const { transaction } of plan.ordered_steps) {
    const hash = await rpc("eth_sendTransaction", [{ from: transaction.from, to: transaction.to, data: transaction.data, value: hex(transaction.value) }]);
    let receipt = await rpc("eth_getTransactionReceipt", [hash]);
    for (let attempt = 0; receipt === null && attempt < 20; attempt += 1) {
      await rpc("evm_mine", []);
      receipt = await rpc("eth_getTransactionReceipt", [hash]);
    }
    receipts.push(receipt);
  }
  return receipts;
}

async function warpTo(timestamp: bigint) {
  await rpc("evm_setNextBlockTimestamp", [hex(timestamp)]);
  await rpc("evm_mine", []);
}

/** Every request a tool call makes, by JSON-RPC method or service, and the size of its stored plan. */
interface Measured {
  rpc: Record<string, number>;
  api: number;
  quoter: number;
}

describe.skipIf(RPC === undefined || MANIFEST_PATH === undefined)("launchpad on the local anvil fork", () => {
  // Read in the test body: describe callbacks run even when the suite is skipped.
  let manifest: Json;
  let env: Record<string, string | undefined>;
  let C: Record<string, `0x${string}`>;
  const details = new Map<string, Json>();
  let measured: Measured = { rpc: {}, api: 0, quoter: 0 };

  async function quote(url: URL): Promise<Response> {
    const [, chain, signed, specified, other] = url.pathname.split("/");
    const detail = [...details.values()][0];
    const amount = BigInt(signed);
    const key = { token0: zeroAddress, token1: getAddress(detail.pool_key.token1), config: concentratedPoolConfig(0n, detail.tick_spacing, C.scheduled_launch) };
    // The launch token is token1; paying token0 in moves the price down.
    const buy = (amount > 0n ? getAddress(specified) : getAddress(other)) === zeroAddress;
    const hop = { type: "forwarded" as const, forwardee: C.scheduled_launch, poolKey: key, sqrtRatioLimit: buy ? MIN_SQRT_RATIO : MAX_SQRT_RATIO, skipAhead: 0 };
    const route = encodeRoutes({ specifiedToken: getAddress(specified), calculatedToken: getAddress(other), calculatedAmountThreshold: false, multiHops: [{ specifiedAmount: amount, hops: [hop] }] });
    const raw = await rpc("eth_call", [{ from: SENDER, to: C.router, data: encodeQuoteCalldata(route) }, "latest"]);
    const [, , specifiedAmount, calculated] = decodeFunctionResult({ abi: YUL_ROUTER_ABI, functionName: "quote", data: raw }) as unknown as [string, string, bigint, bigint];
    const block = await rpc("eth_getBlockByNumber", ["latest", false]);
    expect(chain).toBe(String(manifest.chain_id));
    return Response.json({
      block_number: Number(BigInt(block.number)),
      block_hash: block.hash,
      total_calculated: calculated.toString(),
      estimated_gas_cost: 307_150,
      price_impact: null,
      splits: [
        {
          amount_specified: specifiedAmount.toString(),
          amount_calculated: calculated.toString(),
          route: [{ swap: { type: "forwarded", pool_key: key, sqrt_ratio_limit: hex(hop.sqrtRatioLimit), skip_ahead: 0, forwardee: C.scheduled_launch } }],
        },
      ],
    });
  }

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (String(input) === RPC) {
      const { method } = JSON.parse(String(init?.body));
      measured.rpc[method] = (measured.rpc[method] ?? 0) + 1;
      return fetch(input, init);
    }
    if (url.origin === QUOTER) {
      measured.quoter += 1;
      return quote(url);
    }
    if (url.origin !== API) throw new Error(`unexpected fetch ${url}`);
    measured.api += 1;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 1) {
      const data = [...details.values()];
      return Response.json({ data, pagination: { page: 1, pageSize: 200, totalPages: 1, totalItems: data.length } });
    }
    const detail = details.get(BigInt(parts[2]).toString());
    return detail === undefined ? new Response("{}", { status: 404 }) : Response.json(detail);
  }) as typeof fetch;

  async function measure<T>(run: () => Promise<T>): Promise<{ result: T; measured: Measured; planBytes: number }> {
    measured = { rpc: {}, api: 0, quoter: 0 };
    const result = await run();
    const planBytes = new TextEncoder().encode(JSON.stringify((result as Json).execution_plan)).length;
    return { result, measured, planBytes };
  }

  const report: Record<string, { measured: Measured; planBytes: number }> = {};

  it("creates, buys, advances, migrates and claims with plans that each succeed from the sender", async () => {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH!, "utf8"));
    env = { LAUNCHPAD_MANIFEST: JSON.stringify(manifest), LAUNCHPAD_RPC_URL: RPC, LAUNCHPAD_API_URL: API, LAUNCHPAD_QUOTER_URL: QUOTER };
    C = Object.fromEntries(Object.entries(manifest.contracts).map(([name, entry]) => [name, getAddress((entry as Json).address)]));
    await rpc("anvil_setBalance", [SENDER, hex(100n * E18)]);
    await rpc("evm_mine", []);
    const now = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
    const start = now + 120n;
    const args = {
      chain_id: manifest.chain_id,
      sender: SENDER,
      slippage_bps: 50,
      quote_token: zeroAddress,
      name: "Anvil Prototype",
      symbol: "ANVIL",
      decimals: 18,
      total_supply: (10n ** 27n).toString(),
      start_time: Number(start),
      end_time: Number(start + 3600n),
      target_tick: -18_420_000,
      upper_tick: -13_815_000,
      tick_spacing: 1000,
      initial_fee: ((1n << 64n) / 20n).toString(),
      final_fee: ((1n << 64n) / 200n).toString(),
      // Far above the launch range, so principal stays pending after completion and migrate has work.
      migration_tick_lower: 10_000_000,
      migration_tick_upper: 10_693_147,
    };
    const created = await measure(() => launchpadPrepareCreate(env, args, { fetch: fetcher }));
    report.create = created;
    const createPlan = (created.result as Json).execution_plan;
    expect(createPlan.ordered_steps).toHaveLength(1);
    expect(createPlan.ordered_steps[0].transaction).toMatchObject({ to: C.launch_router, value: "0" });
    await callSteps(createPlan);
    const [receipt] = await sendSteps(createPlan);
    expect(receipt.status).toBe("0x1");
    const createdLog = receipt.logs.find((log: Json) => getAddress(log.address) === C.scheduled_launch);
    const event = decodeEventLog({ abi: scheduledLaunchAbi, topics: createdLog.topics, data: createdLog.data }) as unknown as { args: { poolId: Hex; token: Hex } };
    const token = getAddress(event.args.token);
    // K3: after a hosted create, LaunchRouter records the signing wallet as creator.
    const creator = await rpc("eth_call", [{ to: C.launch_router, data: encodeFunctionData({ abi: launchRouterAbi, functionName: "creator", args: [event.args.poolId] }) }, "latest"]);
    expect(getAddress(decodeFunctionResult({ abi: launchRouterAbi, functionName: "creator", data: creator }) as Hex)).toBe(SENDER);
    details.set(BigInt(event.args.poolId).toString(), {
      chain_id: String(manifest.chain_id),
      pool_key_id: "1",
      pool_id: event.args.poolId,
      pool_key: { core_address: C.core, token0: "0x0", token1: token, fee: "0x0", tick_spacing: 1000, extension: C.scheduled_launch },
      launch_token: { address: token, name: args.name, symbol: args.symbol, decimals: 18, total_supply: args.total_supply },
      quote_token: { address: "0x0", name: "Ether", symbol: "ETH", decimals: 18 },
      launch_token_is_token1: true,
      start_time: args.start_time,
      end_time: args.end_time,
      target_tick: args.target_tick,
      upper_tick: args.upper_tick,
      tick_spacing: 1000,
      initial_fee: args.initial_fee,
      final_fee: args.final_fee,
      migration_tick_lower: args.migration_tick_lower,
      migration_tick_upper: args.migration_tick_upper,
      deployed: "0",
      reserve0: "0",
      reserve1: "0",
      complete: false,
      status: "upcoming",
      status_as_of: Number(now),
      owner: C.launch_router,
      creator: SENDER,
      created_block_number: BigInt(receipt.blockNumber).toString(),
      created_transaction_hash: receipt.transactionHash,
      created_time: Number(now),
      pool_state: null,
      latest_advance: null,
      terminal: null,
      creator_fees_claimed: { amount0: "0", amount1: "0" },
    });

    await warpTo(start + 600n);
    const tradeArgs = { chain_id: manifest.chain_id, sender: SENDER, slippage_bps: 100, token, side: "buy" as const, amount_kind: "exact_input" as const, amount: (E18 / 1000n).toString() };
    const bought = await measure(() => launchpadPrepareTrade(env, tradeArgs, { fetch: fetcher }));
    report.buy = bought;
    const buy = bought.result as Json;
    expect(buy.contract).toBe(C.router);
    expect(buy.route.splits[0][0]).toMatchObject({ type: "forwarded", this_launch: true, forwardee: C.scheduled_launch });
    const [buyReceipt] = await sendSteps(buy.execution_plan);
    expect(buyReceipt.status).toBe("0x1");
    const transfer = buyReceipt.logs.find((log: Json) => getAddress(log.address) === token);
    const received = BigInt(transfer.data);
    expect(received).toBeGreaterThanOrEqual(BigInt(buy.threshold.calculated_amount_threshold));

    const claimed = await measure(() => launchpadPrepareClaim(env, { chain_id: manifest.chain_id, sender: SENDER, slippage_bps: 0, token }, { fetch: fetcher }));
    report.claim = claimed;
    const claim = claimed.result as Json;
    expect(claim.execution_plan.ordered_steps[0].transaction.to).toBe(C.launch_router);
    expect(BigInt(claim.claimable_at_block[0].amount) + BigInt(claim.claimable_at_block[1].amount)).toBeGreaterThan(0n);
    const [claimReceipt] = await sendSteps(claim.execution_plan);
    expect(claimReceipt.status).toBe("0x1");

    await warpTo(start + 3600n + 1n);
    const advanced = await measure(() => launchpadPrepareAdvance(env, { chain_id: manifest.chain_id, sender: SENDER, slippage_bps: 0, token }, { fetch: fetcher }));
    report.advance = advanced;
    expect((advanced.result as Json).action).toBe("advance");
    const [advanceReceipt] = await sendSteps((advanced.result as Json).execution_plan);
    expect(advanceReceipt.status).toBe("0x1");

    const migrated = await measure(() => launchpadPrepareAdvance(env, { chain_id: manifest.chain_id, sender: SENDER, slippage_bps: 0, token }, { fetch: fetcher }));
    report.migrate = migrated;
    const migrate = migrated.result as Json;
    expect(migrate.action).toBe("migrate");
    expect(migrate.execution_plan.ordered_steps[0].transaction.to).toBe(C.locked_launch_liquidity);
    const [migrateReceipt] = await sendSteps(migrate.execution_plan);
    expect(migrateReceipt.status).toBe("0x1");

    for (const [name, entry] of Object.entries(report)) {
      expect(entry.measured.rpc.eth_getLogs).toBeUndefined();
      console.log(`${name}: plan ${entry.planBytes} B; rpc ${JSON.stringify(entry.measured.rpc)}; api ${entry.measured.api}; quoter ${entry.measured.quoter}`);
    }
  }, 180_000);
});
