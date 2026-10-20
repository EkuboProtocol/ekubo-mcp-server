import { describe, expect, test } from "bun:test";
import { YUL_ROUTER_ADDRESS } from "@ekubo/yul-router-sdk";
import { type Address, zeroAddress } from "viem";
import { feeAt, feeInclusiveDelta } from "../../src/launchpad/zero-seed/fee.js";
import { LOCAL_INSTANCE_PINS, NATIVE_QUOTE } from "../../src/launchpad/zero-seed/policy.js";
import { localSwapFromQuote, ZERO_SEED_ROUTER } from "../../src/launchpad/zero-seed/swap.js";
import { chain } from "./zero-seed-fixture.js";

// Router quotes read at block S on the local chain, shaped as the quoter's response (not real quoter output), and
// the plans the MCP produced from them, which then executed in a later block at the same timestamp.
type Vector = (typeof chain.swaps)[number];
const native = [...chain.swaps, chain.after_transfer.swap];
const vectors: Vector[] = [...native, chain.erc20_swap];
const pinFor = (vector: Vector) => LOCAL_INSTANCE_PINS.find((pin) => pin.extension === vector.request.extension)!;
const label = (v: Vector) => `${pinFor(v).quoteKind} ${v.side} ${v.exact_out ? "exact-out" : "exact-in"}`;
const scheduleOf = (vector: Vector) => {
  const launch = pinFor(vector).quoteKind === "native" ? chain.launches.native : chain.launches.erc20;
  return { pool_key: launch.preview.installation.poolKey, fee_schedule: { trading_start: Number(launch.request.tradingStart),
    fee_duration: launch.request.feeDuration, initial_fee: launch.request.initialFee, final_fee: launch.request.finalFee } };
};

function run(vector: Vector, patch: { request?: object; response?: object; fresh?: bigint; pin?: object; recipient?: string } = {}) {
  return localSwapFromQuote({
    pin: { ...pinFor(vector), ...patch.pin }, request: { ...vector.request, ...patch.request },
    response: { ...vector.response, ...patch.response }, context: vector.context,
    recipient: (patch.recipient ?? chain.accounts.buyer) as Address, launch: scheduleOf(vector),
  }, patch.fresh ?? BigInt(vector.receipt.timestamp));
}

const hop = (vector: Vector, change: Record<string, unknown>) => ({ splits: [{ ...vector.response.splits[0],
  route: [{ swap: { ...vector.response.splits[0].route[0].swap, ...change } }] }] });

