import { describe, expect, it } from "bun:test";
import { quoteJurisdiction } from "../src/token-restrictions.js";
import { getQuotesWithPlans, type Env } from "../src/core.js";
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
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({ chain_id: "4663", side: "buy" });
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
});
