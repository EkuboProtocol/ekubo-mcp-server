# Ekubo MCP server

The official agent interface for Ekubo Protocol transactions. This repository
deploys a stateless, public MCP server on Cloudflare Workers. It discovers
tokens, compares Ekubo and 0x liquidity for same-chain EVM swaps, prepares
Across any-to-any bridges, and constructs unsigned VeToken calls for ve(3,3)
vote and fee workflows.

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

- `ekubo_search_tokens` — search the canonical token list, ordered by
  descending `visibility_priority`
- `ekubo_get_token` — fetch token metadata by chain and address
- `ekubo_get_quote` — compare Ekubo and 0x for same-chain exact-input or
  exact-output swaps, or use Across when `destination_chain_id` differs
- `ekubo_prepare_swap` — return firm unsigned Ekubo, 0x, or Across approval
  and execution calldata
- `ekubo_prepare_ve33_vote` — compile vote changes and deterministic VeToken
  splits into one fee-preserving multicall
- `ekubo_prepare_ve33_extend` — claim active-pool fees when necessary and
  extend a VeToken lock
- `ekubo_prepare_ve33_split` — construct a split and predict the child token ID
- `ekubo_prepare_ve33_claim_fees` — claim one or many VeToken voter-fee balances
- `ekubo_prepare_ve33_reinvest` — construct the safe claim, full-balance swap,
  and restake phases

`source=auto` is the normal quote mode. Same-chain requests try Ekubo and 0x;
an acceptable Ekubo price-impact quote is preferred as in the interface,
otherwise the better raw token amount wins. Cross-chain requests route through
Across. Set `source=ekubo`, `source=0x`, or `source=across` to require one
provider. Token arguments accept raw EVM addresses or
`eip155:<chain_id>:<address>` identifiers. The output token's EIP-155 chain
must match `destination_chain_id`.

Every current tool is read-only and idempotent. The Worker has no wallet, key
material, signing function, or broadcast function. It returns an exact unsigned
transaction plan for the agent to present to the user. After confirmation, the
user's wallet or signature tooling is responsible for approvals, current-state
validation, signing, and submission through the user's connected provider.

`confirmation_ready` means the quote, slippage bounds, and unsigned calldata
are complete enough to present to the user. It does not mean the transaction
was validated or authorized. ERC20 plans include the required unsigned approval
transaction(s) in addition to the unsigned swap or bridge transaction.
Exact-output Ekubo and 0x plans that create an allowance also include a
post-execution allowance reset.
The client should check current allowance before asking the user to sign any
approval.
`wallet_validation_required` remains true for every prepared plan.

The boundary mirrors the Ekubo interface: the public services provide token
data and route quotes, transaction construction applies the user's slippage,
and the user's connected wallet or provider handles balances, allowances,
current-state validation, gas estimation, signing, submission, and receipts.

VeToken splitting follows the deployed contract invariants: the source token
must retain a nonzero stake, its active vote remains with reduced weight, and
the child token starts unvoted. Vote compilation claims pending fees before a
vote is replaced or cleared. Extending a voted token uses the compound
claim-and-extend methods because extension clears its vote.

Fee reinvestment is intentionally phased. A static transaction cannot know the
exact output of an exact-input swap and therefore cannot safely call
`increaseStakeAmount` for every resulting unit in the same transaction. The
tool first constructs the claims, then constructs exact-input swaps from the
complete post-claim balance deltas, and finally constructs approval plus
`increaseStakeAmount` from the measured stake-token output.

## Configuration

`wrangler.jsonc` configures the two fixed public Ekubo upstreams:

- `EKUBO_API_URL=https://prod-api.ekubo.org`
- `EKUBO_QUOTER_URL=https://prod-api-quoter.ekubo.org`

Never make an upstream URL a tool argument. Keeping upstreams
operator-controlled prevents the MCP server from becoming an arbitrary proxy.
The deployment also uses three Worker secrets:

- `ZERO_X_API_KEY`
- `ACROSS_API_KEY`
- `ACROSS_INTEGRATOR_ID`

They are declared as required runtime secrets in `wrangler.jsonc`, so a deploy
fails rather than silently publishing disabled provider tools when a binding is
missing.

0x requests use Swap API v2's AllowanceHolder endpoints. Across requests use
`GET /swap/approval` with bearer authentication and the configured integrator
ID. These credentials remain server-side and are never returned by a tool. The
Worker never receives wallet credentials.

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

Authenticate Wrangler, install the locked dependencies, and deploy:

```sh
bun install --frozen-lockfile
bunx wrangler login
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
`https://ekubo-mcp.<account-subdomain>.workers.dev/mcp`, initialize the server,
list tools, search tokens, request same-chain and cross-chain quotes, and
prepare unsigned execution plans. Validate every plan through the user's
connected wallet or provider before signing.

The implementation uses the recommended stateless `createMcpHandler` path and
does not require Durable Objects. Authorization is intentionally omitted
because all tools operate on public data and cannot mutate protocol or user
state. Signing and submission remain client-side.