describe("router quote at S → 0x03c8 router plan → local execution", () => {
  test("router pin is the executed 0x03c8 router, held independently of the SDK default", () => {
    expect(chain.router).toBe(ZERO_SEED_ROUTER);
    expect(ZERO_SEED_ROUTER).toBe("0x03c8b90854b90aa22448b11e885f692972da441c");
    expect(YUL_ROUTER_ADDRESS.toLowerCase()).toBe(ZERO_SEED_ROUTER);
  });

  test("covers native buys and sells, exact-in and exact-out, and an ERC-20 buy", () => {
    expect(vectors.map(label)).toEqual([
      "native buy exact-in", "native buy exact-out", "native sell exact-in", "native sell exact-out",
      "native buy exact-in", "erc20 buy exact-in",
    ]);
  });

  for (const vector of vectors) {
    test(`${label(vector)}: reproduces the plan that executed`, () => {
      const prepared = run(vector);
      expect(prepared).toEqual(vector.plan as never);
      expect(prepared).toMatchObject({ executable: false, executionGuaranteed: false, skip_ahead: 0, partial_fill: false });
      for (const key of ["gas", "gas_limit", "estimated_gas_cost", "execution_plan", "execution_plan_reference"]) {
        expect(prepared).not.toHaveProperty(key);
      }
    });

    test(`${label(vector)}: the emitted rate and fee equal the MCP schedule`, () => {
      const event = vector.events.find((e) => e.event === "LaunchSwapped")!.args as unknown as Record<string, string> & { feeIsToken1: boolean };
      const { fee_schedule: s } = scheduleOf(vector);
      const rate = feeAt({ tradingStart: BigInt(s.trading_start), feeDuration: BigInt(s.fee_duration),
        initialFee: BigInt(s.initial_fee), finalFee: BigInt(s.final_fee) }, BigInt(vector.receipt.timestamp));
      expect(rate.toString()).toBe(event.feeRate);
      expect(run(vector).creator_fee).toMatchObject({ rate_q64: event.feeRate, phase: "fee_decay" });
      const withFee = BigInt(event.feeIsToken1 ? event.delta1 : event.delta0);
      expect(feeInclusiveDelta({ calculated: withFee - BigInt(event.feeAmount), rate, exactOut: vector.exact_out }))
        .toEqual({ fee: BigInt(event.feeAmount), withFee });
    });
  }

  for (const vector of native) {
    test(`${label(vector)}: native settlement without wrapping or a native approval`, () => {
      const plan = vector.plan;
      const nativeIn = vector.side === "buy";
      const executedQuote = BigInt(vector.deltas.quote);
      const calculated = BigInt(plan.calculated_amount);
      expect(BigInt(vector.deltas.router_eth)).toBe(0n);
      if (nativeIn) {
        expect(plan.input_approval).toBeNull();
        expect(plan.native).toMatchObject({ wrapping: false, approval: false, attached_value: plan.value });
        if (vector.exact_out) {
          // Attached the maximum input; spent the quoted input; the router refunded the rest to the sender.
          expect(plan.native!.spend).toBe("at_most");
          expect(BigInt(plan.value)).toBe(-BigInt(plan.threshold));
          expect(-executedQuote).toBe(calculated);
          expect(BigInt(plan.value) + executedQuote).toBeGreaterThan(0n);
          expect(BigInt(vector.deltas.token)).toBe(-BigInt(plan.specified_amount));
        } else {
          expect(plan.native!.spend).toBe("exact");
          expect(plan.value).toBe(plan.specified_amount);
          expect(executedQuote).toBe(-BigInt(plan.value));
          expect(BigInt(vector.deltas.token)).toBe(calculated);
        }
      } else {
        expect(plan.value).toBe("0");
        expect(plan.native).toBeNull();
        // The only approval is the launch token's, to the router; native output needs none.
        expect(plan.input_approval).toMatchObject({ spender: ZERO_SEED_ROUTER, token: chain.launches.native.preview.installation.token });
        expect(plan.input_approval!.token).not.toBe(NATIVE_QUOTE);
        expect(executedQuote).toBe(vector.exact_out ? -BigInt(plan.specified_amount) : calculated);
      }
    });
  }

  const [buy, buyOut] = native;
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
    const [nativePin, erc20Pin] = LOCAL_INSTANCE_PINS;
    expect(() => run(buy, { response: hop(buy, { forwardee: erc20Pin.extension }) })).toThrow("launch_support_disabled");
    expect(() => run(buy, { response: hop(buy, { forwardee: nativePin.periphery }) })).toThrow("launch_support_disabled");
    expect(() => run(buy, { request: { extension: nativePin.periphery } })).toThrow("launch_support_disabled");
    expect(() => run(buy, { request: { extension: erc20Pin.extension } })).toThrow("launch_support_disabled");
    expect(() => run(buy, { request: { other_token: "0x0000000000000000000000000000000000000001" } })).toThrow("quote_route_mismatch");
  });
  test("output to a sink refuses", () => {
    const pin = LOCAL_INSTANCE_PINS[0];
    const key = buy.response.splits[0].route[0].swap.pool_key;
    for (const sink of [zeroAddress, pin.core, pin.extension, pin.periphery, ZERO_SEED_ROUTER, key.token1]) {
      expect(() => run(buy, { recipient: sink })).toThrow("invalid_recipient");
    }
  });
  test("unsupported or mismatched pin refuses before parsing", () => {
    expect(() => run(buy, { pin: { extensionRuntime: `0x${"00".repeat(32)}` } })).toThrow("launch_support_disabled");
    expect(() => run(buy, { pin: { periphery: LOCAL_INSTANCE_PINS[1].periphery } })).toThrow("launch_support_disabled");
    expect(() => run(buy, { pin: { quoteKind: "erc20" } })).toThrow("launch_support_disabled");
  });
});
