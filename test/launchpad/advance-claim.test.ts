import { describe, expect, it } from "bun:test";
import { decodeFunctionData, encodeErrorResult, zeroAddress } from "viem";
import { launchpadPrepareAdvance } from "../../src/launchpad/prepare/advance.js";
import { launchpadPrepareClaim } from "../../src/launchpad/prepare/claim.js";
import { launchRouterAbi, lockedLaunchLiquidityAbi, scheduledLaunchAbi } from "../../src/launchpad/prepare/contracts.js";
import { BLOCK, C, env, failure, harness, type Json, launchFixture, launchKey, launchPoolId, OTHER, SENDER, TOKEN } from "./fake.js";

const args = (overrides: Record<string, unknown> = {}) => ({ chain_id: 1, sender: SENDER, slippage_bps: 0, token: TOKEN, ...overrides });

describe("launchpad_prepare_advance", () => {
  it("prepares ScheduledLaunch.advance(PoolKey) while running and after end_time, from any sender", async () => {
    for (const launch of [launchFixture(), launchFixture({ endTime: BLOCK.timestamp })]) {
      const { deps, chain } = harness(launch);
      const result: Json = await launchpadPrepareAdvance(env(), args({ sender: OTHER }), deps);
      const step = result.execution_plan.ordered_steps[0].transaction;
      expect(step).toMatchObject({ to: C.scheduled_launch, value: "0", from: OTHER });
      expect(decodeFunctionData({ abi: scheduledLaunchAbi, data: step.data })).toEqual({ functionName: "advance", args: [launchKey(launch)] });
      expect(result).toMatchObject({ action: "advance", contract: C.scheduled_launch, principal_pending: null });
      expect(chain.methods).toEqual({ eth_getBlockByNumber: 1, eth_getCode: 6, eth_call: 6 });
    }
  });

  it("prepares LockedLaunchLiquidity.migrate(launchId) only while principal is saved in Core", async () => {
    const launch = launchFixture({ endTime: BLOCK.timestamp - 1n, complete: true });
    const pending = harness(launch);
    pending.chain.pending = { amount0: 5n, amount1: 0n };
    const result: Json = await launchpadPrepareAdvance(env(), args(), pending.deps);
    const step = result.execution_plan.ordered_steps[0].transaction;
    expect(step.to).toBe(C.locked_launch_liquidity);
    expect(decodeFunctionData({ abi: lockedLaunchLiquidityAbi, data: step.data })).toEqual({ functionName: "migrate", args: [launchPoolId(launch)] });
    expect(result.principal_pending).toEqual({ amount0: "5", amount1: "0" });
    expect(pending.chain.methods).toEqual({ eth_getBlockByNumber: 1, eth_getCode: 6, eth_call: 6, eth_getStorageAt: 1 });

    const done = harness(launch);
    expect(await failure(() => launchpadPrepareAdvance(env(), args(), done.deps))).toMatchObject({ code: "nothing_to_advance", details: { phase: "migrated" } });
  });

  it("refuses a launch that has not started", async () => {
    const { deps } = harness(launchFixture({ startTime: BLOCK.timestamp + 1n }));
    expect(await failure(() => launchpadPrepareAdvance(env(), args(), deps))).toMatchObject({ code: "nothing_to_advance", details: { phase: "scheduled" } });
  });
});

describe("launchpad_prepare_claim_fees", () => {
  it("prepares LaunchRouter.claimFees(PoolKey, recipient) for the creator, with the claimable amounts at the block", async () => {
    const { deps, chain } = harness();
    chain.claimable = { amount0: 7n, amount1: 3n };
    const result: Json = await launchpadPrepareClaim(env(), args({ recipient: OTHER }), deps);
    const step = result.execution_plan.ordered_steps[0].transaction;
    expect(step).toMatchObject({ to: C.launch_router, value: "0", from: SENDER });
    expect(decodeFunctionData({ abi: launchRouterAbi, data: step.data })).toEqual({ functionName: "claimFees", args: [launchKey(launchFixture()), OTHER] });
    expect(result).toMatchObject({
      action: "claim_creator_fees",
      creator: SENDER,
      recipient: OTHER,
      claimable_at_block: [
        { token: zeroAddress, amount: "7" },
        { token: TOKEN, amount: "3" },
      ],
      warnings: [],
    });
    expect(chain.methods).toEqual({ eth_getBlockByNumber: 1, eth_getCode: 6, eth_call: 8 });
  });

  it("defaults the recipient to sender and warns when nothing is claimable", async () => {
    const { deps } = harness();
    const result: Json = await launchpadPrepareClaim(env(), args(), deps);
    expect(result.recipient).toBe(SENDER);
    expect(result.warnings.map((w: Json) => w.code)).toEqual(["nothing_to_claim"]);
  });

  it("refuses anyone but the router's recorded creator, and a launch without one", async () => {
    const other = harness();
    expect(await failure(() => launchpadPrepareClaim(env(), args({ sender: OTHER }), other.deps))).toMatchObject({ code: "creator_only", details: { creator: SENDER } });
    const direct = harness(launchFixture({ creator: zeroAddress }));
    expect(await failure(() => launchpadPrepareClaim(env(), args(), direct.deps))).toMatchObject({ code: "not_router_launch" });
  });

  it("reports a reverted claim with its contract error", async () => {
    const { deps, chain } = harness();
    chain.claimRevert = encodeErrorResult({ abi: launchRouterAbi, errorName: "InvalidRecipient" });
    expect(await failure(() => launchpadPrepareClaim(env(), args(), deps))).toMatchObject({ code: "claim_reverted", details: { error_name: "InvalidRecipient" } });
  });
});
