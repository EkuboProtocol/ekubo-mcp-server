import { createMcpHandler } from "agents/mcp/server";
import openapi from "../openapi.json";
import type { Env } from "./core.js";
import { ARTIFACT_TTL_SECONDS, loadArtifact } from "./artifact-store.js";
import {
  chargeForMcpBody,
  enforceRequestRate,
  enforceToolRate,
  MAX_BATCH_LENGTH,
  MAX_MCP_BODY_BYTES,
  MAX_UNITS_PER_REQUEST,
  rateLimitActor,
  type RateLimitRejection,
} from "./rate-limit.js";
import {
  createEkuboServer,
  publicToolCatalog,
  publicToolCatalogWithOutputs,
} from "./server.js";
import { MCP_SERVER_VERSION, MCP_TOOL_CATALOG_REVISION } from "./version.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const actor = rateLimitActor(request);

    // A CORS preflight carries no body and does no work; limiting it only
    // breaks browser clients without denying an abuser anything.
    if (request.method !== "OPTIONS") {
      const rejection = await enforceRequestRate(env, actor);
      if (rejection !== null) return rateLimited(rejection, null);
    }

    if (url.pathname === "/mcp") {
      const admitted = await admitMcpRequest(request, env, actor);
      if (admitted.rejection !== null) return admitted.rejection;
      // Pricing a call means reading the body, so what reaches the MCP handler
      // is a replay of this request carrying those same bytes.
      const mcpRequest = admitted.request;

      const requestOrigin = mcpRequest.headers.get("origin");
      const handler = createMcpHandler(() => createEkuboServer(env, url.origin), {
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
      const response = withSecurityHeaders(await handler(mcpRequest, env, ctx));
      response.headers.set("cache-control", "no-store");
      return response;
    }

    if (
      (url.pathname === "/.well-known/mcp.json" ||
        url.pathname === "/.well-known/mcp/server-card.json") &&
      request.method === "OPTIONS"
    ) {
      return withSecurityHeaders(
        new Response(null, {
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, HEAD, OPTIONS",
            "access-control-allow-headers": "content-type",
            ...cacheHeaders(3600),
          },
        }),
      );
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json(
        { error: { code: "method_not_allowed", message: "Use GET" } },
        405,
        { Allow: "GET, HEAD" },
      );
    }

    // Stored artifact bodies (execution plans and read-call bundles), fetched
    // by wallets from the reference URL a tool returned. Served byte-for-byte
    // as stored so the wallet's keccak256 of the response matches the
    // reference's integrity.value exactly.
    const artifactMatch = /^\/artifact\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(
      url.pathname,
    );
    if (artifactMatch !== null) {
      const body = await loadArtifact(env, artifactMatch[1]);
      if (body === null) {
        // A miss can mean expiry, a bad id, or a KV propagation gap between
        // the storing PoP and this one. Log it so the miss rate is measurable
        // before deciding stronger storage is warranted.
        console.warn(
          JSON.stringify({
            event: "artifact_fetch_miss",
            id: artifactMatch[1],
          }),
        );
        return json(
          {
            error: {
              code: "artifact_not_found_or_expired",
              message:
                "This reference has expired or never existed. Re-run the Ekubo tool that produced it to obtain a fresh reference.",
            },
          },
          404,
        );
      }
      return withSecurityHeaders(
        new Response(request.method === "HEAD" ? null : body, {
          headers: {
            "content-type": "application/json",
            "content-length": String(new TextEncoder().encode(body).length),
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
          },
        }),
      );
    }

    switch (url.pathname) {
      case "/":
        return json(
          {
            name: "Ekubo Protocol MCP",
            description:
              "Primary non-browser, public, unauthenticated, non-custodial tools for onchain swaps on supported EVM networks, plus protocol, LP, token-balance, allowance, bridge, STONX allocation, and signer-neutral Ekubo and Aave V3 transaction preparation workflows",
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
            external_market_data: {
              server_role:
                "none: agents call these public APIs directly; this MCP does not proxy, cache, authenticate to, or replay them",
              aave: {
                graphql: "https://api.v3.aave.com/graphql",
                graphql_docs:
                  "https://aave.com/docs/aave-v3/getting-started/graphql",
                market_data_docs:
                  "https://aave.com/docs/aave-v3/markets/data",
              },
            },
            quoter_contract_resource: "ekubo://docs/quoter-api",
            ve33_workflow_resource: "ekubo://docs/ve33-workflow",
            execution_plan_resource: "ekubo://docs/execution-plan",
            lp_position_workflow_resource: "ekubo://docs/lp-position-workflow",
            contract_directory_resource: "ekubo://contracts/evm",
            safety: {
              signs_transactions: false,
              submits_transactions: false,
              requires_wallet_validation: true,
              agent_confirmation_required: false,
              wallet_authorization_on_simulated_result: true,
              ownership_and_nft_transfer_actions: "forbidden",
            },
            local_result_decoding: {
              trust_boundary: "user_device",
              raw_return_data_default: "included",
              raw_return_data_on_decode_failure: "required",
              decode_kinds: [
                "function_result",
                "multicall3",
                "function_result_bytes_array",
                "semantic_value",
              ],
              custom_bytes: {
                kind: "semantic_value",
                input: "raw_return_data",
                raw_return_data_preserved: true,
              },
              semantic_codec_policy:
                "Platform-neutral codec IDs with explicit implementation assertions; wallets execute only locally installed allowlisted codecs and never fetch code from a plan.",
            },
            operational_semantics: {
              mcp_tool_result_storage: `wallet_payload_bodies_only: prepared execution plan bodies, read-call bundles (exact wallet_batch_eth_call argument objects), and token lists exported by export_tokens are retained at ${url.origin}/artifact/<id> for ${ARTIFACT_TTL_SECONDS} seconds so wallets fetch them by reference instead of receiving them through the agent; no other tool results are stored or replayed`,
              artifact_delivery: {
                mode: "reference",
                envelope_kind: "artifact_reference",
                artifact_types: ["execution_plan", "read_calls", "token_list"],
                fetch_url_template: `${url.origin}/artifact/<id>`,
                storage_ttl_seconds: ARTIFACT_TTL_SECONDS,
                handling:
                  "Pass the whole artifact_reference object unchanged as the wallet tool's reference argument; the wallet fetches the body itself. A 404 means the reference expired: re-run the tool that produced it.",
                integrity:
                  "reference.integrity.value is keccak256 of the exact bytes served and reference.bytes their exact length; wallets recompute both over the fetched body and must refuse a mismatch",
                staleness:
                  "No timestamps travel in the envelope. A plan's validity is expressed by the deadline inside its calldata and enforced by the wallet's simulation against current chain state.",
              },
              mcp_http_cache:
                "no-store; tool calls are not replayed from an MCP cache",
              // Shapes, not numbers. A client needs to know which budget it
              // hit and how to stop hitting it; a scraper given the exact
              // ceilings would simply run just underneath them.
              rate_limit_contract: {
                quota:
                  "No fixed request quota is guaranteed. Limits are enforced per caller, where a caller is one IPv4 address or one IPv6 /64.",
                scopes: {
                  burst: "requests over a few seconds, across every route",
                  sustained: "requests over one minute, across every route",
                  tool_units:
                    "weighted tool cost over one minute; a bulk, fan-out, or provider-backed call costs several times an ordinary read, and a purely local one costs nothing",
                  metered_providers:
                    "calls over one minute to the tools that buy quotes or recommendations from a third party",
                },
                response:
                  "HTTP 429 with Retry-After in seconds. A single identified JSON-RPC call is answered with JSON-RPC error code -32029 carrying data.scope and data.retry_after_seconds.",
                client_obligation:
                  "Honor Retry-After rather than retrying on a fixed interval. Batch identifiers into one call instead of paging the catalog, narrow filters instead of enumerating, and reuse a quote already held instead of re-fetching it.",
                request_limits: {
                  max_body_bytes: MAX_MCP_BODY_BYTES,
                  max_jsonrpc_messages_per_request: MAX_BATCH_LENGTH,
                  // An over-ceiling request is refused rather than served at a
                  // discount. No individual tool reaches the ceiling, so this
                  // only ever asks a client to split a batch.
                  max_tool_units_per_request: MAX_UNITS_PER_REQUEST,
                },
              },
              polling_guidance: {
                positions_by_owner:
                  "Upstream uses no-cache; poll only when ownership or liquidity may have changed.",
                pool_state_seconds: 180,
                pool_liquidity_depth_seconds: 1800,
                pool_key_seconds: 1800,
                liquidity_opportunity_seconds: {
                  pairs_and_boosted_fees: 600,
                  campaigns: 300,
                  ve33_pools: 30,
                },
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
      case "/.well-known/mcp.json":
      case "/.well-known/mcp/server-card.json":
        return json(
          {
            $schema:
              "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
            version: "1.0",
            protocolVersion: "2025-06-18",
            serverInfo: {
              name: "ekubo-mcp",
              title: "Ekubo Protocol MCP",
              version: MCP_SERVER_VERSION,
            },
            description:
              "Primary non-browser onchain swap and unsigned transaction-planning tools for Ekubo Protocol.",
            documentationUrl: "https://docs.ekubo.org",
            transport: {
              type: "streamable-http",
              // Discovery clients may consume the server card without first
              // resolving it relative to the request URL. Advertise the
              // canonical absolute endpoint so connection is immediate.
              endpoint: `${url.origin}/mcp`,
            },
            capabilities: {
              tools: {},
              resources: {},
            },
            authentication: {
              required: false,
              schemes: [],
            },
            tools: "dynamic",
            resources: "dynamic",
          },
          200,
          {
            // Server cards are the discovery entry point. Keep them
            // uncached so clients see endpoint and version changes
            // immediately after deployment.
            "cache-control": "no-store",
            "access-control-allow-methods": "GET, HEAD, OPTIONS",
            "access-control-allow-headers": "content-type",
          },
        );
      case "/tools":
        return json(
          {
            server_version: MCP_SERVER_VERSION,
            catalog_revision: MCP_TOOL_CATALOG_REVISION,
            tool_count: publicToolCatalog.length,
            tools: publicToolCatalogWithOutputs,
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

/**
 * Price an MCP request against the per-tool budgets before the MCP handler
 * sees it.
 *
 * Deciding what a call costs means knowing which tool it names, and the only
 * place that is knowable before the work starts is the JSON-RPC body. So the
 * body is read here and the request is rebuilt around those same bytes for the
 * handler; a `GET` (the SSE stream) has no body and passes straight through.
 *
 * Rejecting here rather than inside a tool is deliberate: an HTTP 429 with
 * `Retry-After` is a status every client already knows how to back off from,
 * and it costs no upstream call to produce.
 */
async function admitMcpRequest(
  request: Request,
  env: Env,
  actor: string,
): Promise<{ request: Request; rejection: Response | null }> {
  if (request.method !== "POST") return { request, rejection: null };

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_MCP_BODY_BYTES) {
    return { request, rejection: bodyTooLarge() };
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).length > MAX_MCP_BODY_BYTES) {
    return { request, rejection: bodyTooLarge() };
  }
  // The handler is given the bytes we priced, not a second read of a stream
  // that has already been consumed. Rebuilt from the URL rather than cloned so
  // it does not depend on how a runtime treats a Request whose body was read.
  const replayed = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  });

  const priced = chargeForMcpBody(body);
  if (!priced.ok) {
    // An unparseable body is the MCP handler's error to report, not ours: it
    // owns the JSON-RPC parse-error contract and the session semantics around
    // it. The oversized asks are refused here, because serving them is what we
    // are declining to do.
    if (priced.reason === "unparseable") {
      return { request: replayed, rejection: null };
    }
    return {
      request: replayed,
      rejection:
        priced.reason === "too_many_calls"
          ? json(
              {
                error: {
                  code: "batch_too_large",
                  message: `Send at most ${MAX_BATCH_LENGTH} JSON-RPC messages per request.`,
                },
              },
              400,
            )
          : json(
              {
                error: {
                  code: "batch_too_expensive",
                  message: `The tool calls in this request cost more than the ${MAX_UNITS_PER_REQUEST}-unit per-request ceiling. Split them across separate requests; every individual tool call is under the ceiling on its own.`,
                },
              },
              400,
            ),
    };
  }

  const rejection = await enforceToolRate(env, actor, priced.charge);
  return {
    request: replayed,
    rejection: rejection === null ? null : rateLimited(rejection, priced.id),
  };
}

function bodyTooLarge() {
  return json(
    {
      error: {
        code: "request_too_large",
        message: `MCP request bodies are limited to ${MAX_MCP_BODY_BYTES} bytes.`,
      },
    },
    413,
  );
}

/**
 * One rejection, said twice: as the HTTP status and `Retry-After` header a
 * transport backs off on, and — when the request was a single identified
 * JSON-RPC call — as an error body the client can attach to that call, so the
 * agent driving it reads why it was refused instead of only that it was.
 */
function rateLimited(
  rejection: RateLimitRejection,
  id: string | number | null,
) {
  const body =
    id === null
      ? {
          error: {
            code: "rate_limited",
            scope: rejection.scope,
            message: rejection.message,
            retry_after_seconds: rejection.retryAfterSeconds,
          },
        }
      : {
          jsonrpc: "2.0",
          id,
          error: {
            // Implementation-defined server error; the JSON-RPC range
            // -32000..-32099 is reserved for exactly this.
            code: -32029,
            message: rejection.message,
            data: {
              reason: "rate_limited",
              scope: rejection.scope,
              retry_after_seconds: rejection.retryAfterSeconds,
            },
          },
        };
  return json(body, 429, {
    "retry-after": String(rejection.retryAfterSeconds),
    "cache-control": "no-store",
  });
}

function allowedOriginHostnames(env: Env, requestHostname: string): string[] {
  const configured =
    env.ALLOWED_ORIGINS === undefined
      ? []
      : commaSeparatedHostnames(env.ALLOWED_ORIGINS, true);
  return [...new Set([requestHostname, ...configured])];
}

function commaSeparatedHostnames(
  value: string,
  parseOrigins = false,
): string[] {
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
- Execution plan bodies, read-call bundles (exact wallet_batch_eth_call argument objects), and token lists exported by export_tokens are stored at ${origin}/artifact/<id> and returned as artifact_reference envelopes under execution_plan_reference, read_calls_reference, and token_list_reference. Pass the whole envelope unchanged as the wallet tool's reference argument; the wallet fetches the body itself and verifies integrity. A 404 means the reference expired: re-run the tool that produced it. No other tool results are stored or replayed.
- Onchain read plans carry canonical ABIs for local wallet decoding. Raw return bytes are included by default and preserved on failure. semantic_value passes a custom non-ABI raw result through a locally installed allowlisted codec; remote plans never supply executable code.
- No fixed request quota is guaranteed. Limits are per caller (one IPv4 address or one IPv6 /64) and are enforced over four budgets: requests per few seconds, requests per minute, weighted tool cost per minute, and calls per minute to tools that buy quotes or recommendations from a third party. A bulk, fan-out, or provider-backed tool costs several times an ordinary read; a purely local one costs nothing. Rejection is HTTP 429 with Retry-After in seconds, and a single identified JSON-RPC call also gets error code -32029 with data.scope. Honor Retry-After instead of retrying on a fixed interval, batch identifiers into one call instead of paging the catalog, and reuse a quote already held instead of re-fetching it. Request bodies are limited to ${MAX_MCP_BODY_BYTES} bytes, ${MAX_BATCH_LENGTH} JSON-RPC messages, and ${MAX_UNITS_PER_REQUEST} tool units; no single tool call reaches that ceiling, so it only ever asks a batch to be split.
- Owner positions use upstream no-cache semantics. Position tools join canonical token metadata and USD prices and provide exact atomic pending eth_call plans for current position state. Pair-pool discovery defaults to a zero TVL floor and returns verified PoolKeys plus the correct position manager. Liquidity opportunities match the interface's boosted-fee, active-incentive, and Ve33-emission feed; pair/boost data is cached upstream for up to 600 seconds, campaigns for 300 seconds, and Ve33 pools for 30 seconds. Every EVM interface transaction path has a first-class prepare tool returning complete wallet execution plans; wallet tooling never constructs or appends calls. Indexed pool state is cached upstream for up to 180 seconds; tick liquidity and pool keys for up to 1,800 seconds. STONX recommendations are at most 86,400 seconds old.

Direct Aave market discovery:
- This MCP does not proxy, index, cache, authenticate to, or replay Aave's APIs. The agent reads them directly, uses them to choose an action, then supplies explicit identifiers to a local preparation tool.
- Aave: query https://api.v3.aave.com/graphql directly for live rates, liquidity, caps, pause/freeze state, eMode categories, and user positions. Schema and market-data guidance: https://aave.com/docs/aave-v3/getting-started/graphql and https://aave.com/docs/aave-v3/markets/data. Cross-check the selected chain, Pool, and underlying reserve against get_aave_v3_markets before calling a prepare_aave_v3_* tool.
- Public API responses are discovery inputs, not execution guarantees. Simulate the prepared plan against current wallet and chain state immediately before authorization.

STONX allocation shortcut:
- For "my Ekubo STONX allocations" or equivalent, call get_ve33_allocations with the user's connected EVM wallet address as owner and omit chain_id and ve_token.
- The production Ve33 deployment is the STONX voting system; omitting those fields selects its production chain and the canonical VeToken automatically.
- If no connected wallet address is available, ask the user. Never infer it from a machine environment, repository, or local keystore.

Safe swap and bridge sequence:
1. Use list_tokens with search when resolving a symbol. Use get_token for one known chain/address pair, or get_tokens for 1–1,000 known pairs in one batch request. Batch results preserve input order and duplicates while omitting unknown identifiers. Show the selected chains and addresses.
2. Convert the amount to base units using token decimals.
3. Use get_quotes_with_plans with exact input/output intent and destination_chain_id.
4. Choose slippage before generating calldata. Honor an explicit user preference. Otherwise set slippage_bps approximately to 10,000 times estimated gas-cost value divided by swap-notional value, with both valued in the same currency, so the maximum tolerated slippage loss is near one gas fee. Do not use a generic 50 bps (0.5%) default, especially on Ethereum mainnet. Prefer re-quoting and preparing a new transaction after a slippage failure to widening the bound; never retry reverted calldata unchanged.
5. Only treat a plan as executable when execution_plan_ready is true.
6. Include the source, exact plan ID, chains, bounds, approvals, recipient, execution transaction, and any allowance reset in the wallet handoff.
7. Pass the chosen option's execution_plan_reference object unchanged as the wallet's reference argument for balance, allowance, policy, and exact-transaction simulation. Do not ask for separate agent-level confirmation.
8. Let the wallet present the simulated result, collect authorization or signature, and submit. Never send credentials to this server.

Wallet handoff: every executable preparation includes execution_plan_reference: an artifact_reference envelope standing in for the plan body. Read ekubo://docs/execution-plan and bind sender before preparation: prepare for the wallet's connected chain and account, since the wallet refuses a fetched plan whose chain or sender disagrees with them. Pass the whole envelope unchanged as the wallet's reference argument for simulate and send; the wallet fetches the body itself, verifies integrity, and validates the plan. Never restate or reconstruct the plan body. If the wallet only accepts inline plans, fetch the URL once and pass its exact JSON unchanged. Use Cast only when the user selected it or no compatible wallet abstraction is available.

Liquidity discovery: call get_liquidity_opportunities when the user asks where to provide liquidity. It matches the interface's boosted-fee, active-incentive, and projected Ve33-emission opportunity feed and returns exact pools where the opportunity is pool-specific. For a pair-level incentive, follow its get_position_pool_candidates handoff before preparing a deposit. If ranking_complete=false, execute and decode local_read_requirement through the user's wallet and repeat the call with the locally decoded ve33_emission_state; do not treat the provisional ordering as final.

ve(3,3): call get_ve33_allocations before reorganizing votes, show the complete allocation and state_id, validate its read-only multicall, then pass that state_id and at most 25 target weight_bps values to prepare_ve33_reallocation. Preserve the exact returned atomic order. Use the other dedicated tools for explicit extension, fee claims, and phased reinvestment. Read ekubo://docs/ve33-workflow before constructing a plan.
Suggested STONX update: call get_stonx_allocation_recommendation, require execution_ready, at most 25 targets, and exactly 10,000 target basis points, then use strategy=compact_max_lock. Pass the survivor, burned source NFT IDs, max-lock extension, final one-NFT-per-pool count, decoded calls, and complete plan to the wallet. The recommendation tool constructs no transaction.
Fee reinvestment: call prepare_ve33_reinvest phase=claim without explicit claims, snapshot exact fee-token balances, use phase=swap for claimed deltas only, refresh allocations, then use phase=stake_all to increase every existing active allocation.
New stake: use prepare_ve33_stake. Max duration is the default when no duration is supplied. Existing voted-stake extension remains explicit and must use the compound fee-claim extension path; unvoted extension is supported directly.
Forbidden: never construct transferOwnership, ownership handover, VeToken ERC721 approval/transfer, or burn calldata. LP position transfer is supported only through prepare_lp_position_transfer.
Contract resources are provenance and read-only ABI context. Wallets and clients must not use them to invent transaction calldata or transaction lists.
`;
}
