import { describe, expect, it } from "bun:test";
import { quoteJurisdiction } from "../src/token-restrictions.js";
import { getQuotesWithPlans, prepareSwap, type Env } from "../src/core.js";
import { walletExecutionPlanSchema } from "../src/wallet-compatibility.js";
import fixtures from "./fixtures/quote-jurisdiction.json";

describe("public quote jurisdiction metadata", () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const [input, output] = BigInt(fixture.amount) < 0n
        ? [fixture.other_token, fixture.specified_token]
        : [fixture.specified_token, fixture.other_token];
      expect(quoteJurisdiction([
        { chainId: BigInt(fixture.chain_id), token: input, side: "sell" },
        { chainId: BigInt(fixture.chain_id), token: output, side: "buy" },
      ]) as unknown).toEqual(fixture.expected);
    });
  }

  it("applies restrictions to the destination chain of a bridge", () => {
    const token = fixtures[0]!.other_token;
    const result = quoteJurisdiction([
      { chainId: "1", token, side: "sell" },
      { chainId: "4663", token, side: "buy" },
    ]);
    expect(result.assets).toHaveLength(2);
    expect(result.assets[0]).toMatchObject({
      chain_id: "1", side: "sell", classification: "out_of_scope", restricted_jurisdictions: [],
    });
    expect(result.assets[1]).toMatchObject({
      chain_id: "4663", side: "buy", classification: "rhj_stock_token",
    });
    expect(result.restricted_jurisdictions).toContain("US");
  });

  it("returns a quote and compatible plan with policy metadata and no proof", async () => {
    const tokenOut = fixtures[0]!.other_token as `0x${string}`;
    const tokenIn = "0x0000000000000000000000000000000000000000";
    const quote = {
      block_number: 123, block_hash: "0x01", total_calculated: "900",
      estimated_gas_cost: 25000, price_impact: 0.001,
      splits: [{ amount_specified: "1000", amount_calculated: "900", route: [{ swap: {
        type: "core", pool_key: { token0: tokenIn, token1: tokenOut, config: `0x${"00".repeat(32)}` },
        sqrt_ratio_limit: "0x000000000000000000000000", skip_ahead: 0,
      } }] }],
    };
    const env = { EKUBO_QUOTER_URL: "https://quoter.test", ZERO_X_API_KEY: "" } as Env;
    const result = await getQuotesWithPlans(env, {
      chainId: "4663", tokenIn, tokenOut, quoteType: "exact_input", amount: "1000",
      sender: "0x1111111111111111111111111111111111111111", slippageBps: 10,
    }, (async (_input: RequestInfo | URL) => Response.json(quote)) as typeof fetch);
    expect(result.quotes).toHaveLength(1);
    expect(result.jurisdiction.restricted_jurisdictions).toContain("US");
    const option = result.quotes[0]!;
    expect(option.jurisdiction).toEqual(result.jurisdiction);
    expect(option.execution).not.toBeNull();
    expect(option.execution!.jurisdiction).toEqual(result.jurisdiction);
    const plan = option.execution!.execution_plan;
    expect(plan.extensions["ekubo.jurisdiction"]).toEqual(result.jurisdiction);
    expect(walletExecutionPlanSchema.safeParse(plan).success).toBe(true);
  });

  describe("unknown assets on a covered chain are labeled, not refused (board EKU-862)", () => {
    const unknown = "0x1111111111111111111111111111111111111111";
    const usdg = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
    const env = { EKUBO_QUOTER_URL: "https://quoter.test", ZERO_X_API_KEY: "" } as Env;
    function ekuboQuote(tokenIn: string, tokenOut: string) {
      const [token0, token1] = BigInt(tokenIn) < BigInt(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];
      return {
        block_number: 123, block_hash: "0x01", total_calculated: "900",
        estimated_gas_cost: 25000, price_impact: 0.001,
        splits: [{ amount_specified: "1000", amount_calculated: "900", route: [{ swap: {
          type: "core", pool_key: { token0, token1, config: `0x${"00".repeat(32)}` },
          sqrt_ratio_limit: "0x000000000000000000000000", skip_ahead: 0,
        } }] }],
      };
    }
    const cases = [
      { name: "sold, with a plan", tokenIn: unknown, tokenOut: usdg, sender: true },
      { name: "bought, with a plan", tokenIn: usdg, tokenOut: unknown, sender: true },
      { name: "bought, indicative", tokenIn: usdg, tokenOut: unknown, sender: false },
    ] as const;
    for (const entry of cases) {
      it(`quotes and labels coverage=unknown: ${entry.name}`, async () => {
        let calls = 0;
        const fetcher = (async () => {
          calls += 1;
          return Response.json(ekuboQuote(entry.tokenIn, entry.tokenOut));
        }) as unknown as typeof fetch;
        const result = await getQuotesWithPlans(env, {
          chainId: "4663", tokenIn: entry.tokenIn, tokenOut: entry.tokenOut,
          quoteType: "exact_input", amount: "1000",
          ...(entry.sender ? { sender: usdg as `0x${string}`, slippageBps: 10 } : {}),
        }, fetcher);
        expect(calls).toBeGreaterThan(0);
        expect(result.quotes).toHaveLength(1);
        expect(result.jurisdiction).toMatchObject({
          coverage: "unknown", execution_hold: true, restricted_jurisdictions: null,
        });
        const asset = result.jurisdiction.assets.find((entry) => entry.token === unknown)!;
        expect(asset).toMatchObject({ classification: "unknown", restricted_jurisdictions: null, execution_hold: true });
        expect(result.jurisdiction.execution_notice).toContain("asset-policy coverage are unknown");
        const option = result.quotes[0]!;
        expect(option.jurisdiction).toEqual(result.jurisdiction);
        if (entry.sender) {
          expect(option.execution).not.toBeNull();
          const plan = option.execution!.execution_plan;
          expect(plan.extensions["ekubo.jurisdiction"]).toEqual(result.jurisdiction);
          expect(walletExecutionPlanSchema.safeParse(plan).success).toBe(true);
        }
      });
    }

    it("labels a bridge whose destination asset on the covered chain is unknown", () => {
      const result = quoteJurisdiction([
        { chainId: "1", token: "0x0000000000000000000000000000000000000000", side: "sell" },
        { chainId: "4663", token: unknown, side: "buy" },
      ]);
      expect(result).toMatchObject({ coverage: "unknown", execution_hold: true, restricted_jurisdictions: null });
      expect(result.assets.map((asset) => asset.classification)).toEqual(["out_of_scope", "unknown"]);
    });

    it("prepareSwap builds the plan and carries the unknown label", async () => {
      const result = await prepareSwap(env, {
        chainId: "4663", tokenIn: unknown, tokenOut: usdg, quoteType: "exact_input",
        amount: "1000", source: "ekubo", sender: usdg, slippageBps: 10,
      } as Parameters<typeof prepareSwap>[1], (async () => Response.json(ekuboQuote(unknown, usdg))) as unknown as typeof fetch);
      expect(result.jurisdiction).toMatchObject({ coverage: "unknown", execution_hold: true, restricted_jurisdictions: null });
    });
  });
});
