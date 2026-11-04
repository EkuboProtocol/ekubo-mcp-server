# Google Connected Apps compatibility

## Status

This is a **compatibility baseline, not a completed integration or launch**.
Source baseline: `1d1d359ac42931f2a475531c0c483fd6db2edf4f` (remote main), merged
up to `c2fc62e07150b29d300419c9213b523b9c0d6755` on 2026-11-04.
No runtime contract, tool schema, transport, authorization or deployment changes
are introduced by the baseline tests or the ADK harness. Consequently no
package/catalog version bump is needed for this change.

| Milestone | Status |
| --- | --- |
| Source-ready integration | Not yet: baseline regression checks pass; real-model scenarios, catalog lifecycle and policy questions below remain |
| Deployed integration changes | Transport-path Browser Integrity Check exception applied; no Worker/code deployment |
| Gemini validated (Gemini API through ADK) | Partly: Google ADK's MCP client discovers, converts and calls both facets with verified references; scenarios against a real Gemini model are pending a Gemini API key |
| Gemini validated (Gemini app) | No: custom app connections require a personal Google Account with Keep Activity on, and work accounts are unsupported; outstanding external requirement |
| Submitted | No |
| Published | No |

## Contract and gaps

Primary sources checked 2026-10-31:

- [Integration standards](https://developers.google.com/connected-apps/mcp/server-optimization)
- [Developer Mode procedure](https://developers.google.com/connected-apps/mcp/dev-mode/usage)
- [Platform policy](https://developers.google.com/connected-apps/connected-apps-policy)
- [Registration](https://developers.google.com/connected-apps/gpc)

Account eligibility checked separately on 2026-11-02:
[Connect and manage custom apps](https://support.google.com/gemini/answer/17209137).
Google currently requires a personal Google Account, age 18 or over, US presence,
and Keep Activity enabled. Work/school accounts are explicitly unsupported for
custom app connections. A visible Developer Mode pane is not proof of connection
eligibility. Do not switch accounts or enable activity recording implicitly.

| Source clause | Existing behavior / evidence | Remaining action |
| --- | --- | --- |
| Standards: MCP protocol version compatibility | `initialize` negotiates `2025-11-25` through `worker.fetch` | No speculative SDK/protocol upgrade |
| Standards: Transport protocol specification | Single Streamable HTTP POST endpoint; JSON or SSE response; optional GET returns 405; no browser Origin or authentication required | Confirm same request sequence in Gemini |
| Standards: Responses and error handling / Use JSON | Existing successful JSON TextContent mirrors structuredContent. Acceptance checks consume text for quotes, positions/read bundles, transfer preparation and expiry/retry. SDK validation errors use plain text, permitted by the recoverable-error guidance, and are checked without structuredContent | Gemini must demonstrate equivalent consumption; local parsing is not trusted-reference provenance evidence |
| Standards: Versioning / ingestion snapshots | Core and advanced tools remain separate, 34 and 16 tools respectively. Tests pin SHA-256 over exact wire tools and instructions | Do not register the changing bundled `/mcp` catalog. Establish an immutable versioned registration profile or explicitly controlled backward-compatible release policy before submission. Snapshot updates are not ingestion approval |
| Standards: Declare tool annotations for safety | Tools are read-only queries or unsigned preparation, not signing/submission. Published `readOnlyHint: true`; compact catalog omits default `openWorldHint: true` and redundant read-only annotations | Verify Google safety badges; explicit-default requirement may require profile-specific annotations. Do not label preparation as transaction execution or weaken wallet approval |
| Standards: Tool granularity and flatter schemas | Genuine intent-facing core tools and separate advanced operations; no new protocol support. Inspector reports warnings, not errors, below | Google review may flag dozens of tools. Do not silently omit preparations to obtain a read-only demo; resolve actual ingestion findings first |
| Policy: Deceptive behavior / references to other tools; no system instructions in responses | Existing references include handoff instructions and name wallet tools. Standards themselves recommend linking a returned ID to another tool | Seek concrete Google client/partner interpretation. Do not remove integrity, expiry, jurisdiction or owner-authorization safeguards based on a speculative reading |
| Policy: Impersonation / third-party wrappers | Ekubo-owned data and protocol preparation are primary; core quotes can also include external route providers | Describe provider coverage honestly and confirm policy treatment; do not imply Google approval |
| OAuth guide / account linking | Producer endpoint is public, unauthenticated, non-custodial; no user accounts, credentials or OAuth scopes | No producer OAuth added just for compatibility. Wallet has independent authentication and owner authorization |
| Policy: Privacy / notice and data control | Public chain data and wallet-supplied addresses; ephemeral artifact retrieval is unauthenticated and expiry-enforced | Confirm approved privacy/support/data-management URLs and artifact retention disclosure before registration |

## Catalog candidate and registration worksheet

- App display name: **Ekubo Protocol**; proposed handle: `Ekubo` (availability unverified).
- Producer: Ekubo, Inc.; website: <https://ekubo.org>.
- Core candidate URL: `https://mcp.ekubo.org/mcp/ekubo` (34 tools).
- Advanced candidate URL: `https://mcp.ekubo.org/mcp/ekubo-advanced` (16 tools).
  These are existing protocol boundaries, not two proposed public app listings.
  If registration accepts only one URL, resolve catalog composition without
  disguising or dropping advanced functionality.
- Description draft: “Discover Ekubo tokens, pools, positions and quotes, and
  prepare unsigned transactions. A separately connected wallet verifies,
  simulates and obtains owner authorization before submitting transactions.”
- Transport: Streamable HTTP; tested protocol: `2025-11-25`.
- Authentication/scopes: none for this producer. No location/locale Tool Context
  signals requested. Never use Google location metadata as investor attestation.
- Documentation: <https://docs.ekubo.org/products/mcp-server/>.
- Privacy policy, support URL, data-management help and approved brand asset:
  **not yet verified; do not submit placeholders**.
- Registration URL/profile and frozen schema artifact: not finalized. Current
  wire digests are in `test/__snapshots__/tool-acceptance.test.ts.snap`.
- Console access application: <https://connected.google.com/console/help/?apply>.
  A human must choose the authorized Google organization/account and accept any
  terms. Console access does not authorize submission, publication or deployment.

## Reproducible checks

```sh
bun install --frozen-lockfile
bun test test/protocols.test.ts test/tool-acceptance.test.ts test/context-budget.test.ts
bun run build
bun run lint
```

The new digest checks cover instructions plus complete `tools/list` schemas,
descriptions, annotations and output schemas. They are drift alarms, not an
immutable endpoint implementation. Inspect any drift instead of blindly updating
snapshots. Existing protocol/facet regressions remain in `test/protocols.test.ts`.

Text-only fixture journeys pass through actual `tools/call` and artifact HTTP
retrieval with mocked upstreams. They verify exact strings, checksums, byte
lengths, chain/address values, absence of inline plans, expired-artifact 404 and
safe fresh preparation. Fixtures never sign, broadcast or move funds. They do
not prove that Gemini preserves origin/provenance when forwarding references.
Actual wallet simulation, owner review, submission and confirmation remain
distinct and are not asserted by a producer-only fixture.

### Live MCP Inspector baseline

Read-only checks against the existing public deployment:

```sh
bunx @modelcontextprotocol/inspector --cli \
  --server-url https://mcp.ekubo.org/mcp/ekubo --transport http \
  --protocol-era legacy --stored-auth-only --method tools/list --strict \
  --output /path/to/inspector-tools.json --format json

bunx @modelcontextprotocol/inspector --cli \
  --server-url https://mcp.ekubo.org/mcp/ekubo --transport http \
  --protocol-era legacy --stored-auth-only --method tools/call \
  --tool-name get_token \
  --tool-args-json '{"chain_id":"1","address":"0x0000000000000000000000000000000000000000"}' \
  --output /path/to/inspector-token.json --format json
```

Both exited 0. Discovery returned 34 tools. Strict Inspector reported 42
`type-union` warnings and one `untyped-schema` warning, zero errors. Those are
portability advisories, **not confirmed Gemini failures**. The token call returned
Ether on chain `"1"`; parsed TextContent exactly matched structuredContent.
Inspector's `legacy` era flag is not proof of exact negotiated version; the
separate wire regression explicitly checks `2025-11-25`.

Re-run on 2026-11-04 with Inspector 2.13.0 after the transport fix: core lists 34
tools (42 `type-union` and one `untyped-schema` warning) and advanced lists 16
(21 `type-union` warnings), both with zero errors. `get_token` for Ether, an
empty `get_positions_by_owner` page, `prepare_wrap_unwrap` on Base and `get_pool`
on Ethereum succeeded with TextContent equal to structuredContent; the returned
`execution_plan_reference` and `read_calls_reference` fetched with matching byte
counts and keccak256 integrity. A malformed `chain_id` returned `isError` with a
message naming the argument (Inspector exit 5, `tool_is_error`).

### Gemini through Google ADK

`script/gemini-adk-acceptance.py` drives the endpoint through Google ADK's
`McpToolset` (Streamable HTTP), the MCP client in Google's agent stack. It pins
`google-adk` and runs with `uv`:

```sh
uv run script/gemini-adk-acceptance.py --out gemini-adk.json
uv run script/gemini-adk-acceptance.py --url https://mcp.ekubo.org/mcp/ekubo-advanced
GEMINI_API_KEY=… uv run script/gemini-adk-acceptance.py \
  --wallet-catalog ../cloud-wallet/apps/api/src/reference/tools.json
```

Without a key it checks discovery, the conversion of every tool to the Gemini
function declaration ADK sends, the older OpenAPI-subset conversion, and
representative calls through ADK's session, verifying every returned reference
against the stored bytes. With `GEMINI_API_KEY` or `GOOGLE_API_KEY` set it also
runs four scenarios against a real Gemini model (default `gemini-3.5-flash`):
an Ether metadata read, a wrap plan and a swap quote handed to wallet
simulation, and a pool's read bundle handed to `wallet_batch_eth_call`. The
model gets the server's initialize instructions and TextContent only, since
Connected Apps does not consume structuredContent yet. The wallet tools are
local stand-ins declared from the Cloud Wallet catalog snapshot: they check that
the reference the model passed equals the producer's envelope and that the
stored bytes match its length and keccak256 digest. They never simulate, sign or
send, and no send tool is offered. Report fields never include the key.

Results on 2026-11-04 (ADK 2.13.0, google-genai 2.34.0, MCP SDK 2.3.0), without
a model:

- Both facets negotiate `2025-11-25`; core lists 34 tools and advanced 16. ADK
  declares every tool with `parameters_json_schema` and `response_json_schema`,
  and the request configuration builds.
- The OpenAPI-subset conversion succeeds for all 50 tools. It narrows each
  `["integer", "string"]` union (`chain_id`, `tick_spacing`) to `INTEGER` and
  keeps `["object", "null"]` as a nullable object. Integer chain IDs remain valid
  input, so a client on that dialect loses only the string spelling.
- Core direct calls pass: Ether metadata with TextContent equal to
  structuredContent, a malformed `chain_id` error naming the argument, an empty
  positions page, and plan and read-bundle references whose fetched bytes match
  their declared length and digest. The same check rejects copies with altered
  integrity, length, URL, chain or sender.

Model scenarios have not run yet: they need a Gemini API key.

Artifact fetches with the default Python urllib user agent still return 403
from Browser Integrity Check, which the transport exception does not cover;
httpx and curl fetch them. The Cloud Wallet fetches artifacts server-side.

### Real-client access evidence and remaining journey

Existing shared-browser access was checked without adding credentials, changing
account settings or accepting terms. `https://gemini.google.com/devmode`
redirected to `https://gemini.google.com/app` in the available personal session.
`https://connected.google.com/console` redirected to
`https://connected.google.com/console/u/0/signup`, displaying “Page not found / 404”.
This does not establish that another authorized organization/account lacks access.
The runtime connection-search route returned HTTP 401; it was not retried or
bypassed. No console registration or custom-app connection was created.

On 2026-11-02, the authorized Workspace account opened Developer Mode, but the
core custom-app connection failed with “Verify the URL and try again.” A captured
Google connection response returned HTTP 200 with RPC error code `9` and
`BardErrorInfo [1040]`; no tool telemetry or available-actions list appeared.
Google does not document that code here, so it is not assigned a specific meaning.
The independently documented personal-account requirement above prevents treating
the Workspace session as an eligible custom-app test client.

A separate machine-client problem was demonstrated and fixed: zone Browser
Integrity Check blocked default Python urllib MCP requests with HTTP 403 / Error
1010. An edge rule now skips only that product on the MCP
hostname's `/mcp` and `/mcp/…` transport paths, preserving existing rules, WAF,
rate limits and other paths. After propagation, the unchanged client negotiated
`2025-11-25`, discovered 34 core tools and called `get_token` for Ether, with JSON
TextContent matching structuredContent. The Workspace retry still failed. This
is transport-reachability evidence, not Gemini ingestion or reference-provenance
acceptance. Artifact paths are outside this exception (see the user-agent note
under the ADK results).

Gemini app validation therefore stays an outstanding external requirement: it
needs an eligible personal account with Keep Activity on, which this project
does not use. Real-model validation runs through the Gemini API with ADK
instead (above). When an eligible client is available, use Developer Mode's
schema and event logs:

1. Connect the agreed producer catalog; check discovery and safety badges.
2. Ask for Ether metadata on Ethereum; compare actual arguments/result with the
   Inspector call above. Exercise a malformed chain and an empty positions page.
3. In isolated fixtures/sandbox, prepare a transfer and owner-position read
   bundle; forward the producer-returned envelope unchanged to the wallet.
   Demonstrate provenance acceptance and integrity/expiry failures through the
   real client, not just JSON equality. Do not substitute reconstructed calldata.
4. Verify simulation/policy rejection and owner-review states without a real
   signature, transaction broadcast or transfer. Record wallet status separately.
5. Resolve policy and registration gaps, then obtain the separate approvals
   needed for any deployment, registration submission and publication.

English-only tool descriptions/errors are unchanged. DOM accessibility,
responsive viewports and localization checks do not apply to the pure MCP
endpoint; schema discovery, text serialization and safe recovery are the
corresponding acceptance surfaces. No optional MCP Apps UI was introduced.
The paid Workers AI small-model acceptance suite was not run: this change does
not alter tool selection or behavior.
