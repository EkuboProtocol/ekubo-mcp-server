import { createMcpHandler } from "agents/mcp/server";
import openapi from "../openapi.json";
import type { Env } from "./core.js";
import { createEkuboServer, publicToolCatalog } from "./server.js";
import {
  MCP_SERVER_VERSION,
  MCP_TOOL_CATALOG_REVISION,
} from "./version.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      const limited = await rateLimit(request, env);
      if (limited !== null) return limited;

      const requestOrigin = request.headers.get("origin");
      const handler = createMcpHandler(() => createEkuboServer(env), {
        route: "/mcp",
        allowedHostnames:
          env.ALLOWED_HOSTNAMES === undefined
            ? undefined
            : commaSeparatedHostnames(env.ALLOWED_HOSTNAMES),
        corsOptions: {
          origin: requestOrigin ?? url.origin,
          methods: "GET, POST, OPTIONS",
          headers:
            "content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
          exposeHeaders: "mcp-session-id, mcp-protocol-version",
          maxAge: 86400,
        },
        allowedOriginHostnames: allowedOriginHostnames(env, url.hostname),
      });
      const response = withSecurityHeaders(await handler(request, env, ctx));
      response.headers.set("cache-control", "no-store");
      return response;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json(
        { error: { code: "method_not_allowed", message: "Use GET" } },
        405,
        { Allow: "GET, HEAD" },
      );
    }

    switch (url.pathname) {
      case "/":
        return json(
          {
            name: "Ekubo Protocol MCP",
            description:
              "Public, unauthenticated, non-custodial agent tools for protocol reads and provider-neutral STONX allocations plus unsigned swap, bridge, and fee-first ve(3,3) calldata preparation",
            version: MCP_SERVER_VERSION,
            tool_catalog_revision: MCP_TOOL_CATALOG_REVISION,
            tool_count: publicToolCatalog.length,
            mcp_endpoint: `${url.origin}/mcp`,
            mcp_transport: "streamable-http",
            authentication: "none",
            tools_url: `${url.origin}/tools`,
            openapi_url: `${url.origin}/openapi.json`,
            llms_txt_url: `${url.origin}/llms.txt`,
            upstream_openapi: {
              data_api: "https://prod-api.ekubo.org/openapi.json",
              zero_x: "https://docs.0x.org",
              across: "https://docs.across.to/api-reference",
            },
            quoter_contract_resource: "ekubo://docs/quoter-api",
            ve33_workflow_resource: "ekubo://docs/ve33-workflow",
            execution_plan_resource: "ekubo://docs/execution-plan",
            lp_position_workflow_resource:
              "ekubo://docs/lp-position-workflow",
            contract_directory_resource: "ekubo://contracts/evm",
            safety: {
              signs_transactions: false,
              submits_transactions: false,
              requires_wallet_validation: true,
              requires_user_confirmation: true,
              ownership_and_nft_transfer_actions: "forbidden",
            },
            operational_semantics: {
              mcp_tool_result_storage: "none",
              mcp_http_cache:
                "no-store; tool calls are not replayed from an MCP cache",
              rate_limit_contract:
                "No fixed request quota is guaranteed. A configured deployment limiter returns HTTP 429 with Retry-After: 60; clients must back off and honor that header.",
              polling_guidance: {
                positions_by_owner:
                  "Upstream uses no-cache; poll only when ownership or liquidity may have changed.",
                pool_state_seconds: 180,
                pool_liquidity_depth_seconds: 1800,
                pool_key_seconds: 1800,
                recommendation_max_age_seconds: 86400,
              },
              discovery_http_cache_seconds: {
                root: 300,
                tools: 0,
                openapi: 3600,
                llms_txt: 3600,
              },
            },
          },
          200,
          cacheHeaders(300),
        );
      case "/tools":
        return json(
          {
            server_version: MCP_SERVER_VERSION,
            catalog_revision: MCP_TOOL_CATALOG_REVISION,
            tool_count: publicToolCatalog.length,
            tools: publicToolCatalog,
          },
          200,
          { "cache-control": "no-store" },
        );
      case "/openapi.json":
        return json(openapi, 200, cacheHeaders(3600));
      case "/llms.txt":
        return text(llmsText(url.origin), "text/plain; charset=utf-8", 3600);
      case "/robots.txt":
        return text(
          "User-agent: *\nAllow: /\n",
          "text/plain; charset=utf-8",
          86400,
        );
      default:
        return json(
          {
            error: {
              code: "route_not_found",
              message: "See /, /tools, /openapi.json, or /mcp",
            },
          },
          404,
        );
    }
  },
} satisfies ExportedHandler<Env>;

async function rateLimit(request: Request, env: Env): Promise<Response | null> {
  if (env.RATE_LIMITER === undefined || request.method === "OPTIONS") {
    return null;
  }
  const actor = request.headers.get("cf-connecting-ip") ?? "anonymous";
  const { success } = await env.RATE_LIMITER.limit({ key: `mcp:${actor}` });
  return success
    ? null
    : json(
        {
          error: {
            code: "rate_limited",
            message: "Too many MCP requests; retry later",
          },
        },
        429,
        { "retry-after": "60" },
      );
}

function allowedOriginHostnames(env: Env, requestHostname: string): string[] {
  const configured =
    env.ALLOWED_ORIGINS === undefined
      ? []
      : commaSeparatedHostnames(env.ALLOWED_ORIGINS, true);
  return [...new Set([requestHostname, ...configured])];
}

