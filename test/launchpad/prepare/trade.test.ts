import { describe, expect, it } from "bun:test";
import { decodeFunctionData, encodeFunctionData, erc20Abi, type Hex, zeroAddress } from "viem";
import { launchpadPrepareAdvance } from "../../../src/launchpad/prepare/advance.js";
import { launchRouterAbi, lockedLaunchLiquidityAbi, routerAbi, scheduledLaunchAbi } from "../../../src/launchpad/prepare/contracts.js";
import { MAX_TICK, MIN_TICK, poolId, sqrtRatioAtTick } from "../../../src/launchpad/prepare/encoding.js";
import { launchpadPrepareTrade } from "../../../src/launchpad/prepare/trade.js";
import { BLOCK, C, env, FakeChain, launchFixture, launchKey, log, SENDER, TEST_QUOTE_HIGH, TOKEN } from "./fake-chain.js";
import type { Json } from "./helpers.js";

const E18 = 10n ** 18n;
const MASK_128 = (1n << 128n) - 1n;

function tradeArgs(overrides: Record<string, unknown> = {}) {
  return { chain_id: 1, sender: SENDER, slippage_bps: 100, token: TOKEN, side: "buy", amount_kind: "exact_input", amount: E18.toString(), ...overrides };
}

async function trade(chain: FakeChain, overrides: Record<string, unknown> = {}): Promise<Json> {
  return launchpadPrepareTrade(env({ test_quote_token: TEST_QUOTE_HIGH }), tradeArgs(overrides) as never, () => chain);
}

async function tradeError(chain: FakeChain, overrides: Record<string, unknown> = {}) {
  try {
    await trade(chain, overrides);
  } catch (error) {
    return error as { code: string; details: Record<string, unknown> };
  }
  throw new Error("expected a rejection");
}

function params(word: Hex) {
  const value = BigInt(word);
  const amount = (value >> 32n) & MASK_128;
  return {
    sqrtRatioLimit: value >> 160n,
    amount: amount > (1n << 127n) - 1n ? amount - (1n << 128n) : amount,
    isToken1: ((value >> 31n) & 1n) === 1n,
  };
}

function launchSwap(data: Hex) {
  const decoded = decodeFunctionData({ abi: launchRouterAbi, data });
  expect(decoded.functionName).toBe("swap");
  const [key, swapParams, threshold, recipient, deadline] = decoded.args as unknown as [Json, Hex, bigint, string, bigint];
  return { key, params: params(swapParams), threshold, recipient, deadline };
}

