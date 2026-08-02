const origin = (process.argv[2] ?? process.env.MCP_ORIGIN)?.replace(/\/+$/, "");
const expectedServerVersion = "0.18.0";
const expectedCatalogRevision = "2026-08-02.liquidity-opportunities";
const smokeNonce = `${Date.now()}-${Math.random()}`;
const privateRecommendationSourcePattern = /dune|8187907|api\.dune/i;

if (origin === undefined) {
  throw new Error(
    "Pass the deployed origin as an argument or set MCP_ORIGIN, for example: bun run smoke https://mcp.example.workers.dev",
  );
}

const metadata = await getJson("/");
assert(metadata.mcp_endpoint === `${origin}/mcp`, "root MCP URL is incorrect");
assert(
  metadata.version === expectedServerVersion,
  "root server version is stale",
);
assert(
  metadata.tool_catalog_revision === expectedCatalogRevision,
  "root tool catalog revision is stale",
);

const openapi = await getJson("/openapi.json");
assert(openapi.openapi === "3.1.0", "OpenAPI endpoint is invalid");

const catalog = await getJson("/tools");
const expectedTools = [
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
];
assert(
  catalog.server_version === expectedServerVersion,
  "HTTP tool catalog server version is stale",
);
assert(
  catalog.catalog_revision === expectedCatalogRevision,
  "HTTP tool catalog revision is stale",
);
assert(
  catalog.tool_count === expectedTools.length,
  "HTTP tool catalog count is incorrect",
);
assert(
  JSON.stringify(catalog.tools?.map((tool) => tool.name)) ===
    JSON.stringify(expectedTools),
  "HTTP tool catalog does not match the expected toolset",
);
assert(
  !privateRecommendationSourcePattern.test(JSON.stringify(catalog)),
  "HTTP discovery exposes the private recommendation source",
);

const initialized = await mcpRequest(1, "initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "ekubo-deployment-smoke", version: "1.0.0" },
});
assert(
  initialized.result?.capabilities?.tools,
  "MCP tools capability is missing",
);
assert(
  initialized.result?.serverInfo?.version === expectedServerVersion,
  "MCP server version is stale",
);
assert(
  initialized.result?.instructions?.includes("ekubo_get_ve33_allocations"),
  "MCP VeToken safety instructions are missing",
);
assert(
  !privateRecommendationSourcePattern.test(JSON.stringify(initialized)),
  "MCP initialization exposes the private recommendation source",
);

const listed = await mcpRequest(2, "tools/list", {});
assert(
  JSON.stringify(listed.result?.tools?.map((tool) => tool.name)) ===
    JSON.stringify(expectedTools),
  "MCP tools/list does not match the expected toolset",
);
assert(
  listed.result?.tools?.every(
    (tool) =>
      tool._meta?.["com.ekubo/catalogRevision"] === expectedCatalogRevision,
  ),
  "MCP tools/list is missing the tool catalog revision metadata",
);
assert(
  !privateRecommendationSourcePattern.test(JSON.stringify(listed)),
  "MCP tools/list exposes the private recommendation source",
);

const resources = await mcpRequest(3, "resources/list", {});
assert(
  resources.result?.resources?.some(
    (resource) => resource.uri === "ekubo://docs/execution-plan",
  ),
  "execution plan resource is missing",
);
assert(
  resources.result?.resources?.some(
    (resource) => resource.uri === "ekubo://docs/lp-position-workflow",
  ),
  "LP position workflow resource is missing",
);
assert(
  resources.result?.resources?.some(
    (resource) => resource.uri === "ekubo://contracts/evm",
  ),
  "contract directory resource is missing",
);

const templates = await mcpRequest(4, "resources/templates/list", {});
const expectedTemplates = [
  "ekubo://contracts/evm/{chain_id}",
  "ekubo://contracts/evm/{chain_id}/{address}",
];
assert(
  JSON.stringify(
    templates.result?.resourceTemplates?.map(
      (template) => template.uriTemplate,
    ),
  ) === JSON.stringify(expectedTemplates),
  "contract resource templates are missing",
);

const robinhoodContracts = await mcpRequest(5, "resources/read", {
  uri: "ekubo://contracts/evm/4663",
});
const robinhoodDirectory = JSON.parse(
  robinhoodContracts.result?.contents?.[0]?.text ?? "{}",
);
assert(
  Object.values(robinhoodDirectory.contracts ?? {}).some(
    (contract) => contract.name === "VeToken",
  ),
  "Robinhood Chain VeToken resource is missing",
);

const recommendationCall = await mcpRequest(6, "tools/call", {
  name: "ekubo_get_stonx_allocation_recommendation",
  arguments: {},
});
const recommendation = recommendationCall.result?.structuredContent;
assert(
  recommendation?.execution_ready === true,
  "recommendation is not executable",
);
assert(
  recommendation?.target_total_weight_bps === 10_000,
  "recommendation targets do not total 10,000 bps",
);
assert(
  Array.isArray(recommendation?.targets) && recommendation.targets.length > 0,
  "recommendation has no executable targets",
);
assert(
  recommendation?.safe_execution_workflow
    ?.every_current_vote_is_claimed_before_it_is_cleared_or_moved === true,
  "recommendation is missing the fee-preservation invariant",
);
assert(
  recommendation?.targets?.length <= 25 &&
    recommendation?.safe_execution_workflow?.compact_max_lock_strategy === true,
  "recommendation is missing the compact 25-NFT strategy",
);
assert(
  !privateRecommendationSourcePattern.test(JSON.stringify(recommendationCall)),
  "recommendation result exposes the private recommendation source",
);

console.log(`Ekubo MCP deployment smoke checks passed at ${origin}/mcp`);
console.log(`Discovered tools: ${expectedTools.join(", ")}`);

async function getJson(path) {
  const url = new URL(path, origin);
  url.searchParams.set("smoke_catalog_revision", expectedCatalogRevision);
  url.searchParams.set("smoke_nonce", smokeNonce);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  return response.json();
}

async function mcpRequest(id, method, params) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(method === "initialize"
        ? {}
        : { "mcp-protocol-version": "2025-11-25" }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${method} returned HTTP ${response.status}: ${body}`);
  }
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(body);
  }

  const data = body
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice("data:".length)
    .trim();
  if (data === undefined) {
    throw new Error(`${method} returned an MCP event stream without data`);
  }
  return JSON.parse(data);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
