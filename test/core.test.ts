import { fakeArtifactStore } from "./fake-r2.js";
import { describe, expect, it } from "bun:test";
import {
  planStepKinds,
  planTargets,
  planTotalValue,
  planTransactions,
  planValues,
} from "./plan-helpers.js";
import { type Env, getQuotesWithPlans, getTokens, prepareSwap } from "../src/core.js";

const token0 = "0x0000000000000000000000000000000000000000";
const token1 = "0x1111111111111111111111111111111111111111";
const sender = "0x2222222222222222222222222222222222222222";
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
  ARTIFACT_STORE: fakeArtifactStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused",
  ACROSS_API_KEY: "unused",
  ACROSS_INTEGRATOR_ID: "unused",
  DUNE_API_KEY: "unused",
};

describe("MCP service core", () => {
  it("uses one canonical batch endpoint for exact token identifiers", async () => {
    let requested = "";
    const upstreamTokens = [
      { chain_id: "0x1", address: token0, symbol: "ETH" },
      { chain_id: "0x1237", address: token1, symbol: "TEST" },
    ];
    const fetcher = async (input: RequestInfo | URL) => {
      requested = input.toString();
      return Response.json(upstreamTokens);
    };

    const result = await getTokens(
      env,
      {
        tokens: [
          { chainId: "1", address: token0 },
          { chainId: "4663", address: token1 },
        ],
      },
      fetcher as typeof fetch,
    );

    expect(requested).toBe(
      `https://api.test/tokens/batch?id=1%3A${token0}&id=4663%3A${token1}`,
    );
    expect(result).toEqual([
      { ...upstreamTokens[0], chain_id: "1" },
      { ...upstreamTokens[1], chain_id: "4663" },
    ]);
  });

  it("rejects a malformed batch token response", async () => {
    const fetcher = async (_input: RequestInfo | URL) =>
      Response.json({ token: "not-an-array" });

    expect(
      getTokens(
        env,
        { tokens: [{ chainId: "1", address: token0 }] },
        fetcher as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: "invalid_upstream_response" });
  });

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
    await getQuotesWithPlans(
      { ...env, ZERO_X_API_KEY: "" },
      {
        chainId: "1",
        tokenIn: token1,
        tokenOut: token0,
        quoteType: "exact_output",
        amount: "100",
      },
      fetcher as typeof fetch,
    );

    expect(requested).toBe(`https://quoter.test/1/-100/${token0}/${token1}`);
  });

  it("returns wallet-owned authorization calldata for wallet-side validation", async () => {
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
        source: "ekubo",
        amount: "1000",
        slippageBps: 25,
        sender,
      },
      fetcher as typeof fetch,
    );

    expect(result.execution_plan_ready).toBe(true);
    expect(result.agent_confirmation_required).toBe(false);
    expect(result.wallet_validation_required).toBe(true);
    expect(result.client_execution.must_revalidate_before_signing).toBe(true);
    expect(planTransactions(result)[0].data).toStartWith("0x");
    expect(result.execution_plan).toMatchObject({
      chain_id: "1",
      caip2_chain_id: "eip155:1",
      sender,
      ordered_steps: [
        {
          kind: "execution",
          transaction: { chain_id: "1", from: sender },
        },
      ],
    });
    expect(result.plan_id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.execution_plan).not.toHaveProperty("required_capabilities");
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
        source: "ekubo",
        amount: "100",
        slippageBps: 50,
        sender,
      },
      fetcher as typeof fetch,
    );

    expect(result.execution_plan.required_capabilities).toEqual([
      "atomic_batch",
    ]);
    expect(result.client_execution.must_revalidate_before_signing).toBe(true);
  });
});
