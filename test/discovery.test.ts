import { describe, expect, it } from "bun:test";
import worker from "../src/index.js";
import {
  getTokensSchema,
  getStonxAllocationRecommendationSchema,
  getVe33AllocationsSchema,
  prepareVe33ExtendSchema,
  prepareVe33ReallocationSchema,
  prepareVe33StakeSchema,
  prepareVe33VoteSchema,
  publicToolCatalog,
  ROBINHOOD_STONX_CHAIN_ID,
  ROBINHOOD_STONX_VE_TOKEN,
  searchTokensSchema,
} from "../src/server.js";
import {
  MCP_SERVER_VERSION,
  MCP_TOOL_CATALOG_REVISION,
} from "../src/version.js";

const env = {
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "zero-x-test-key",
  ACROSS_API_KEY: "across-test-key",
  ACROSS_INTEGRATOR_ID: "test-integrator",
  DUNE_API_KEY: "recommendation-test-key",
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
      description: string;
      version: string;
      tool_catalog_revision: string;
      tool_count: number;
      mcp_endpoint: string;
      authentication: string;
      lp_position_workflow_resource: string;
      readiness_url?: string;
      safety: {
        requires_wallet_validation: boolean;
      };
      local_result_decoding: {
        trust_boundary: string;
        decode_kinds: string[];
        custom_bytes: { input_encoding: string; preserves_input: boolean };
      };
      operational_semantics: {
        rate_limit_contract: string;
        polling_guidance: { pool_liquidity_depth_seconds: number };
      };
    };
    expect(metadata.mcp_endpoint).toBe("https://mcp.ekubo.org/mcp");
    expect(metadata.description).toContain("STONX allocation");
    expect(metadata.description).toContain("non-custodial");
    expect(metadata.description).not.toContain("read-only agent tools");
    expect(metadata.version).toBe(MCP_SERVER_VERSION);
    expect(metadata.tool_catalog_revision).toBe(MCP_TOOL_CATALOG_REVISION);
    expect(metadata.tool_count).toBe(publicToolCatalog.length);
    expect(metadata.authentication).toBe("none");
    expect(metadata.lp_position_workflow_resource).toBe(
      "ekubo://docs/lp-position-workflow",
    );
    expect(metadata.readiness_url).toBeUndefined();
    expect(metadata.safety.requires_wallet_validation).toBe(true);
    expect(metadata.local_result_decoding).toMatchObject({
      trust_boundary: "user_device",
      decode_kinds: [
        "function_result",
        "multicall3",
        "semantic_value",
      ],
      custom_bytes: {
        input_encoding: "hex_bytes",
        preserves_input: true,
      },
    });
    expect(metadata.operational_semantics.rate_limit_contract).toContain(
      "Retry-After: 60",
    );
    expect(
      metadata.operational_semantics.polling_guidance
        .pool_liquidity_depth_seconds,
    ).toBe(1800);

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
    expect(tools.headers.get("cache-control")).toBe("no-store");
    const catalog = (await tools.json()) as {
      server_version: string;
      catalog_revision: string;
      tool_count: number;
      tools: typeof publicToolCatalog;
    };
    expect(catalog.server_version).toBe(MCP_SERVER_VERSION);
    expect(catalog.catalog_revision).toBe(MCP_TOOL_CATALOG_REVISION);
    expect(catalog.tool_count).toBe(publicToolCatalog.length);
    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      "ekubo_search_tokens",
      "ekubo_get_token",
      "ekubo_get_tokens",
      "ekubo_get_quote",
      "ekubo_prepare_swap",
      "ekubo_prepare_ve33_vote",
      "ekubo_prepare_ve33_extend",
      "ekubo_prepare_ve33_stake",
      "ekubo_prepare_ve33_split",
      "ekubo_prepare_ve33_claim_fees",
      "ekubo_prepare_ve33_reinvest",
      "ekubo_prepare_ve33_claim_all_fees",
      "ekubo_get_ve33_allocations",
      "ekubo_get_stonx_allocation_recommendation",
      "ekubo_prepare_ve33_reallocation",
      "ekubo_get_positions_by_owner",
      "ekubo_get_pool",
      "ekubo_get_pool_liquidity",
      "ekubo_derive_pool_id",
      "ekubo_decode_pool_config",
      "ekubo_get_position",
      "ekubo_get_position_pool_candidates",
      "ekubo_prepare_lp_position_deposit",
      "ekubo_prepare_lp_position_earnings_claim",
      "ekubo_prepare_lp_position_withdraw",
      "ekubo_prepare_wrap_unwrap",
      "ekubo_prepare_lp_position_transfer",
      "ekubo_prepare_fix_pool_price",
      "ekubo_prepare_twamm_order",
      "ekubo_prepare_twamm_order_collection",
      "ekubo_prepare_twamm_order_stop",
      "ekubo_prepare_twamm_virtual_orders",
      "ekubo_prepare_auction_create",
      "ekubo_prepare_auction_complete",
      "ekubo_prepare_auction_creator_proceeds",
      "ekubo_prepare_manual_pool_boost",
      "ekubo_prepare_oracle_capacity_expansion",
      "ekubo_prepare_approval_revocations",
      "ekubo_prepare_old_gekubo_unwrap",
      "ekubo_get_rewards_claims_by_owner",
      "ekubo_prepare_rewards_claim",
      "ekubo_prepare_recovery_fund_claim",
      "ekubo_prepare_revenue_buybacks",
      "ekubo_prepare_ve33_increase_stake",
      "ekubo_prepare_ve33_merge",
      "ekubo_prepare_ve33_withdraw",
      "ekubo_get_liquidity_opportunities",
    ]);
    expect(JSON.stringify(catalog)).not.toMatch(/dune|8187907|api\.dune/i);
    expect(
      catalog.tools.every(
        (tool) =>
          tool._meta["com.ekubo/catalogRevision"] === MCP_TOOL_CATALOG_REVISION,
      ),
    ).toBe(true);
    const batchTokens = catalog.tools.find(
      (tool) => tool.name === "ekubo_get_tokens",
    );
    expect(batchTokens?.description).toContain("one batch request");
    expect(batchTokens?.description).toContain("omitted");
    expect(
      (batchTokens?.inputSchema as { required?: string[] }).required,
    ).toEqual(["tokens"]);
    expect(
      getTokensSchema.safeParse({
        tokens: [
          { chain_id: "1", address: "0x0" },
          { chain_id: "4663", address: "0x1234" },
        ],
      }).success,
    ).toBe(true);
    expect(getTokensSchema.safeParse({ tokens: [] }).success).toBe(false);
    expect(
      searchTokensSchema.safeParse({
        chain_id: 4663,
        query: "STONX",
        page_size: 20,
      }).success,
    ).toBe(true);
    expect(
      searchTokensSchema.safeParse({
        chain_id: "0x1237",
        query: "STONX",
        page_size: 20,
      }).success,
    ).toBe(true);
    expect(
      getTokensSchema.safeParse({
        tokens: Array.from({ length: 1_001 }, () => ({
          chain_id: "1",
          address: "0x0",
        })),
      }).success,
    ).toBe(false);
    const stonxAllocations = catalog.tools.find(
      (tool) => tool.name === "ekubo_get_ve33_allocations",
    );
    expect(stonxAllocations?.description).toContain(
      "show all my Ekubo STONX allocations",
    );
    expect(
      (stonxAllocations?.inputSchema as { required?: string[] }).required,
    ).toEqual(["owner"]);
    expect(
      getVe33AllocationsSchema.safeParse({
        owner: "0x1111111111111111111111111111111111111111",
      }).success,
    ).toBe(true);
    expect(
      getVe33AllocationsSchema.safeParse({
        chain_id: "46630",
        owner: "0x1111111111111111111111111111111111111111",
      }).success,
    ).toBe(false);
    expect(ROBINHOOD_STONX_CHAIN_ID).toBe("4663");
    expect(ROBINHOOD_STONX_VE_TOKEN).toBe(
      "0x9d7008E169D040B6c0140eb92E7cA82B12643497",
    );
    const prepareSwap = catalog.tools.find(
      (tool) => tool.name === "ekubo_prepare_swap",
    );
    expect(prepareSwap?.description).toContain("connected wallet or provider");
    expect(
      prepareVe33VoteSchema.shape.current_vote.safeParse(null).success,
    ).toBe(false);
    expect(
      prepareVe33ExtendSchema.shape.current_pool_key.safeParse(null).success,
    ).toBe(false);
    expect(getStonxAllocationRecommendationSchema.safeParse({}).success).toBe(
      true,
    );
    expect(
      prepareVe33StakeSchema.safeParse({
        chain_id: "4663",
        ve_token: ROBINHOOD_STONX_VE_TOKEN,
        sender: "0x1111111111111111111111111111111111111111",
        stake_token: "0x570c5aa79c798e7a418412cc8399ae5bcce570c5",
        amount: "1",
        salt: `0x${"12".repeat(32)}`,
      }).success,
    ).toBe(true);
    const twentyFiveTargets = Array.from({ length: 25 }, (_, index) => ({
      pool_key_id: String(index + 1),
      swap_fee: String(index),
      weight_bps: 400,
    }));
    const reallocationBase = {
      chain_id: "4663",
      ve_token: ROBINHOOD_STONX_VE_TOKEN,
      sender: "0x1111111111111111111111111111111111111111",
      current_state_id: `0x${"34".repeat(32)}`,
      salt_nonce: `0x${"56".repeat(32)}`,
    };
    expect(
      prepareVe33ReallocationSchema.safeParse({
        ...reallocationBase,
        targets: twentyFiveTargets,
      }).success,
    ).toBe(true);
    expect(
      prepareVe33ReallocationSchema.safeParse({
        ...reallocationBase,
        targets: [...twentyFiveTargets, twentyFiveTargets[0]],
      }).success,
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
    expect(initialized.headers.get("cache-control")).toBe("no-store");
    const initializeResult = (await mcpJson(initialized)) as {
      result: {
        capabilities: { tools?: unknown };
        instructions?: string;
        serverInfo: { version: string };
      };
    };
    expect(initializeResult.result.capabilities.tools).toBeDefined();
    expect(initializeResult.result.serverInfo.version).toBe(MCP_SERVER_VERSION);
    expect(initializeResult.result.instructions).toContain(
      "ekubo_get_ve33_allocations",
    );
    expect(initializeResult.result.instructions).toContain("ekubo_get_tokens");
    expect(initializeResult.result.instructions).toContain(
      "Never infer the user's wallet",
    );
    expect(initializeResult.result.instructions).toContain(
      "unconditionally before that vote is cleared or moved",
    );
    expect(initializeResult.result.instructions).toContain(
      "strategy=compact_max_lock",
    );
    expect(initializeResult.result.instructions).toContain(
      "update my STONX allocations to the suggested allocations",
    );
    expect(initializeResult.result.instructions).toContain(
      "wallet must never construct calldata",
    );
    expect(initializeResult.result.instructions).toContain("execution_plan");
    expect(initializeResult.result.instructions).toContain(
      "plan_id commits to the chain",
    );
    expect(initializeResult.result.instructions).toContain(
      "Do not ask the user for a separate agent-level confirmation",
    );
    expect(initializeResult.result.instructions).toContain(
      "Cast remains an optional fallback",
    );
    expect(initializeResult.result.instructions).not.toContain(
      "receiving explicit user confirmation",
    );
    expect(initializeResult.result.instructions).not.toMatch(
      /dune|8187907|api\.dune/i,
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
      result: {
        tools: {
          name: string;
          _meta?: Record<string, unknown>;
        }[];
      };
    };
    expect(listResult.result.tools.map((tool) => tool.name)).toEqual(
      publicToolCatalog.map((tool) => tool.name),
    );
    expect(
      listResult.result.tools.every(
        (tool) =>
          tool._meta?.["com.ekubo/catalogRevision"] ===
          MCP_TOOL_CATALOG_REVISION,
      ),
    ).toBe(true);

    const preparedWrap = await worker.fetch(
      new Request("https://mcp.ekubo.org/mcp", {
        method: "POST",
        headers: { ...headers, "mcp-protocol-version": "2025-11-25" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 21,
          method: "tools/call",
          params: {
            name: "ekubo_prepare_wrap_unwrap",
            arguments: {
              chain_id: 1,
              sender: "0x1111111111111111111111111111111111111111",
              direction: "wrap",
              amount: "100",
            },
          },
        }),
      }),
      env,
      context,
    );
    expect(preparedWrap.status).toBe(200);
    const preparedWrapResult = (await mcpJson(preparedWrap)) as {
      result: { structuredContent: Record<string, unknown> };
    };
    expect(preparedWrapResult.result.structuredContent).toMatchObject({
      action: "ekubo_wrap_native_token",
      execution_plan_ready: true,
      agent_confirmation_required: false,
    });

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
    expect(
      resourceResult.result.resources.map((resource) => resource.uri),
    ).toContain("ekubo://docs/quoter-api");
    expect(
      resourceResult.result.resources.map((resource) => resource.uri),
    ).toContain("ekubo://docs/ve33-workflow");
    expect(
      resourceResult.result.resources.map((resource) => resource.uri),
    ).toContain("ekubo://docs/execution-plan");
    expect(
      resourceResult.result.resources.map((resource) => resource.uri),
    ).toContain("ekubo://docs/lp-position-workflow");
    expect(
      resourceResult.result.resources.map((resource) => resource.uri),
    ).toContain("ekubo://contracts/evm");

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
        forbidden_ownership_and_nft_actions: string[];
        notes: string[];
      };
    };
    expect(veToken.name).toBe("VeToken");
    expect(veToken.address).toBe("0x9d7008E169D040B6c0140eb92E7cA82B12643497");
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
    expect(veToken.vetoken_safety.notes.join(" ")).toContain("Never call burn");
    expect(veToken.vetoken_safety.forbidden_ownership_and_nft_actions).toEqual(
      expect.arrayContaining([
        "transferOwnership",
        "transferFrom",
        "safeTransferFrom",
        "approve (ERC721)",
        "burn",
      ]),
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
          execution_plan: {
            chain_id: string;
            ordered_steps: { kind: string }[];
          };
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
    expect(splitResult.result.structuredContent.execution_plan).toMatchObject({
      chain_id: "4663",
      ordered_steps: [{ kind: "execution" }],
    });

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
