import { describe, expect, it, spyOn } from "bun:test";
import worker from "../src/index.js";
import { fakeArtifactStore } from "./fake-r2.js";

// Elysium has the Ekubo core protocol, API, quoter and Yul swap router, but
// not Across, 0x or Cloud Wallet. These calls go through the MCP boundary so
// the agent-visible result of each gap is what is asserted.
const env = {
  ARTIFACT_STORE: fakeArtifactStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  // Empty keys leave 0x, LayerZero and LI.FI unconfigured, so each call
  // reaches only the Ekubo quoter and Across.
  ZERO_X_API_KEY: "",
  LAYER_ZERO_API_KEY: "",
  LI_FI_API_KEY: "",
  ACROSS_API_KEY: "across-test-key",
  ACROSS_INTEGRATOR_ID: "test-integrator",
  DUNE_API_KEY: "unused",
  ALLOWED_ORIGINS: "https://mcp.ekubo.org",
};
const context = {} as unknown as ExecutionContext;

const ELYSIUM = "99901";
const NATIVE = "0x0000000000000000000000000000000000000000";
const USDC = "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65";
const WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81";
const SENDER = "0x1111111111111111111111111111111111111111";
const YUL_ROUTER = "0x03c8B90854b90AA22448b11e885F692972DA441C";

async function callTool(
  name: string,
  args: Record<string, unknown>,
  workerEnv: Record<string, unknown> = env,
): Promise<{ isError?: boolean; structuredContent: Record<string, unknown> }> {
  const response = await worker.fetch(
    new Request("https://mcp.ekubo.org/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        host: "mcp.ekubo.org",
        origin: "https://mcp.ekubo.org",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    workerEnv as never,
    context,
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  const data = body.includes("data:")
    ? body
        .split("\n")
        .find((line) => line.startsWith("data:"))!
        .slice("data:".length)
    : body;
  return (JSON.parse(data) as { result: never }).result;
}

function mockFetch(handler: (url: string) => Response) {
  return spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
  ) => handler(input.toString())) as typeof fetch);
}

const executableQuote = {
  block_number: 123,
  block_hash: "0x01",
  total_calculated: "900",
  estimated_gas_cost: 25000,
  price_impact: 0.001,
  splits: [
    {
      amount_specified: "1000",
      amount_calculated: "900",
      route: [
        {
          swap: {
            type: "core",
            pool_key: {
              token0: NATIVE,
              token1: USDC,
              config: `0x${"00".repeat(32)}`,
            },
            sqrt_ratio_limit: "0x000000000000000000000000",
            skip_ahead: 0,
          },
        },
      ],
    },
  ],
};

