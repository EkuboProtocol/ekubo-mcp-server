import { describe, expect, it, spyOn } from "bun:test";
import worker from "../src/index.js";
import { fakeArtifactStore } from "./fake-r2.js";

const env = {
  ARTIFACT_STORE: fakeArtifactStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "zero-x-test-key",
  ACROSS_API_KEY: "across-test-key",
  ACROSS_INTEGRATOR_ID: "test-integrator",
  LAYER_ZERO_API_KEY: "unused",
  LI_FI_API_KEY: "unused",
  DUNE_API_KEY: "recommendation-test-key",
  ALLOWED_ORIGINS: "https://mcp.ekubo.org",
};
const context = {} as unknown as ExecutionContext;

const headers = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
  host: "mcp.ekubo.org",
  origin: "https://mcp.ekubo.org",
  "mcp-protocol-version": "2025-11-25",
};

const ROBINHOOD_CHAIN = 4663;
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const SENDER = "0x1111111111111111111111111111111111111111";
const UNKNOWN = "0x3333333333333333333333333333333333333333";
const V2_COUNTRIES = [
  "AE", "BY", "CA", "CH", "CU", "GB", "IR", "KP", "MM",
  "RU", "SD", "SG", "SS", "SY", "UA", "US", "VE",
];

/**
 * Cloudflare populates `cf` on the request it hands the Worker. Bun's Request
 * has no such property, so the edge is simulated by attaching one.
 */
function edgeRequest(body: unknown, country?: string): Request {
  const request = new Request("https://mcp.ekubo.org/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  Object.defineProperty(request, "cf", {
    value: country === undefined ? {} : { country },
  });
  return request;
}

function toolCall(name: string, args: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

async function mcpJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(body);
  }
  const data = body
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice("data:".length)
    .trim();
  if (data === undefined) throw new Error(`MCP stream had no data: ${body}`);
  return JSON.parse(data);
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  country?: string,
): Promise<{ isError?: boolean; structuredContent: Record<string, unknown> }> {
  const response = await worker.fetch(
    edgeRequest(toolCall(name, args), country),
    env,
    context,
  );
  expect(response.status).toBe(200);
  const parsed = (await mcpJson(response)) as {
    result: { isError?: boolean; structuredContent: Record<string, unknown> };
  };
  return parsed.result;
}

