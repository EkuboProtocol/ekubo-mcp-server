import { describe, expect, test } from "bun:test";
import { YUL_ROUTER_ADDRESS } from "@ekubo/yul-router-sdk";
import { type Address, encodeAbiParameters, type Hex, pad, toHex, zeroAddress } from "viem";
import { feeAt, feeInclusiveDelta } from "../../src/launchpad/zero-seed/fee.js";
import { LOCAL_INSTANCE_PINS, NATIVE_QUOTE } from "../../src/launchpad/zero-seed/policy.js";
import { localSwapFromQuote, ZERO_SEED_ROUTER } from "../../src/launchpad/zero-seed/swap.js";
import fixture from "../fixtures/launchpad/zero-seed-quoter-plans.json";

// Real quoter-service output (a1ce2ee) for zero-seed pools on the indexer's fork-free replay chain of the earlier
// evm-contracts 4f1a306 deployment, the MCP router plans built from it and their local execution, recorded by
// script/zero-seed-quoter-plans.ts. LOCAL evidence only. The swap path is unchanged through 550afc4: the forward payload
// abi.encode(PoolKey, SwapParameters), the router layout and the settlement are the same. Only the instance changed
// (one extension for every quote, the quote named per launch), so each recorded plan is replayed against the current
// pin with the earlier extension address substituted, and must reproduce the executed calldata byte for byte with
// only that address changed. The recorded execution evidence is checked as recorded.
type Json = any;
type Plan = (typeof fixture.plans)[number];
const plans: Plan[] = fixture.plans;
const [pin] = LOCAL_INSTANCE_PINS;
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
/** The 4f1a306 replay chain's constructor-quote extensions, one per quote, and that chain's Core. */
const EARLIER = { native: "0x5114703a4cf4256f0acb68f992c861d8c4d1b173", erc20: "0x519435a42752da78e395999218d0ecc4fdcbcf4b" } as const;
const CORE = "0x00000000000014aa86c5d3c41765bb24e11bd701";
// The indexed fee schedules of the three recorded pools (api 2429547 golden; the schedule is unchanged through 550afc4).
const SCHEDULES: Record<string, { trading_start: number; fee_duration: number; initial_fee: string; final_fee: string }> = {
  "0xc0a9f26952af6a470e5798edc551951d998bf408a332128e643c867e0c556a71": { trading_start: 1800001000, fee_duration: 3600,
    initial_fee: "9223372036854775808", final_fee: "55340232221128654" },
  "0xc27e3d1a2b492b8fbe32fd539a341e1424d8c629c79ee1f796408c485955fc33": { trading_start: 1800001000, fee_duration: 600,
    initial_fee: "922337203685477580", final_fee: "55340232221128654" },
  "0xe5c50d3246c67d6ffc896e8db9c4af89a8f4ee169276a99efb7fbbeb4ad5b2d5": { trading_start: 1800001400, fee_duration: 600,
    initial_fee: "922337203685477580", final_fee: "55340232221128654" },
};
const label = (p: Plan) => `${p.phase} ${p.label} ${p.quoteKind} ${p.side} ${p.exactOut ? "exact-out" : "exact-in"} ${p.variant}`;
const earlier = (p: Plan) => EARLIER[p.quoteKind as keyof typeof EARLIER];
/** The recorded plan with the earlier extension address replaced by the current pin's, in any casing. */
function current<T>(p: Plan, value: T): T {
  return JSON.parse(JSON.stringify(value).replace(new RegExp(earlier(p).slice(2), "gi"), pin.extension.slice(2)));
}
const hopOf = (p: Plan) => p.response.splits[0].route[0].swap;
const quoteTokenOf = (p: Plan) => (p.quoteKind === "native" ? NATIVE_QUOTE : hopOf(p).pool_key.token1.toLowerCase());
const launchTokenOf = (p: Plan) => (p.quoteKind === "native" ? hopOf(p).pool_key.token1 : hopOf(p).pool_key.token0).toLowerCase();
const scheduleOf = (p: Plan) => {
  const key = current(p, hopOf(p).pool_key);
  return { pool_key: { token0: key.token0.toLowerCase(), token1: key.token1.toLowerCase(), config: key.config },
    fee_schedule: SCHEDULES[p.poolId] };
};

