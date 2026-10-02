import { describe, expect, it } from "bun:test";
import { decodeFunctionData, encodeFunctionData, erc20Abi, type Hex, zeroAddress } from "viem";
import { launchRouterAbi } from "../../../src/launchpad/prepare/contracts.js";
import { FINAL_FEE_CAP, INITIAL_FEE_CAP, launchpadPrepareCreate } from "../../../src/launchpad/prepare/create.js";
import { BLOCK, C, env, FakeChain, OTHER, SENDER, TEST_QUOTE_HIGH } from "./fake-chain.js";
import { create, createArgs, type Json, rejection } from "./helpers.js";

function decodeCreate(data: Hex) {
  const decoded = decodeFunctionData({ abi: launchRouterAbi, data });
  expect(decoded.functionName).toBe("create");
  return decoded.args as unknown as [Record<string, unknown>, bigint];
}

describe("launchpad_prepare_create plan", () => {
  it("decodes against the manifest ABI to exactly the requested LaunchConfig", async () => {
    const result = await create();
    const plan = result.execution_plan;
    expect(plan.ordered_steps).toHaveLength(1);
    const step = plan.ordered_steps[0].transaction;
    expect(step.to).toBe(C.launchRouter);
    expect(step.value).toBe((10n ** 16n).toString());
    const [config, deadline] = decodeCreate(step.data);
    const args = createArgs();
    expect(config).toEqual({
      owner: SENDER,
      quoteToken: zeroAddress,
      name: args.name,
      symbol: args.symbol,
      decimals: 18,
      totalSupply: 10n ** 27n,
      quoteAmount: 10n ** 16n,
      startTime: BigInt(args.start_time),
      endTime: BigInt(args.end_time),
      targetTick: args.target_tick,
      upperTick: args.upper_tick,
      tickSpacing: 1000,
      initialFee: BigInt(args.initial_fee),
      finalFee: BigInt(args.final_fee),
      migrationTickLower: args.migration_tick_lower,
      migrationTickUpper: args.migration_tick_upper,
    });
    expect(deadline).toBe(BLOCK.timestamp + 1200n);
    expect(result.deadline).toBe(deadline.toString());
  });

  it("binds sender and chain into the plan and every step", async () => {
    const result = await create();
    const plan = result.execution_plan;
    expect(plan.sender).toBe(SENDER);
    expect(plan.chain_id).toBe("1");
    expect(plan.caip2_chain_id).toBe("eip155:1");
    for (const step of plan.ordered_steps) {
      expect(step.transaction.from).toBe(SENDER);
      expect(step.transaction.chain_id).toBe("1");
    }
    expect(result.transaction_sender).toBe(SENDER);
    expect(result.payer).toBe(SENDER);
    expect(result.as_of).toEqual({
      chain_id: 1,
      block_number: BLOCK.number.toString(),
      block_hash: BLOCK.hash,
      block_timestamp: BLOCK.timestamp.toString(),
    });
  });

  it("orders an ERC-20 quote approval before create, for exactly the seed, with no value", async () => {
    const result = await create({ quote_token: TEST_QUOTE_HIGH }, { test_quote_token: TEST_QUOTE_HIGH });
    const steps = result.execution_plan.ordered_steps;
    expect(steps.map((s: Json) => s.kind)).toEqual(["approval", "execution"]);
    expect(steps[0].transaction.to).toBe(TEST_QUOTE_HIGH);
    expect(steps[0].transaction.data).toBe(
      encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [C.launchRouter, 10n ** 16n] }),
    );
    expect(steps[1].transaction.value).toBe("0");
    expect(decodeCreate(steps[1].transaction.data)[0].quoteToken).toBe(TEST_QUOTE_HIGH);
    expect(result.launch.quote_decimals).toBe(6);
  });

  it("names the fee beneficiary and warns only when it is not the sender", async () => {
    const same = await create();
    expect(same.beneficiary).toBe(SENDER);
    expect(same.warnings.map((w: Json) => w.code)).not.toContain("beneficiary_differs_from_sender");
    const other = await create({ owner: OTHER });
    expect(other.beneficiary).toBe(OTHER);
    expect(other.beneficiary_is_sender).toBe(false);
    expect(other.warnings.map((w: Json) => w.code)).toContain("beneficiary_differs_from_sender");
    expect(decodeCreate(other.execution_plan.ordered_steps[0].transaction.data)[0].owner).toBe(OTHER);
  });

  it("echoes migration bounds as ticks matching the calldata, and as prices, with the lock statement", async () => {
    const result = await create();
    const [config] = decodeCreate(result.execution_plan.ordered_steps[0].transaction.data);
    expect(result.migration_bounds.tick_lower).toBe(config.migrationTickLower);
    expect(result.migration_bounds.tick_upper).toBe(config.migrationTickUpper);
    // 1.000001^-30e6 ≈ 9.36e-14 raw quote per raw token; both 18 decimals.
    expect(Number(result.migration_bounds.price_lower)).toBeCloseTo(Math.exp(-30_000_000 * Math.log1p(1e-6)), 18);
    expect(result.migration_bounds.note).toContain("Principal stays locked until the terminal pool price is inside these bounds");
  });

  it("adjusts echoed prices for decimals", async () => {
    const result = await create({ quote_token: TEST_QUOTE_HIGH, migration_tick_lower: 0, migration_tick_upper: 1000 }, { test_quote_token: TEST_QUOTE_HIGH });
    // Tick 0 is one raw quote unit per raw token: 10^(18-6) quote per whole token.
    expect(result.migration_bounds.price_lower).toBe("1.00000e+12");
  });
});

