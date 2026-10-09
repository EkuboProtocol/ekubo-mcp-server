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

| Endpoint     | Tools | Original | EKU-971 | EKU-991 | tools/list (EKU-991) | Largest tool |
| ------------ | ----: | -------: | ------: | ------: | -------------------: | -----------: |
| `/mcp`       |   100 |   72,327 |  40,505 |  31,494 |               29,010 |        1,105 |
| `/mcp/ekubo` |    51 |   44,788 |  23,963 |  17,440 |               16,132 |        1,105 |
| `/mcp/safe`  |     6 |    6,322 |   3,195 |   2,622 |                2,294 |          497 |

EKU-994 then split Ekubo's 51 tools across two endpoints; `/mcp` is unchanged:

| Endpoint               | Tools | Total  | tools/list | Instructions | Resources |
| ---------------------- | ----: | -----: | ---------: | -----------: | --------: |
| `/mcp/ekubo`           |    34 | 13,187 |     11,816 |          960 |       411 |
| `/mcp/ekubo-advanced`  |    17 |  5,321 |      4,312 |          826 |       183 |

EKU-1123 added combined endpoints, which state the shared paragraphs once per
connection instead of once per protocol (0.50.0 measurements):

| Selection                                   | Separate connections | `/mcp?protocols=` | Saved |
| ------------------------------------------- | -------------------: | ----------------: | ----: |
| Cloud Wallet default (8 bundled, no advanced) |               34,249 |            27,624 | 6,625 |
| `ekubo+ekubo-advanced`                      |               19,026 |            17,818 | 1,208 |
| `ekubo+uniswap`                             |               18,914 |            17,941 |   973 |

Every endpoint except `/mcp/safe` carries the CLO jurisdiction notice and the
jurisdiction-metadata paragraph verbatim, about 480 tokens, and
`get_quotes_with_plans` carries the notice again in its description. Raise a
budget only with a reason the extra tokens buy. One such raise: every non-Safe
instructions budget grew by 550 characters (about 115 tokens) for the opening
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
- **Output schemas** are a reading guide: they list the fields an agent
  reads to decide its next call and drop `required`, `additionalProperties`
  and `pattern`. Every `artifact_reference` envelope is named rather than
  spelled out: the agent passes it on without reading inside it.
- **Repeated nested objects are named once.** `catalogSummary()` publishes a
  schema such as a PoolKey argument, the ve(3,3) emission state or the
  `jurisdiction` result block as `{ type, description }` with a one-line
  description of its fields, wherever it appears. The handler still parses
  the full zod shape.
- **Server limits are not published.** Bounds no sensible argument reaches
  (tick ranges, fee ceilings, uint32 durations, 78-digit strings, array
  maxima) are enforced by the handler and reported in its error.
- **Argument descriptions say what the name and format do not.** A format
  label is not repeated when the description already names it; a tool's
  description is not restated in its arguments; multi-step detail lives in
  the `ekubo://docs/*` resource that already covers it.
- **Say each rule once.** The instructions carry what an agent needs before
  its first call: routing, the swap call shape, the jurisdiction notice, the
  reference pass-through rule, where workflows live, and endpoint scope.
  Tool-family workflow lives in that tool's description, or in
  `ekubo://docs/agent-workflow`, `ekubo://docs/lp-position-workflow`,
  `ekubo://docs/ve33-workflow` and `ekubo://docs/execution-plan`, read on
  demand.
- Tool and argument names never change for size: gateways and clients cache
  the catalog by name.