describe("Elysium (99901) over the MCP endpoint", () => {
  it("reports insufficient liquidity as a definitive, non-retryable answer", async () => {
    const quoterUrls: string[] = [];
    const mocked = mockFetch((url) => {
      quoterUrls.push(url);
      return Response.json(
        {
          code: "insufficient_liquidity",
          error: `Insufficient liquidity in the routes from ${NATIVE} to ${USDC.toLowerCase()}`,
        },
        { status: 404 },
      );
    });
    try {
      const result = await callTool("get_quotes_with_plans", {
        chain_id: ELYSIUM,
        token_in: NATIVE,
        token_out: USDC,
        quote_type: "exact_input",
        amount: "1000000000000000000",
      });
      expect(result.isError).toBe(true);
      const error = result.structuredContent.error as {
        code: string;
        message: string;
        details: { source: string; code: string; retry_recommended: boolean }[];
      };
      expect(error.code).toBe("quote_unavailable");
      expect(error.message).not.toContain("retry");
      expect(error.details).toEqual([
        expect.objectContaining({
          source: "ekubo",
          code: "insufficient_liquidity",
          retry_recommended: false,
        }),
      ]);
      expect(quoterUrls[0]).toStartWith(`https://quoter.test/${ELYSIUM}/`);
    } finally {
      mocked.mockRestore();
    }
  });

  it("prepares an Ekubo swap plan through the Yul router", async () => {
    const mocked = mockFetch((url) =>
      url.startsWith("https://quoter.test/")
        ? Response.json(executableQuote)
        : new Response("not found", { status: 404 }),
    );
    try {
      const result = await callTool("get_quotes_with_plans", {
        chain_id: ELYSIUM,
        token_in: NATIVE,
        token_out: USDC,
        quote_type: "exact_input",
        amount: "1000",
        sender: SENDER,
        slippage_bps: 10,
      });
      expect(result.isError).toBeUndefined();
      const quotes = result.structuredContent.quotes as Record<
        string,
        unknown
      >[];
      expect(quotes).toHaveLength(1);
      expect(quotes[0]).toMatchObject({
        source: "ekubo",
        normalized: { amount_out: "900" },
        execution_unavailable: null,
      });
      expect(quotes[0]!.execution).not.toBeNull();
      const plans = [...env.ARTIFACT_STORE.entries.values()].map(
        (entry) => entry.value,
      );
      expect(plans.some((plan) => plan.includes(YUL_ROUTER))).toBe(true);
      expect(result.structuredContent).toMatchObject({
        wallet_support: [{ chain_id: ELYSIUM, cloud_wallet_supported: false }],
      });
    } finally {
      mocked.mockRestore();
    }
  });

  it("says Across does not support Elysium instead of surfacing a provider error", async () => {
    const mocked = mockFetch(() => {
      throw new Error("Across must not be called for an unsupported chain");
    });
    try {
      for (const [origin, destination] of [
        [ELYSIUM, "1"],
        ["1", ELYSIUM],
      ]) {
        const result = await callTool("get_quotes_with_plans", {
          chain_id: origin,
          destination_chain_id: destination,
          token_in: NATIVE,
          token_out: NATIVE,
          quote_type: "exact_input",
          amount: "1000",
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent.error).toMatchObject({
          code: "quote_unavailable",
          details: [
            {
              source: "across",
              code: "unsupported_chain",
              message:
                "Across does not support Elysium (chain 99901), so Across cannot quote this transfer",
              retry_recommended: false,
            },
          ],
        });
      }
      expect(mocked).not.toHaveBeenCalled();
    } finally {
      mocked.mockRestore();
    }
  });

  it("does not ask 0x to quote Elysium even when 0x is configured", async () => {
    const withZeroX = { ...env, ZERO_X_API_KEY: "zero-x-test-key" };
    const urls: string[] = [];
    const mocked = mockFetch((url) => {
      urls.push(url);
      return url.startsWith("https://quoter.test/")
        ? Response.json(
            {
              code: "insufficient_liquidity",
              error: `Insufficient liquidity in the routes from ${NATIVE} to ${USDC.toLowerCase()}`,
            },
            { status: 404 },
          )
        : new Response("not found", { status: 404 });
    });
    const request = {
      chain_id: ELYSIUM,
      token_in: NATIVE,
      token_out: USDC,
      quote_type: "exact_input",
      amount: "1000000000000000000",
    };
    try {
      const all = await callTool("get_quotes_with_plans", request, withZeroX);
      expect(all.isError).toBe(true);
      const error = all.structuredContent.error as {
        message: string;
        details: { source: string }[];
      };
      expect(error.message).not.toContain("retry");
      expect(error.details.map((detail) => detail.source)).toEqual(["ekubo"]);

      expect(urls.some((url) => url.includes("0x.org"))).toBe(false);
    } finally {
      mocked.mockRestore();
    }
  });

  it("prepares a WHYPE wrap and flags that Cloud Wallet cannot run it", async () => {
    const result = await callTool("prepare_wrap_unwrap", {
      chain_id: ELYSIUM,
      sender: SENDER,
      direction: "wrap",
      amount: "1000",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toHaveProperty("execution_plan_reference");
    expect(result.structuredContent).toMatchObject({
      request: { wrapped_token: WHYPE, wrapped_token_symbol: "WHYPE" },
      wallet_support: [
        { chain_id: ELYSIUM, cloud_wallet_supported: false },
      ],
    });
    const [notice] = result.structuredContent.wallet_support as {
      message: string;
    }[];
    expect(notice!.message).toStartWith(
      "Cloud Wallet does not support Elysium (chain 99901)",
    );
  });

  it("accepts Elysium in a core prepare tool without changing other chains' results", async () => {
    const elysium = await callTool("prepare_oracle_capacity_expansion", {
      chain_id: ELYSIUM,
      sender: SENDER,
      token: USDC,
      min_capacity: 64,
    });
    expect(elysium.isError).toBeUndefined();
    expect(elysium.structuredContent).toHaveProperty("execution_plan_reference");
    expect(elysium.structuredContent).toHaveProperty("wallet_support");

    const ethereum = await callTool("prepare_wrap_unwrap", {
      chain_id: "1",
      sender: SENDER,
      direction: "wrap",
      amount: "1000",
    });
    expect(ethereum.isError).toBeUndefined();
    expect(ethereum.structuredContent).not.toHaveProperty("wallet_support");
  });
});
