const origin = (process.argv[2] ?? process.env.MCP_ORIGIN)?.replace(/\/+$/, "");

if (origin === undefined) {
  throw new Error(
    "Pass the deployed origin as an argument or set MCP_ORIGIN, for example: bun run smoke https://mcp.example.workers.dev",
  );
}

const metadata = await getJson("/");
assert(metadata.mcp_endpoint === `${origin}/mcp`, "root MCP URL is incorrect");

const openapi = await getJson("/openapi.json");
assert(openapi.openapi === "3.1.0", "OpenAPI endpoint is invalid");

const catalog = await getJson("/tools");
const expectedTools = [
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
];
assert(
  JSON.stringify(catalog.tools?.map((tool) => tool.name)) ===
    JSON.stringify(expectedTools),
  "HTTP tool catalog does not match the expected toolset",
);

const initialized = await mcpRequest(1, "initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "ekubo-deployment-smoke", version: "1.0.0" },
});
assert(initialized.result?.capabilities?.tools, "MCP tools capability is missing");

const listed = await mcpRequest(2, "tools/list", {});
assert(
  JSON.stringify(listed.result?.tools?.map((tool) => tool.name)) ===
    JSON.stringify(expectedTools),
  "MCP tools/list does not match the expected toolset",
);

const resources = await mcpRequest(3, "resources/list", {});
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

console.log(`Ekubo MCP deployment smoke checks passed at ${origin}/mcp`);
console.log(`Discovered tools: ${expectedTools.join(", ")}`);

async function getJson(path) {
  const response = await fetch(`${origin}${path}`, {
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
