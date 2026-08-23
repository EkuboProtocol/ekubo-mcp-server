import { fakeArtifactStore } from "./fake-r2.js";
import { describe, expect, it } from "bun:test";
import { decodeFunctionData, encodeFunctionData, erc20Abi } from "viem";
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
// LI.FI names one contract as both the approval spender and the call target,
// so the fixture keeps them the same address the live API does.
const lifiDiamond = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const acrossTarget = "0x7777777777777777777777777777777777777777";
const originHash = `0x${"1".repeat(64)}`;

function envFor(overrides: Partial<Env> = {}): Env {
  return {
    ARTIFACT_STORE: fakeArtifactStore(),
    EKUBO_API_URL: "https://api.test",
    EKUBO_QUOTER_URL: "https://quoter.test",
    ZERO_X_API_KEY: "zero-x-test-key",
    ACROSS_API_KEY: "across-test-key",
    ACROSS_INTEGRATOR_ID: "0xbeef",
    ACROSS_API_URL: "https://across.test",
    // LayerZero is left unconfigured so these cases weigh LI.FI against
    // Across alone; the LayerZero suite covers the other pairing.
    LAYER_ZERO_API_KEY: "",
    LI_FI_API_KEY: "lifi-test-key",
    LI_FI_API_URL: "https://lifi.test/v1",
    DUNE_API_KEY: "unused",
  } as Env & typeof overrides;
}

/** The step shape LI.FI answers a quote with, trimmed to the fields read. */
const quoteResponse = {
  type: "lifi",
  id: "45bd70e0-439c-4c9a-89b6-1929e2be81a6:0",
  tool: "eco",
  estimate: {
    tool: "eco",
    approvalAddress: lifiDiamond,
    fromAmount: "1000",
    toAmount: "985",
    toAmountMin: "980",
    // Already seconds, unlike LayerZero's milliseconds.
    executionDuration: 7,
  },
  transactionRequest: {
    // Every number on an ethers TransactionRequest is a hex string.
    value: "0x7",
    to: lifiDiamond,
    data: "0xabcd",
    from: sender,
    chainId: 8453,
    gasLimit: "0x12762c",
  },
};

const acrossResponse = {
  inputAmount: "1000",
  maxInputAmount: "1000",
  expectedOutputAmount: "970",
  minOutputAmount: "960",
  swapTx: { chainId: 8453, to: acrossTarget, data: "0xacac", value: "0" },
};

