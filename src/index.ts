import { createMcpHandler } from "agents/mcp/server";
import openapi from "../openapi.json";
import type { Env } from "./core.js";
import { createEkuboServer, publicToolCatalog } from "./server.js";

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
      return withSecurityHeaders(await handler(request, env, ctx));
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
              "Public, unauthenticated, read-only agent tools for token discovery, same-chain swaps, Across bridges, and ve(3,3) calldata preparation",
            version: "0.2.0",
            mcp_endpoint: `${url.origin}/mcp`,
            mcp_transport: "streamable-http",
            authentication: "none",
            tools_url: `${url.origin}/tools`,
            readiness_url: `${url.origin}/ready`,
            openapi_url: `${url.origin}/openapi.json`,
            llms_txt_url: `${url.origin}/llms.txt`,
            upstream_openapi: {
              data_api: "https://prod-api.ekubo.org/openapi.json",
              zero_x: "https://docs.0x.org",
              across: "https://docs.across.to/api-reference",
            },
            quoter_contract_resource: "ekubo://docs/quoter-api",
            ve33_workflow_resource: "ekubo://docs/ve33-workflow",
            safety: {
              signs_transactions: false,
              submits_transactions: false,
              requires_wallet_validation: true,
              requires_user_confirmation: true,
            },
          },
          200,
          cacheHeaders(300),
        );
      case "/health":
        return json({ status: "ok" }, 200, { "cache-control": "no-store" });
      case "/ready": {
        const providers = {
          zero_x: Boolean(env.ZERO_X_API_KEY),
          across: Boolean(env.ACROSS_API_KEY && env.ACROSS_INTEGRATOR_ID),
        };
        const ready = providers.zero_x && providers.across;
        return json(
          { status: ready ? "ready" : "degraded", providers },
          ready ? 200 : 503,
          { "cache-control": "no-store" },
        );
      }
      case "/tools":
        return json(
          { tools: publicToolCatalog },
          200,
          cacheHeaders(3600),
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
              message: "See /, /health, /ready, /tools, /openapi.json, or /mcp",
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
Tool catalog: ${origin}/tools
OpenAPI: ${origin}/openapi.json
Canonical data API OpenAPI: https://prod-api.ekubo.org/openapi.json
Aggregated quote resource: ekubo://docs/quoter-api
ve(3,3) workflow resource: ekubo://docs/ve33-workflow

Safe swap and bridge sequence:
1. Use ekubo_search_tokens; results prioritize visibility_priority. Show the selected chain and address.
2. Convert the amount to base units using token decimals.
3. Use ekubo_get_quote or ekubo_prepare_swap with exact input/output intent and destination_chain_id.
4. Choose slippage before generating calldata.
5. Only treat a plan as ready when confirmation_ready is true.
6. Show the source, exact plan ID, chains, bounds, approvals, recipient, execution transaction, and any allowance reset.
7. Validate balances, allowances, and the exact transaction through the user's connected wallet or provider, and require explicit confirmation.
8. Use the user's wallet or signature tooling to sign and submit. Never send credentials to this server.

ve(3,3): use the dedicated prepare tools for vote allocation/splitting, extension, fee claims, and phased reinvestment. Read ekubo://docs/ve33-workflow before constructing a plan.
`;
}
