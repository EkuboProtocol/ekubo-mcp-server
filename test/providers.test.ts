import { describe, expect, it } from "bun:test";
import { decodeFunctionData, erc20Abi } from "viem";
import {
  type Env,
  getQuote,
  prepareSwap,
  searchTokens,
} from "../src/core.js";

const native = "0x0000000000000000000000000000000000000000";
const tokenA = "0x1111111111111111111111111111111111111111";
const tokenB = "0x2222222222222222222222222222222222222222";
const sender = "0x3333333333333333333333333333333333333333";
const recipient = "0x4444444444444444444444444444444444444444";
const spender = "0x5555555555555555555555555555555555555555";
const swapTarget = "0x6666666666666666666666666666666666666666";

const env: Env = {
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "zero-x-test-key",
  ZERO_X_API_URL: "https://zero-x.test",
  ACROSS_API_KEY: "across-test-key",
  ACROSS_INTEGRATOR_ID: "0xbeef",
  ACROSS_API_URL: "https://across.test",
  DUNE_API_KEY: "unused",
};

describe("aggregated quote providers", () => {
  it("returns every complete exact-input quote without selecting one", async () => {
    const ekuboQuote = {
      block_number: 1,
      block_hash: "0x01",
      total_calculated: "900",
      estimated_gas_cost: 1,
      price_impact: 0,
      splits: [],
      provider_metadata: { route: "full-ekubo-quote" },
    };
    const zeroXQuote = {
      liquidityAvailable: true,
      sellAmount: "1000",
      buyAmount: "950",
      issues: { allowance: null },
      providerMetadata: { route: "full-zero-x-quote" },
    };
    const result = await getQuote(
      env,
      {
        chainId: "4663",
        tokenIn: tokenA,
        tokenOut: tokenB,
        quoteType: "exact_input",
        amount: "1000",
      },
      (async (input: RequestInfo | URL) =>
        input.toString().startsWith("https://quoter.test/")
          ? Response.json(ekuboQuote)
          : Response.json(zeroXQuote)) as typeof fetch,
    );

    expect(result.quotes).toHaveLength(2);
    expect(result.quotes[0]).toMatchObject({
      source: "ekubo",
      source_url: "https://quoter.test/4663/1000/0x1111111111111111111111111111111111111111/0x2222222222222222222222222222222222222222",
      normalized: { amount_in: "1000", amount_out: "900" },
    });
    expect(result.quotes[0].quote).toEqual(ekuboQuote);
    expect(result.quotes[1]).toMatchObject({
      source: "0x",
      normalized: { amount_in: "1000", amount_out: "950" },
    });
    expect(result.quotes[1].quote).toEqual(zeroXQuote);
    expect(result).not.toHaveProperty("source");
    expect(result).not.toHaveProperty("quote");
    expect(result).not.toHaveProperty("selection");
    expect(result.request).not.toHaveProperty("source");
    expect(result.request).not.toHaveProperty("sender");
    expect(result.request).not.toHaveProperty("recipient");
    expect(result.comparison).toMatchObject({
      comparison_basis: "highest_calculated_amount_out",
      comparison_complete: true,
      retry_recommended: false,
    });
  });

  it("normalizes all exact-output quotes without selecting one", async () => {
    const result = await getQuote(
      env,
      {
        chainId: "4663",
        tokenIn: tokenA,
        tokenOut: tokenB,
        quoteType: "exact_output",
        amount: "100",
      },
      (async (input: RequestInfo | URL) =>
        input.toString().startsWith("https://quoter.test/")
          ? Response.json({
              block_number: 1,
              block_hash: "0x01",
              total_calculated: "-210",
              estimated_gas_cost: 1,
              price_impact: 0,
              splits: [],
            })
          : Response.json({
              liquidityAvailable: true,
              buyAmount: "100",
              estimatedNetSellAmount: "200",
              issues: { allowance: null },
            })) as typeof fetch,
    );

    expect(result.quotes.map((quote) => quote.source)).toEqual(["ekubo", "0x"]);
    expect(result.comparison.comparison_basis).toBe(
      "lowest_calculated_amount_in",
    );
  });

  it("sorts ambiguous token matches by descending visibility priority", async () => {
    const requested: string[] = [];
    const result = await searchTokens(
      env,
      { chainId: "1", query: "NVDA", pageSize: 20 },
      (async (input: RequestInfo | URL) => {
        requested.push(input.toString());
        return Response.json([
          { symbol: "NVDA", visibility_priority: 0, address: tokenA },
          { symbol: "NVDA", visibility_priority: 3, address: tokenB },
          { symbol: "NVDAX", visibility_priority: 2, address: sender },
        ]);
      }) as typeof fetch,
    );

    expect(result.map((token) => token.address)).toEqual([
      tokenB,
      sender,
      tokenA,
    ]);
    expect(requested[0]).toContain("search=NVDA");
  });

  it("prepares a 0x exact-output swap and approves maxSellAmount", async () => {
    let requestUrl = "";
    let requestHeaders: Headers | undefined;
    const result = await prepareSwap(
      env,
      {
        chainId: "4663",
        destinationChainId: "4663",
        tokenIn: tokenA,
        tokenOut: tokenB,
        quoteType: "exact_output",
        amount: "100",
        source: "0x",
        slippageBps: 75,
        sender,
        recipient,
      },
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        requestUrl = input.toString();
        requestHeaders = new Headers(init?.headers);
        return Response.json({
          liquidityAvailable: true,
          buyAmount: "100",
          estimatedNetSellAmount: "201",
          maxSellAmount: "205",
          issues: { allowance: { actual: "0", spender } },
          transaction: {
            to: swapTarget,
            data: "0x1234",
            value: "0",
            gas: "123456",
          },
        });
      }) as typeof fetch,
    );

    const url = new URL(requestUrl);
    expect(url.pathname).toBe("/swap/allowance-holder/quote");
    expect(url.searchParams.get("chainId")).toBe("4663");
    expect(url.searchParams.get("buyAmount")).toBe("100");
    expect(url.searchParams.get("sellAmount")).toBeNull();
    expect(url.searchParams.get("taker")).toBe(sender);
    expect(url.searchParams.get("recipient")).toBe(recipient);
    expect(requestHeaders?.get("0x-api-key")).toBe("zero-x-test-key");
    expect(result.source).toBe("0x");
    expect(result.quote.maximum_amount_in).toBe("205");
    expect(result.transaction.to).toBe(swapTarget);
    const approval = decodeFunctionData({
      abi: erc20Abi,
      data: result.approvals[0].data,
    });
    expect(approval.functionName).toBe("approve");
    expect(approval.args).toEqual([spender, 205n]);
    const cleanup = decodeFunctionData({
      abi: erc20Abi,
      data: result.post_execution_transactions[0].data,
    });
    expect(cleanup.args).toEqual([spender, 0n]);
  });

  it("maps the zero address to 0x native-token notation", async () => {
    let requestUrl = "";
    const result = await getQuote(
      env,
      {
        chainId: "4663",
        tokenIn: native,
        tokenOut: tokenB,
        quoteType: "exact_input",
        amount: "1000",
      },
      (async (input: RequestInfo | URL) => {
        if (input.toString().startsWith("https://quoter.test/")) {
          return Response.json({
            block_number: 1,
            block_hash: "0x01",
            total_calculated: "800",
            estimated_gas_cost: 1,
            price_impact: 0,
            splits: [],
          });
        }
        requestUrl = input.toString();
        return Response.json({
          liquidityAvailable: true,
          sellAmount: "1000",
          buyAmount: "900",
          minBuyAmount: "890",
          issues: { allowance: null },
        });
      }) as typeof fetch,
    );

    expect(new URL(requestUrl).searchParams.get("sellToken")).toBe(
      "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    );
    expect(
      result.quotes.find((quote) => quote.source === "0x")?.normalized
        .amount_out,
    ).toBe("900");
  });

  it("does not alter a sufficient pre-existing 0x allowance", async () => {
    const result = await prepareSwap(
      env,
      {
        chainId: "4663",
        tokenIn: tokenA,
        tokenOut: tokenB,
        quoteType: "exact_output",
        amount: "100",
        source: "0x",
        slippageBps: 50,
        sender,
      },
      (async (_input: RequestInfo | URL) =>
        Response.json({
          liquidityAvailable: true,
          buyAmount: "100",
          estimatedNetSellAmount: "200",
          maxSellAmount: "205",
          allowanceTarget: spender,
          issues: { allowance: null },
          transaction: {
            to: swapTarget,
            data: "0x1234",
            value: "0",
          },
        })) as typeof fetch,
    );

    expect(result.approvals).toEqual([]);
    expect(result.post_execution_transactions).toEqual([]);
  });

  it("prepares an Across exact-output bridge with returned approvals", async () => {
    let requestUrl = "";
    let authorization = "";
    const result = await prepareSwap(
      env,
      {
        chainId: "1",
        destinationChainId: "4663",
        tokenIn: tokenA,
        tokenOut: tokenB,
        quoteType: "exact_output",
        amount: "100000000000000000",
        source: "across",
        slippageBps: 50,
        sender,
        recipient,
      },
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        requestUrl = input.toString();
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json({
          inputAmount: "201",
          maxInputAmount: "205",
          expectedOutputAmount: "100000000000000000",
          minOutputAmount: "100000000000000000",
          expectedFillTime: 12,
          quoteExpiryTimestamp: 2_000_000_000,
          checks: { allowance: { token: tokenA, spender } },
          approvalTxns: [
            {
              chainId: 1,
              to: tokenA,
              data: "0xaaaa",
              value: "0",
            },
          ],
          swapTx: {
            chainId: 1,
            to: swapTarget,
            data: "0xbbbb",
            value: "3",
            gas: "456789",
          },
        });
      }) as typeof fetch,
    );

    const url = new URL(requestUrl);
    expect(url.pathname).toBe("/swap/approval");
    expect(url.searchParams.get("tradeType")).toBe("exactOutput");
    expect(url.searchParams.get("originChainId")).toBe("1");
    expect(url.searchParams.get("destinationChainId")).toBe("4663");
    expect(url.searchParams.get("integratorId")).toBe("0xbeef");
    expect(authorization).toBe("Bearer across-test-key");
    expect(result.action).toBe("ekubo_bridge");
    expect(result.source).toBe("across");
    expect(result.approvals).toHaveLength(1);
    expect(result.transaction.value).toBe("3");
    expect(result.quote.expected_fill_time_seconds).toBe(12);
  });

  it("returns an available 0x option when Ekubo is unavailable", async () => {
    const result = await getQuote(
      env,
      {
        chainId: "4663",
        tokenIn: tokenA,
        tokenOut: tokenB,
        quoteType: "exact_input",
        amount: "1000",
      },
      (async (input: RequestInfo | URL) => {
        if (input.toString().startsWith("https://quoter.test/")) {
          return Response.json(
            { code: "no_route", error: "No Ekubo route" },
            { status: 404 },
          );
        }
        return Response.json({
          liquidityAvailable: true,
          sellAmount: "1000",
          buyAmount: "950",
          minBuyAmount: "940",
          issues: { allowance: null },
        });
      }) as typeof fetch,
    );

    expect(result.quotes).toHaveLength(1);
    expect(result.quotes[0].source).toBe("0x");
    expect(result.unavailable_sources).toEqual([
      {
        source: "ekubo",
        code: "no_route",
        message: "No Ekubo route",
        retry_recommended: true,
      },
    ]);
    expect(result.comparison).toMatchObject({
      comparison_complete: false,
      retry_recommended: false,
    });
    expect(result.comparison.retry_instruction).toBeNull();
  });

  it("prepares only the explicitly selected provider", async () => {
    const requestedUrls: string[] = [];
    const result = await prepareSwap(
      env,
      {
        chainId: "4663",
        tokenIn: tokenA,
        tokenOut: tokenB,
        quoteType: "exact_input",
        amount: "1000",
        source: "0x",
        slippageBps: 50,
        sender,
      },
      (async (input: RequestInfo | URL) => {
        requestedUrls.push(input.toString());
        return Response.json({
          liquidityAvailable: true,
          sellAmount: "1000",
          buyAmount: "950",
          issues: { allowance: null },
          transaction: { to: swapTarget, data: "0x1234", value: "0" },
        });
      }) as typeof fetch,
    );

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toStartWith("https://zero-x.test/");
    expect(result.source).toBe("0x");
    expect(result.execution_plan_ready).toBe(true);
    expect(result.wallet_handoff.instruction).toContain("Pass this complete plan");
  });
});
