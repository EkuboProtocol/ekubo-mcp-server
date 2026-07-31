# Ekubo MCP server

The official agent interface for Ekubo Protocol transactions. This repository
deploys a stateless, public MCP server on Cloudflare Workers. Its first toolset
focuses on EVM swaps; the same server can grow to cover ve(3,3) analysis, vote
planning, positions, orders, and other Ekubo workflows.

The MCP server owns agent-facing transaction construction. `prod-api` remains
a data API and the quoter remains a route-data service.

## Public endpoints

- `POST/GET /mcp` — MCP Streamable HTTP endpoint
- `GET /` — service metadata and canonical documentation links
- `GET /tools` — deterministic tool catalog for non-MCP discovery
- `GET /openapi.json` — OpenAPI 3.1 discovery contract
- `GET /llms.txt` — concise agent workflow
- `GET /health` — Worker liveness

MCP-native discovery remains authoritative: clients use `tools/list` and
`resources/list`. The HTTP discovery endpoints are additive and help crawlers,
OpenAPI clients, and humans find the same capabilities.

## Tools

- `ekubo_search_tokens` — search the canonical token list
- `ekubo_get_token` — fetch token metadata by chain and address
- `ekubo_get_quote` — translate explicit EVM intent to the canonical signed
  quoter URL and return its block-pinned route
- `ekubo_prepare_swap` — quote, generate slippage-protected unsigned Yul
  router calldata, and simulate when an allowlisted RPC is configured

Every current tool is read-only and idempotent. The Worker has no wallet, key
material, signing function, or broadcast function. It returns an exact unsigned
transaction plan for the agent to present to the user. After confirmation, the
user's wallet or signature tooling is responsible for approvals, current-state
validation, signing, and submission through the user's RPC provider.

`confirmation_ready` means the server successfully simulated the plan at the
quote block. It is not authorization to sign or submit it. ERC20 plans include
an unsigned approval transaction in addition to the unsigned swap transaction;
the client should check current allowance before asking the user to sign it.

## Configuration

`wrangler.jsonc` configures the two fixed public upstreams:

- `EKUBO_API_URL=https://prod-api.ekubo.org`
- `EKUBO_QUOTER_URL=https://prod-api-quoter.ekubo.org`

Never make either URL a tool argument. Keeping upstreams operator-controlled
prevents the public Worker from becoming an SSRF or arbitrary RPC proxy.

Set allowlisted per-chain RPC URLs as an encrypted Worker secret:

```sh
bunx wrangler secret put RPC_URLS_JSON
```

The value is a JSON object such as:

```json
{"1":"https://...","8453":"https://..."}
```

Without a configured RPC, `ekubo_prepare_swap` still returns unsigned calldata
but sets `confirmation_ready` to false. Agents must not present such a plan for
submission until it has been simulated successfully.

These deployment-controlled RPCs are used only for read-only quote-block
simulation. RPC URLs and wallet credentials are not MCP tool inputs. The client
must use the user's own RPC and wallet/signature tooling for current-state
revalidation, signing, submission, and receipt confirmation.

Cloudflare routing protects the default `workers.dev` hostname and any custom
domain. Set optional comma-separated `ALLOWED_HOSTNAMES` and `ALLOWED_ORIGINS`
variables if the deployment needs a stricter host list or cross-origin browser
MCP clients. The request's own hostname is always accepted as a browser origin;
non-browser MCP clients normally omit `Origin`.

For production abuse protection, add a Cloudflare Workers Rate Limiting
binding named `RATE_LIMITER` or enforce an equivalent account-level rule. The
Worker automatically uses that binding when present and returns HTTP 429 after
the configured limit. See the [Cloudflare Rate Limiting binding
documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

## Development

```sh
bun install
bun run build
bun run test
bun run check
bun run dev
```

Connect MCP Inspector to `http://localhost:8787/mcp`.

## Deployment

Authenticate Wrangler, install the locked dependencies, optionally configure
RPC simulation, and deploy:

```sh
bun install --frozen-lockfile
bunx wrangler login
bunx wrangler secret put RPC_URLS_JSON
bun run deploy
```

`wrangler.jsonc` intentionally enables `workers.dev` without declaring a
custom domain. The first deployment therefore produces a testable
`https://ekubo-mcp.<account-subdomain>.workers.dev` URL. Add
`mcp.ekubo.org` as a Worker custom domain after that deployment; no code or
configuration change is required.

For CI or non-interactive deployment, provide `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` instead of running `wrangler login`.

Smoke-test the deployed origin before adding the custom domain:

```sh
curl https://ekubo-mcp.<account-subdomain>.workers.dev/health
curl https://ekubo-mcp.<account-subdomain>.workers.dev/tools
MCP_ORIGIN=https://ekubo-mcp.<account-subdomain>.workers.dev bun run smoke
npx @modelcontextprotocol/inspector@latest
```

`bun run smoke` checks health, root discovery, OpenAPI, the HTTP tool catalog,
MCP initialization, and protocol-native `tools/list`.

Connect MCP Inspector to
`https://ekubo-mcp.<account-subdomain>.workers.dev/mcp`, initialize the
server, list tools, search tokens, and request a quote. Full swap preparation
requires an `RPC_URLS_JSON` entry for the selected chain.

The implementation uses the recommended stateless `createMcpHandler` path and
does not require Durable Objects. Authorization is intentionally omitted
because all tools operate on public data and cannot mutate protocol or user
state. Future tools may construct unsigned ve(3,3) vote calls and other
transactions here, but signing and submission remain client-side.
