const origin = (process.argv[2] ?? process.env.MCP_ORIGIN)?.replace(/\/+$/, "");
const expectedServerVersion = "0.40.0";
const expectedCatalogRevision = "2026-09-08.per-protocol-endpoints";
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
// The limiter bindings are provisioned outside this repository, so a deploy
// can silently come up with abuse protection missing. The published contract
// is the one part of it a smoke run can see from outside.
assert(
  ["burst", "sustained", "tool_units", "metered_providers"].every(
    (scope) =>
      typeof metadata.operational_semantics?.rate_limit_contract?.scopes?.[
        scope
      ] === "string",
  ),
  "root rate limit contract is missing a scope",
);

const openapi = await getJson("/openapi.json");
assert(openapi.openapi === "3.1.0", "OpenAPI endpoint is invalid");

const catalog = await getJson("/tools");
const expectedTools = [
  "list_tokens",
  "export_tokens",
  "get_token",
  "get_tokens",
  "get_quotes_with_plans",
  "get_value_transfer_status",
  "prepare_ve33_vote",
  "prepare_ve33_extend",
  "prepare_ve33_stake",
  "prepare_ve33_split",
  "prepare_ve33_claim_fees",
  "prepare_ve33_reinvest",
  "prepare_ve33_claim_all_fees",
  "prepare_ve33_clear_vote",
  "get_ve33_allocations",
  "get_stonx_allocation_recommendation",
  "prepare_ve33_reallocation",
  "get_positions_by_owner",
  "get_pool",
  "get_pool_liquidity",
  "list_pool_keys",
  "derive_pool_id",
  "decode_pool_config",
  "get_position",
  "get_position_pool_candidates",
  "prepare_lp_position_deposit",
  "prepare_lp_position_earnings_claim",
  "prepare_lp_position_withdraw",
  "prepare_wrap_unwrap",
  "prepare_transfers",
  "prepare_lp_position_transfer",
  "prepare_fix_pool_price",
  "prepare_twamm_order",
  "prepare_twamm_order_collection",
  "prepare_twamm_order_stop",
  "prepare_twamm_virtual_orders",
  "prepare_auction_create",
  "prepare_auction_complete",
  "prepare_auction_creator_proceeds",
  "prepare_manual_pool_boost",
  "prepare_oracle_capacity_expansion",
  "prepare_approval_revocations",
  "prepare_old_gekubo_unwrap",
  "get_rewards_claims_by_owner",
  "prepare_rewards_claim",
  "prepare_revenue_buybacks",
  "prepare_ve33_increase_stake",
  "prepare_ve33_merge",
  "prepare_ve33_withdraw",
  "get_liquidity_opportunities",
  "prepare_pool_initialization",
  "get_aave_v3_markets",
  "prepare_aave_v3_supply",
  "prepare_aave_v3_withdraw",
  "prepare_aave_v3_borrow",
  "prepare_aave_v3_repay",
  "prepare_aave_v3_collateral",
  "prepare_aave_v3_emode",
  "get_morpho_vaults",
  "prepare_morpho_vault_deposit",
  "prepare_morpho_vault_withdraw",
  "prepare_morpho_vault_redeem",
  "get_sky_savings_deployment",
  "prepare_sky_savings_deposit",
  "prepare_sky_savings_withdraw",
  "prepare_sky_savings_redeem",
  "get_merkl_deployment",
  "prepare_merkl_claim",
  "get_aerodrome_deployment",
  "prepare_aerodrome_sugar_reads",
  "prepare_aerodrome_liquidity_deposit",
  "prepare_aerodrome_liquidity_withdraw",
  "prepare_aerodrome_gauge_deposit",
  "prepare_aerodrome_gauge_withdraw",
  "prepare_aerodrome_gauge_claim",
  "prepare_aerodrome_lock",
  "prepare_aerodrome_vote",
  "prepare_aerodrome_incentive_claim",
  "get_lido_deployment",
  "prepare_lido_stake",
  "prepare_lido_wrap",
  "prepare_lido_unwrap",
  "prepare_lido_withdrawal_request",
  "prepare_lido_withdrawal_claim",
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
  initialized.result?.instructions?.includes("get_ve33_allocations"),
  "MCP VeToken safety instructions are missing",
);
assert(
  initialized.result?.instructions?.includes(expectedCatalogRevision),
  "MCP instructions are missing the tool catalog revision",
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
    (tool) => tool._meta?.["com.ekubo/catalogRevision"] === undefined,
  ),
  "MCP tools/list still repeats per-tool catalog revision metadata",
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
for (const skill of ["use-morpho", "use-sky", "use-lido"]) {
  assert(
    resources.result?.resources?.some(
      (resource) => resource.uri === `ekubo://skills/${skill}`,
    ),
    `${skill} resource is missing`,
  );
}

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
  name: "get_stonx_allocation_recommendation",
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

