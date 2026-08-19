import { fakeArtifactStore } from "./fake-r2.js";
import { describe, expect, it } from "bun:test";
import { decodeFunctionData, encodeFunctionData, erc20Abi, maxUint256 } from "viem";
import { planStepKinds, planTargets, planTransactions } from "./plan-helpers.js";
import {
  type Env,
  getQuotesWithPlans,
  getValueTransferStatus,
  prepareSwap,
} from "../src/core.js";

const tokenA = "0x1111111111111111111111111111111111111111";
const tokenB = "0x2222222222222222222222222222222222222222";
const sender = "0x3333333333333333333333333333333333333333";
const recipient = "0x4444444444444444444444444444444444444444";
// The documented hazard on this API is approving the multicall wrapper instead
// of the delegate, so the two are distinct addresses in every fixture and the
// assertions name which one the plan must reach.
const transferDelegate = "0x5555555555555555555555555555555555555555";
const lzMulticall = "0x6666666666666666666666666666666666666666";
const acrossTarget = "0x7777777777777777777777777777777777777777";
const expiresAt = "2026-08-19T12:00:00.000Z";
const expiresAtSeconds = Math.floor(Date.parse(expiresAt) / 1000);

/**
 * The chain catalog is cached per base URL for ten minutes, so a test that
 * wants a fresh catalog read asks for one under its own host rather than
 * depending on the order the tests happen to run in.
 */
function envFor(host: string): Env {
  return {
    ARTIFACT_STORE: fakeArtifactStore(),
    EKUBO_API_URL: "https://api.test",
    EKUBO_QUOTER_URL: "https://quoter.test",
    ZERO_X_API_KEY: "zero-x-test-key",
    ACROSS_API_KEY: "across-test-key",
    ACROSS_INTEGRATOR_ID: "0xbeef",
    ACROSS_API_URL: "https://across.test",
    LAYER_ZERO_API_KEY: "layerzero-test-key",
    LAYER_ZERO_API_URL: `https://${host}/v1`,
    DUNE_API_KEY: "unused",
  };
}

const chainsResponse = {
  chains: [
    { name: "Ethereum", chainKey: "ethereum", chainType: "EVM", chainId: 1 },
    { name: "Base", chainKey: "base", chainType: "EVM", chainId: 8453 },
    // Non-EVM chains carry no EIP-155 id an intent could name, and no plan
    // could execute one, so they must not enter the mapping.
    { name: "Solana", chainKey: "solana", chainType: "SOLANA" },
  ],
  pagination: {},
};

const approveDelegate = encodeFunctionData({
  abi: erc20Abi,
  functionName: "approve",
  // LayerZero issues an unlimited approval; the plan must not.
  args: [transferDelegate, maxUint256],
});

/** An OFT route beside an intent route that pays more but needs a signature. */
const quotesResponse = {
  error: null,
  quotes: [
    {
      id: "quote-aori",
      routeSteps: [{ type: "AORI", srcChainKey: "ethereum" }],
      srcAmount: "1000",
      // Deliberately the best price in the set: the signature step, not the
      // amount, is what has to disqualify it.
      dstAmount: "999",
      dstAmountMin: "995",
      duration: { estimated: "8000" },
      userSteps: [
        {
          type: "SIGNATURE",
          description: "Sign the Aori order",
          chainKey: "ethereum",
          chainType: "EVM",
        },
      ],
    },
    {
      id: "quote-oft",
      routeSteps: [{ type: "OFT", srcChainKey: "ethereum" }],
      srcAmount: "1000",
      dstAmount: "980",
      dstAmountMin: "975",
      feeUsd: "0.42",
      duration: { estimated: "45000" },
      expiresAt,
      userSteps: [
        {
          type: "TRANSACTION",
          description: "Approve the TransferDelegate",
          chainKey: "ethereum",
          chainType: "EVM",
          transaction: {
            encoded: { to: tokenA, data: approveDelegate, chainId: 1 },
          },
        },
        {
          type: "TRANSACTION",
          description: "Send the transfer",
          chainKey: "ethereum",
          chainType: "EVM",
          transaction: {
            encoded: {
              to: lzMulticall,
              data: "0xbbbb",
              value: "7",
              chainId: 1,
              gasLimit: "321000",
            },
          },
        },
      ],
    },
  ],
};

