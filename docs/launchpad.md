# Launchpad (zero-seed, support disabled)

The launchpad targets the **draft** exponential creator-fee decay of the
zero-seed launch contract at evm-contracts `b1cbb1c` (ABI SHA-256
`bc51b392…3792bb`), which is not released, audited or a selected parameter
set. It replaced the linear decay of `d6aeb58` (ABI `189ff93c…ced215`). The tools are
part of the Ekubo Protocol catalog: they are served by `/mcp/ekubo`, by any
`/mcp?protocols=` selection that includes `ekubo`, and by the root `/mcp`
bundle, and are listed at `/tools?protocol=ekubo`. There is no separate
launchpad endpoint. Discovery does not enable execution: every tool still
fails closed as described below.

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

Registering the seven tools and the disclosures resource in the Ekubo Protocol
catalog deliberately left the catalog identifiers unchanged while it is
unreleased. The release that first serves them must bump, in the same commit:

- `MCP_TOOL_CATALOG_REVISION` in `src/version.ts`, from
  `2026-10-12.usability-acceptance` to `<release date>.launchpad-zero-seed-hold`;
- `MCP_SERVER_VERSION` in `src/version.ts` and `version` in `package.json`, from
  `0.52.0` to `0.53.0`.

`script/smoke.mjs` reads both from `src/version.ts`, so it needs no edit.
Enabling execution is a separate change: it requires a non-empty
`LIVE_INSTANCE_PINS` and replacing the refusals, neither of which this
catalog registration does.
