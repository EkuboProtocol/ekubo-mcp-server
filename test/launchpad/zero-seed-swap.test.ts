import { describe, expect, test } from "bun:test";
import { YUL_ROUTER_ADDRESS } from "@ekubo/yul-router-sdk";
import { type Address, encodeAbiParameters, type Hex, pad, toHex, zeroAddress } from "viem";
import { feeAt, feeInclusiveDelta } from "../../src/launchpad/zero-seed/fee.js";
import { BACKEND_REPLAY_PINS, LOCAL_INSTANCE_PINS, NATIVE_QUOTE } from "../../src/launchpad/zero-seed/policy.js";
import { localSwapFromQuote, ZERO_SEED_ROUTER } from "../../src/launchpad/zero-seed/swap.js";
import golden from "../fixtures/launchpad/zero-seed-api-v3-2429547.golden.json";
import fixture from "../fixtures/launchpad/zero-seed-quoter-plans.json";

// Real quoter-service output (a1ce2ee) for zero-seed pools on the indexer's fork-free replay chain, the MCP plans
// built from it and their local execution, recorded by script/zero-seed-quoter-plans.ts. LOCAL evidence only.
type Json = any;
type Plan = (typeof fixture.plans)[number];
const plans: Plan[] = fixture.plans;
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const label = (p: Plan) => `${p.phase} ${p.label} ${p.quoteKind} ${p.side} ${p.exactOut ? "exact-out" : "exact-in"} ${p.variant}`;
const pinFor = (p: Plan) => BACKEND_REPLAY_PINS.find((pin) => pin.extension === p.request.extension)!;
const launches = (golden as Json).canonicalList.data as Json[];
const launchOf = (p: Plan) => launches.find((row) => row.pool_id === p.poolId)!;
const scheduleOf = (p: Plan) => {
  const row = launchOf(p);
  return { pool_key: { token0: row.pool_key.token0, token1: row.pool_key.token1, config: row.pool_key.config },
    fee_schedule: row.fee_schedule };
};

function run(p: Plan, patch: { request?: object; response?: object; fresh?: bigint; pin?: object; recipient?: string; launch?: boolean } = {}) {
  return localSwapFromQuote({
    pin: { ...pinFor(p), ...patch.pin }, request: { ...p.request, ...patch.request },
    response: { ...p.response, ...patch.response }, context: p.context,
    recipient: (patch.recipient ?? p.recipient) as Address, ...(patch.launch ? { launch: scheduleOf(p) } : {}),
  }, patch.fresh ?? BigInt(p.context.blockTime));
}
const hop = (p: Plan, change: Record<string, unknown>) => ({ splits: [{ ...p.response.splits[0],
  route: [{ swap: { ...p.response.splits[0].route[0].swap, ...change } }] }] });

/** abi.encode(PoolKey, SwapParameters) from the quoter's hop and the request alone. */
function payload(p: Plan): Hex {
  const h = p.response.splits[0].route[0].swap;
  const amount = BigInt(p.request.amount);
  const is1 = BigInt(p.request.specified_token) === BigInt(h.pool_key.token1);
  const params = (BigInt(h.sqrt_ratio_limit) << 160n) | (BigInt.asUintN(128, amount) << 32n) | (is1 ? 1n << 31n : 0n);
  return encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
    [h.pool_key.token0 as Address, h.pool_key.token1 as Address, h.pool_key.config as Hex, pad(toHex(params), { size: 32 })]);
}

