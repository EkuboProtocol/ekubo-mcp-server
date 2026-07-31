import { describe, expect, it } from "bun:test";
import { type Env, getQuote, prepareSwap } from "../src/core.js";

const token0 = "0x0000000000000000000000000000000000000000";
const token1 = "0x1111111111111111111111111111111111111111";
const config = `0x${"00".repeat(32)}`;

const quote = {
  block_number: 123,
  block_hash: "0x01",
  total_calculated: "900",
  estimated_gas_cost: 25_000,
  price_impact: 0.001,
  splits: [
    {
      amount_specified: "1000",
      amount_calculated: "900",
      route: [
        {
          swap: {
            type: "core",
            pool_key: { token0, token1, config },
            sqrt_ratio_limit: "0x000000000000000000000000",
            skip_ahead: 0,
          },
        },
      ],
    },
  ],
} as const;

const env: Env = {
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
};

describe("MCP service core", () => {
  it("maps explicit exact-output intent to the canonical quoter path", async () => {
    let requested = "";
    const fetcher = async (input: RequestInfo | URL) => {
      requested = input.toString();
      return Response.json({
        ...quote,
        total_calculated: "-201",
        splits: [
          {
            ...quote.splits[0],
            amount_specified: "-100",
            amount_calculated: "-201",
          },
        ],
      });
    };
    await getQuote(
      env,
      {
        chainId: "1",
        tokenIn: token1,
        tokenOut: token0,
        quoteType: "exact_output",
        amount: "100",
      },
      fetcher as typeof fetch,
    );

    expect(requested).toBe(
      `https://quoter.test/1/-100/${token0}/${token1}`,
    );
  });

  it("returns confirmation-gated calldata for wallet-side validation", async () => {
    const requested: string[] = [];
    const fetcher = async (input: RequestInfo | URL) => {
      const url = input.toString();
      requested.push(url);
      if (url.startsWith("https://quoter.test/")) {
        return Response.json(quote);
      }
      return new Response("not found", { status: 404 });
    };

    const result = await prepareSwap(
      env,
      {
        chainId: "1",
        tokenIn: token0,
        tokenOut: token1,
        quoteType: "exact_input",
        amount: "1000",
        slippageBps: 25,
      },
      fetcher as typeof fetch,
    );

    expect(result.requires_user_confirmation).toBe(true);
    expect(result.confirmation_ready).toBe(true);
    expect(result.wallet_validation_required).toBe(true);
    expect(result.client_execution.must_revalidate_before_signing).toBe(true);
    expect(result.transaction.data).toStartWith("0x");
    expect(result.plan_id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(requested).toEqual([
      `https://quoter.test/1/1000/${token0}/${token1}`,
    ]);
  });

  it("constructs an unsigned ERC20 approval for client-side execution", async () => {
    const fetcher = async (input: RequestInfo | URL) => {
      if (input.toString().startsWith("https://quoter.test/")) {
        return Response.json({
          ...quote,
          total_calculated: "-201",
          splits: [
            {
              ...quote.splits[0],
              amount_specified: "-100",
              amount_calculated: "-201",
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const result = await prepareSwap(
      env,
      {
        chainId: "1",
        tokenIn: token1,
        tokenOut: token0,
        quoteType: "exact_output",
        amount: "100",
        slippageBps: 50,
      },
      fetcher as typeof fetch,
    );

    expect(result.approval?.transaction.chain_id).toBe("1");
    expect(result.approval?.transaction.to).toBe(token1);
    expect(result.approval?.transaction.data).toStartWith("0x095ea7b3");
    expect(result.client_execution.must_revalidate_before_signing).toBe(true);
  });
});
