# Launchpad (zero-seed, support disabled)

The launchpad targets the **draft** exponential creator-fee decay of the
zero-seed launch contract at evm-contracts `b1cbb1c` (ABI SHA-256
`bc51b392…3792bb`), which is not released, externally reviewed or a selected
parameter set. It replaced the linear decay of `d6aeb58` (ABI `189ff93c…ced215`).

## Where the tools are served

The seven `launchpad_*` tools and `launchpad://disclosures` belong to the
standalone `launchpad-testing` protocol. They are served only at
`/mcp/launchpad-testing` and listed only at `/tools?protocol=launchpad-testing`.
Like Safe, that protocol is not part of the root `/mcp` bundle and cannot be
combined through `?protocols=` (`/mcp?protocols=ekubo+launchpad-testing` is
refused with `unknown_protocol`). `/mcp`, `/mcp/ekubo`, every other
`/mcp/<protocol>`, every `?protocols=` selection and unfiltered `/tools` list
none of these tools or the resource, and calling one there fails as an unknown
tool. `/mcp/launchpad` does not exist.

While support is disabled the tools refuse every call, so they stay out of the
default catalogs, whose `initialize`, `tools/list` and `resources/list` are
loaded into every agent session (about 1,830 o200k tokens on `/mcp` and
`/mcp/ekubo`; see [MCP-CONTEXT.md](MCP-CONTEXT.md)). Placing them in the
Ekubo Protocol catalog is part of a later live-enablement change, together
with non-empty live pins and a hosted producer. Discovery on the testing
endpoint does not enable execution: every tool fails closed as described below.

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

`launchpad://disclosures` serves the eight mechanism disclosures (version 3)
every owner summary carries: zero initial bid, buyer-funded quote reserve,
permanent principal lock, creator fee recipient and rate, creator fee
recapture, high initial fee, exact-output gross-up and no exit guarantee. The
wording is a draft and not approved.

## Creator fee schedule (draft)

`decayFactor` (`uint64`, after `finalFee`, before `salt`) is a literal Q0.64
per-second multiplier `b` in `(0, 2^64)`, not a half-life. With
`E = powQ64(b, D)`, the fee is `initialFee` at or before trading start,
`finalFee + floor((initialFee - finalFee) * (powQ64(b, t) - E) / (2^64 - E))`
inside the window and `finalFee` from `D` on. `powQ64` is square-and-multiply,
flooring after every multiply (`src/launchpad/zero-seed/fee.ts`, BigInt only).
The initial fee is capped at the draft `floor(99 * 2^64 / 100)` and a zero
factor is refused. Owner summaries (`zero-seed-launch-owner-summary/v2`) show
the encoded factor, the exact schedule at sample times and the first second
at which the excess fee has halved, computed from the integer schedule. The
API contract consumed is `zero-seed-launch-api/v2` (`fee_schedule.decay_factor`);
v1 bodies are refused. Sealed local create bodies are
`zero-seed-local-create/v2` and bind the disclosure version.

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

## Release

This unpublished candidate bumps, in the same commit:

- `MCP_TOOL_CATALOG_REVISION` in `src/version.ts`, from
  `2026-10-12.usability-acceptance` to `2026-10-20.launchpad-zero-seed-hold`
  (the date is the candidate's; set it to the actual release date if it ships
  later);
- `MCP_SERVER_VERSION` in `src/version.ts` and `version` in `package.json`, from
  `0.52.0` to `0.53.0`.

`script/smoke.mjs` reads both from `src/version.ts` and checks that the testing
endpoint serves exactly its seven tools and stays out of the root bundle.
Enabling execution is a separate change: it requires a non-empty
`LIVE_INSTANCE_PINS` and replacing the refusals, neither of which this
change does.