describe("launchpad_prepare_trade in the launch phase", () => {
  it("prepares a native-ETH exact-input buy against the manifest ABI with the quote's threshold", async () => {
    const chain = new FakeChain();
    // Native ETH is token0, so the launch token is token1.
    chain.launchQuote = { update: { delta0: E18, delta1: -(5_000n * E18) }, fee: (1n << 64n) / 25n };
    const result = await trade(chain);
    const steps = result.execution_plan.ordered_steps;
    expect(steps).toHaveLength(1);
    expect(steps[0].transaction).toMatchObject({ from: SENDER, chain_id: "1", to: C.launchRouter, value: E18.toString() });
    const swap = launchSwap(steps[0].transaction.data);
    expect(swap.key).toEqual(launchKey(launchFixture()));
    expect(swap.params.amount).toBe(E18);
    expect(swap.params.isToken1).toBe(false);
    expect(swap.threshold).toBe((5_000n * E18 * 9_900n) / 10_000n);
    expect(swap.recipient).toBe(SENDER);
    expect(swap.deadline).toBe(BLOCK.timestamp + 1200n);
    expect(result.threshold).toMatchObject({ calculated_amount_threshold: swap.threshold.toString(), meaning: "minimum_output" });
    expect(result.quote).toMatchObject({ contract: C.launchRouter, calculated_amount: (5_000n * E18).toString(), fee_inclusive: true });
    expect(result.quote.fee_rate.percent).toBe("4%");
  });

  it("quotes at the stated block from the sender", async () => {
    const chain = new FakeChain();
    chain.launchQuote = { update: { delta0: E18, delta1: -E18 }, fee: 0n };
    const result = await trade(chain);
    expect(chain.calls.length).toBeGreaterThan(0);
    for (const call of chain.calls) {
      expect(call.block).toEqual(BLOCK);
      expect(call.from).toBe(SENDER);
    }
    const quoteCall = chain.calls.find((call) => call.to === C.launchRouter)!;
    const quoted = decodeFunctionData({ abi: launchRouterAbi, data: quoteCall.data });
    expect(quoted.functionName).toBe("quote");
    const swap = launchSwap(result.execution_plan.ordered_steps[0].transaction.data);
    expect((quoted.args as unknown as [Json, Hex])[1]).toBe(
      `0x${((swap.params.sqrtRatioLimit << 160n) | ((swap.params.amount & MASK_128) << 32n)).toString(16).padStart(64, "0")}`,
    );
    expect(result.as_of).toMatchObject({ block_number: BLOCK.number.toString(), block_hash: BLOCK.hash });
  });

  it("sets a buy's price limit to the top of the launch range, never the default", async () => {
    for (const quoteToken of [zeroAddress, TEST_QUOTE_HIGH]) {
      const launch = launchFixture({ quoteToken });
      const chain = new FakeChain(launch);
      const tokenIs0 = quoteToken === TEST_QUOTE_HIGH;
      chain.launchQuote = { update: tokenIs0 ? { delta0: -E18, delta1: E18 } : { delta0: E18, delta1: -E18 }, fee: 0n };
      const result = await trade(chain);
      const step = result.execution_plan.ordered_steps.at(-1).transaction;
      const { params: p } = launchSwap(step.data);
      const top = tokenIs0 ? launch.upperTick : -launch.upperTick;
      expect(p.sqrtRatioLimit).toBe(sqrtRatioAtTick(top));
      expect(p.sqrtRatioLimit).not.toBe(0n);
      expect(p.sqrtRatioLimit).not.toBe(sqrtRatioAtTick(MIN_TICK));
      expect(p.sqrtRatioLimit).not.toBe(sqrtRatioAtTick(MAX_TICK));
      expect(result.price_limit).toMatchObject({ pool_tick: top, position: "top_of_launch_range" });
    }
  });

  it("sets a sell's price limit to the bottom of the launch range and approves the launch token", async () => {
    const launch = launchFixture();
    const chain = new FakeChain(launch);
    chain.launchQuote = { update: { delta0: -E18, delta1: 1_000n * E18 }, fee: 0n };
    const result = await trade(chain, { side: "sell", amount: (1_000n * E18).toString() });
    const [approve, swap] = result.execution_plan.ordered_steps;
    expect(approve.transaction.to).toBe(TOKEN);
    expect(approve.transaction.data).toBe(
      encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [C.launchRouter, 1_000n * E18] }),
    );
    const decoded = launchSwap(swap.transaction.data);
    expect(decoded.params).toMatchObject({ isToken1: true, amount: 1_000n * E18, sqrtRatioLimit: sqrtRatioAtTick(-launch.targetTick) });
    expect(swap.transaction.value).toBe("0");
    expect(result.execution_plan.ordered_steps).toHaveLength(2);
  });

  it("bounds an ERC-20 exact-output buy by the slippage-adjusted maximum and clears the allowance after", async () => {
    const chain = new FakeChain(launchFixture({ quoteToken: TEST_QUOTE_HIGH }));
    // Launch token is token0: the pool pays out token0 and takes token1.
    chain.launchQuote = { update: { delta0: -(500n * E18), delta1: 333_333n }, fee: 0n };
    const result = await trade(chain, { amount_kind: "exact_output", amount: (500n * E18).toString() });
    const maxIn = (333_333n * 10_100n + 9_999n) / 10_000n;
    const steps = result.execution_plan.ordered_steps;
    expect(steps.map((s: Json) => s.kind)).toEqual(["approval", "execution", "allowance_cleanup"]);
    expect(steps[0].transaction.data).toBe(encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [C.launchRouter, maxIn] }));
    expect(steps[2].transaction.data).toBe(encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [C.launchRouter, 0n] }));
    const swap = launchSwap(steps[1].transaction.data);
    expect(swap.params).toMatchObject({ amount: -(500n * E18), isToken1: false });
    expect(swap.threshold).toBe(-maxIn);
    expect(result.threshold.meaning).toBe("maximum_input");
    expect(result.max_payment).toEqual({ token: TEST_QUOTE_HIGH, amount: maxIn.toString() });
  });

  it("refuses an exact-output buy the quote cannot fill", async () => {
    const chain = new FakeChain(launchFixture({ quoteToken: TEST_QUOTE_HIGH }));
    chain.launchQuote = { update: { delta0: -(200n * E18), delta1: 100n }, fee: 0n };
    const error = await tradeError(chain, { amount_kind: "exact_output", amount: (500n * E18).toString() });
    expect(error.code).toBe("partial_fill_not_allowed");
    expect(error.details.fillable_amount).toBe((200n * E18).toString());
  });

  it("warns on a partially filled exact-input buy, thresholds the filled output and clears an ERC-20 allowance", async () => {
    const chain = new FakeChain(launchFixture({ quoteToken: TEST_QUOTE_HIGH }));
    chain.launchQuote = { update: { delta0: -(7n * E18), delta1: 400_000n }, fee: 0n };
    const result = await trade(chain, { amount: "1000000" });
    expect(result.warnings.map((w: Json) => w.code)).toEqual(["partial_fill"]);
    expect(result.quote.filled_specified_amount).toBe("400000");
    const steps = result.execution_plan.ordered_steps;
    expect(steps.map((s: Json) => s.kind)).toEqual(["approval", "execution", "allowance_cleanup"]);
    expect(launchSwap(steps[1].transaction.data).threshold).toBe((7n * E18 * 9_900n) / 10_000n);
  });

  it("requires slippage_bps with no default and binds the chain", async () => {
    const { slippage_bps: _omitted, ...rest } = tradeArgs();
    await expect(launchpadPrepareTrade(env(), rest as never, () => new FakeChain())).rejects.toThrow();
    const error = await tradeError(new FakeChain(), { chain_id: 10 });
    expect(error.code).toBe("unsupported_chain");
  });

  it("refuses launches that have not started or need an advance, and unknown tokens", async () => {
    const scheduled = new FakeChain(launchFixture({ startTime: BLOCK.timestamp + 10n }));
    expect((await tradeError(scheduled)).code).toBe("launch_not_started");
    const ended = new FakeChain(launchFixture({ endTime: BLOCK.timestamp - 1n }));
    expect((await tradeError(ended)).code).toBe("launch_needs_advance");
    expect((await tradeError(new FakeChain(null))).code).toBe("launch_not_found");
  });
});

