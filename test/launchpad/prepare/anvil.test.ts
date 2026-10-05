import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { decodeEventLog, decodeFunctionResult, type Hex } from "viem";
import { launchpadPrepareAdvance } from "../../../src/launchpad/prepare/advance.js";
import { launchRouterAbi, scheduledLaunchAbi } from "../../../src/launchpad/prepare/contracts.js";
import { launchpadPrepareCreate } from "../../../src/launchpad/prepare/create.js";
import { balanceUpdate } from "../../../src/launchpad/prepare/encoding.js";
import { rpcChain } from "../../../src/launchpad/prepare/context.js";
import { launchpadPrepareTrade } from "../../../src/launchpad/prepare/trade.js";

/**
 * Runs against the local anvil fork written by the contracts repository's
 * `script/launchpad-local.sh` (KEEP_ANVIL=1). Set LAUNCHPAD_ANVIL_RPC and
 * LAUNCHPAD_ANVIL_MANIFEST; skipped otherwise. Never point it at a live chain:
 * it advances the node's clock and sends from anvil's unlocked account 0.
 */
const RPC = process.env.LAUNCHPAD_ANVIL_RPC;
const MANIFEST_PATH = process.env.LAUNCHPAD_ANVIL_MANIFEST;
const SENDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // anvil development account 0
const E18 = 10n ** 18n;

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

const hex = (value: string) => `0x${BigInt(value).toString(16)}`;

/** Every plan step under eth_call from its bound sender, in order, at the latest block. */
async function callSteps(plan: Json): Promise<Hex[]> {
  const results: Hex[] = [];
  for (const { transaction } of plan.ordered_steps) {
    results.push(
      await rpc("eth_call", [{ from: transaction.from, to: transaction.to, data: transaction.data, value: hex(transaction.value) }, "latest"]),
    );
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
  await rpc("evm_setNextBlockTimestamp", [hex(timestamp.toString())]);
  await rpc("evm_mine", []);
}

describe.skipIf(RPC === undefined || MANIFEST_PATH === undefined)("launchpad preparation on the local anvil fork", () => {
  const env = () => ({ LAUNCHPAD_MANIFEST: readFileSync(MANIFEST_PATH!, "utf8"), LAUNCHPAD_RPC_URL: RPC });

  it("prepares a create and a launch-phase buy that each succeed under eth_call from the sender", async () => {
    await rpc("anvil_setBalance", [SENDER, hex((100n * E18).toString())]);
    // Anvil stamps new blocks from the wall clock; mine one so start_time is measured from now, not from the deployment.
    await rpc("evm_mine", []);
    const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
    const now = BigInt(latest.timestamp);
    const start = now + 120n;
    const created: Json = await launchpadPrepareCreate(
      env(),
      {
        chain_id: Number(await rpc("eth_chainId", [])),
        sender: SENDER,
        slippage_bps: 50,
        owner: SENDER,
        quote_token: "0x0000000000000000000000000000000000000000",
        name: "Anvil Prototype",
        symbol: "ANVIL",
        decimals: 18,
        total_supply: (10n ** 27n).toString(),
        quote_amount: (E18 / 100n).toString(),
        start_time: Number(start),
        end_time: Number(start + 3600n),
        target_tick: -18_420_000,
        upper_tick: -13_815_000,
        tick_spacing: 1000,
        initial_fee: ((1n << 64n) / 20n).toString(),
        final_fee: ((1n << 64n) / 200n).toString(),
        migration_tick_lower: -17_000_000,
        migration_tick_upper: -15_000_000,
      },
      rpcChain,
    );
    // Acceptance: the prepared create succeeds under eth_call from the sender.
    const [createResult] = await callSteps(created.execution_plan);
    expect(createResult).toMatch(/^0x[0-9a-f]+$/);
    console.log(`create eth_call ok at block ${created.as_of.block_number}; returned ${createResult.length / 2 - 1} bytes`);

    // Execute it on the local fork only, to have a launch to trade.
    const [receipt] = await sendSteps(created.execution_plan);
    expect(receipt.status).toBe("0x1");
    const createdLog = receipt.logs.find((log: Json) => log.address.toLowerCase() === JSON.parse(env().LAUNCHPAD_MANIFEST).contracts.scheduled_launch.address.toLowerCase());
    const event = decodeEventLog({ abi: scheduledLaunchAbi, topics: createdLog.topics, data: createdLog.data }) as unknown as { args: { token: Hex } };
    const token = event.args.token;

    await warpTo(start + 600n);
    const buy: Json = await launchpadPrepareTrade(
      env(),
      { chain_id: created.as_of.chain_id, sender: SENDER, slippage_bps: 100, token, side: "buy", amount_kind: "exact_input", amount: (E18 / 1000n).toString() },
      rpcChain,
    );
    expect(buy.trading_phase).toBe("launch");
    expect(buy.price_limit.position).toBe("top_of_launch_range");
    // Acceptance: the prepared launch-phase buy succeeds under eth_call from the sender.
    const [swapResult] = await callSteps(buy.execution_plan);
    const update = decodeFunctionResult({ abi: launchRouterAbi, functionName: "swap", data: swapResult }) as Hex;
    // Native ETH is token0, so the launch token is token1 and leaves the pool as a negative delta1.
    const received = -balanceUpdate(update).delta1;
    expect(received).toBeGreaterThanOrEqual(BigInt(buy.threshold.calculated_amount_threshold));
    console.log(
      `buy eth_call ok at block ${buy.as_of.block_number}: quoted ${buy.quote.calculated_amount}, threshold ${buy.threshold.calculated_amount_threshold}, simulated ${received}`,
    );

    const [buyReceipt] = await sendSteps(buy.execution_plan);
    expect(buyReceipt.status).toBe("0x1");

    await warpTo(start + 3600n + 1n);
    const advance: Json = await launchpadPrepareAdvance(env(), { chain_id: created.as_of.chain_id, sender: SENDER, slippage_bps: 0, token }, rpcChain);
    expect(advance.action).toBe("advance");
    await callSteps(advance.execution_plan);
    const [advanceReceipt] = await sendSteps(advance.execution_plan);
    expect(advanceReceipt.status).toBe("0x1");
    console.log(`advance after end_time executed: ${advanceReceipt.logs.length} logs`);
  }, 120_000);
});