/** Serves the chain catalog and the quote endpoint, recording each request. */
function layerZeroFetcher(
  host: string,
  options: { quotes?: unknown; chains?: unknown } = {},
) {
  const requests: {
    url: string;
    body: unknown;
    apiKey: string | null;
    userAgent: string | null;
  }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    requests.push({
      url,
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      apiKey: new Headers(init?.headers).get("x-api-key"),
      userAgent: new Headers(init?.headers).get("user-agent"),
    });
    if (url.startsWith(`https://${host}/v1/chains`)) {
      return Response.json(options.chains ?? chainsResponse);
    }
    if (url.startsWith(`https://${host}/v1/quotes`)) {
      return Response.json(options.quotes ?? quotesResponse);
    }
    if (url.startsWith("https://across.test/")) {
      return Response.json({
        inputAmount: "1000",
        maxInputAmount: "1000",
        expectedOutputAmount: "970",
        minOutputAmount: "960",
        swapTx: { chainId: 1, to: acrossTarget, data: "0xacac", value: "0" },
      });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return { fetcher, requests };
}

const bridgeIntent = {
  chainId: "1",
  destinationChainId: "8453",
  tokenIn: tokenA,
  tokenOut: tokenB,
  quoteType: "exact_input",
  amount: "1000",
} as const;

describe("LayerZero value transfers", () => {
  it("maps chain IDs onto chain keys and prepares the transfer", async () => {
    const host = "lz-prepare.test";
    const { fetcher, requests } = layerZeroFetcher(host);
    const result = await prepareSwap(
      envFor(host),
      {
        ...bridgeIntent,
        source: "layerzero",
        slippageBps: 25,
        sender,
        recipient,
      },
      fetcher,
    );

    const quoteRequest = requests.find((request) =>
      request.url.includes("/quotes"),
    );
    expect(quoteRequest?.apiKey).toBe("layerzero-test-key");
    expect(quoteRequest?.body).toMatchObject({
      srcChainKey: "ethereum",
      dstChainKey: "base",
      srcTokenAddress: tokenA,
      dstTokenAddress: tokenB,
      srcWalletAddress: sender,
      dstWalletAddress: recipient,
      amount: "1000",
      options: {
        amountType: "EXACT_SRC_AMOUNT",
        // 25 bps is a quarter of one percent.
        feeTolerance: { type: "PERCENT", amount: 0.25 },
      },
    });

    expect(result.action).toBe("ekubo_bridge");
    expect(result.source).toBe("layerzero");
    expect(planStepKinds(result)).toEqual(["approval", "execution"]);
    expect(result.quote).toMatchObject({
      provider_quote_id: "quote-oft",
      amount_in: "1000",
      amount_out: "980",
      minimum_amount_out: "975",
      // The API states milliseconds; the candidate carries seconds.
      expected_fill_time_seconds: 45,
      quote_expiry_timestamp: expiresAtSeconds,
    });
    expect(planTransactions(result)[1]).toMatchObject({
      to: lzMulticall,
      data: "0xbbbb",
      value: "7",
    });
  });

  it("names itself on every request, including the unauthenticated one", async () => {
    const host = "lz-user-agent.test";
    const { fetcher, requests } = layerZeroFetcher(host);
    await prepareSwap(
      envFor(host),
      { ...bridgeIntent, source: "layerzero", slippageBps: 25, sender },
      fetcher,
    );

    const layerZeroRequests = requests.filter((request) =>
      request.url.includes(host),
    );
    // Both the chain catalog and the quote: a Worker sends no User-Agent
    // unless one is set, and LayerZero answers a request without one with a
    // 403 HTML page rather than JSON.
    expect(layerZeroRequests.length).toBeGreaterThan(1);
    for (const request of layerZeroRequests) {
      expect(request.userAgent).toMatch(/^ekubo-mcp\//);
    }
    // The catalog read carries no credential, only the agent.
    const chains = layerZeroRequests.find((request) =>
      request.url.includes("/chains"),
    );
    expect(chains?.apiKey).toBeNull();
  });

  it("re-issues the approval to the decoded delegate for an exact amount", async () => {
    const host = "lz-approval.test";
    const { fetcher } = layerZeroFetcher(host);
    const result = await prepareSwap(
      envFor(host),
      { ...bridgeIntent, source: "layerzero", slippageBps: 25, sender },
      fetcher,
    );

    // The approval targets the token, never the multicall wrapper.
    expect(planTargets(result)[0]).toBe(tokenA);
    const approval = decodeFunctionData({
      abi: erc20Abi,
      data: planTransactions(result)[0].data,
    });
    expect(approval.functionName).toBe("approve");
    // The spender is the delegate LayerZero named, and the allowance is the
    // exact transfer amount rather than the unlimited one it asked for.
    expect(approval.args).toEqual([transferDelegate, 1000n]);
    expect(planTransactions(result)[0].data).not.toBe(approveDelegate);
  });

  it("skips an intent route that needs a signature even when it pays more", async () => {
    const host = "lz-signature.test";
    const { fetcher } = layerZeroFetcher(host);
    const result = await prepareSwap(
      envFor(host),
      { ...bridgeIntent, source: "layerzero", slippageBps: 25, sender },
      fetcher,
    );

    // quote-aori delivers 999 against quote-oft's 980, but an execution plan
    // cannot perform its /submit-signature round trip.
    expect(result.quote.provider_quote_id).toBe("quote-oft");
    expect(result.quote.amount_out).toBe("980");
  });

  it("reads the chain catalog once and reuses it across quotes", async () => {
    const host = "lz-cache.test";
    const { fetcher, requests } = layerZeroFetcher(host);
    const env = envFor(host);
    const intent = {
      ...bridgeIntent,
      source: "layerzero",
      slippageBps: 25,
      sender,
    } as const;
    await prepareSwap(env, intent, fetcher);
    await prepareSwap(env, intent, fetcher);

    expect(
      requests.filter((request) => request.url.includes("/chains")),
    ).toHaveLength(1);
    expect(
      requests.filter((request) => request.url.includes("/quotes")),
    ).toHaveLength(2);
  });

  it("walks every page of the chain catalog", async () => {
    const host = "lz-pagination.test";
    const requests: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      requests.push(url);
      if (url.includes("/chains")) {
        return Response.json(
          new URL(url).searchParams.get("pagination[nextToken]") === "page-2"
            ? {
                chains: [
                  {
                    chainKey: "base",
                    chainType: "EVM",
                    chainId: 8453,
                  },
                ],
                pagination: {},
              }
            : {
                chains: [
                  { chainKey: "ethereum", chainType: "EVM", chainId: 1 },
                ],
                pagination: { nextToken: "page-2" },
              },
        );
      }
      return Response.json(quotesResponse);
    }) as typeof fetch;

    const result = await prepareSwap(
      envFor(host),
      { ...bridgeIntent, source: "layerzero", slippageBps: 25, sender },
      fetcher,
    );

    // Base only exists on the second page, so the destination could not have
    // resolved without following the cursor.
    expect(result.source).toBe("layerzero");
    expect(requests.filter((url) => url.includes("/chains"))).toHaveLength(2);
  });

  it("reports a chain LayerZero does not list", async () => {
    const host = "lz-unknown-chain.test";
    const { fetcher } = layerZeroFetcher(host);
    const attempt = prepareSwap(
      envFor(host),
      {
        ...bridgeIntent,
        destinationChainId: "999999",
        source: "layerzero",
        slippageBps: 25,
        sender,
      },
      fetcher,
    );

    await expect(attempt).rejects.toMatchObject({ code: "quote_unavailable" });
    const error = await attempt.catch((caught: unknown) => caught);
    expect((error as { details: { code: string }[] }).details[0]).toMatchObject({
      code: "unsupported_chain",
    });
  });

  it("surfaces a rejection LayerZero returns inside a 200 body", async () => {
    const host = "lz-error-body.test";
    const { fetcher } = layerZeroFetcher(host, {
      quotes: {
        error: { status: 400, message: "Unsupported token pair" },
        quotes: [],
      },
    });
    const attempt = prepareSwap(
      envFor(host),
      { ...bridgeIntent, source: "layerzero", slippageBps: 25, sender },
      fetcher,
    );

    await expect(attempt).rejects.toMatchObject({ code: "quote_unavailable" });
    const error = await attempt.catch((caught: unknown) => caught);
    expect((error as { details: { message: string }[] }).details[0]).toMatchObject(
      { message: "Unsupported token pair" },
    );
  });

  it("compares LayerZero beside Across for a cross-chain request", async () => {
    const host = "lz-compare.test";
    const { fetcher } = layerZeroFetcher(host);
    const result = await getQuotesWithPlans(
      envFor(host),
      { ...bridgeIntent, slippageBps: 25, sender },
      fetcher,
    );

    expect(result.quotes.map((quote) => quote.source)).toEqual([
      "across",
      "layerzero",
    ]);
    expect(result.unavailable_sources).toEqual([]);
    const layerZero = result.quotes[1];
    expect(layerZero.normalized).toMatchObject({
      provider_quote_id: "quote-oft",
      amount_out: "980",
    });
    // Both options arrive executable, so the comparison is between plans.
    expect(layerZero.execution?.execution_plan_ready).toBe(true);
    expect(result.quotes[0].execution?.execution_plan_ready).toBe(true);
  });

  it("leaves the exact-output request to Across and says why", async () => {
    const host = "lz-exact-output.test";
    const { fetcher } = layerZeroFetcher(host);
    const result = await getQuotesWithPlans(
      envFor(host),
      {
        ...bridgeIntent,
        quoteType: "exact_output",
        slippageBps: 25,
        sender,
      },
      fetcher,
    );

    // The Value Transfer API prices a source amount only, so this request has
    // one provider — and the other's absence is stated rather than silent.
    expect(result.quotes.map((quote) => quote.source)).toEqual(["across"]);
    expect(result.unavailable_sources).toMatchObject([
      { source: "layerzero", code: "unsupported_quote_type" },
    ]);
  });

  it("omits LayerZero entirely where it is not configured", async () => {
    const host = "lz-unconfigured.test";
    const { fetcher, requests } = layerZeroFetcher(host);
    const result = await getQuotesWithPlans(
      { ...envFor(host), LAYER_ZERO_API_KEY: "" },
      { ...bridgeIntent, slippageBps: 25, sender },
      fetcher,
    );

    // Not attempted at all, so a deployment without the key reports no failure
    // and spends no round trip on one.
    expect(result.quotes.map((quote) => quote.source)).toEqual(["across"]);
    expect(result.unavailable_sources).toEqual([]);
    expect(requests.filter((request) => request.url.includes(host))).toEqual(
      [],
    );
  });

  it("quotes indicatively without a sender", async () => {
    const host = "lz-indicative.test";
    const { fetcher, requests } = layerZeroFetcher(host);
    const result = await getQuotesWithPlans(envFor(host), bridgeIntent, fetcher);

    const quoteRequest = requests.find((request) =>
      request.url.includes("/quotes"),
    );
    // Both wallet addresses are required by the API, so an indicative request
    // borrows a placeholder rather than omitting them.
    expect(quoteRequest?.body).toMatchObject({
      srcWalletAddress: "0x0000000000000000000000000000000000000001",
      dstWalletAddress: "0x0000000000000000000000000000000000000001",
    });
    expect((quoteRequest?.body as { options: object }).options).not.toHaveProperty(
      "feeTolerance",
    );
    const layerZero = result.quotes.find(
      (quote) => quote.source === "layerzero",
    );
    expect(layerZero?.normalized).toMatchObject({ amount_out: "980" });
    expect(layerZero?.execution).toBeNull();
  });
});

