import { describe, expect, it } from "bun:test";
import exactIn from "./fixtures/launchpad/quoter-exact-in.json";
import partialFill from "./fixtures/launchpad/quoter-partial-fill.json";
import { type EvmQuoterQuote, prepareSwapFromQuote } from "../src/yul-router.js";

/**
 * quoter-service#84 snapshots for the ScheduledLaunch vectors
 * launch_token0_buy_exact_in and launch_token0_buy_partial_fill_range_top,
 * with the hop bytes the EKU-826 worked example encoded with the same SDK.
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

describe("prepareSwapFromQuote with launch-pool hops", () => {
  it("encodes a forwarded hop with its forwardee and no allowPartial for a full fill", () => {
    const prepared = prepare(exactIn, 1000n * 10n ** 18n);
    expect(prepared.partialFill).toBe(false);
    expect(prepared.amountOut).toBe(926849323490444487392n);
    expect(prepared.route.toLowerCase()).toContain(`${HOP}00000000`);
  });

  it("accepts a single allow_partial hop filling less than requested, specifying only the filled amount", () => {
    const prepared = prepare(partialFill, 900_000n * 10n ** 18n);
    expect(prepared).toMatchObject({ partialFill: true, filledAmount: 105127107009426447987133n, amountIn: 105127107009426447987133n });
    expect(prepared.transaction.value).toBe(0n);
    expect(prepared.approval?.amount).toBe(105127107009426447987133n);
    expect(prepared.route.toLowerCase()).toContain(`${HOP}80000000`);
  });

  it("refuses a short fill without allow_partial, a fill above the request, and a multi-split partial", () => {
    const withoutFlag = structuredClone(partialFill) as Record<string, any>;
    delete withoutFlag.splits[0].route[0].swap.allow_partial;
    expect(() => prepare(withoutFlag, 900_000n * 10n ** 18n)).toThrow(/does not match/);
    expect(() => prepare(partialFill, 10n ** 18n)).toThrow(/does not match/);
    const twoSplits = structuredClone(partialFill) as Record<string, any>;
    twoSplits.splits = [twoSplits.splits[0], twoSplits.splits[0]];
    twoSplits.total_calculated = (2n * BigInt(twoSplits.total_calculated)).toString();
    expect(() => prepare(twoSplits, 900_000n * 10n ** 18n)).toThrow(/does not match/);
  });

  it("refuses a forwardee on a core hop", () => {
    const core = structuredClone(exactIn) as Record<string, any>;
    core.splits[0].route[0].swap.type = "core";
    expect(() => prepare(core, 1000n * 10n ** 18n)).toThrow(/forwardee/);
  });
});
