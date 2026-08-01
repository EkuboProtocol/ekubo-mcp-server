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
};

describe("aggregated quote providers", () => {
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
        source: "0x",
      },
      (async (input: RequestInfo | URL) => {
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
    expect(result.source).toBe("0x");
    expect(result.normalized.amount_out).toBe("900");
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
        source: "auto",
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

  it("falls back to 0x when an auto Ekubo quote is unavailable", async () => {
    const result = await getQuote(
      env,
      {
        chainId: "4663",
        tokenIn: tokenA,
        tokenOut: tokenB,
        quoteType: "exact_input",
        amount: "1000",
        source: "auto",
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

    expect(result.source).toBe("0x");
    expect(result.unavailable_sources).toEqual([
      { source: "ekubo", code: "no_route", message: "No Ekubo route" },
    ]);
  });
});
