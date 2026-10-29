# Dependency compatibility baseline

`dependency-compatibility.json` was captured through `worker.fetch` at source
`d384334cc90d7199a96da177f6c687ae2738484d`, before updating the five dependencies.
The source commit and runtime dependency versions are recorded in the fixture.
The clock is fixed at `1800000000000` milliseconds for both capture and tests,
including artifact-store timestamps; every identity is synthetic.

`dependency-cases.ts` defines the input ordering. The fixture contains:

- The Keccak-256 hash of the affected tools' complete `tools/list` entries,
  including descriptions and input/output schemas, in catalog order.
- Keccak-256 hashes of the complete unsigned execution plans fetched from their
  returned artifact references, in case order. Hash input is `JSON.stringify` of
  the parsed plan, without sorting or removing fields. Artifact URLs are random
  and intentionally not part of the golden plan. The tests separately verify
  each reference's integrity against the original fetched bytes and byte length.
- Full structured liquidity-quote outputs at the minimum, lower range edge,
  in-range, upper range edge, and maximum-minus-one square-root prices, with
  amounts above JavaScript's exact-number range.

The same fixtures pass with the original and updated dependency sets. Existing
protocol tests independently decode calldata; existing tool acceptance tests
cover expired references, safe retry, malformed input, upstream failure,
exact-output-loss budgets and jurisdiction metadata. No wallet is connected or
invoked. The three protocol revisions exercise legacy initialization and modern
discovery, not a fictitious modern initialization handshake.

Update a golden only after reviewing the intended public contract or calldata
change. Do not regenerate it from a failing dependency candidate merely to make
that candidate pass.

## V4 follow-up

`dependency-v4-compatibility.json` was captured at unchanged source
`00a0b7ea7b2076a5d5bdc854cef9de837ed744c5` using viem 2.57.7,
v4-sdk 2.4.1 and sdk-core 7.19.4, before the next dependency updates.
`dependencyV4PlanCases` defines four native-currency cases: mint, increase,
collect and remove, with exact amounts and token IDs above 2^53. The same fixed
clock, complete-plan hashing, fetched-byte integrity checks and three MCP
protocol versions apply. V4 catalog entries are hashed separately so the older
golden stays unchanged. `uniswap.test.ts` independently decodes the action stream,
Permit2 approvals, settlement, native refunds and minimum withdrawal amounts.