const listTokensCall = await mcpRequest(7, "tools/call", {
  name: "list_tokens",
  arguments: { chain_id: "4663", search: "NVDA" },
});
const listedTokens = listTokensCall.result?.structuredContent?.tokens;
assert(
  Array.isArray(listedTokens) && listedTokens.length > 0,
  "list_tokens returned no tokens for a known symbol",
);
assert(
  listedTokens.every((token) => token.chain_id === "4663"),
  "list_tokens ignored chain_id",
);
assert(
  listedTokens.every(
    (token, index) =>
      index === 0 ||
      token.visibility_priority <= listedTokens[index - 1].visibility_priority,
  ),
  "list_tokens is not ordered by descending visibility priority",
);

const unfilteredTokensCall = await mcpRequest(8, "tools/call", {
  name: "list_tokens",
  arguments: {},
});
assert(
  (unfilteredTokensCall.result?.structuredContent?.tokens ?? []).length > 0,
  "list_tokens requires arguments it should default",
);

// The per-protocol endpoints, checked against the deployment rather than
// against this file's own list: the point of the check is that /mcp/<slug>
// answers at all and serves exactly what the deployed root document says it
// does. A deployment that routed every slug back to the full catalog would
// pass a tools/list that only asserted "some tools came back".
const advertised = metadata.mcp_endpoints;
assert(
  advertised?.all?.url === `${origin}/mcp`,
  "root document does not advertise /mcp as the all-protocol endpoint",
);
assert(
  Array.isArray(advertised.by_protocol) && advertised.by_protocol.length > 0,
  "root document advertises no per-protocol endpoints",
);
const seenPerProtocol = [];
for (const entry of advertised.by_protocol) {
  assert(
    entry.url === `${origin}/mcp/${entry.protocol}`,
    `${entry.protocol} endpoint URL is incorrect`,
  );
  const filtered = await getJson(`/tools?protocol=${entry.protocol}`);
  const names = (filtered.tools ?? []).map((tool) => tool.name);
  assert(
    names.length === entry.tool_count &&
      names.every((name) => entry.tools.includes(name)),
    `/tools?protocol=${entry.protocol} disagrees with the root document`,
  );
  const listed = await mcpRequest(
    100,
    "tools/list",
    {},
    `/mcp/${entry.protocol}`,
  );
  const served = (listed.result?.tools ?? []).map((tool) => tool.name).sort();
  assert(
    served.length === names.length &&
      served.every((name, index) => name === [...names].sort()[index]),
    `/mcp/${entry.protocol} does not serve exactly its own tools`,
  );
  seenPerProtocol.push(...served);
}
assert(
  new Set(seenPerProtocol).size === seenPerProtocol.length,
  "a tool is served by more than one per-protocol endpoint",
);
assert(
  seenPerProtocol.length === expectedTools.length,
  "the per-protocol endpoints do not cover the whole catalog",
);

console.log(`Ekubo MCP deployment smoke checks passed at ${origin}/mcp`);
console.log(
  `Per-protocol endpoints: ${advertised.by_protocol
    .map((entry) => `${entry.protocol} (${entry.tool_count})`)
    .join(", ")}`,
);
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

async function mcpRequest(id, method, params, path = "/mcp") {
  const response = await fetch(`${origin}${path}`, {
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
