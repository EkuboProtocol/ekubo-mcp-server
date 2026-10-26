import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { type Address, erc20Abi, getAddress, type Hex, parseEther, zeroAddress } from "viem";
import { walletHandoff } from "./wallet-handoff.js";
import { ACCOUNTS, API, CORE, callTool, decodeLogs, execute, type LocalChain, loadPlan, mined, mockApi, startChain } from "./local-chain.js";

// Runs only with LAUNCHPAD_ANVIL=1 and anvil on PATH; LAUNCHPAD_WRITE_FIXTURE=1 also rewrites
// test/fixtures/launchpad/local-lifecycle.json, which launchpad-calldata.test.ts checks in every run.
const enabled = process.env.LAUNCHPAD_ANVIL === "1";
const [OWNER, TRADER, NEW_OWNER] = ACCOUNTS.map((account) => account.address);
const recorded: Record<string, unknown>[] = [];
let chain: LocalChain;
const original = globalThis.fetch;

async function prepared(name: string, args: Record<string, unknown>) {
  const result = await callTool(chain.env, name, args);
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent;
}

async function run(label: string, name: string, args: Record<string, unknown>) {
  const result = await prepared(name, args);
  const plan = await loadPlan(chain.env, result.execution_plan_reference);
  if (name === "launchpad_prepare_trade") expect(result.owner_review).toBeUndefined();
  else {
    const body = JSON.parse(result.owner_review.artifact.body);
    const step = plan.ordered_steps.at(-1)!.transaction;
    expect([body.target, body.data, body.value]).toEqual([step.to.toLowerCase(), step.data.toLowerCase(), step.value]);
  }
  const receipts = await execute(chain, plan);
  const events = receipts.flatMap(decodeLogs);
  recorded.push({
    label, tool: name, arguments: args, details: result.details,
    steps: plan.ordered_steps.map((step) => ({ kind: step.kind, to: step.transaction.to, data: step.transaction.data, value: step.transaction.value })),
    ...(result.owner_review === undefined ? {} : { owner_review: result.owner_review }),
    receipts: receipts.map((receipt) => ({ status: receipt.status, block: receipt.blockNumber.toString(), transaction_hash: receipt.transactionHash })),
    events: events.map((event) => ({ address: event.address, event: event.eventName, args: event.args })),
  });
  return { result, plan, events };
}

const balance = (token: Address, who: Address) => BigInt(token) === 0n
  ? chain.pub.getBalance({ address: who })
  : chain.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

async function now() {
  return (await chain.pub.getBlock()).timestamp;
}

const withLogo = (label: string) => label.includes("logo") && !label.includes("empty logo");

async function create(label: string, extra: Record<string, unknown>) {
  const args = { chain_id: "31337", sender: OWNER, total_supply: "1000000000", trading_start: String((await now()) + 600n), ...extra };
  const preview = await prepared("launchpad_preview_launch", args);
  const { result, events } = await run(label, "launchpad_prepare_create", {
    ...args, salt: preview.parameters.salt, preview_id: preview.preview_id, ...(withLogo(label) ? { logo_url: "https://example.org/logo.png" } : {}),
  });
  const created = events.find((event) => event.eventName === "LaunchCreated")!;
  const install = preview.installation;
  expect(created.args.poolId).toBe(install.pool_id);
  expect(getAddress(created.args.token as Address)).toBe(install.token);
  expect((created.args.liquidity as bigint).toString()).toBe(install.liquidity);
  expect(created.args.logoUrl).toBe(withLogo(label) ? "https://example.org/logo.png" : "");
  expect(getAddress(created.args.controller as Address)).toBe(chain.periphery);
  const owner = events.find((event) => event.eventName === "LaunchOwnerChanged")!;
  expect([owner.args.previousOwner, owner.args.newOwner]).toEqual([zeroAddress, OWNER]);
  const mints = events.filter((event) => event.eventName === "Transfer");
  expect(mints.map((event) => [event.args.to, (event.args.amount as bigint).toString()])).toEqual([
    [CORE, install.installed_supply], [zeroAddress, install.uninstalled_remainder],
  ]);
  expect(result.details.token).toBe(install.token);
  return { poolId: install.pool_id as Hex, token: install.token as Address, tradingStart: BigInt(args.trading_start) };
}

