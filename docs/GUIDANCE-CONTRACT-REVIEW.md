# Agent guidance contract review

Scope: Ekubo MCP initialize instructions, tools/list (including parameter descriptions), root discovery workflow, referenced workflow resources and error/retry guidance. Cloud Wallet catalog and diagnostics are reviewed separately in their own repository. This is a qualitative copy review, not a prohibition on particular words.

## Copy changes

| Surface | Before | After / rationale |
| --- | --- | --- |
| Initialize routing | Use this MCP before any browser; browser only for named interfaces or unsupported work | Capabilities and unsigned-plan boundary; no exclusive routing requirement |
| Token discovery | Preferred token wins ambiguous symbol | Visibility is ranking, not authority to choose for the user |
| New Ve33 stake | Maximum duration is the safe default | States actual omitted-duration behavior and shorter-duration support without calling a four-year lock safe |
| Voter fee claims | Always safe before any other action | States unchanged vote/stake/lock/ownership and required wallet simulation/authorization |
| Allocation recommendation | Apply with compact_max_lock | Default preserves locks; compact strategy is optional and discloses extensions and NFT burns |
| Slippage parameters/workflow | Gas-sized defaults; size near gas value | No server default; gas-sized budget is an optional heuristic, explicit numeric user bounds remain exact |
| Quote refresh | Do not call again except after named events | Re-quoting is supported; replacements need validation, simulation and authorization |
| Pre-simulation checks | Do not read allowances or validate separately | Optional independent checks neither replace simulation nor extend validity |
| Simulation | Simulate once | Re-simulation is supported; expired or changed terms require fresh simulation |
| Pool tier | Prefer existing depth over a new tier | Existing depth is an optional consideration, not a restriction |

## Retained hard requirements

- Reference bytes, length, digest and ordered calls are integrity contracts, not strategy preferences. Never modify prepared plans or execute stale/reverted bytes.
- Exact amounts and provider precision limits remain unchanged; tolerance preferences do not override provider limits.
- Simulation, owner authorization, policy denial, account isolation and uncertain-broadcast reconciliation remain independent boundaries.
- Jurisdiction, issuer eligibility and unknown-asset holds remain unchanged; user preferences do not waive them.
- LP measured balances after settled swaps, Ve33 state snapshots and claim-before-clear ordering remain because these protect actual transaction semantics, not merely a preferred conversational sequence.
- Protocol discovery remains direct/no-proxy where this server does not implement an upstream client; required deployment allowlists and guarded routes are unchanged.

## Verification boundary

Generated initialize/tools/list/resources/read are exercised through worker.fetch in tool-acceptance tests; initialization has a golden fixture. Existing precision, expiry, integrity and provider failure tests remain. Offline scenarios cover optional alternate workflows and retained protections. English-only endpoints have no DOM, viewport or locale negotiation. No live funds, signing or owner-policy changes are needed. Small-model acceptance scenarios cost Workers AI neurons and are not implied by offline checks.
