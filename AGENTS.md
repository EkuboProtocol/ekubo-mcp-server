# AGENTS.md

## Complexity Policy
- Run `bun run lint` before considering a change done. CI runs it on every push and
  pull request, before the type-check.
- The only rule is ESLint's `complexity`, capped at 10 per function.
- Fifty-four functions are over the limit today, recorded in
  `eslint-suppressions.json`. That file is a ratchet, not an amnesty: ESLint stores a
  per-file count, so a new function over the limit fails the build even in a file
  that already has entries. Do not raise a count to make the build pass — split the
  function.
- If you simplify one of the recorded functions the run will report an unused
  suppression. That is the ratchet working: run `bun run lint:prune` and commit the
  tightened file.
- The concentrations, worst first: `src/core.ts` (12 functions), `src/ve33.ts` (10),
  `src/pools.ts` (7). The two single worst are in `src/opportunities.ts` (68) and
  `src/liquidity.ts` (65). Both are tool handlers that fan out over every combination
  of optional filter argument inline; extracting the argument normalisation into a
  named parser is the way to bring them down.

## User-facing tool changes
A change to a tool's name, description, input or output schema, error, or result
shape is a user-facing change: the user is the agent that reads the catalog and
the person it acts for. Before considering one done:

- **Discoverability.** The tool must be choosable and callable from its
  `tools/list` entry alone. State chain, units (base units, wei, Unix seconds),
  defaults and paging on the argument or once in the description, and say which
  tool comes next when the result is a handoff. Keep within the budgets in
  `test/context-budget.test.ts` (see `docs/MCP-CONTEXT.md`).
- **Compatibility.** Keep machine fields stable and additive. Amounts, chain IDs
  and IDs stay exact decimal or hex strings, addresses keep their checksum, and
  `artifact_reference` envelopes are never inlined or rebuilt. Bump
  `MCP_TOOL_CATALOG_REVISION` and the package version when a schema or result
  contract changes.
- **Error recovery.** Invalid input must name the argument and the fix before
  any upstream call. Upstream failures return a structured `error.code`
  (`upstream_timeout`, `invalid_upstream_response`, `upstream_error`, or a
  domain code) with guidance on whether to retry, re-run or change the request,
  and never echo credentials.
- **Acceptance through the MCP boundary.** Extend `test/tool-acceptance.test.ts`
  (or the protocol's endpoint test) with `tools/list` and `tools/call` through
  `worker.fetch` and mocked upstreams, not only helper unit tests. Cover valid,
  missing, malformed, boundary and unsupported input, empty results and paging,
  upstream failure and timeout, and, for a preparation tool, the full handoff:
  reference fetch, integrity, expiry and a safe retry. Keep preparation,
  wallet simulation, owner authorization, submission and confirmation distinct;
  never sign, send or move funds to test a tool.
- **Not applicable.** These are tool endpoints with no DOM, so browser
  accessibility and viewport checks do not apply; the checks above are the
  equivalent evidence. Descriptions and errors are English only and there is no
  language negotiation; do not localize machine identifiers or values.
- `bun run test:mcp-acceptance` (small-model scenarios against a live
  endpoint) costs Workers AI neurons and is not part of CI; add a scenario to
  `test/mcp-acceptance/scenarios.json` when a change alters which tool an agent
  should pick, and record whether it was run.