describe("launchpad_prepare_create rejections", () => {
  it("rejects an initial fee above the 10% hosted cap", async () => {
    expect(await rejection({ initial_fee: (INITIAL_FEE_CAP + 1n).toString() })).toMatchObject({
      code: "fee_above_cap",
      details: { field: "initial_fee", cap_q64: INITIAL_FEE_CAP.toString() },
    });
    expect(await create({ initial_fee: INITIAL_FEE_CAP.toString() })).toHaveProperty("execution_plan");
  });

  it("rejects a final fee above the 1% hosted cap", async () => {
    expect(await rejection({ final_fee: (FINAL_FEE_CAP + 1n).toString() })).toMatchObject({
      code: "fee_above_cap",
      details: { field: "final_fee" },
    });
  });

  it("rejects a quote asset outside the allowlist", async () => {
    const outcome = await rejection({ quote_token: TEST_QUOTE_HIGH });
    expect(outcome).toMatchObject({ code: "quote_asset_not_allowed", details: { allowed_quote_tokens: [zeroAddress] } });
  });

  it("rejects a start time that is not in the future", async () => {
    for (const start of [Number(BLOCK.timestamp), Number(BLOCK.timestamp) - 1]) {
      expect(await rejection({ start_time: start })).toMatchObject({
        code: "start_time_not_future",
        details: { block_timestamp: BLOCK.timestamp.toString() },
      });
    }
  });

  it("rejects a name or symbol over 31 UTF-8 bytes, counting bytes not characters", async () => {
    expect(await rejection({ name: "N".repeat(32) })).toMatchObject({ code: "string_too_long", details: { field: "name" } });
    expect(await rejection({ symbol: "€".repeat(11) })).toMatchObject({ code: "string_too_long", details: { field: "symbol" } });
    expect(await rejection({ symbol: "" })).toMatchObject({ code: "string_too_long", details: { field: "symbol" } });
    expect(await create({ name: "N".repeat(31), symbol: "€".repeat(10) })).toHaveProperty("execution_plan");
  });

  it("rejects another chain and a manifest from another contract revision", async () => {
    expect(await rejection({ chain_id: 8453 })).toMatchObject({ code: "unsupported_chain", details: { supported_chain_id: 1 } });
    expect(await rejection({}, { git_revision: "0".repeat(40) })).toMatchObject({ code: "abi_revision_mismatch" });
  });

  it("requires sender and slippage_bps, with no default", async () => {
    const args = createArgs();
    for (const field of ["sender", "slippage_bps"] as const) {
      const { [field]: _omitted, ...rest } = args;
      await expect(launchpadPrepareCreate(env(), rest as never, () => new FakeChain())).rejects.toThrow();
    }
  });

  it("rejects fee order, schedule and range errors before encoding", async () => {
    expect((await rejection({ initial_fee: "1", final_fee: "2" })).code).toBe("fee_order");
    expect((await rejection({ end_time: Number(BLOCK.timestamp) + 3600 })).code).toBe("invalid_schedule");
    expect((await rejection({ target_tick: -18_420_000 })).code).toBe("invalid_ticks");
    expect((await rejection({ target_tick: -27_631_500 })).code).toBe("invalid_ticks");
    expect((await rejection({ migration_tick_lower: 0, migration_tick_upper: 0 })).code).toBe("invalid_migration_bounds");
    expect((await rejection({ total_supply: "0" })).code).toBe("invalid_supply");
  });
});

