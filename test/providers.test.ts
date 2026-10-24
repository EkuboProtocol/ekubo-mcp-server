import { fakeArtifactStore } from "./fake-r2.js";
import { describe, expect, it } from "bun:test";
import { decodeFunctionData, erc20Abi } from "viem";
import {
  planStepKinds,
  planTargets,
  planTotalValue,
  planTransactions,
  planValues,
} from "./plan-helpers.js";
import {
  type Env,
  getQuotesWithPlans,
  listTokens,
  prepareSwap,
} from "../src/core.js";
import zeroXIndicative from "./fixtures/zero-x-indicative-price.json";

const native = "0x0000000000000000000000000000000000000000";
const tokenA = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const tokenB = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const sender = "0x3333333333333333333333333333333333333333";
const recipient = "0x4444444444444444444444444444444444444444";
const spender = "0x5555555555555555555555555555555555555555";
const swapTarget = "0x6666666666666666666666666666666666666666";

const env: Env = {
  ARTIFACT_STORE: fakeArtifactStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "zero-x-test-key",
  ZERO_X_API_URL: "https://zero-x.test",
  ACROSS_API_KEY: "across-test-key",
  ACROSS_INTEGRATOR_ID: "0xbeef",
  ACROSS_API_URL: "https://across.test",
  LAYER_ZERO_API_KEY: "unused",
  LI_FI_API_KEY: "unused",
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
    const result = await getQuotesWithPlans(
      env,
      {
        chainId: "4663",
        tokenIn: tokenA,
        tokenOut: tokenB,
        quoteType: "exact_input",
        amount: "1000",
        includeRawQuotes: true,
      },
      (async (input: RequestInfo | URL) =>
        input.toString().startsWith("https://quoter.test/")
          ? Response.json(ekuboQuote)
          : Response.json(zeroXQuote)) as typeof fetch,
    );

    expect(result.quotes).toHaveLength(2);
    expect(result.quotes[0]).toMatchObject({
      source: "ekubo",
      source_url: "https://quoter.test/4663/1000/0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
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
    const result = await getQuotesWithPlans(
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
    const result = await listTokens(
      env,
      { chainId: "1", search: "NVDA", pageSize: 20, minVisibilityPriority: 0 },
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
    expect(requested[0]).toContain("chainId=1");
    expect(requested[0]).toContain("minVisibilityPriority=0");
  });

  it("lists tokens without a search term and forwards every filter", async () => {
    const requested: string[] = [];
    const result = await listTokens(
      env,
      {
        pageSize: 50,
        minVisibilityPriority: -100,
        afterToken: `4663:${tokenA}`,
      },
      (async (input: RequestInfo | URL) => {
        requested.push(input.toString());
        return Response.json([
          { symbol: "AAA", visibility_priority: 0, address: tokenA },
          { symbol: "BBB", visibility_priority: 5, address: tokenB },
        ]);
      }) as typeof fetch,
    );

    expect(result.map((token) => token.address)).toEqual([tokenB, tokenA]);
    const url = new URL(requested[0]);
    expect(url.searchParams.get("search")).toBeNull();
    expect(url.searchParams.get("chainId")).toBeNull();
    expect(url.searchParams.get("pageSize")).toBe("50");
    expect(url.searchParams.get("minVisibilityPriority")).toBe("-100");
    expect(url.searchParams.get("afterToken")).toBe(`4663:${tokenA}`);
  });

  describe("executable discovery", () => {
    const config = `0x${"00".repeat(32)}`;
    const ekuboQuote = {
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
                pool_key: { token0: native, token1: tokenA, config },
                sqrt_ratio_limit: "0x000000000000000000000000",
                skip_ahead: 0,
              },
            },
          ],
        },
      ],
    } as const;
    const zeroXQuote = {
      liquidityAvailable: true,
      sellAmount: "1000",
      buyAmount: "950",
      minBuyAmount: "940",
      issues: { allowance: null },
      transaction: { to: swapTarget, data: "0x1234", value: "0" },
    } as const;

    const intent = {
      chainId: "4663",
      tokenIn: native,
      tokenOut: tokenA,
      quoteType: "exact_input",
      amount: "1000",
    } as const;

    const respond = (zeroX: unknown = zeroXQuote) =>
      (async (input: RequestInfo | URL) =>
        input.toString().startsWith("https://quoter.test/")
          ? Response.json(ekuboQuote)
          : Response.json(zeroX)) as typeof fetch;

    it("returns calldata for every option from one round trip each", async () => {
      const requested: string[] = [];
      const result = await getQuotesWithPlans(
        env,
        { ...intent, sender, slippageBps: 50 },
        (async (input: RequestInfo | URL) => {
          requested.push(input.toString());
          return respond()(input);
        }) as typeof fetch,
      );

      expect(requested).toHaveLength(2);
      expect(result.execution).toMatchObject({
        execution_plans_included: true,
        sender,
        recipient: sender,
        slippage_bps: "50",
      });
      for (const quote of result.quotes) {
        expect(quote.execution_unavailable).toBeNull();
        expect(quote.execution?.execution_plan).toMatchObject({
          chain_id: "4663",
          caip2_chain_id: "eip155:4663",
          sender,
        });
        expect(quote.execution?.plan_id).toMatch(/^0x[0-9a-f]{64}$/);
        expect(quote.execution?.quote.slippage_bps).toBe("50");
      }
      const zeroXUrl = new URL(
        requested.find((url) => url.startsWith("https://zero-x.test"))!,
      );
      expect(zeroXUrl.pathname).toBe("/swap/allowance-holder/quote");
      expect(zeroXUrl.searchParams.get("taker")).toBe(sender);
      expect(zeroXUrl.searchParams.get("slippageBps")).toBe("50");
    });

    it("produces the same calldata a dedicated preparation step would have", async () => {
      const discovered = await getQuotesWithPlans(
        env,
        { ...intent, sender, slippageBps: 50, includeRawQuotes: true },
        respond(),
      );
      const prepared = await prepareSwap(
        env,
        { ...intent, source: "ekubo", sender, slippageBps: 50 },
        respond(),
      );

      const option = discovered.quotes.find(
        (quote) => quote.source === "ekubo",
      );
      expect(option?.execution?.execution_plan).toEqual(
        prepared.execution_plan,
      );
      expect(option?.execution?.plan_id).toBe(prepared.plan_id);
      const { raw, ...preparedQuoteFields } = prepared.quote;
      expect(option?.quote).toEqual(raw);
      expect(option?.execution?.quote).toEqual(preparedQuoteFields);
    });

    it("states the transactions once, inside the plan the wallet receives", async () => {
      const result = await getQuotesWithPlans(
        env,
        { ...intent, sender, slippageBps: 50 },
        respond(),
      );

      for (const quote of result.quotes) {
        expect(quote.execution).not.toHaveProperty("transaction");
        expect(quote.execution).not.toHaveProperty("approvals");
        expect(quote.execution).not.toHaveProperty(
          "post_execution_transactions",
        );
        expect(quote.execution?.execution_plan.ordered_steps).not.toBeEmpty();
        expect(quote.execution).not.toHaveProperty("client_execution");
        expect(quote).not.toHaveProperty("quote");
      }
      expect(result.execution.client_execution).not.toBeNull();
    });

    it("stays indicative, and cheap, when nobody has decided to swap", async () => {
      const requested: string[] = [];
      const result = await getQuotesWithPlans(
        env,
        intent,
        (async (input: RequestInfo | URL) => {
          requested.push(input.toString());
          return respond()(input);
        }) as typeof fetch,
      );

      expect(result.execution.execution_plans_included).toBe(false);
      for (const quote of result.quotes) {
        expect(quote.execution).toBeNull();
        expect(quote.execution_unavailable).toBeNull();
      }
      expect(
        new URL(requested.find((url) => url.startsWith("https://zero-x.test"))!)
          .pathname,
      ).toBe("/swap/allowance-holder/price");
    });

    it("refuses half an execution request before spending a round trip", async () => {
      const requested: string[] = [];
      const attempt = getQuotesWithPlans(
        env,
        { ...intent, sender },
        (async (input: RequestInfo | URL) => {
          requested.push(input.toString());
          return respond()(input);
        }) as typeof fetch,
      );

      await expect(attempt).rejects.toMatchObject({
        code: "incomplete_execution_request",
      });
      expect(requested).toBeEmpty();
    });

    it("keeps the options it can execute when one provider cannot", async () => {
      const result = await getQuotesWithPlans(
        env,
        { ...intent, sender, slippageBps: 50 },
        respond({
          liquidityAvailable: true,
          sellAmount: "1000",
          buyAmount: "950",
          issues: { allowance: null },
        }),
      );

      const ekubo = result.quotes.find((quote) => quote.source === "ekubo");
      const zeroX = result.quotes.find((quote) => quote.source === "0x");
      expect(ekubo?.execution?.execution_plan).toBeDefined();
      expect(zeroX?.execution).toBeNull();
      expect(zeroX?.execution_unavailable).toMatchObject({
        code: "firm_quote_required",
      });
      expect(zeroX?.normalized.amount_out).toBe("950");
    });
  });

  describe("0x gas estimates", () => {
    const ekuboQuote = {
      block_number: 1,
      block_hash: "0x01",
      total_calculated: "900",
      estimated_gas_cost: 1,
      price_impact: 0,
      splits: [],
    };
    const intent = {
      chainId: "1",
      tokenIn: native,
      tokenOut: tokenB,
      quoteType: "exact_input",
      amount: "1000000000000000000",
    } as const;
    const respond = (zeroX: unknown) =>
      (async (input: RequestInfo | URL) =>
        input.toString().startsWith("https://quoter.test/")
          ? Response.json(ekuboQuote)
          : Response.json(zeroX)) as typeof fetch;
    const zeroXGas = async (zeroX: unknown) =>
      (await getQuotesWithPlans(env, intent, respond(zeroX))).quotes.find(
        (quote) => quote.source === "0x",
      )?.normalized.estimated_gas;

    it("reads the top-level gas limit of a captured indicative price", async () => {
      const captured = zeroXIndicative.zero_x_price;
      expect(captured.gas).toBe("1058057");
      expect(captured).not.toHaveProperty("transaction");
      expect(zeroXIndicative.normalized_before_fix["0x"].estimated_gas).toBeNull();

      const result = await getQuotesWithPlans(env, intent, respond(captured));
      const zeroX = result.quotes.find((quote) => quote.source === "0x");
      expect(zeroX?.normalized).toMatchObject({
        estimated_gas: 1058057,
        amount_out: "2377410000",
        minimum_amount_out: "2353635900",
      });
      expect(result.comparison.comparison_basis).toBe(
        "highest_calculated_amount_out",
      );
    });

    it("prefers the firm transaction gas limit and puts it in the plan", async () => {
      const result = await getQuotesWithPlans(
        env,
        { ...intent, sender, slippageBps: 50 },
        respond({
          liquidityAvailable: true,
          sellAmount: "1000000000000000000",
          buyAmount: "950",
          minBuyAmount: "940",
          issues: { allowance: null },
          transaction: {
            to: swapTarget,
            data: "0x1234",
            value: "1000000000000000000",
            gas: "240000",
            gasPrice: "51046405",
          },
        }),
      );
      const zeroX = result.quotes.find((quote) => quote.source === "0x");
      expect(zeroX?.normalized.estimated_gas).toBe(240000);
      const swap = zeroX?.execution?.execution_plan.ordered_steps.find(
        (step) => step.transaction.to === swapTarget,
      );
      expect(swap?.transaction).toMatchObject({
        data: "0x1234",
        value: "1000000000000000000",
        gas: "240000",
      });
    });

    it("takes the transaction gas over a conflicting top-level estimate", async () => {
      expect(
        await zeroXGas({
          liquidityAvailable: true,
          sellAmount: "1000",
          buyAmount: "950",
          gas: "999999",
          transaction: { to: swapTarget, data: "0x", value: "0", gas: "240000" },
        }),
      ).toBe(240000);
    });

    it("plans a firm quote whose transaction gas is null, with gas unknown", async () => {
      const result = await getQuotesWithPlans(
        env,
        { ...intent, sender, slippageBps: 50 },
        respond({
          liquidityAvailable: true,
          sellAmount: "1000000000000000000",
          buyAmount: "950",
          minBuyAmount: "940",
          issues: { allowance: null },
          transaction: { to: swapTarget, data: "0x1234", value: "0", gas: null },
        }),
      );
      const zeroX = result.quotes.find((quote) => quote.source === "0x");
      expect(zeroX?.normalized.estimated_gas).toBeNull();
      expect(zeroX?.execution_unavailable).toBeNull();
      const swap = zeroX?.execution?.execution_plan.ordered_steps.find(
        (step) => step.transaction.to === swapTarget,
      );
      expect(swap?.transaction).not.toHaveProperty("gas");
    });

    const base = { liquidityAvailable: true, sellAmount: "1000", buyAmount: "950" };
    const unknown: [string, unknown][] = [
      ["omitted", base],
      ["null, as 0x documents when it cannot estimate", { ...base, gas: null }],
      ["zero", { ...base, gas: "0" }],
      ["empty", { ...base, gas: "" }],
      ["not an integer", { ...base, gas: "1.5e6" }],
      ["negative", { ...base, gas: "-1" }],
      ["hex", { ...base, gas: "0x10" }],
      ["beyond a safe integer", { ...base, gas: "9007199254740993" }],
      ["an object", { ...base, gas: { value: "1" } }],
    ];
    for (const [label, zeroX] of unknown) {
      it(`reports gas as unknown, not zero, when it is ${label}`, async () => {
        expect(await zeroXGas(zeroX)).toBeNull();
      });
    }
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
    expect(planStepKinds(result)).toEqual([
      "approval",
      "execution",
      "allowance_cleanup",
    ]);
    const [approvalTx, swapTx, cleanupTx] = planTransactions(result);
    expect(swapTx.to).toBe(swapTarget);
    const approval = decodeFunctionData({ abi: erc20Abi, data: approvalTx.data });
    expect(approval.functionName).toBe("approve");
    expect(approval.args).toEqual([spender, 205n]);
    const cleanup = decodeFunctionData({ abi: erc20Abi, data: cleanupTx.data });
    expect(cleanup.args).toEqual([spender, 0n]);
  });

  it("maps the zero address to 0x native-token notation", async () => {
    let requestUrl = "";
    const result = await getQuotesWithPlans(
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

    expect(planStepKinds(result)).toEqual(["execution"]);
  });

  it("replaces the Across unlimited approval with an exact-amount approval", async () => {
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
    expect(planStepKinds(result)).toEqual(["approval", "execution"]);
    expect(planTransactions(result)[0].data).not.toBe("0xaaaa");
    const acrossApproval = decodeFunctionData({
      abi: erc20Abi,
      data: planTransactions(result)[0].data,
    });
    expect(acrossApproval.functionName).toBe("approve");
    expect(acrossApproval.args).toEqual([spender, 205n]);
    expect(planTransactions(result)[1].value).toBe("3");
    expect(result.quote.expected_fill_time_seconds).toBe(12);
  });

  it("returns an available 0x option when Ekubo is unavailable", async () => {
    const result = await getQuotesWithPlans(
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
    expect(result.wallet_handoff.instruction).toContain("execution_plan_reference");
  });
});
