import { describe, expect, it } from "bun:test";
import { decodeFunctionData, type Hex, zeroAddress } from "viem";
import { launchRouterAbi } from "../../src/launchpad/prepare/contracts.js";
import { FINAL_FEE_CAP, INITIAL_FEE_CAP, launchpadPrepareCreate } from "../../src/launchpad/prepare/create.js";
import { HOSTED_MAX_MIGRATION_TICK_WIDTH, MAX_MIGRATION_TICK_WIDTH } from "../../src/launchpad/prepare/encoding.js";
import { BLOCK, C, env, failure, harness, type Json, OTHER, SENDER } from "./fake.js";
import { create, createArgs, createRejection } from "./helpers.js";

function decodeCreate(data: Hex) {
  const decoded = decodeFunctionData({ abi: launchRouterAbi, data });
  expect(decoded.functionName).toBe("create");
  return decoded.args as unknown as [Record<string, unknown>];
}

describe("launchpad_prepare_create plan", () => {
  it("is one LaunchRouter.create step decoding to exactly the requested LaunchConfig, with no value or approval", async () => {
    const result = await create();
    const plan = result.execution_plan;
    expect(plan.ordered_steps).toHaveLength(1);
    const step = plan.ordered_steps[0].transaction;
    expect(step.to).toBe(C.launch_router);
    expect(step.value).toBe("0");
    const args = createArgs();
    expect(decodeCreate(step.data)).toEqual([
      {
        owner: C.launch_router,
        quoteToken: zeroAddress,
        name: args.name,
        symbol: args.symbol,
        decimals: 18,
        totalSupply: 10n ** 27n,
        startTime: BigInt(args.start_time),
        endTime: BigInt(args.end_time),
        targetTick: args.target_tick,
        upperTick: args.upper_tick,
        tickSpacing: 1000,
        initialFee: BigInt(args.initial_fee),
        finalFee: BigInt(args.final_fee),
        migrationTickLower: args.migration_tick_lower,
        migrationTickUpper: args.migration_tick_upper,
      },
    ]);
    expect(result).toMatchObject({ action: "create_launch", contract: C.launch_router, value: "0", token_approvals: [], reference: null });
  });

  it("binds sender and chain into the plan and names the signer as fee claimant (K3)", async () => {
    const result = await create();
    const plan = result.execution_plan;
    expect(plan.sender).toBe(SENDER);
    expect(plan.chain_id).toBe("1");
    for (const step of plan.ordered_steps) {
      expect(step.transaction.from).toBe(SENDER);
      expect(step.transaction.chain_id).toBe("1");
    }
    expect(result.fee_claimant).toBe(SENDER);
    expect(result.warnings.map((w: Json) => w.code)).toEqual(["creator_is_permanent", "migration_may_stay_pending"]);
    expect(result.as_of).toEqual({
      chain_id: 1,
      block_number: BLOCK.number.toString(),
      block_hash: BLOCK.hash,
      block_timestamp: BLOCK.timestamp.toString(),
    });
  });

  it("echoes migration bounds as ticks matching the calldata, and as prices, with the lock statement", async () => {
    const result = await create();
    expect(result.migration_bounds).toMatchObject({ tick_lower: -20_000_000, tick_upper: -19_500_000, unit: "quote per whole launch token" });
    expect(Number(result.migration_bounds.price_lower)).toBeCloseTo(Math.exp(-20_000_000 * Math.log1p(1e-6)), 12);
    expect(result.migration_bounds.note).toContain("never withdrawable");
  });

  it("warns when start_time falls within 20 minutes of the stated block", async () => {
    const result = await create({ start_time: Number(BLOCK.timestamp) + 60, end_time: Number(BLOCK.timestamp) + 7200 });
    expect(result.warnings[0].code).toBe("start_time_soon");
  });
});

