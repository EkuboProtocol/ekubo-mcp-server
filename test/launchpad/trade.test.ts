import { describe, expect, it } from "bun:test";
import { decodeFunctionData, erc20Abi, getAddress, zeroAddress } from "viem";
import { launchpadPrepareTrade } from "../../src/launchpad/prepare/trade.js";
import { BLOCK, C, E18, env, failure, harness, type Json, launchFixture, launchPoolId, launchQuote, OTHER, QUOTER_URL, SENDER, TOKEN } from "./fake.js";

function tradeArgs(overrides: Record<string, unknown> = {}) {
  return { chain_id: 1, sender: SENDER, slippage_bps: 100, token: TOKEN, side: "buy", amount_kind: "exact_input", amount: E18.toString(), ...overrides };
}

function setup(quote: unknown, launch = launchFixture(), status = 200) {
  const h = harness(launch);
  h.services.quote = { status, body: quote };
  return h;
}

async function trade(h: ReturnType<typeof setup>, overrides: Record<string, unknown> = {}): Promise<Json> {
  return launchpadPrepareTrade(env(), tradeArgs(overrides) as never, h.deps);
}

describe("launchpad_prepare_trade during the launch", () => {
  it("asks quoter-service for the pair and amount, and plans a Yul router swap with value and the slippage threshold", async () => {
    const h = setup(launchQuote({ specified: E18, calculated: 1000n * E18 }));
    const result = await trade(h);
    expect(h.services.requests.filter((url) => url.startsWith(QUOTER_URL))).toEqual([`${QUOTER_URL}/1/${E18}/${zeroAddress}/${TOKEN}`]);
    const steps = result.execution_plan.ordered_steps;
    expect(steps).toHaveLength(1);
    expect(steps[0].transaction).toMatchObject({ to: C.router, value: E18.toString(), from: SENDER, chain_id: "1" });
    expect(result.contract).toBe(C.router);
    // 1000e18 out at 100 bps: floor(1000e18 * 10000 / 10100).
    expect(result.threshold).toMatchObject({ calculated_amount_threshold: ((1000n * E18 * 10_000n) / 10_100n).toString(), meaning: "minimum_output" });
    expect(result.quote).toMatchObject({ source: "quoter-service", requested_amount: E18.toString(), filled_amount: E18.toString(), partial_fill: false, amount_out: (1000n * E18).toString() });
    expect(result.route.splits[0][0]).toEqual({
      type: "forwarded",
      pool_id: launchPoolId(),
      extension: C.scheduled_launch,
      launch_pool: true,
      this_launch: true,
      forwardee: C.scheduled_launch,
      allow_partial: false,
    });
    expect(result.creator_fee_at_block).toEqual({ q64: ((1n << 64n) / 25n).toString(), percent: "4%" });
    expect(result.phase).toBe("launch");
  });

  it("encodes the launch hop as Yul router kind 0x01 with the extension as forwardee", async () => {
    const h = setup(launchQuote({ specified: E18, calculated: 1000n * E18 }));
    const data: string = (await trade(h)).execution_plan.ordered_steps[0].transaction.data.toLowerCase();
    const hop = `01${C.scheduled_launch.slice(2)}${zeroAddress.slice(2)}${TOKEN.slice(2)}`.toLowerCase();
    expect(data).toContain(hop);
  });

  it("plans a partial fill for the filled amount only, with allowPartial, and warns", async () => {
    const filled = E18 / 4n;
    const h = setup(launchQuote({ specified: filled, calculated: 250n * E18, partial: true }));
    const result = await trade(h);
    expect(result.quote).toMatchObject({ requested_amount: E18.toString(), filled_amount: filled.toString(), partial_fill: true, amount_in: filled.toString() });
    expect(result.execution_plan.ordered_steps[0].transaction.value).toBe(filled.toString());
    expect(result.max_payment).toEqual({ token: zeroAddress, amount: filled.toString() });
    expect(result.warnings.map((w: Json) => w.code)).toEqual(["partial_fill"]);
    // The hop's control word sets bit 31 (allowPartial).
    expect(result.execution_plan.ordered_steps[0].transaction.data.toLowerCase()).toContain("80000000");
    expect(result.route.splits[0][0].allow_partial).toBe(true);
  });

  it("refuses a short fill the quoter did not mark allow_partial", async () => {
    const h = setup(launchQuote({ specified: E18 / 4n, calculated: 250n * E18 }));
    expect(await failure(() => trade(h))).toMatchObject({ code: "quoter_invalid_response" });
  });

  it("approves exactly the launch token input to the Yul router for a sell", async () => {
    const h = setup(launchQuote({ buy: false, specified: 1000n * E18, calculated: E18 / 2n }));
    const result = await trade(h, { side: "sell", amount: (1000n * E18).toString() });
    const [approval, swap] = result.execution_plan.ordered_steps;
    expect(approval.transaction.to).toBe(TOKEN);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: approval.transaction.data });
    expect(decoded).toEqual({ functionName: "approve", args: [C.router, 1000n * E18] });
    expect(swap.transaction).toMatchObject({ to: C.router, value: "0" });
    expect(h.services.requests.at(-1)).toBe(`${QUOTER_URL}/1/${1000n * E18}/${TOKEN}/${zeroAddress}`);
  });

  it("bounds an exact-output buy by the slippage-adjusted maximum native input", async () => {
    const h = setup(launchQuote({ specified: -(1000n * E18), calculated: -E18 }));
    const result = await trade(h, { amount_kind: "exact_output", amount: (1000n * E18).toString() });
    const max = (E18 * 10_100n + 9_999n) / 10_000n;
    expect(result.threshold).toMatchObject({ calculated_amount_threshold: (-max).toString(), meaning: "maximum_input" });
    expect(result.execution_plan.ordered_steps[0].transaction.value).toBe(max.toString());
    expect(h.services.requests.at(-1)).toBe(`${QUOTER_URL}/1/-${1000n * E18}/${TOKEN}/${zeroAddress}`);
  });

  it("refuses a launch-pool hop that is not forwarded, or forwarded to another contract", async () => {
    expect(await failure(() => trade(setup(launchQuote({ specified: E18, calculated: E18, type: "core", forwardee: null }))))).toMatchObject({
      code: "quoter_invalid_response",
      details: { reason: "launch_pool_not_forwarded" },
    });
    expect(await failure(() => trade(setup(launchQuote({ specified: E18, calculated: E18, forwardee: OTHER }))))).toMatchObject({
      code: "quoter_invalid_response",
      details: { reason: "unexpected_forwardee" },
    });
  });

  it("reports no route when the quoter has none", async () => {
    expect(await failure(() => trade(setup({ error: "insufficient_liquidity" }, launchFixture(), 400)))).toMatchObject({
      code: "no_route",
      details: { status: 400, quoter_error: "insufficient_liquidity" },
    });
  });
});