function commaSeparatedHostnames(value: string, parseOrigins = false): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (parseOrigins ? new URL(entry).hostname : entry));
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return withSecurityHeaders(
    Response.json(body, {
      status,
      headers: {
        "access-control-allow-origin": "*",
        ...headers,
      },
    }),
  );
}

function text(body: string, contentType: string, maxAge: number) {
  return withSecurityHeaders(
    new Response(body, {
      headers: {
        "content-type": contentType,
        "cache-control": `public, max-age=${maxAge}`,
        "access-control-allow-origin": "*",
      },
    }),
  );
}

function withSecurityHeaders(response: Response) {
  const secured = new Response(response.body, response);
  secured.headers.set("x-content-type-options", "nosniff");
  secured.headers.set("referrer-policy", "no-referrer");
  secured.headers.set("x-frame-options", "DENY");
  return secured;
}

function cacheHeaders(maxAge: number) {
  return { "cache-control": `public, max-age=${maxAge}` };
}

function llmsText(origin: string) {
  return `# Ekubo Protocol agent API

MCP endpoint: ${origin}/mcp
Transport: Streamable HTTP
Authentication: none
Server version: ${MCP_SERVER_VERSION}
Tool catalog revision: ${MCP_TOOL_CATALOG_REVISION}
Tool catalog: ${origin}/tools
OpenAPI: ${origin}/openapi.json
Canonical data API OpenAPI: https://prod-api.ekubo.org/openapi.json
Aggregated quote resource: ekubo://docs/quoter-api
ve(3,3) workflow resource: ekubo://docs/ve33-workflow
Execution plan resource: ekubo://docs/execution-plan
LP position workflow resource: ekubo://docs/lp-position-workflow
EVM contract directory: ekubo://contracts/evm

Operational semantics:
- MCP tool results are not stored or replayed by this server.
- No fixed request quota is guaranteed. If the deployment limiter returns HTTP 429, honor Retry-After: 60 and back off.
- Owner positions use upstream no-cache semantics. Position tools join canonical token metadata and USD prices and provide exact atomic pending eth_call plans for current position state. Indexed pool state is cached upstream for up to 180 seconds; tick liquidity and pool keys for up to 1,800 seconds. STONX recommendations are at most 86,400 seconds old.

STONX allocation shortcut:
- For "my Ekubo STONX allocations" or equivalent, call ekubo_get_ve33_allocations with the user's connected EVM wallet address as owner and omit chain_id and ve_token.
- The production Ve33 deployment is the STONX voting system; omitting those fields selects Robinhood Chain 4663 and the canonical VeToken automatically.
- If no connected wallet address is available, ask the user. Never infer it from a machine environment, repository, or local keystore.

Safe swap and bridge sequence:
1. Use ekubo_search_tokens when resolving a name or symbol. Use ekubo_get_token for one known chain/address pair, or ekubo_get_tokens for 1–1,000 known pairs in one batch request. Batch results preserve input order and duplicates while omitting unknown identifiers. Show the selected chains and addresses.
2. Convert the amount to base units using token decimals.
3. Use ekubo_get_quote or ekubo_prepare_swap with exact input/output intent and destination_chain_id.
4. Choose slippage before generating calldata.
5. Only treat a plan as ready when confirmation_ready is true.
6. Show the source, exact plan ID, chains, bounds, approvals, recipient, execution transaction, and any allowance reset.
7. Validate balances, allowances, and the exact transaction through the user's connected wallet or provider, and require explicit confirmation.
8. Use the user's wallet or signature tooling to sign and submit. Never send credentials to this server.

Wallet handoff: every executable preparation includes execution_plan. Read ekubo://docs/execution-plan, bind sender before preparation, verify its chain_id and sender against the selected local Cast account or connected wallet MCP, and preserve ordered_steps. Pass the exact execution_plan to a separately trusted compatible wallet MCP. For Cast, use --data with cast call and pass the same raw data positionally to cast estimate and cast send. The plan_id commits to the chain, sender, destination, calldata, and native value of all approval, execution, and cleanup calls.

ve(3,3): call ekubo_get_ve33_allocations before reorganizing votes, show the complete allocation and state_id, validate its read-only multicall, then pass that state_id and at most 25 target weight_bps values to ekubo_prepare_ve33_reallocation. Preserve the exact returned atomic order. Use the other dedicated tools for explicit extension, fee claims, and phased reinvestment. Read ekubo://docs/ve33-workflow before constructing a plan.
Suggested STONX update: call ekubo_get_stonx_allocation_recommendation, require execution_ready, at most 25 targets, and exactly 10,000 target basis points, then use strategy=compact_max_lock. Show the survivor, burned source NFT IDs, max-lock extension, final one-NFT-per-pool count, and decoded calls before confirmation. The recommendation tool constructs no transaction.
Fee reinvestment: call ekubo_prepare_ve33_reinvest phase=claim without explicit claims, snapshot exact fee-token balances, use phase=swap for claimed deltas only, refresh allocations, then use phase=stake_all to increase every existing active allocation.
New stake: use ekubo_prepare_ve33_stake. Max duration is the default when no duration is supplied. Existing stake extension remains explicit and must use the compound fee-claim extension tool.
Forbidden: never construct transferOwnership, ownership handover, ERC721 approval/transfer, safe transfer, or burn calldata.
Unsupported contract actions: only after checking tools/list, read ekubo://contracts/evm/{chain_id}, then ekubo://contracts/evm/{chain_id}/{address} for the exact ABI. Verify deployed code and simulate through the user's provider before requesting a signature.
`;
}