describe("launchpad_prepare_create hosted rules", () => {
  it("accepts only native ETH as the quote asset (C2)", async () => {
    expect(await createRejection({ quote_token: OTHER })).toMatchObject({
      code: "quote_asset_not_allowed",
      details: { allowed_quote_tokens: [zeroAddress] },
    });
  });

  it("refuses a manifest naming a test quote token or a reference tier (C2, C3)", async () => {
    expect(await createRejection({}, { test_quote_token: OTHER })).toMatchObject({ code: "invalid_manifest", details: { field: "test_quote_token" } });
    expect(await createRejection({}, { reference_tier: { width: 1 } })).toMatchObject({ code: "invalid_manifest", details: { field: "reference_tier" } });
    expect((await create({}, { reference_tier: null })).reference).toBeNull();
  });

  it(`refuses migration bounds wider than the hosted ${HOSTED_MAX_MIGRATION_TICK_WIDTH} ticks, below the contract's ${MAX_MIGRATION_TICK_WIDTH}`, async () => {
    const width = (lower: number, w: number) => ({ migration_tick_lower: lower, migration_tick_upper: lower + w });
    expect((await create(width(-20_000_000, HOSTED_MAX_MIGRATION_TICK_WIDTH))).migration_bounds.tick_upper).toBe(-20_000_000 + 693_147);
    for (const w of [HOSTED_MAX_MIGRATION_TICK_WIDTH + 1, MAX_MIGRATION_TICK_WIDTH]) {
      expect(await createRejection(width(-20_000_000, w))).toMatchObject({
        code: "migration_bounds_too_wide",
        details: { width_ticks: w, max_width_ticks: 693_147 },
      });
    }
  });

  it("rejects fees above the hosted caps and an increasing fee", async () => {
    expect(await createRejection({ initial_fee: (INITIAL_FEE_CAP + 1n).toString() })).toMatchObject({ code: "fee_above_cap", details: { field: "initial_fee" } });
    expect(await createRejection({ final_fee: (FINAL_FEE_CAP + 1n).toString() })).toMatchObject({ code: "fee_above_cap", details: { field: "final_fee" } });
    expect(await createRejection({ initial_fee: "1", final_fee: "2" })).toMatchObject({ code: "fee_order" });
  });

  it("rejects a start time that is not in the future, and schedule and range errors", async () => {
    expect(await createRejection({ start_time: Number(BLOCK.timestamp) })).toMatchObject({
      code: "start_time_not_future",
      details: { block_timestamp: BLOCK.timestamp.toString() },
    });
    expect(await createRejection({ end_time: Number(BLOCK.timestamp) + 3600 })).toMatchObject({ code: "invalid_schedule" });
    expect(await createRejection({ upper_tick: -27_631_000 })).toMatchObject({ code: "invalid_ticks", details: { field: "upper_tick" } });
    expect(await createRejection({ target_tick: -27_631_500 })).toMatchObject({ code: "invalid_ticks", details: { field: "target_tick" } });
    expect(await createRejection({ migration_tick_lower: -19_000_000 })).toMatchObject({ code: "invalid_migration_bounds" });
    expect(await createRejection({ total_supply: "0" })).toMatchObject({ code: "invalid_supply" });
  });

  it("rejects a name or symbol over 31 UTF-8 bytes, counting bytes not characters", async () => {
    expect(await createRejection({ name: "é".repeat(16) })).toMatchObject({ code: "string_too_long", details: { field: "name", max_bytes: 31 } });
    expect((await create({ symbol: "é".repeat(15) })).untrusted.symbol).toBe("é".repeat(15));
    expect(await createRejection({ symbol: "" })).toMatchObject({ code: "string_too_long", details: { field: "symbol" } });
  });

  it("requires sender and slippage_bps with no default, and refuses another chain", async () => {
    const { deps } = harness();
    for (const missing of ["sender", "slippage_bps"]) {
      const args: Json = createArgs();
      delete args[missing];
      expect((await failure(() => launchpadPrepareCreate(env(), args, deps))).code).toBe("schema");
    }
    expect(await createRejection({ chain_id: 8453 })).toMatchObject({ code: "unsupported_chain", details: { supported_chain_id: 1 } });
  });
});