/** Serves the LI.FI and Across endpoints, recording every LI.FI request. */
function lifiFetcher(options: { quote?: unknown; status?: number } = {}) {
  const requests: { url: string; apiKey: string | null; userAgent: string | null }[] =
    [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.startsWith("https://lifi.test/")) {
      requests.push({
        url,
        apiKey: new Headers(init?.headers).get("x-lifi-api-key"),
        userAgent: new Headers(init?.headers).get("user-agent"),
      });
      return Response.json(options.quote ?? quoteResponse, {
        status: options.status ?? 200,
      });
    }
    if (url.startsWith("https://across.test/")) {
      return Response.json(acrossResponse);
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return { fetcher, requests };
}

const bridgeIntent = {
  chainId: "8453",
  destinationChainId: "42161",
  tokenIn: tokenA,
  tokenOut: tokenB,
  quoteType: "exact_input",
  amount: "1000",
} as const;

describe("LI.FI value transfers", () => {
  it("prepares the transfer and states the request it priced", async () => {
    const { fetcher, requests } = lifiFetcher();
    const result = await prepareSwap(
      envFor(),
      { ...bridgeIntent, source: "lifi", slippageBps: 25, sender, recipient },
      fetcher,
    );

    const url = new URL(requests[0].url);
    expect(url.pathname).toBe("/v1/quote");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      fromChain: "8453",
      toChain: "42161",
      fromAmount: "1000",
      fromAddress: sender,
      toAddress: recipient,
      // Basis points become the decimal fraction LI.FI states slippage in.
      slippage: "0.0025",
    });
    // A real sender has a balance to simulate against, so the route is
    // simulated rather than skipped.
    expect(url.searchParams.get("skipSimulation")).toBeNull();
    expect(requests[0].apiKey).toBe("lifi-test-key");
    // Workers send no User-Agent unless one is set, and an unnamed client is
    // what a third-party edge answers with an HTML block page.
    expect(requests[0].userAgent).toMatch(/^ekubo-mcp\//);

    expect(result.source).toBe("lifi");
    expect(result.action).toBe("ekubo_bridge");
    expect(result.quote).toMatchObject({
      provider_quote_id: "45bd70e0-439c-4c9a-89b6-1929e2be81a6:0",
      amount_in: "1000",
      amount_out: "985",
      minimum_amount_out: "980",
      expected_fill_time_seconds: 7,
      // LI.FI states no expiry; the route is re-solved on every request.
      quote_expiry_timestamp: null,
    });
    expect(planStepKinds(result)).toEqual([
      "approval",
      "execution",
    ]);
    expect(planTargets(result)).toEqual([tokenA, lifiDiamond]);
    // The hex value and gas limit are carried through as decimal base units.
    expect(planTransactions(result)[1]).toMatchObject({
      value: "7",
      gas: "1209900",
    });
  });

  it("approves the exact amount rather than the unlimited one", async () => {
    const { fetcher } = lifiFetcher();
    const result = await prepareSwap(
      envFor(),
      { ...bridgeIntent, source: "lifi", slippageBps: 25, sender },
      fetcher,
    );

    const approval = planTransactions(result)[0];
    expect(approval.to).toBe(tokenA);
    expect(decodeFunctionData({ abi: erc20Abi, data: approval.data })).toEqual({
      functionName: "approve",
      args: [lifiDiamond, 1000n],
    });
  });

  it("asks no approval for a native transfer", async () => {
    const { fetcher } = lifiFetcher();
    const result = await prepareSwap(
      envFor(),
      {
        ...bridgeIntent,
        tokenIn: "0x0000000000000000000000000000000000000000",
        source: "lifi",
        slippageBps: 25,
        sender,
      },
      fetcher,
    );

    expect(planStepKinds(result)).toEqual(["execution"]);
  });

  it("solves for the source amount on an exact-output request", async () => {
    const { fetcher, requests } = lifiFetcher({
      quote: {
        ...quoteResponse,
        estimate: {
          ...quoteResponse.estimate,
          // The endpoint over-solves, so more arrives than was asked for and
          // the source amount it names is the bound an approval must cover.
          fromAmount: "1020",
          toAmount: "1005",
          toAmountMin: "1005",
        },
      },
    });
    const result = await prepareSwap(
      envFor(),
      {
        ...bridgeIntent,
        quoteType: "exact_output",
        source: "lifi",
        slippageBps: 25,
        sender,
      },
      fetcher,
    );

    const url = new URL(requests[0].url);
    expect(url.pathname).toBe("/v1/quote/toAmount");
    expect(url.searchParams.get("toAmount")).toBe("1000");
    expect(url.searchParams.get("fromAmount")).toBeNull();
    expect(result.quote).toMatchObject({
      amount_in: "1020",
      amount_out: "1005",
      maximum_amount_in: "1020",
    });
    // The approval covers the solved source amount, and the leftover it may
    // create is cleared once the transfer has a receipt.
    const [approval] = planTransactions(result);
    expect(decodeFunctionData({ abi: erc20Abi, data: approval.data })).toEqual({
      functionName: "approve",
      args: [lifiDiamond, 1020n],
    });
    expect(planStepKinds(result)).toEqual([
      "approval",
      "execution",
      "allowance_cleanup",
    ]);
  });

  it("skips simulation for a request that names no sender", async () => {
    const { fetcher, requests } = lifiFetcher();
    const result = await getQuotesWithPlans(envFor(), bridgeIntent, fetcher);

    const url = new URL(requests[0].url);
    // The placeholder depositor holds no balance, so a simulated route would
    // be refused for a quote that is only being priced.
    expect(url.searchParams.get("skipSimulation")).toBe("true");
    expect(url.searchParams.get("fromAddress")).toBe(
      "0x0000000000000000000000000000000000000001",
    );
    const lifi = result.quotes.find((quote) => quote.source === "lifi");
    expect(lifi?.normalized).toMatchObject({ amount_out: "985" });
    // Indicative quotes carry no calldata for any provider.
    expect(lifi?.execution).toBeNull();
  });

  it("names the integrator only where one is configured", async () => {
    const { fetcher, requests } = lifiFetcher();
    await prepareSwap(
      envFor(),
      { ...bridgeIntent, source: "lifi", slippageBps: 25, sender },
      fetcher,
    );
    expect(new URL(requests[0].url).searchParams.get("integrator")).toBeNull();

    const { fetcher: named, requests: namedRequests } = lifiFetcher();
    await prepareSwap(
      { ...envFor(), LI_FI_INTEGRATOR: "ekubo" },
      { ...bridgeIntent, source: "lifi", slippageBps: 25, sender },
      named,
    );
    expect(new URL(namedRequests[0].url).searchParams.get("integrator")).toBe(
      "ekubo",
    );
  });

  it("refuses a transaction built for a chain other than the origin", async () => {
    const { fetcher } = lifiFetcher({
      quote: {
        ...quoteResponse,
        transactionRequest: { ...quoteResponse.transactionRequest, chainId: 1 },
      },
    });
    expect(
      prepareSwap(
        envFor(),
        { ...bridgeIntent, source: "lifi", slippageBps: 25, sender },
        fetcher,
      ),
    ).rejects.toMatchObject({
      code: "quote_unavailable",
      details: [
        {
          source: "lifi",
          code: "invalid_upstream_response",
          message:
            "LI.FI returned a transaction for chain 1 on a transfer whose origin is 8453",
        },
      ],
    });
  });

  it("reports a quote that carries no amounts", async () => {
    const { fetcher } = lifiFetcher({ quote: { id: "x", estimate: {} } });
    expect(
      prepareSwap(
        envFor(),
        { ...bridgeIntent, source: "lifi", slippageBps: 25, sender },
        fetcher,
      ),
    ).rejects.toMatchObject({
      code: "quote_unavailable",
      details: [{ source: "lifi", code: "invalid_upstream_response" }],
    });
  });

  it("compares LI.FI beside Across for a cross-chain request", async () => {
    const { fetcher } = lifiFetcher();
    const result = await getQuotesWithPlans(
      envFor(),
      { ...bridgeIntent, slippageBps: 25, sender },
      fetcher,
    );

    expect(result.quotes.map((quote) => quote.source)).toEqual([
      "across",
      "lifi",
    ]);
    expect(result.unavailable_sources).toEqual([]);
    // Both options arrive executable, so the comparison is between plans.
    expect(
      result.quotes.every((quote) => quote.execution?.execution_plan_ready),
    ).toBe(true);
  });

  it("omits LI.FI entirely where it is not configured", async () => {
    const { fetcher } = lifiFetcher();
    const result = await getQuotesWithPlans(
      { ...envFor(), LI_FI_API_KEY: "" },
      { ...bridgeIntent, slippageBps: 25, sender },
      fetcher,
    );

    // Not attempted at all, so a deployment without the key reports no failure
    // and spends no round trip on one.
    expect(result.quotes.map((quote) => quote.source)).toEqual(["across"]);
    expect(result.unavailable_sources).toEqual([]);
  });

  it("refuses a same-chain request", async () => {
    const { fetcher } = lifiFetcher();
    expect(
      prepareSwap(
        envFor(),
        {
          ...bridgeIntent,
          destinationChainId: "8453",
          source: "lifi",
          slippageBps: 25,
          sender,
        },
        fetcher,
      ),
    ).rejects.toMatchObject({ code: "invalid_quote_source" });
  });
});