function run(p: Plan, patch: { request?: object; response?: object; fresh?: bigint; pin?: object; recipient?: string;
  launch?: boolean; quoteToken?: string; earlier?: boolean } = {}) {
  const [request, response] = patch.earlier ? [p.request, p.response] : [current(p, p.request), current(p, p.response)];
  return localSwapFromQuote({
    pin: { ...pin, ...patch.pin }, quoteToken: patch.quoteToken ?? quoteTokenOf(p), request: { ...request, ...patch.request },
    response: { ...response, ...patch.response }, context: p.context,
    recipient: (patch.recipient ?? p.recipient) as Address, ...(patch.launch ? { launch: scheduleOf(p) } : {}),
  }, patch.fresh ?? BigInt(p.context.blockTime));
}
const hop = (p: Plan, change: Record<string, unknown>) => {
  const response = current(p, p.response);
  return { splits: [{ ...response.splits[0], route: [{ swap: { ...response.splits[0].route[0].swap, ...change } }] }] };
};

/** abi.encode(PoolKey, SwapParameters) from the quoter's hop and the request alone. */
function payload(p: Plan): Hex {
  const h = p.response.splits[0].route[0].swap;
  const amount = BigInt(p.request.amount);
  const is1 = BigInt(p.request.specified_token) === BigInt(h.pool_key.token1);
  const params = (BigInt(h.sqrt_ratio_limit) << 160n) | (BigInt.asUintN(128, amount) << 32n) | (is1 ? 1n << 31n : 0n);
  return encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
    [h.pool_key.token0 as Address, h.pool_key.token1 as Address, h.pool_key.config as Hex, pad(toHex(params), { size: 32 })]);
}

describe("real quoter output → MCP router plan → local execution (recorded on the 4f1a306 instance)", () => {
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
    for (const p of plans) expect(SCHEDULES[p.poolId]).toBeDefined();
  });

  for (const p of plans) {
    test(`${label(p)}: reproduces the plan that executed, with only the extension address changed`, () => {
      const prepared = run(p);
      expect(prepared).toEqual(current(p, p.plan) as never);
      const occurrences = (data: string, address: string) => data.split(address.slice(2)).length - 1;
      expect(occurrences(p.plan.data, earlier(p))).toBe(2);
      expect(prepared.data.replaceAll(pin.extension.slice(2), earlier(p).slice(2))).toBe(p.plan.data);
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
      const s = SCHEDULES[p.poolId];
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
      expect(x.logEmitters).toEqual([CORE, earlier(p), launchTokenOf(p)].sort());
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
        expect(plan.input_approval).toMatchObject({ token: launchTokenOf(p), spender: ZERO_SEED_ROUTER });
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
    const other = "0x51000000000000000000000000000000000000e1";
    expect(() => run(buy, { response: hop(buy, { forwardee: other }) })).toThrow("launch_support_disabled");
    expect(() => run(buy, { response: hop(buy, { forwardee: pin.periphery }) })).toThrow("launch_support_disabled");
    expect(() => run(buy, { request: { extension: pin.periphery } })).toThrow("launch_support_disabled");
    expect(() => run(buy, { request: { extension: other } })).toThrow("launch_support_disabled");
    expect(() => run(buy, { request: { other_token: "0x0000000000000000000000000000000000000001" } })).toThrow("quote_route_mismatch");
  });
  test("the plan names the launch's own quote: another or an unreviewed quote refuses", () => {
    const erc = plans.find((p) => p.quoteKind === "erc20" && p.variant === "quote_guard")!;
    expect(() => run(buy, { quoteToken: quoteTokenOf(erc) })).toThrow("quote_route_mismatch");
    expect(() => run(erc, { quoteToken: NATIVE_QUOTE })).toThrow("quote_route_mismatch");
    expect(() => run(buy, { quoteToken: "0x4200000000000000000000000000000000000006" })).toThrow("unsupported_quote");
    expect(() => run(buy, { quoteToken: "0x00" })).toThrow("unsupported_quote");
  });
  test("a plan for the earlier per-quote instance refuses", () => {
    expect(() => run(buy, { earlier: true })).toThrow("launch_support_disabled");
  });
  test("output to a sink refuses", () => {
    const key = buy.response.splits[0].route[0].swap.pool_key;
    for (const sink of [zeroAddress, pin.core, pin.extension, pin.periphery, ZERO_SEED_ROUTER, key.token1]) {
      expect(() => run(buy, { recipient: sink })).toThrow("invalid_recipient");
    }
  });
  test("unsupported or mismatched pin refuses before parsing", () => {
    expect(() => run(buy, { pin: { extensionRuntime: `0x${"00".repeat(32)}` } })).toThrow("launch_support_disabled");
    expect(() => run(buy, { pin: { periphery: "0x0000000000000000000000000000000000000abc" } })).toThrow("launch_support_disabled");
    expect(() => run(buy, { pin: { deploymentBlock: "3" } })).toThrow("launch_support_disabled");
    expect(() => run(buy, { pin: { quoteKind: "native" } })).toThrow("launch_support_disabled");
  });
});
