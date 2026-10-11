import { describe, expect, test } from "bun:test";
import { YUL_ROUTER_ADDRESS } from "@ekubo/yul-router-sdk";
import { type Address, keccak256 } from "viem";
import fixture from "../fixtures/launchpad/zero-seed-router-vectors.json";
import { LOCAL_INSTANCE_PINS } from "../../src/launchpad/zero-seed/policy.js";
import { localSwapFromQuote, ZERO_SEED_ROUTER } from "../../src/launchpad/zero-seed/swap.js";

// Accepted quoter responses and the router calldata that executed on the local chain.
// Thresholds equal the quote (zero slippage) and the deadline equals the indexed time.
const pinFor = (label: string) => LOCAL_INSTANCE_PINS[label === "l1" ? 0 : 1];
type Vector = (typeof fixture.vectors)[number];

function requestFor(vector: Vector) {
  const pin = pinFor(vector.label);
  const specified = vector.input.specified_token.toLowerCase();
  const { token0, token1 } = vector.response.splits[0].route[0].swap.pool_key;
  const other = [token0, token1].map((t) => t.toLowerCase()).find((t) => t !== specified)!;
  const exactIn = !vector.input.amount.startsWith("-");
  return {
    amount: vector.input.amount, specified_token: specified, other_token: other, extension: pin.address,
    ...(exactIn ? { min_output: vector.response.total_calculated } : { max_input: vector.response.total_calculated }),
    deadline: String(vector.input.time),
  };
}

function run(vector: Vector, patch: { request?: object; response?: object; fresh?: bigint; pin?: object } = {}) {
  const context = { blockNumber: String(vector.input.block_number), blockHash: vector.input.block_hash, blockTime: String(vector.input.time) };
  return localSwapFromQuote({
    pin: { ...pinFor(vector.label), ...patch.pin }, request: { ...requestFor(vector), ...patch.request },
    response: { ...vector.response, ...patch.response }, context, recipient: fixture.recipient as Address,
  }, patch.fresh ?? BigInt(vector.input.time));
}

const hop = (vector: Vector, change: Record<string, unknown>) => ({ splits: [{ ...vector.response.splits[0],
  route: [{ swap: { ...vector.response.splits[0].route[0].swap, ...change } }] }] });

describe("accepted quoter → 0x03c8 router (local, non-executable)", () => {
  test("router pin is the executed 0x03c8 router, not the SDK default", () => {
    expect(fixture.router).toBe(ZERO_SEED_ROUTER);
    expect(ZERO_SEED_ROUTER).not.toBe(YUL_ROUTER_ADDRESS.toLowerCase());
  });

  for (const vector of fixture.vectors) {
    test(`${vector.label} ${vector.sell ? "sell" : "buy"} ${vector.exactOut ? "exact-out" : "exact-in"} matches executed calldata`, () => {
      const prepared = run(vector);
      expect(prepared.data).toBe(vector.calldata.toLowerCase() as `0x${string}`);
      expect(keccak256(prepared.data)).toBe(vector.calldataKeccak as `0x${string}`);
      expect(prepared).toMatchObject({ executable: false, executionGuaranteed: false, skip_ahead: 0, partial_fill: false, value: "0" });
      for (const key of ["gas", "gas_limit", "estimated_gas_cost", "estimatedRouteGas", "execution_plan", "execution_plan_reference"]) {
        expect(prepared).not.toHaveProperty(key);
      }
    });
  }

  const [buy, buyOut] = fixture.vectors;
  test("both supported orders are covered", () => {
    expect(new Set(fixture.vectors.map((v) => v.label))).toEqual(new Set(["l1", "l3"]));
  });
  test("estimated_gas_cost cannot influence the prepared call", () => {
    expect(run(buy, { response: { estimated_gas_cost: 1 } }).data).toBe(run(buy).data);
    expect(run(buy, { response: { estimated_gas_cost: 10_000_000 } })).toEqual(run(buy));
  });
  test("inclusive deadline: equal accepts, one second later refuses", () => {
    expect(run(buy, { fresh: BigInt(buy.input.time) }).deadline).toBe(String(buy.input.time));
    expect(() => run(buy, { fresh: BigInt(buy.input.time) + 1n })).toThrow("deadline_expired");
    expect(() => run(buy, { request: { deadline: String(buy.input.time - 1) } })).toThrow("deadline_expired");
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
    expect(() => run(buy, { response: { block_number: 14 } })).toThrow("quote_snapshot_mismatch");
    expect(() => run(buy, { response: { block_hash: `0x${"00".repeat(32)}` } })).toThrow("quote_snapshot_mismatch");
    expect(() => run(buy, { request: { amount: "999999999999999999" } })).toThrow("quote_amount_mismatch");
    expect(() => run(buy, { response: { total_calculated: "1" } })).toThrow("quote_amount_mismatch");
    expect(() => run(buy, { response: { price_impact: 0 } })).toThrow("quote_response_invalid");
    expect(() => run(buy, { response: { splits: [buy.response.splits[0], buy.response.splits[0]] } })).toThrow("quote_response_invalid");
    expect(() => run(buy, { response: hop(buy, { type: "core" }) })).toThrow("quote_response_invalid");
    expect(() => run(buy, { response: hop(buy, { forwardee: LOCAL_INSTANCE_PINS[1].address }) })).toThrow("launch_support_disabled");
    expect(() => run(buy, { request: { extension: LOCAL_INSTANCE_PINS[1].address } })).toThrow("launch_support_disabled");
    expect(() => run(buy, { request: { other_token: "0x0000000000000000000000000000000000000001" } })).toThrow("quote_route_mismatch");
  });
  test("unsupported pin refuses before parsing", () => {
    expect(() => run(buy, { pin: { runtime: `0x${"00".repeat(32)}` } })).toThrow("launch_support_disabled");
  });
});
