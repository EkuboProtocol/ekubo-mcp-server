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
