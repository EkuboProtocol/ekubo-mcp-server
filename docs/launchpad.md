# Launchpad (zero-seed, support disabled)

The launchpad targets the zero-seed launch contract frozen at evm-contracts
`d6aeb58` (ABI SHA-256 `189ff93c…ced215`, freeze `ceebe872`). Connect to
`/mcp/launchpad`; the tools are not part of the root `/mcp` bundle. Discovery
is at `/tools?protocol=launchpad`.

No launch instance is supported on any hosted or live chain. The live pin list
in `src/launchpad/zero-seed/policy.ts` is empty, and no environment variable,
provider read or caller-supplied address can add one.

## Tools

| Tool | Hosted behaviour |
| --- | --- |
| `launchpad_list_launches` | Empty list with `launch_support: "disabled"`; no request is made. |
| `launchpad_get_launch` | Refuses with `launch_support_disabled`. |
| `launchpad_get_swaps` | Refuses with `launch_support_disabled`. |
| `launchpad_get_claims` | Refuses with `launch_support_disabled`. |
| `launchpad_prepare_create` | Refuses with `launch_support_disabled`; no plan or reference. |
| `launchpad_prepare_claim_fees` | Refuses with `launch_support_disabled`; no plan or reference. |
| `launchpad_prepare_trade` | Refuses with `executable_budget_not_proven`; no plan or reference. |

`launchpad://disclosures` serves the five mechanism disclosures every owner
summary carries: zero initial bid, buyer-funded quote reserve, permanent
principal lock, creator fee recipient and rate, and no exit guarantee. The
wording is a draft and not approved.

The quoter's `estimated_gas_cost` is never a gas limit, UserOp budget,
affordability decision or owner assurance. Trade preparation stays refused
until execution budgeting and wallet simulation are separately proven.

## Local modules

`src/launchpad/zero-seed/` holds the exact-API client (`api.ts`, `schema.ts`),
the frozen constraints (`policy.ts`), the create/preview/claim ABI subset
(`abi.ts`), parameter and build validation (`installation.ts`) and the single
synthetic installation preview (`preview.ts`). They accept the actual emitted
local WETH instances only, inside an explicit local harness that the public
tools never construct. See [zero-seed-checkpoint.md](zero-seed-checkpoint.md)
for pins, reproduction and what remains unproven.

Configuration: `LAUNCHPAD_API_URL` (default `EKUBO_API_URL`) is read only for a
supported chain, so the hosted server never contacts it.