describe.skipIf(!enabled)("final launch lifecycle on a local anvil chain", () => {
  beforeAll(async () => {
    chain = await startChain();
    const api = mockApi(chain);
    spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      return url.origin === API ? api(url) : original(input, init);
    }) as typeof fetch);
  }, 60_000);
  afterAll(() => {
    (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
    chain?.stop();
    if (enabled && process.env.LAUNCHPAD_WRITE_FIXTURE === "1") {
      writeFileSync(new URL("../fixtures/launchpad/local-lifecycle.json", import.meta.url), `${JSON.stringify({
        scope: "LOCAL anvil chain only: frozen evm-contracts 853b608 init code, Core runtime and the production Yul router runtime; plans prepared by the launchpad tools through worker.fetch and sent with anvil dev keys.",
        deployment: { core: CORE, extension: chain.extension, periphery: chain.periphery, erc20_quote: chain.quote },
        plans: recorded,
      }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const plans = JSON.parse(JSON.stringify(recorded, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      writeFileSync(new URL("../fixtures/launchpad/wallet-handoff-final.json", import.meta.url), `${JSON.stringify(walletHandoff(plans, commit), null, 2)}\n`);
    }
  });

  test("create, trade, claim, transfer and claim by the new owner", async () => {
    const native = await create("native quote, empty logo", { name: "Zero Seed", symbol: "ZERO", ask_tick: -13815500, upper_tick: -9210300 });
    const erc20 = await create("erc20 quote, logo", { name: "Quote Seed", symbol: "QS", quote_token: chain.quote, start_price: "0.000001", upper_price: "0.0001" });
    const early = await callTool(chain.env, "launchpad_prepare_trade", { chain_id: "31337", sender: TRADER, pool_id: native.poolId, side: "buy", amount: "1" });
    expect(early.structuredContent.error.code).toBe("trading_not_started");
    await chain.test.setNextBlockTimestamp({ timestamp: native.tradingStart + 10n });
    await chain.test.mine({ blocks: 1 });

    const before = await balance(native.token, TRADER);
    const buy = await run("native buy", "launchpad_prepare_trade", { chain_id: "31337", sender: TRADER, pool_id: native.poolId, side: "buy", amount: parseEther("1").toString() });
    const bought = (await balance(native.token, TRADER)) - before;
    expect(bought).toBeGreaterThanOrEqual(BigInt(buy.result.details.minimum_amount_out));
    expect(buy.plan.ordered_steps.map((step) => step.kind)).toEqual(["execution"]);
    expect(buy.events.some((event) => event.eventName === "LaunchSwapped")).toBe(true);

    const sell = await run("native sell", "launchpad_prepare_trade", { chain_id: "31337", sender: TRADER, pool_id: native.poolId, side: "sell", amount: (bought / 2n).toString() });
    expect(sell.plan.ordered_steps.map((step) => step.kind)).toEqual(["approval", "execution"]);
    expect((await balance(native.token, TRADER))).toBe(bought - bought / 2n + before);

    const wallet = (await import("viem")).createWalletClient({ chain: chain.pub.chain, transport: (await import("viem")).http(chain.rpcUrl), account: ACCOUNTS[0] });
    await mined(chain.pub, await wallet.writeContract({ address: chain.quote, abi: erc20Abi, functionName: "transfer", args: [TRADER, parseEther("100")], chain: chain.pub.chain }));
    const erc20Buy = await run("erc20 buy", "launchpad_prepare_trade", { chain_id: "31337", sender: TRADER, pool_id: erc20.poolId, side: "buy", amount: parseEther("1").toString(), slippage_bps: 100 });
    expect(erc20Buy.plan.ordered_steps.map((step) => step.kind)).toEqual(["approval", "execution"]);

    const quoteBefore = await balance(zeroAddress, OWNER);
    const claim = await run("owner claim", "launchpad_prepare_claim_fees", { chain_id: "31337", sender: OWNER, pool_id: native.poolId });
    const extensionClaim = claim.events.find((event) => event.eventName === "CreatorFeesClaimed")!;
    const peripheryClaim = claim.events.find((event) => event.eventName === "LaunchFeesClaimed")!;
    expect([peripheryClaim.args.amount0, peripheryClaim.args.amount1]).toEqual([extensionClaim.args.amount0, extensionClaim.args.amount1]);
    expect((extensionClaim.args.amount0 as bigint) > 0n).toBe(true);
    expect(await balance(zeroAddress, OWNER)).toBeGreaterThan(quoteBefore);

    const transfer = await run("transfer", "launchpad_prepare_transfer_launch", { chain_id: "31337", sender: OWNER, pool_id: native.poolId, new_owner: NEW_OWNER });
    const changed = transfer.events.find((event) => event.eventName === "LaunchOwnerChanged")!;
    expect([changed.args.previousOwner, changed.args.newOwner]).toEqual([OWNER, NEW_OWNER]);
    const stale = await callTool(chain.env, "launchpad_prepare_claim_fees", { chain_id: "31337", sender: OWNER, pool_id: native.poolId });
    expect(stale.structuredContent.error.code).toBe("not_launch_owner");

    await run("second buy", "launchpad_prepare_trade", { chain_id: "31337", sender: TRADER, pool_id: native.poolId, side: "buy", amount: parseEther("0.5").toString() });
    const newOwnerBefore = await balance(zeroAddress, NEW_OWNER);
    const second = await run("new owner claim", "launchpad_prepare_claim_fees", { chain_id: "31337", sender: NEW_OWNER, pool_id: native.poolId });
    const paid = second.events.find((event) => event.eventName === "LaunchFeesClaimed")!;
    expect(paid.args.owner).toBe(NEW_OWNER);
    expect(await balance(zeroAddress, NEW_OWNER)).toBeGreaterThan(newOwnerBefore - parseEther("0.01"));

    const detail = await callTool(chain.env, "launchpad_get_launch", { chain_id: "31337", pool_id: native.poolId });
    expect(detail.structuredContent.onchain.owner).toBe(NEW_OWNER);
    expect(detail.structuredContent.onchain.unclaimed_fees.amount0).toBe("0");
  }, 120_000);
});
