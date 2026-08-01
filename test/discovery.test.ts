import { describe, expect, it } from "bun:test";
import worker from "../src/index.js";
import {
  prepareVe33ExtendSchema,
  prepareVe33VoteSchema,
  publicToolCatalog,
} from "../src/server.js";

const env = {
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "zero-x-test-key",
  ACROSS_API_KEY: "across-test-key",
  ACROSS_INTEGRATOR_ID: "test-integrator",
  ALLOWED_ORIGINS: "https://mcp.ekubo.org",
};
const context = {} as unknown as ExecutionContext;

describe("Worker discovery", () => {
  it("publishes root metadata, OpenAPI, and a deterministic tool catalog", async () => {
    const root = await worker.fetch(
      new Request("https://mcp.ekubo.org/"),
      env,
      context,
    );
    const metadata = (await root.json()) as {
      mcp_endpoint: string;
      authentication: string;
      readiness_url?: string;
      safety: {
        requires_wallet_validation: boolean;
      };
    };
    expect(metadata.mcp_endpoint).toBe("https://mcp.ekubo.org/mcp");
    expect(metadata.authentication).toBe("none");
    expect(metadata.readiness_url).toBeUndefined();
    expect(metadata.safety.requires_wallet_validation).toBe(true);

    const removedReadiness = await worker.fetch(
      new Request("https://mcp.ekubo.org/ready"),
      env,
      context,
    );
    expect(removedReadiness.status).toBe(404);
    const removedHealth = await worker.fetch(
      new Request("https://mcp.ekubo.org/health"),
      env,
      context,
    );
    expect(removedHealth.status).toBe(404);

    const tools = await worker.fetch(
      new Request("https://mcp.ekubo.org/tools"),
      env,
      context,
    );
    const catalog = (await tools.json()) as { tools: typeof publicToolCatalog };
    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      "ekubo_search_tokens",
      "ekubo_get_token",
      "ekubo_get_quote",
      "ekubo_prepare_swap",
      "ekubo_prepare_ve33_vote",
      "ekubo_prepare_ve33_extend",
      "ekubo_prepare_ve33_split",
      "ekubo_prepare_ve33_claim_fees",
      "ekubo_prepare_ve33_reinvest",
      "ekubo_prepare_ve33_claim_all_fees",
      "ekubo_get_ve33_allocations",
      "ekubo_prepare_ve33_reallocation",
    ]);
    const prepareSwap = catalog.tools.find(
      (tool) => tool.name === "ekubo_prepare_swap",
    );
    expect(prepareSwap?.description).toContain("connected wallet or provider");
    expect(prepareVe33VoteSchema.shape.current_vote.safeParse(null).success).toBe(
      false,
    );
    expect(
      prepareVe33ExtendSchema.shape.current_pool_key.safeParse(null).success,
    ).toBe(false);

    const spec = await worker.fetch(
      new Request("https://mcp.ekubo.org/openapi.json"),
      env,
      context,
    );
    const document = (await spec.json()) as {
      openapi: string;
      paths: Record<string, { post?: unknown }>;
    };
    expect(document.openapi).toBe("3.1.0");
    expect(document.paths["/mcp"].post).toBeDefined();
    expect(document.paths["/health"]).toBeUndefined();
  });

  it("serves protocol-native MCP initialization and tool discovery", async () => {
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      host: "mcp.ekubo.org",
      origin: "https://mcp.ekubo.org",
    };
    const initialized = await worker.fetch(
      new Request("https://mcp.ekubo.org/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "ekubo-test", version: "1.0.0" },
          },
        }),
      }),
      env,
      context,
    );
    expect(initialized.status).toBe(200);
    const initializeResult = (await mcpJson(initialized)) as {
      result: { capabilities: { tools?: unknown }; instructions?: string };
    };
    expect(initializeResult.result.capabilities.tools).toBeDefined();
    expect(initializeResult.result.instructions).toContain(
      "ekubo_get_ve33_allocations",
    );
    expect(initializeResult.result.instructions).toContain(
      "unconditionally before any split or vote mutation",
    );

    const listed = await worker.fetch(
      new Request("https://mcp.ekubo.org/mcp", {
        method: "POST",
        headers: { ...headers, "mcp-protocol-version": "2025-11-25" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      }),
      env,
      context,
    );
    expect(listed.status).toBe(200);
    const listResult = (await mcpJson(listed)) as {
      result: { tools: { name: string }[] };
    };
    expect(listResult.result.tools.map((tool) => tool.name)).toEqual(
      publicToolCatalog.map((tool) => tool.name),
    );

    const resources = await worker.fetch(
      new Request("https://mcp.ekubo.org/mcp", {
        method: "POST",
        headers: { ...headers, "mcp-protocol-version": "2025-11-25" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "resources/list",
          params: {},
        }),
      }),
      env,
      context,
    );
    expect(resources.status).toBe(200);
    const resourceResult = (await mcpJson(resources)) as {
      result: { resources: { uri: string }[] };
    };
    expect(resourceResult.result.resources.map((resource) => resource.uri)).toContain(
      "ekubo://docs/quoter-api",
    );
    expect(resourceResult.result.resources.map((resource) => resource.uri)).toContain(
      "ekubo://docs/ve33-workflow",
    );
    expect(resourceResult.result.resources.map((resource) => resource.uri)).toContain(
      "ekubo://contracts/evm",
    );

    const templates = await worker.fetch(
      new Request("https://mcp.ekubo.org/mcp", {
        method: "POST",
        headers: { ...headers, "mcp-protocol-version": "2025-11-25" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 31,
          method: "resources/templates/list",
          params: {},
        }),
      }),
      env,
      context,
    );
    expect(templates.status).toBe(200);
    const templateResult = (await mcpJson(templates)) as {
      result: { resourceTemplates: { uriTemplate: string }[] };
    };
    expect(
      templateResult.result.resourceTemplates.map(
        (template) => template.uriTemplate,
      ),
    ).toEqual([
      "ekubo://contracts/evm/{chain_id}",
      "ekubo://contracts/evm/{chain_id}/{address}",
    ]);

    const robinhoodContracts = await worker.fetch(
      new Request("https://mcp.ekubo.org/mcp", {
        method: "POST",
        headers: { ...headers, "mcp-protocol-version": "2025-11-25" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 32,
          method: "resources/read",
          params: { uri: "ekubo://contracts/evm/4663" },
        }),
      }),
      env,
      context,
    );
    expect(robinhoodContracts.status).toBe(200);
    const robinhoodResult = (await mcpJson(robinhoodContracts)) as {
      result: { contents: { text: string }[] };
    };
    const robinhoodDirectory = JSON.parse(
      robinhoodResult.result.contents[0]?.text ?? "{}",
    ) as {
      contracts: Record<string, { name: string; abi_resource_uri: string }>;
    };
    expect(Object.values(robinhoodDirectory.contracts)).toContainEqual(
      expect.objectContaining({ name: "VeToken" }),
    );
    expect(Object.values(robinhoodDirectory.contracts)).toContainEqual(
      expect.objectContaining({
        name: "YulRouter",
        abi_resource_uri:
          "ekubo://contracts/evm/4663/0x7B2aA7Ecc0B5936b7C52E6259A19C3BA557d0748",
      }),
    );

    const veTokenContract = await worker.fetch(
      new Request("https://mcp.ekubo.org/mcp", {
        method: "POST",
        headers: { ...headers, "mcp-protocol-version": "2025-11-25" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 33,
          method: "resources/read",
          params: {
            uri: "ekubo://contracts/evm/4663/0x9d7008e169d040b6c0140eb92e7ca82b12643497",
          },
        }),
      }),
      env,
      context,
    );
    expect(veTokenContract.status).toBe(200);
    const veTokenResult = (await mcpJson(veTokenContract)) as {
      result: { contents: { text: string }[] };
    };
    const veToken = JSON.parse(
      veTokenResult.result.contents[0]?.text ?? "{}",
    ) as {
      name: string;
      address: string;
      abi: { type: string; name?: string }[];
      vetoken_safety: {
        claim_current_pool_fees_before: string[];
        notes: string[];
      };
    };
    expect(veToken.name).toBe("VeToken");
    expect(veToken.address).toBe(
      "0x9d7008E169D040B6c0140eb92E7cA82B12643497",
    );
    expect(veToken.abi).toContainEqual(
      expect.objectContaining({
        type: "function",
        name: "claimPoolFeesToSelf",
      }),
    );
    expect(veToken.vetoken_safety.claim_current_pool_fees_before).toContain(
      "vote",
    );
    expect(veToken.vetoken_safety.claim_current_pool_fees_before).toContain(
      "mergeStakes (claim the full source NFT)",
    );
    expect(veToken.vetoken_safety.notes.join(" ")).toContain(
      "Never call burn",
    );

    const quoterContract = await worker.fetch(
      new Request("https://mcp.ekubo.org/mcp", {
        method: "POST",
        headers: { ...headers, "mcp-protocol-version": "2025-11-25" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "resources/read",
          params: { uri: "ekubo://docs/quoter-api" },
        }),
      }),
      env,
      context,
    );
    expect(quoterContract.status).toBe(200);
    const contractResult = (await mcpJson(quoterContract)) as {
      result: { contents: { text: string }[] };
    };
    expect(contractResult.result.contents[0]?.text).toContain(
      "GET /{chainId}/{signedAmount}/{specifiedToken}/{otherToken}",
    );

    const splitPlan = await worker.fetch(
      new Request("https://mcp.ekubo.org/mcp", {
        method: "POST",
        headers: { ...headers, "mcp-protocol-version": "2025-11-25" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "ekubo_prepare_ve33_split",
            arguments: {
              chain_id: "4663",
              ve_token: "0x9d7008E169D040B6c0140eb92E7cA82B12643497",
              sender: "0x1111111111111111111111111111111111111111",
              ve_id: "123",
              amount: "1",
              salt: `0x${"12".repeat(32)}`,
            },
          },
        }),
      }),
      env,
      context,
    );
    expect(splitPlan.status).toBe(200);
    const splitResult = (await mcpJson(splitPlan)) as {
      result: {
        structuredContent: {
          action: string;
          transaction: { chain_id: string; data: string };
        };
      };
    };
    expect(splitResult.result.structuredContent.action).toBe("ve33_split");
    expect(splitResult.result.structuredContent.transaction.chain_id).toBe(
      "4663",
    );
    expect(splitResult.result.structuredContent.transaction.data).toStartWith(
      "0x",
    );

    const mismatchedCaip = await worker.fetch(
      new Request("https://mcp.ekubo.org/mcp", {
        method: "POST",
        headers: { ...headers, "mcp-protocol-version": "2025-11-25" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: {
            name: "ekubo_get_quote",
            arguments: {
              chain_id: "1",
              token_in:
                "eip155:4663:0x1111111111111111111111111111111111111111",
              token_out: "0x2222222222222222222222222222222222222222",
              quote_type: "exact_input",
              amount: "1",
              source: "ekubo",
            },
          },
        }),
      }),
      env,
      context,
    );
    const mismatchResult = (await mcpJson(mismatchedCaip)) as {
      result: {
        isError: boolean;
        structuredContent: { error: { code: string } };
      };
    };
    expect(mismatchResult.result.isError).toBe(true);
    expect(mismatchResult.result.structuredContent.error.code).toBe(
      "chain_mismatch",
    );
  });

  it("rejects browser origins outside the explicit allowlist", async () => {
    const response = await worker.fetch(
      new Request("https://mcp.ekubo.org/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          host: "mcp.ekubo.org",
          origin: "https://example.com",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "blocked-test", version: "1.0.0" },
          },
        }),
      }),
      env,
      context,
    );

    expect(response.status).toBe(403);
  });
});

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
