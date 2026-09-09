import { attestationTypedData } from "../src/jurisdiction-message.js";
import { describe, expect, it } from "bun:test";
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

describe("jurisdiction restrictions over the MCP endpoint", () => {
  it("requires a signed attestation for indicative restricted-token quotes", async () => {
    const result = await callTool(
      "get_quotes_with_plans",
      {
        chain_id: ROBINHOOD_CHAIN,
        token_in: USDG,
        token_out: NVDA,
        quote_type: "exact_input",
        amount: "1000000",
        attestation_address: SENDER,
        jurisdiction_code: "DE",
      },
      "DE",
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "jurisdiction_attestation_required",
        details: {
          typed_data: {
            primaryType: "JurisdictionAttestation",
            message: { wallet: SENDER },
          },
        },
      },
    });
  });

  it("verifies signatures submitted through the quote schema", async () => {
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
        attestation: {
          typed_data: attestationTypedData(
            SENDER,
            "DE",
            Math.floor(Date.now() / 1000),
          ),
          signature: `0x${"00".repeat(65)}`,
        },
      },
      "DE",
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: "invalid_attestation" },
    });
  });

  it("refuses to prepare a restricted asset for a restricted country", async () => {
    const result = await callTool(
      "prepare_oracle_capacity_expansion",
      {
        chain_id: ROBINHOOD_CHAIN,
        sender: SENDER,
        token: NVDA,
        min_capacity: 64,
      },
      "US",
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "restricted_jurisdiction" },
    });
  });

  it("prepares the same asset for an unrestricted country", async () => {
    const result = await callTool(
      "prepare_oracle_capacity_expansion",
      {
        chain_id: ROBINHOOD_CHAIN,
        sender: SENDER,
        token: NVDA,
        min_capacity: 64,
      },
      "FR",
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toHaveProperty("execution_plan_reference");
  });

  it("fails closed for a restricted asset when the edge resolved no country", async () => {
    const result = await callTool("prepare_oracle_capacity_expansion", {
      chain_id: ROBINHOOD_CHAIN,
      sender: SENDER,
      token: NVDA,
      min_capacity: 64,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "restricted_jurisdiction" },
    });
  });

  // The regression that matters: an unresolved country must restrict the
  // restricted assets only, never every asset on the chain.
  it("still prepares an unrestricted asset when the edge resolved no country", async () => {
    const result = await callTool("prepare_oracle_capacity_expansion", {
      chain_id: ROBINHOOD_CHAIN,
      sender: SENDER,
      token: USDG,
      min_capacity: 64,
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toHaveProperty("execution_plan_reference");
  });

  it("does not restrict an unrestricted asset for a restricted country", async () => {
    const result = await callTool(
      "prepare_oracle_capacity_expansion",
      {
        chain_id: ROBINHOOD_CHAIN,
        sender: SENDER,
        token: USDG,
        min_capacity: 64,
      },
      "US",
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toHaveProperty("execution_plan_reference");
  });

  it("refuses a swap quote that would acquire a restricted asset", async () => {
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
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "restricted_jurisdiction" },
    });
  });

  /**
   * The disposal is the point of the carve-out, so it is checked through the
   * endpoint and not only against the gate. There is no quoter here, so this
   * asserts the jurisdiction gate specifically rather than a successful quote:
   * whatever this fails on downstream, it must no longer be the region.
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

  it("still refuses that disposal from a sanctioned jurisdiction", async () => {
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
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "restricted_jurisdiction" },
    });
  });
});