describe("jurisdiction metadata over the MCP endpoint (inform only, board EKU-873)", () => {
  const COUNTRIES = ["US", "IR", "FR", "XX", "T1", undefined];

  it("prepares a Stock Token for every connection and attaches identical metadata", async () => {
    const seen = new Set<string>();
    for (const country of COUNTRIES) {
      const result = await callTool(
        "prepare_oracle_capacity_expansion",
        { chain_id: ROBINHOOD_CHAIN, sender: SENDER, token: NVDA, min_capacity: 64 },
        country,
      );
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toHaveProperty("execution_plan_reference");
      expect(result.structuredContent).toMatchObject({
        jurisdiction: {
          coverage: "complete", restricted_jurisdictions: V2_COUNTRIES,
          assets: [{ token: NVDA, side: "buy", classification: "rhj_stock_token" }],
        },
      });
      const text = JSON.stringify(result.structuredContent.jurisdiction);
      expect(text).not.toContain("country");
      seen.add(text);
    }
    expect(seen.size).toBe(1);
  });

  it("labels an unclassified asset coverage=unknown instead of refusing", async () => {
    for (const country of COUNTRIES) {
      const result = await callTool(
        "prepare_oracle_capacity_expansion",
        { chain_id: ROBINHOOD_CHAIN, sender: SENDER, token: UNKNOWN, min_capacity: 64 },
        country,
      );
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toHaveProperty("execution_plan_reference");
      expect(result.structuredContent).toMatchObject({
        jurisdiction: { coverage: "unknown", execution_hold: true, restricted_jurisdictions: null },
      });
    }
  });

  it("reports an explicit empty list for a verified non-class asset", async () => {
    const result = await callTool(
      "prepare_oracle_capacity_expansion",
      { chain_id: ROBINHOOD_CHAIN, sender: SENDER, token: USDG, min_capacity: 64 },
      "US",
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      jurisdiction: { coverage: "complete", restricted_jurisdictions: [], execution_notice: null },
    });
  });

  it("labels a Stock Token or unclassified ERC-20 sent with prepare_transfers as a sale", async () => {
    const result = await callTool("prepare_transfers", {
      chain_id: ROBINHOOD_CHAIN, sender: SENDER,
      transfers: [
        { kind: "native", recipient: USDG, amount: "1" },
        { kind: "erc20", token: NVDA, recipient: USDG, amount: "5" },
        { kind: "erc20", token: NVDA, recipient: UNKNOWN, amount: "6" },
        { kind: "erc20", token: USDG, recipient: UNKNOWN, amount: "7" },
        { kind: "erc20", token: UNKNOWN, recipient: USDG, amount: "8" },
      ],
    }, "US");
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toHaveProperty("execution_plan_reference");
    expect(result.structuredContent).toMatchObject({
      jurisdiction: {
        coverage: "unknown",
        assets: [
          { token: NVDA, side: "sell", classification: "rhj_stock_token", restricted_jurisdictions: V2_COUNTRIES },
          { token: UNKNOWN, side: "sell", classification: "unknown", restricted_jurisdictions: null },
        ],
      },
    });
  });

  it("attaches nothing to a transfer of only unrestricted assets", async () => {
    const result = await callTool("prepare_transfers", {
      chain_id: ROBINHOOD_CHAIN, sender: SENDER,
      transfers: [
        { kind: "native", recipient: USDG, amount: "1" },
        { kind: "erc20", token: USDG, recipient: UNKNOWN, amount: "7" },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).not.toHaveProperty("jurisdiction");
  });

  it("returns the same restriction metadata for restricted, allowed and unknown connections", async () => {
    const mockedFetch = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      if (!input.toString().startsWith("https://quoter.test/")) return new Response("not found", { status: 404 });
      return Response.json({
        block_number: 123, block_hash: "0x01", total_calculated: "900",
        estimated_gas_cost: 25000, price_impact: 0.001,
        splits: [{ amount_specified: "1000", amount_calculated: "900", route: [{ swap: {
          type: "core", pool_key: { token0: "0x0000000000000000000000000000000000000000", token1: NVDA, config: `0x${"00".repeat(32)}` },
          sqrt_ratio_limit: "0x000000000000000000000000", skip_ahead: 0,
        } }] }],
      });
    }) as typeof fetch);
    try {
      for (const country of ["US", "IR", "FR", undefined]) {
        const result = await callTool("get_quotes_with_plans", {
          chain_id: ROBINHOOD_CHAIN,
          token_in: "0x0000000000000000000000000000000000000000", token_out: NVDA,
          quote_type: "exact_input", amount: "1000", sender: SENDER, slippage_bps: 10,
        }, country);
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toMatchObject({
          jurisdiction: { restricted_jurisdictions: V2_COUNTRIES, coverage: "complete", execution_hold: false },
          quotes: [{ execution: { jurisdiction: { policy_version: "ekubo-token-jurisdictions-v2" } } }],
        });
        const quotes = result.structuredContent.quotes as { execution: Record<string, unknown> }[];
        expect(quotes[0]!.execution).toHaveProperty("execution_plan_reference");
        expect(quotes[0]!.execution).not.toHaveProperty("execution_plan");
        const stored = [...env.ARTIFACT_STORE.entries.values()].map((entry) => JSON.parse(entry.value));
        expect(stored.some((plan) => plan.extensions?.["ekubo.jurisdiction"]?.restricted_jurisdictions.includes("US"))).toBe(true);
      }
    } finally {
      mockedFetch.mockRestore();
    }
  });

  // Board direction EKU-862: policy v2 is metadata only. None of these may
  // produce a jurisdiction refusal that the 0.44.1 v1 gate would not have.
  it("quotes and plans an unclassified asset, labeled coverage=unknown, identically for every connection", async () => {
    let calls = 0;
    const mockedFetch = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      if (!input.toString().startsWith("https://quoter.test/")) return new Response("not found", { status: 404 });
      calls += 1;
      return Response.json({
        block_number: 123, block_hash: "0x01", total_calculated: "900",
        estimated_gas_cost: 25000, price_impact: 0.001,
        splits: [{ amount_specified: "1000", amount_calculated: "900", route: [{ swap: {
          type: "core", pool_key: { token0: "0x0000000000000000000000000000000000000000", token1: UNKNOWN, config: `0x${"00".repeat(32)}` },
          sqrt_ratio_limit: "0x000000000000000000000000", skip_ahead: 0,
        } }] }],
      });
    }) as typeof fetch);
    try {
      const seen: string[] = [];
      for (const country of ["FR", "US", "IR", "XX", "T1", undefined]) {
        const result = await callTool("get_quotes_with_plans", {
          chain_id: ROBINHOOD_CHAIN,
          token_in: "0x0000000000000000000000000000000000000000", token_out: UNKNOWN,
          quote_type: "exact_input", amount: "1000", sender: SENDER, slippage_bps: 10,
        }, country);
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toMatchObject({
          jurisdiction: {
            coverage: "unknown", execution_hold: true, restricted_jurisdictions: null,
            assets: [
              { classification: "non_class", restricted_jurisdictions: [] },
              { token: UNKNOWN, side: "buy", classification: "unknown", restricted_jurisdictions: null },
            ],
          },
        });
        const quotes = result.structuredContent.quotes as { execution: Record<string, unknown> }[];
        expect(quotes[0]!.execution).toHaveProperty("execution_plan_reference");
        const text = JSON.stringify(result.structuredContent.jurisdiction);
        expect(text).not.toContain("country");
        seen.push(text);
      }
      expect(new Set(seen).size).toBe(1);
      expect(calls).toBeGreaterThan(0);
    } finally {
      mockedFetch.mockRestore();
    }
  });

  it("does not block swap quoting for a restricted acquisition", async () => {
    const result = await callTool(
      "get_quotes_with_plans",
      {
        chain_id: ROBINHOOD_CHAIN,
        token_in: USDG,
        token_out: NVDA,
        quote_type: "exact_input",
        amount: "1000000",
        sender: SENDER,
        slippage_bps: 10,
      },
      "US",
    );
    expect(result.structuredContent).not.toMatchObject({
      error: { code: "restricted_jurisdiction" },
    });
  });

  /**
   * Quotes are informational and carry metadata instead of a country gate, in
   * both directions. There is no quoter here, so this asserts the jurisdiction
   * gate specifically rather than a successful quote.
   */
  it("does not stop a swap quote that disposes of a restricted asset", async () => {
    const result = await callTool(
      "get_quotes_with_plans",
      {
        chain_id: ROBINHOOD_CHAIN,
        token_in: NVDA,
        token_out: USDG,
        quote_type: "exact_input",
        amount: "1000000",
        sender: SENDER,
        slippage_bps: 10,
      },
      "US",
    );
    expect(result.structuredContent).not.toMatchObject({
      error: { code: "restricted_jurisdiction" },
    });
  });

  it("does not block quoting a disposal from a restricted jurisdiction", async () => {
    const result = await callTool(
      "get_quotes_with_plans",
      {
        chain_id: ROBINHOOD_CHAIN,
        token_in: NVDA,
        token_out: USDG,
        quote_type: "exact_input",
        amount: "1000000",
        sender: SENDER,
        slippage_bps: 10,
      },
      "IR",
    );
    expect(result.structuredContent).not.toMatchObject({
      error: { code: "restricted_jurisdiction" },
    });
  });
});
