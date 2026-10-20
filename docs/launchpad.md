# Launchpad (zero-seed, support disabled)

The launchpad targets the zero-seed launch interface of evm-contracts
`4f1a306`: the `ZeroSeedLaunch(Core, quote)` extension and the
`ZeroSeedLaunchPeriphery(Core, extension)` that users call. It is not
deployed, released or externally reviewed. A launcher deploys and funds its
own pair of contracts; nothing here assumes a canonical Ekubo instance.

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
loaded into every agent session (about 1,810 o200k tokens on `/mcp` and
`/mcp/ekubo`; see [MCP-CONTEXT.md](MCP-CONTEXT.md)). Placing them in the
Ekubo Protocol catalog is part of a later live-enablement change, together
with non-empty live pins, the indexed launch API and a hosted producer.
Discovery on the testing endpoint does not enable execution.

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

Were a live pin ever added, the read tools would still refuse with
`api_schema_pending`: the indexed launch API for this contract version is not
consumed yet.

`launchpad://disclosures` serves the nine mechanism disclosures (version 4)
every owner summary carries: zero initial bid, buyer-funded quote reserve,
permanent principal lock, creator fee rate, transferable launch ownership,
owner fee recapture, high initial fee, exact-output gross-up and no exit
guarantee. The wording is a draft and not approved.

## Instances

A pin (`InstancePin`) binds one launcher deployment: Core, the extension, its
periphery and the extension's constructor quote, each by exact deployed
runtime. The extension address must start with the call-points byte `0x51`;
Core, extension, periphery and quote must be distinct. `runtime.ts` accepts
deployed code only when it is the compiler template with exactly the expected
Core, quote or extension word at every `immutableReferences` offset, so a
template-equal instance bound to another Core, quote or extension is refused.

The quote is either native ETH (`quoteKind: "native"`, `address(0)`, always
token0, 18 decimals, no runtime, no `decimals()` call, no approval, no
wrapping) or an ERC-20 whose runtime is pinned. Owner summaries show which.

## Calls

- `create(LaunchParameters)` and `claimFees(PoolKey, recipient)` go to the
  periphery, never with value. `LaunchParameters` has no quote token (the
  constructor fixes it) and no decay factor.
- The periphery namespaces the user's salt as `keccak256(abi.encode(owner,
  salt))`; the extension namespaces it again with its controller, the
  periphery. The launch token is `CREATE2(extension, keccak256(abi.encode(
  periphery, ownerSalt)), MintableERC20 init code)`.
- The caller of `create` becomes the launch owner, recorded by the periphery
  (`LaunchOwnerChanged(poolId, 0x0, owner)` identifies the creator). Only the
  current owner can claim, and `transferLaunch` moves that right, including
  fees not yet claimed. A claim body carries the `launchOwner(poolId)` read it
  was built on and is refused for anyone else.
- Claim recipients may not be `address(0)`, Core, the extension, the
  periphery or either pool token.
- Swaps go through the 0x03c8 router as a forwarded hop to the extension, with
  the unchanged `abi.encode(PoolKey, SwapParameters)` payload. A native
  exact-input buy attaches exactly the input as value; a native exact-output
  buy attaches the maximum input and the router refunds the rest in the same
  transaction; a sell attaches nothing. Only an ERC-20 input needs an
  allowance to the router.

## Creator fee schedule

The decay has a fixed 600 s half-life: `decayQ128(t)` multiplies `2^128` by
the table constant of every set bit of `t` in ascending order, flooring after
each multiply, and is zero from `2^17` s. With `E = decayQ128(D)` the fee is
`initialFee` at or before trading start,
`finalFee + floor((initialFee - finalFee) * (decayQ128(t) - E) / (2^128 - E))`
inside the window and `finalFee` from `D` on. The initial fee is capped at
`floor(99 * 2^64 / 100)`. 50% to 0.3% over 3,600 s first halves its excess
after 587 s. Owner summaries (`zero-seed-launch-owner-summary/v3`) show the
exact schedule at sample times; sealed local bodies are
`zero-seed-local-create/v3` and `zero-seed-local-claim/v2`.

The quoter's `estimated_gas_cost` is never a gas limit, UserOp budget,
affordability decision or owner assurance. Trade preparation stays refused
until execution budgeting and wallet simulation are separately proven.

## Local modules

`src/launchpad/zero-seed/` holds the frozen constraints (`policy.ts`), runtime
checks (`runtime.ts`), the periphery and extension ABI subsets (`abi.ts`),
parameter and build validation (`installation.ts`), the single installation
preview (`preview.ts`), the local create/claim producer and owner decoder
(`owner.ts`) and the router plan from a quote (`swap.ts`). They accept the
local anvil instances only, inside an explicit local harness that the public
tools never construct. See [zero-seed-checkpoint.md](zero-seed-checkpoint.md)
for reproduction and what remains unproven.

## Release

This unpublished candidate bumps, in the same commit:

- `MCP_TOOL_CATALOG_REVISION` in `src/version.ts`, from
  `2026-10-20.launchpad-zero-seed-hold` to
  `2026-10-20.launchpad-zero-seed-native-periphery` (the create tool's
  parameters changed; set the date to the actual release date if it ships
  later);
- `MCP_SERVER_VERSION` in `src/version.ts` and `version` in `package.json`, from
  `0.53.0` to `0.54.0`.

`script/smoke.mjs` reads both from `src/version.ts` and checks that the testing
endpoint serves exactly its seven tools and stays out of the root bundle.
Enabling execution is a separate change: it requires a non-empty
`LIVE_INSTANCE_PINS`, the indexed API and replacing the refusals, none of
which this change does.