describe("launchpad_prepare_trade phases", () => {
  it("refuses a launch before start_time and one that ended without an advance, without asking the quoter", async () => {
    for (const [launch, code] of [
      [launchFixture({ startTime: BLOCK.timestamp + 10n }), "launch_not_started"],
      [launchFixture({ endTime: BLOCK.timestamp }), "launch_needs_advance"],
    ] as const) {
      const h = setup(launchQuote({ specified: E18, calculated: E18 }), launch);
      expect((await failure(() => trade(h))).code).toBe(code);
      expect(h.services.quoterRequests).toBe(0);
    }
  });

  it("after completion routes through whatever pools the quoter chooses, with no creator fee read", async () => {
    const launch = launchFixture({ endTime: BLOCK.timestamp - 1n, complete: true });
    const terminal = launchQuote({ launch, specified: E18, calculated: 900n * E18, forwardee: null, type: "core" });
    // A terminal TWAMM pool: same tokens, another extension.
    terminal.splits[0].route[0].swap!.pool_key.config = `0x${C.twamm.slice(2).toLowerCase()}${"0".repeat(24)}`;
    const h = setup(terminal, launch);
    const result = await trade(h);
    expect(result.phase).toBe("complete");
    expect(result.route.splits[0][0]).toMatchObject({ type: "core", launch_pool: false, this_launch: false, extension: C.twamm });
    expect(result.creator_fee_at_block).toBeNull();
    expect(h.chain.calls.filter((call) => call.to === C.scheduled_launch).length).toBe(3);
  });

  it("refuses an unknown token and a launch the api places on another extension", async () => {
    const h = setup(launchQuote({ specified: E18, calculated: E18 }));
    expect((await failure(() => trade(h, { token: OTHER }))).code).toBe("launch_not_found");
    const moved = setup(launchQuote({ specified: E18, calculated: E18 }));
    for (const detail of moved.services.details.values()) detail.pool_key.extension = OTHER.toLowerCase();
    expect((await failure(() => trade(moved))).code).toBe("launch_not_found");
  });

  it("requires slippage_bps with no default", async () => {
    const h = setup(launchQuote({ specified: E18, calculated: E18 }));
    const args: Json = tradeArgs();
    delete args.slippage_bps;
    expect((await failure(() => launchpadPrepareTrade(env(), args, h.deps))).code).toBe("schema");
  });
});

describe("launchpad_prepare_trade reads", () => {
  it("makes one quoter request, list and detail api requests, and no log reads", async () => {
    const h = setup(launchQuote({ specified: E18, calculated: E18 }));
    await trade(h);
    expect(h.services.quoterRequests).toBe(1);
    expect(h.services.apiRequests).toBe(2);
    expect(h.chain.methods).toEqual({ eth_getBlockByNumber: 1, eth_getCode: 6, eth_call: 7 });
    expect(getAddress(h.chain.calls.at(-1)!.to)).toBe(C.scheduled_launch);
  });
});
