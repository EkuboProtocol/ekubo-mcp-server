# MCP context budget

Everything a client loads at session start is paid for on every turn of every
agent session: the `initialize` instructions, the whole `tools/list` and
`resources/list`. The rule is tighter language that is at least as precise, and
nothing in the initial context that is not needed to pick the right tool and
fill its arguments. The method is shared with the cloud wallet
(`cloud-wallet/docs/MCP-CONTEXT.md`).

## What is measured

`test/context-budget.test.ts` drives `initialize`, `tools/list` and
`resources/list` through the worker for `/mcp` and every `/mcp/<protocol>`
endpoint and enforces JSON-character budgets per endpoint and for the largest
single tool. `MCP_CONTEXT_DUMP=<dir> bun test test/context-budget.test.ts`
writes each endpoint's payloads for token counting.

o200k tokens, instructions + tools/list + resources/list:

| Endpoint     | Tools | Before | After  | Instructions before → after |
| ------------ | ----: | -----: | -----: | --------------------------: |
| `/mcp`       |   100 | 72,327 | 40,505 |               4,833 → 1,538 |
| `/mcp/ekubo` |    51 | 44,788 | 23,963 |                 4,183 → 896 |
| `/mcp/safe`  |     6 |  6,322 |  3,195 |                   273 → 269 |

Every endpoint except `/mcp/safe` carries the CLO jurisdiction notice and the
jurisdiction-metadata paragraph verbatim, about 480 tokens. Raise a budget only
with a reason the extra tokens buy. One such raise: every non-Safe
instructions budget grew by 300 characters (about 60 tokens) for the opening
scope sentence, after agents read the handoff rules as a ban on the user's own
cast/sncast work outside this server. Restrictive rules in this text are scoped
to this server's tools and plans; do not write one as a blanket prohibition.

## How the catalog is kept small

- **Published versus enforced schemas.** `src/mcp-catalog.ts` replaces the
  SDK's `tools/list`. Handlers still validate against the registered zod
  schemas; the published copy drops the draft marker, default
  `additionalProperties`, `.safe()` integer bounds and string `propertyNames`,
  merges `anyOf` branches that differ only in type (lossless, because
  type-specific keywords apply only to their own type), names shared formats
  (`address`, `decimal integer`, `bytes32 hex`) instead of spelling the regex,
  and sends only annotations that differ from the MCP defaults.
- **Output schemas** keep their structure but not their patterns, and every
  `artifact_reference` envelope is named rather than spelled out: the agent
  passes it on without reading inside it.
- **Say each rule once.** The instructions carry what an agent needs before
  its first call: routing, the swap call shape, the jurisdiction notice, the
  reference pass-through rule, where workflows live, and endpoint scope.
  Tool-family workflow lives in that tool's description, or in
  `ekubo://docs/agent-workflow`, `ekubo://docs/lp-position-workflow`,
  `ekubo://docs/ve33-workflow` and `ekubo://docs/execution-plan`, read on
  demand.
- Tool and argument names never change for size: gateways and clients cache
  the catalog by name.