describe("LayerZero transfer status", () => {
  it("reports a delivered transfer as settled", async () => {
    let requestUrl = "";
    let apiKey = "";
    let userAgent = "";
    const result = await getValueTransferStatus(
      envFor("lz-status.test"),
      { quoteId: "quote-oft", transactionHash: `0x${"1".repeat(64)}` },
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        requestUrl = input.toString();
        apiKey = new Headers(init?.headers).get("x-api-key") ?? "";
        userAgent = new Headers(init?.headers).get("user-agent") ?? "";
        return Response.json({
          status: "SUCCEEDED",
          explorerUrl: "https://layerzeroscan.com/tx/0x1",
          executionHistory: [
            {
              event: "SENT",
              transaction: {
                chainKey: "ethereum",
                hash: "0x1",
                timestamp: 1_704_067_200_000,
              },
            },
            {
              event: "DELIVERED",
              transaction: {
                chainKey: "base",
                hash: "0x2",
                timestamp: 1_704_067_260_000,
              },
            },
          ],
        });
      }) as typeof fetch,
    );

    const url = new URL(requestUrl);
    expect(url.pathname).toBe("/v1/status/quote-oft");
    expect(url.searchParams.get("txHash")).toBe(`0x${"1".repeat(64)}`);
    expect(apiKey).toBe("layerzero-test-key");
    expect(userAgent).toMatch(/^ekubo-mcp\//);
    expect(result).toMatchObject({
      status: "SUCCEEDED",
      settled: true,
      explorer_url: "https://layerzeroscan.com/tx/0x1",
    });
    expect(result.execution_history).toEqual([
      {
        event: "SENT",
        chain_key: "ethereum",
        transaction_hash: "0x1",
        timestamp: 1_704_067_200_000,
      },
      {
        event: "DELIVERED",
        chain_key: "base",
        transaction_hash: "0x2",
        timestamp: 1_704_067_260_000,
      },
    ]);
  });

  it("keeps an in-flight transfer unsettled and tells the caller to poll", async () => {
    const result = await getValueTransferStatus(
      envFor("lz-status-pending.test"),
      { quoteId: "quote-oft" },
      (async (_input: RequestInfo | URL) =>
        Response.json({ status: "PROCESSING" })) as typeof fetch,
    );

    expect(result).toMatchObject({
      status: "PROCESSING",
      settled: false,
      origin_transaction_hash: null,
      explorer_url: null,
    });
    expect(result.polling.instruction).toContain("Poll this tool again");
    expect(result.execution_history).toEqual([]);
  });

  it("tells the caller not to resubmit a failed transfer", async () => {
    const result = await getValueTransferStatus(
      envFor("lz-status-failed.test"),
      { quoteId: "quote-oft" },
      (async (_input: RequestInfo | URL) =>
        Response.json({ status: "FAILED" })) as typeof fetch,
    );

    expect(result.settled).toBe(true);
    expect(result.polling.instruction).toContain("do not resubmit");
  });

  it("refuses to report status where LayerZero is not configured", async () => {
    await expect(
      getValueTransferStatus(
        { ...envFor("lz-status-unconfigured.test"), LAYER_ZERO_API_KEY: "" },
        { quoteId: "quote-oft" },
        (async (_input: RequestInfo | URL): Promise<Response> => {
          throw new Error("must not be called");
        }) as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: "provider_not_configured" });
  });
});
