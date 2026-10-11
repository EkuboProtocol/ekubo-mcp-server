import { describe, expect, it } from "bun:test";
import exactIn from "./fixtures/launchpad/quoter-exact-in.json";
import { type EvmQuoterQuote, prepareSwapFromQuote } from "../src/yul-router.js";

/**
 * A quoter-service forwarded-hop snapshot, with the hop bytes the EKU-826
 * worked example encoded with the same SDK.
 */
const QUOTE_TOKEN = "0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF";
const LAUNCH_TOKEN = "0x504f4f373EF5529d60838DC1aC106932A33B5848";
const HOP =
  "015100000000000000000000000000000000000000504f4f373ef5529d60838dc1ac106932a33b5848ffffffffffffffffffffffffffffffffffffffff5100000000000000000000000000000000000000000000000000000080000064ffff9a5889f795069a41a8a3";

function prepare(quote: unknown, amount: bigint) {
  return prepareSwapFromQuote({
    quote: quote as EvmQuoterQuote,
    tokenIn: QUOTE_TOKEN,
    tokenOut: LAUNCH_TOKEN,
    quoteType: "exact_input",
    amount,
    slippageBps: 0,
  });
}

describe("prepareSwapFromQuote with forwarded hops", () => {
  it("encodes a forwarded hop with its forwardee and a full fill", () => {
    const prepared = prepare(exactIn, 1000n * 10n ** 18n);
    expect(prepared.amountIn).toBe(1000n * 10n ** 18n);
    expect(prepared.amountOut).toBe(926849323490444487392n);
    expect(prepared.route.toLowerCase()).toContain(`${HOP}00000000`);
  });

  it("refuses partial-fill intent and any specified total other than the request", () => {
    const partial = structuredClone(exactIn) as Record<string, any>;
    partial.splits[0].route[0].swap.allow_partial = true;
    expect(() => prepare(partial, 1000n * 10n ** 18n)).toThrow(/partial-fill/);
    expect(() => prepare(exactIn, 1001n * 10n ** 18n)).toThrow(/does not match/);
    expect(() => prepare(exactIn, 999n * 10n ** 18n)).toThrow(/does not match/);
    const twoSplits = structuredClone(exactIn) as Record<string, any>;
    twoSplits.splits = [twoSplits.splits[0], twoSplits.splits[0]];
    twoSplits.total_calculated = (2n * BigInt(twoSplits.total_calculated)).toString();
    expect(() => prepare(twoSplits, 1000n * 10n ** 18n)).toThrow(/does not match/);
  });

  it("refuses a forwardee on a core hop", () => {
    const core = structuredClone(exactIn) as Record<string, any>;
    core.splits[0].route[0].swap.type = "core";
    expect(() => prepare(core, 1000n * 10n ** 18n)).toThrow(/forwardee/);
  });
});