describe("LI.FI transfer status", () => {
  function statusFetcher(body: unknown, status = 200) {
    let requestUrl = "";
    let apiKey = "";
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = input.toString();
      apiKey = new Headers(init?.headers).get("x-lifi-api-key") ?? "";
      return Response.json(body, { status });
    }) as typeof fetch;
    return { fetcher, url: () => requestUrl, apiKey: () => apiKey };
  }

  it("reports a delivered transfer as settled", async () => {
    const { fetcher, url, apiKey } = statusFetcher({
      status: "DONE",
      substatus: "COMPLETED",
      substatusMessage: "The transfer is complete.",
      tool: "eco",
      lifiExplorerLink: "https://explorer.li.fi/tx/0x1",
      sending: { txHash: "0x1", chainId: 8453, timestamp: 1_704_067_200 },
      receiving: { txHash: "0x2", chainId: 42161, timestamp: 1_704_067_260 },
    });
    const result = await getValueTransferStatus(
      envFor(),
      {
        source: "lifi",
        quoteId: "45bd70e0:0",
        transactionHash: originHash,
        originChainId: "8453",
        destinationChainId: "42161",
      },
      fetcher,
    );

    const requested = new URL(url());
    expect(requested.pathname).toBe("/v1/status");
    expect(requested.searchParams.get("txHash")).toBe(originHash);
    expect(requested.searchParams.get("fromChain")).toBe("8453");
    expect(requested.searchParams.get("toChain")).toBe("42161");
    expect(apiKey()).toBe("lifi-test-key");
    expect(result).toMatchObject({
      source: "lifi",
      status: "DONE",
      substatus: "COMPLETED",
      settled: true,
      explorer_url: "https://explorer.li.fi/tx/0x1",
    });
    expect(result.execution_history).toEqual([
      {
        event: "SENT",
        chain_key: "8453",
        transaction_hash: "0x1",
        timestamp: 1_704_067_200,
      },
      {
        event: "RECEIVED",
        chain_key: "42161",
        transaction_hash: "0x2",
        timestamp: 1_704_067_260,
      },
    ]);
  });

  it("distinguishes a refund from a delivery", async () => {
    const { fetcher } = statusFetcher({
      status: "DONE",
      substatus: "REFUNDED",
      sending: { txHash: "0x1", chainId: 8453 },
    });
    const result = await getValueTransferStatus(
      envFor(),
      { source: "lifi", transactionHash: originHash },
      fetcher,
    );

    // DONE alone would read as delivered, and the funds never arrived.
    expect(result.settled).toBe(true);
    expect(result.polling.instruction).toContain("refunded");
  });

  it("treats a transfer LI.FI has not yet seen as still in flight", async () => {
    const { fetcher } = statusFetcher(
      { message: `Transaction hash '${originHash}' not found`, code: 1003 },
      404,
    );
    const result = await getValueTransferStatus(
      envFor(),
      { source: "lifi", transactionHash: originHash, originChainId: "8453" },
      fetcher,
    );

    // The window between broadcasting and LI.FI observing the transaction is
    // the ordinary case, so a poll loop must survive it rather than end.
    expect(result).toMatchObject({ status: "NOT_FOUND", settled: false });
  });

  it("still raises an upstream failure that is not a missing transfer", async () => {
    const { fetcher } = statusFetcher(
      { message: "/txHash Not a valid txHash", code: 1011 },
      400,
    );
    expect(
      getValueTransferStatus(
        envFor(),
        { source: "lifi", transactionHash: originHash },
        fetcher,
      ),
    ).rejects.toMatchObject({ message: "/txHash Not a valid txHash" });
  });

  it("requires the origin transaction hash", async () => {
    const { fetcher } = statusFetcher({ status: "DONE" });
    expect(
      getValueTransferStatus(
        envFor(),
        { source: "lifi", quoteId: "45bd70e0:0" },
        fetcher,
      ),
    ).rejects.toMatchObject({ code: "missing_transaction_hash" });
  });

  it("refuses to report status where LI.FI is not configured", async () => {
    const { fetcher } = statusFetcher({ status: "DONE" });
    expect(
      getValueTransferStatus(
        { ...envFor(), LI_FI_API_KEY: "" },
        { source: "lifi", transactionHash: originHash },
        fetcher,
      ),
    ).rejects.toMatchObject({ code: "provider_not_configured" });
  });

  it("still routes an unnamed source to LayerZero", async () => {
    const { fetcher, url } = statusFetcher({ status: "INFLIGHT" });
    const result = await getValueTransferStatus(
      { ...envFor(), LAYER_ZERO_API_KEY: "layerzero-test-key" },
      { quoteId: "quote-oft", transactionHash: originHash },
      fetcher,
    );

    // The tool predates LI.FI, so a caller that names no source keeps the
    // provider it has always been answered by.
    expect(new URL(url()).pathname).toBe("/v1/status/quote-oft");
    expect(result.source).toBe("layerzero");
  });
});