describe("real quoter output → MCP router plan → local execution", () => {
  test("provenance: quoter, indexer and contract heads; the quoter harness itself passed", () => {
    expect(fixture.provenance).toMatchObject({ quoterService: "a1ce2ee7a2546a74b7192bb926b3f0531a65b899",
      indexer: "200684630121eef0ce18c649cd5035f9b57cef60", evmContracts: "4f1a3060b099e8a50469848118f44c0c65cfab9a" });
    expect(fixture.quoterHarness).toEqual({ executions: 20, refusals: 0, negativeControls: 84 });
    expect(ZERO_SEED_ROUTER).toBe("0x03c8b90854b90aa22448b11e885f692972da441c");
    expect(YUL_ROUTER_ADDRESS.toLowerCase()).toBe(ZERO_SEED_ROUTER);
  });

  test("covers native buys and sells exact-in and exact-out and two ERC-20 launches, at two blocks, two guards each", () => {
    const kinds = new Set(plans.map((p) => `${p.quoteKind} ${p.side} ${p.exactOut ? "out" : "in"}`));
    expect(kinds.size).toBe(8);
    expect(new Set(plans.map((p) => `${p.phase} ${p.label}`))).toEqual(
      new Set(["prefix l1", "prefix l2", "canonical l1", "canonical l2", "canonical l4"]));
    expect(plans).toHaveLength(40);
    for (const p of plans) expect(launchOf(p).quote_token.kind).toBe(p.quoteKind);
  });

  for (const p of plans) {
    test(`${label(p)}: reproduces the plan that executed`, () => {
      const prepared = run(p);
      expect(prepared).toEqual(p.plan as never);
      expect(prepared).toMatchObject({ executable: false, executionGuaranteed: false, skip_ahead: 0, partial_fill: false,
        router: ZERO_SEED_ROUTER, block: { number: p.context.blockNumber, hash: p.context.blockHash } });
      for (const key of ["gas", "gas_limit", "estimated_gas_cost", "execution_plan", "execution_plan_reference"]) {
        expect(prepared).not.toHaveProperty(key);
      }
      expect(p.execution.status).toBe("success");
    });

    if (p.variant === "quote_guard") {
      test(`${label(p)}: byte-identical to the transaction the quoter's own harness executed`, () => {
        expect(p.plan.data).toBe(p.quoterHarness.calldata);
        expect(p.plan.value).toBe(p.quoterHarness.value);
      });
    }

    test(`${label(p)}: the router forwarded the quoter's hop unchanged to the extension`, () => {
      expect(p.execution.forwardPayload).toBe(payload(p).toLowerCase());
      expect(p.execution.forwardedCalls).toBe(1);
      expect(p.execution.forwardedInputContainsPayload).toBe(true);
      const e = p.execution.event;
      const is1 = BigInt(p.request.specified_token) === BigInt(p.response.splits[0].route[0].swap.pool_key.token1);
      const [specified, calculated] = is1 ? [e.delta1, e.delta0] : [e.delta0, e.delta1];
      expect(specified).toBe(p.request.amount);
      const magnitude = BigInt(calculated) < 0n ? -BigInt(calculated) : BigInt(calculated);
      expect(magnitude.toString()).toBe(p.plan.calculated_amount);
    });

    test(`${label(p)}: the API's indexed schedule gives the executed creator fee rate`, () => {
      const prepared = run(p, { launch: true });
      const e = p.execution.event;
      expect(prepared.creator_fee!.rate_q64).toBe(e.feeRate);
      const { fee_schedule: s } = scheduleOf(p);
      const rate = feeAt({ tradingStart: BigInt(s.trading_start), feeDuration: BigInt(s.fee_duration),
        initialFee: BigInt(s.initial_fee), finalFee: BigInt(s.final_fee) }, BigInt(p.execution.blockTime));
      expect(rate.toString()).toBe(e.feeRate);
      const withFee = BigInt(e.feeIsToken1 ? e.delta1 : e.delta0);
      expect(feeInclusiveDelta({ calculated: withFee - BigInt(e.feeAmount), rate, exactOut: p.exactOut }))
        .toEqual({ fee: BigInt(e.feeAmount), withFee });
    });

    test(`${label(p)}: settlement value, refund and approvals`, () => {
      const plan = p.plan as Json;
      const x = p.execution;
      const specified = BigInt(p.request.amount);
      const calculated = BigInt(plan.calculated_amount);
      expect(x.routerEthBefore).toBe("0");
      expect(x.routerEthAfter).toBe("0");
      expect(x.logTopics).not.toContain(APPROVAL);
      if (p.quoteKind === "erc20") {
        expect(plan.value).toBe("0");
        expect(plan.native).toBeNull();
        const input = specified > 0n ? p.request.specified_token : p.request.other_token;
        expect(plan.input_approval).toEqual({ token: input, spender: ZERO_SEED_ROUTER,
          amount: (specified > 0n ? specified : BigInt(plan.threshold) * -1n).toString() });
        return;
      }
      const eth = BigInt(x.traderDeltas.token0);
      // No wrapping: nothing but Core, the extension and the launch token emits, and never the ERC-20 quote.
      expect(x.logEmitters).toEqual([pinFor(p).core, pinFor(p).extension, launchOf(p).token.address].sort());
      if (p.side === "buy") {
        expect(plan.input_approval).toBeNull();
        expect(plan.native).toMatchObject({ wrapping: false, approval: false, attached_value: plan.value });
        if (p.exactOut) {
          expect(plan.native.spend).toBe("at_most");
          expect(BigInt(plan.value)).toBe(-BigInt(plan.threshold));
          // Spent exactly the quote; the router returned the rest of the attached value in the same transaction.
          expect(eth).toBe(-calculated);
          const refund = BigInt(plan.value) + eth;
          expect(refund).toBe(p.variant === "quote_guard" ? 0n : BigInt(plan.value) - calculated);
          if (p.variant !== "quote_guard") expect(refund).toBeGreaterThan(0n);
        } else {
          expect(plan.native.spend).toBe("exact");
          expect(plan.value).toBe(p.request.amount);
          expect(eth).toBe(-specified);
        }
      } else {
        expect(plan.value).toBe("0");
        expect(plan.native).toBeNull();
        expect(plan.input_approval).toMatchObject({ token: launchOf(p).token.address, spender: ZERO_SEED_ROUTER });
        expect(plan.input_approval.token).not.toBe(NATIVE_QUOTE);
        expect(eth).toBe(p.exactOut ? -specified : calculated);
      }
    });
  }

  const buy = plans.find((p) => p.quoteKind === "native" && p.side === "buy" && !p.exactOut && p.variant === "quote_guard")!;
  const buyOut = plans.find((p) => p.quoteKind === "native" && p.side === "buy" && p.exactOut && p.variant === "quote_guard")!;
  test("estimated_gas_cost cannot influence the prepared call", () => {
    expect(run(buy, { response: { estimated_gas_cost: 1 } })).toEqual(run(buy));
    expect(run(buy, { response: { estimated_gas_cost: 10_000_000 } })).toEqual(run(buy));
  });
  test("inclusive deadline: equal accepts, one second later refuses", () => {
    const deadline = BigInt(buy.request.deadline);
    expect(run(buy, { fresh: deadline }).deadline).toBe(buy.request.deadline);
    expect(() => run(buy, { fresh: deadline + 1n })).toThrow("deadline_expired");
    expect(() => run(buy, { request: { deadline: (BigInt(buy.context.blockTime) - 1n).toString() } })).toThrow("deadline_expired");
    expect(() => run(buy, { request: { deadline: "4294967296" }, fresh: 0n })).toThrow("deadline_out_of_range");
  });
  test("partial intent and nonzero skipAhead refuse", () => {
    expect(() => run(buy, { request: { allow_partial: true } })).toThrow("partial_fill");
    expect(() => run(buy, { response: hop(buy, { skip_ahead: 1 }) })).toThrow("quote_response_invalid");
    expect(() => run(buy, { response: hop(buy, { allow_partial: true }) })).toThrow("quote_response_invalid");
    expect(run(buy, { request: { allow_partial: false } }).data).toBe(run(buy).data);
  });
  test("guards: positive min output, finite max input, right side only", () => {
    expect(() => run(buy, { request: { min_output: "0" } })).toThrow("invalid_argument");
    expect(() => run(buy, { request: { min_output: undefined } })).toThrow("invalid_argument");
    expect(() => run(buy, { request: { max_input: "1" } })).toThrow("invalid_argument");
    expect(() => run(buyOut, { request: { max_input: (1n << 127n).toString() } })).toThrow("invalid_argument");
    expect(() => run(buyOut, { request: { min_output: "1" } })).toThrow("invalid_argument");
    expect(() => run(buy, { request: { min_output: (BigInt(buy.response.total_calculated) + 1n).toString() } })).toThrow("guard_not_met");
    expect(() => run(buyOut, { request: { max_input: (BigInt(buyOut.response.total_calculated) - 1n).toString() } })).toThrow("guard_not_met");
  });
  test("snapshot, amount and route identity are bound", () => {
    expect(() => run(buy, { response: { block_number: 1 } })).toThrow("quote_snapshot_mismatch");
    expect(() => run(buy, { response: { block_hash: `0x${"00".repeat(32)}` } })).toThrow("quote_snapshot_mismatch");
    expect(() => run(buy, { request: { amount: "999999999999999999" } })).toThrow("quote_amount_mismatch");
    expect(() => run(buy, { response: { total_calculated: "1" } })).toThrow("quote_amount_mismatch");
    expect(() => run(buy, { response: { price_impact: 0 } })).toThrow("quote_response_invalid");
    expect(() => run(buy, { response: { splits: [buy.response.splits[0], buy.response.splits[0]] } })).toThrow("quote_response_invalid");
    expect(() => run(buy, { response: hop(buy, { type: "core" }) })).toThrow("quote_response_invalid");
    const [nativePin, erc20Pin] = BACKEND_REPLAY_PINS;
    expect(() => run(buy, { response: hop(buy, { forwardee: erc20Pin.extension }) })).toThrow("launch_support_disabled");
    expect(() => run(buy, { response: hop(buy, { forwardee: nativePin.periphery }) })).toThrow("launch_support_disabled");
    expect(() => run(buy, { request: { extension: nativePin.periphery } })).toThrow("launch_support_disabled");
    expect(() => run(buy, { request: { extension: erc20Pin.extension } })).toThrow("launch_support_disabled");
    expect(() => run(buy, { request: { other_token: "0x0000000000000000000000000000000000000001" } })).toThrow("quote_route_mismatch");
  });
  test("output to a sink refuses", () => {
    const pin = pinFor(buy);
    const key = buy.response.splits[0].route[0].swap.pool_key;
    for (const sink of [zeroAddress, pin.core, pin.extension, pin.periphery, ZERO_SEED_ROUTER, key.token1]) {
      expect(() => run(buy, { recipient: sink })).toThrow("invalid_recipient");
    }
  });
  test("unsupported or mismatched pin refuses before parsing", () => {
    expect(() => run(buy, { pin: { extensionRuntime: `0x${"00".repeat(32)}` } })).toThrow("launch_support_disabled");
    expect(() => run(buy, { pin: { periphery: BACKEND_REPLAY_PINS[1].periphery } })).toThrow("launch_support_disabled");
    expect(() => run(buy, { pin: { periphery: "0x0000000000000000000000000000000000000abc" } })).toThrow("launch_support_disabled");
    expect(() => run(buy, { pin: { quoteKind: "erc20" } })).toThrow("launch_support_disabled");
    // The MCP local chain's own instance of the same extension is accepted as a pin, but not as this route's periphery sink.
    expect(run(buy, { pin: { periphery: LOCAL_INSTANCE_PINS[0].periphery } }).data).toBe(run(buy).data);
  });
});