describe("launchpad_prepare_trade after completion", () => {
  const complete = () => launchFixture({ endTime: BLOCK.timestamp - 1n, complete: true });

  it("swaps on the terminal pool through the standard router and refunds unused native input", async () => {
    const launch = complete();
    const chain = new FakeChain(launch);
    // Exact output of the launch token (token1), paid in native ETH (token0).
    chain.routerQuote = { delta0: 2n * E18, delta1: -(100n * E18) };
    const result = await trade(chain, { amount_kind: "exact_output", amount: (100n * E18).toString() });
    expect(result.trading_phase).toBe("terminal");
    const step = result.execution_plan.ordered_steps[0].transaction;
    const maxIn = (2n * E18 * 10_100n + 9_999n) / 10_000n;
    expect(step).toMatchObject({ to: C.router, value: maxIn.toString(), from: SENDER });
    const multicall = decodeFunctionData({ abi: routerAbi, data: step.data });
    expect(multicall.functionName).toBe("multicall");
    const [swapData, refundData] = (multicall.args as unknown as [Hex[]])[0];
    expect(refundData).toBe(encodeFunctionData({ abi: routerAbi, functionName: "refundNativeToken" }));
    const swap = decodeFunctionData({ abi: routerAbi, data: swapData });
    const [key, p, threshold, recipient] = swap.args as unknown as [Json, Hex, bigint, string];
    expect(key.token1).toBe(TOKEN);
    expect((BigInt(key.config) >> 96n).toString(16)).toBe(BigInt(C.twamm).toString(16));
    expect(params(p)).toMatchObject({ amount: -(100n * E18), isToken1: true, sqrtRatioLimit: 0n });
    expect(threshold).toBe(-maxIn);
    expect(recipient).toBe(SENDER);
    expect(result.fees[0]).toMatchObject({ fee: "terminal_pool_fee", rate: { percent: "0.5%" } });
  });

  it("refuses any partial fill on the terminal pool", async () => {
    const chain = new FakeChain(complete());
    chain.routerQuote = { delta0: E18 / 2n, delta1: -(10n * E18) };
    expect((await tradeError(chain)).code).toBe("partial_fill_not_allowed");
  });
});

describe("launchpad_prepare_advance", () => {
  const advance = (chain: FakeChain): Promise<Json> =>
    launchpadPrepareAdvance(env(), { chain_id: 1, sender: SENDER, slippage_bps: 0, token: TOKEN }, () => chain);

  it("prepares ScheduledLaunch.advance while running and after end_time", async () => {
    for (const launch of [launchFixture(), launchFixture({ endTime: BLOCK.timestamp - 1n })]) {
      const result = await advance(new FakeChain(launch));
      const step = result.execution_plan.ordered_steps[0].transaction;
      expect(step).toMatchObject({ to: C.scheduledLaunch, from: SENDER, value: "0" });
      const decoded = decodeFunctionData({ abi: scheduledLaunchAbi, data: step.data });
      expect(decoded.functionName).toBe("advance");
      expect(decoded.args).toEqual([launchKey(launch)]);
      expect(result.action).toBe("advance");
    }
  });

  it("prepares LockedLaunchLiquidity.migrate only while principal waits", async () => {
    const launch = launchFixture({ endTime: BLOCK.timestamp - 1n, complete: true });
    const pending = new FakeChain(launch);
    pending.principalReceived = [log(100n, 1), log(200n, 0)];
    pending.liquidityLocked = [log(100n, 2)];
    const result = await advance(pending);
    const step = result.execution_plan.ordered_steps[0].transaction;
    expect(step.to).toBe(C.locked);
    expect(decodeFunctionData({ abi: lockedLaunchLiquidityAbi, data: step.data }).args).toEqual([poolId(launchKey(launch))]);
    const migrated = new FakeChain(launch);
    migrated.principalReceived = [log(100n, 1)];
    migrated.liquidityLocked = [log(100n, 2)];
    await expect(advance(migrated)).rejects.toMatchObject({ code: "nothing_to_advance", details: { phase: "migrated" } });
  });

  it("refuses a launch that has not started", async () => {
    await expect(advance(new FakeChain(launchFixture({ startTime: BLOCK.timestamp + 1n })))).rejects.toMatchObject({
      code: "nothing_to_advance",
    });
  });
});
