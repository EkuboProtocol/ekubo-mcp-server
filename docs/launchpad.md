# Launchpad (zero-seed, support disabled)

The launchpad targets the zero-seed launch interface of evm-contracts
`43d6628`: the `ZeroSeedLaunch(Core)` extension and the
`ZeroSeedLaunchPeriphery(Core, extension)` that users call. One extension and
its periphery serve every quote token; each launch names its own. It is not
deployed, released or externally reviewed. A launcher deploys and funds its
own pair of contracts; nothing here assumes a canonical Ekubo instance.

## Where the tools are served

The eight `launchpad_*` tools and `launchpad://disclosures` belong to the
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
| `launchpad_get_owners` | Refuses with `launch_support_disabled`. |
| `launchpad_prepare_create` | Refuses with `launch_support_disabled`; no plan or reference. |
| `launchpad_prepare_claim_fees` | Refuses with `launch_support_disabled`; no plan or reference. |
| `launchpad_prepare_trade` | Refuses with `executable_budget_not_proven`; no plan or reference. |

The read tools consume the indexed launch API `zero-seed-launch-api/v4`
(`src/launchpad/zero-seed/api.ts`) only for a chain with a live pin, of which
there is none, so no hosted call reaches the API. Any other schema version is
refused. The client re-derives the pool, the instance, the launch's quote and
its support, the supply split, the fee rate and the owner and ledger totals
from each response; see
[zero-seed-checkpoint.md](zero-seed-checkpoint.md).

`launchpad://disclosures` serves the ten mechanism disclosures (version 6)
every owner summary carries: zero initial bid, buyer-funded quote reserve,
permanent principal lock (with the requested, installed and sink supply),
creator fee rate, transferable launch ownership,
owner fee recapture, high initial fee, exact-output gross-up, no exit
guarantee and quote trust. The quote-trust statement has an ERC-20 form
(`template`) and a native-ETH form (`native_template`). The wording is a
draft and not approved.

## Instances

A pin (`InstancePin`) binds one launcher deployment: the chain, Core, the
extension and its periphery, each contract by exact deployed runtime, and the
block both were deployed in. It has no quote. The extension address must start
with the call-points byte `0x51`; Core, extension and periphery must be
distinct. `runtime.ts` accepts deployed code only when it is the compiler
template with exactly the expected Core or extension word at every
`immutableReferences` offset, so a template-equal instance bound to another
Core or extension is refused. The extension has no quote immutable and no
`quoteToken()` getter.

## Quotes

The quote is per launch: `LaunchParameters.quoteToken`, the other token of
that launch's pool key, fixed at creation. Native ETH is `address(0)`: always
token0 (so the launch token is token1), 18 decimals, no runtime, no
`decimals()` call, no approval and no wrapping. An ERC-20 quote at a higher
address than the launch token makes the launch token token0. The contract
refuses a nonzero quote without code (`UnsupportedQuoteToken()`) and screens
nothing else.

Supporting a quote is a separate, per-launch decision from supporting the
instance. Native ETH is eligible behind the same instance gates. An ERC-20 is
eligible only when it is in a reviewed list keyed by chain, address and
runtime codehash (`policy.ts`): `LIVE_REVIEWED_ERC20_QUOTES` is empty, and the
local list holds only the local chains' plain test ERC-20 at
`0xff…ff`. Every producer (preview, create, claim, swap plan) and the API
client refuse any other quote with `unsupported_quote`, or drop it from lists.
Owner summaries show the quote and, for an ERC-20, its reviewed runtime.

Trust in an ERC-20 quote is token-wide, not limited to the launch's pool.
Core keeps one balance per token, so a quote that misreports balances or
transfers exposes every pool, position and fee ledger that holds it, including
other launches and ordinary pools on the same token, and an honest token
paired with it can lose that pool's own reserve. Pools that do not hold the
quote, including native ETH and unrelated tokens, keep their own per-token
accounting and are not reachable through it. Every ERC-20 owner summary
carries this as its quote-trust statement; a native-ETH summary states that
no quote token contract is trusted. Reviewing a quote does not change this.

## Supply

`LaunchParameters.supply` is the requested supply: the token's `totalSupply`
and `LaunchCreated.parameters.supply`. There is no liquidity input. The
contract computes the largest liquidity whose rounded-up Core debit fits the
requested supply (refusing `ZeroLiquidity` and `LiquidityAboveTickCap`),
installs the launch-token amount Core takes for it (`installedSupply`, rounded
up, `0 < installed <= requested`) and mints the remainder `sink = requested -
installed` to `address(0)`, where nothing can spend it; the sink is too small
to pay for one more liquidity unit, and when it is zero nothing is minted
there. `totalSupply` stays the requested supply. `previewInstallation`
returns the same installation for display; the MCP reads it rather than
recomputing it.

The producers submit the requested parameters unchanged: the create calldata
carries the requested supply, never the installed one. The preview and owner
summary report `supply: { requested, installed, sink, sink_holder }` as exact
decimal strings of raw launch-token units, plus the computed `liquidity`, and
refuse a preview whose installed supply exceeds the request, whose liquidity is
zero or above the per-tick cap, or whose pool does not pair the launch token
with the launch's own quote. For 18/18 decimals, ticks `-13815500`/`-9210300`,
spacing 100 and a requested `1e27`, the native launch (token1) installs
`999999999999999999999999422` with a sink of `578`, and an ERC-20 launch whose
token is token0 installs `999999999999999999999999210` with a sink of `790`.
At ticks `-88080384`/`-85983232`, spacing 524,288 and a requested `1e30`, an
ERC-20 launch whose token is token0 installs liquidity `115073586432` and
`999999999991410763432286846442` with a sink of `8589236567713153558` raw
units; over the full width at spacing 1, a requested
`170141183460469231694794709727778658247` installs the whole supply with no
sink.

## Calls

- `create(LaunchParameters)` (`0x662af306`), `previewInstallation(owner,
  LaunchParameters)` (`0x917c1163`) and `claimFees(PoolKey, recipient)` go to
  the periphery, never with value. `LaunchParameters` is `(name, symbol,
  decimals, supply, quoteToken, askTick, upperTick, tickSpacing, tradingStart,
  feeDuration, initialFee, finalFee, salt)`: the quote in slot 5, no liquidity
  and no decay factor. The earlier `0x687ba810` tuple never decodes as a
  create.
- The periphery namespaces the user's salt as `keccak256(abi.encode(owner,
  salt))`; the extension namespaces it again with its controller, the
  periphery. The launch token is `CREATE2(extension, keccak256(abi.encode(
  periphery, ownerSalt)), MintableERC20 init code)`.
- The caller of `create` becomes the launch owner, recorded by the periphery
  (`LaunchOwnerChanged(poolId, 0x0, owner)` identifies the creator;
  `events.ts` decodes `LaunchCreated`, topic `0x3a4e8111…098f`, and
  attributes the creator from it). Only the
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
  allowance to the router. A swap plan names the launch's quote and is checked
  against the pool's pair.

## Creator fee schedule

The decay has a fixed 600 s half-life: `decayQ128(t)` multiplies `2^128` by
the table constant of every set bit of `t` in ascending order, flooring after
each multiply, and is zero from `2^17` s. With `E = decayQ128(D)` the fee is
`initialFee` at or before trading start,
`finalFee + floor((initialFee - finalFee) * (decayQ128(t) - E) / (2^128 - E))`
inside the window and `finalFee` from `D` on. Both fees are Q0.64 rates
(`value / 2^64`) and may be any uint64, `0` to `18446744073709551615` (`2^64 - 1`,
just under 100%; exactly 100% is `2^64`, which is not a uint64). The contract
checks only `finalFee <= initialFee` and `feeDuration > 0`
(`InvalidFeeSchedule()`); there is no lower ceiling and no `FeeTooHigh`.
Both fee fields are required; the tool has no default schedule. The reference
schedule is unchanged: 50% (`9223372036854775808`) to 0.3%
(`55340232221128654`) over 3,600 s, whose excess first halves after 587 s,
with the fees going to the launch owner. The maximum is a bound a caller may
choose, not a suggestion.

At the tool boundary `initialFee` and `finalFee` are canonical decimal
strings. Leading zeros, signs, whitespace, hex, exponents, fractions, empty
strings and JSON numbers are refused as invalid input naming the field, as is
any value above `2^64 - 1`, a final fee above the initial fee and a zero
duration; nothing is truncated or wrapped. Owner summaries show each rate as
the exact Q0.64 integer and as a percentage to four decimals rounded half up,
except that no rate below `2^64` rounds up to 100%: the maximum shows as
`99.9999%`. Owner summaries (`zero-seed-launch-owner-summary/v4`) show the
exact schedule at sample times; sealed local bodies are
`zero-seed-local-create/v4` and `zero-seed-local-claim/v3`, both carrying the
launch's resolved quote.

The quoter's `estimated_gas_cost` is never a gas limit, UserOp budget,
affordability decision or owner assurance. Trade preparation stays refused
until execution budgeting and wallet simulation are separately proven.

## Local modules

`src/launchpad/zero-seed/` holds the frozen constraints (`policy.ts`), runtime
checks (`runtime.ts`), the periphery and extension ABI subsets (`abi.ts`),
parameter and build validation (`installation.ts`), the single installation
preview (`preview.ts`), the local create/claim producer and owner decoder
(`owner.ts`), `LaunchCreated` decoding and creator attribution (`events.ts`)
and the router plan from a quote (`swap.ts`). They accept the one local anvil
instance only, inside an explicit local harness that the public tools never
construct. See [zero-seed-checkpoint.md](zero-seed-checkpoint.md)
for reproduction and what remains unproven.

## Release

This unpublished candidate bumps, in the same commit:

- `MCP_TOOL_CATALOG_REVISION` in `src/version.ts`, from
  `2026-10-20.launchpad-zero-seed-hold` to
  `2026-10-21.launchpad-zero-seed-fee-range` (the create tool's parameters
  changed: `quoteToken` added with the native default, `liquidity` removed,
  `initialFee` and `finalFee` documented and validated as the full uint64
  range; `launchpad_get_owners` was added; the disclosures resource moved to
  version 6 with the quote-trust statement and the exact-installation sink
  wording; set the date to the actual release date if it ships later);
- `MCP_SERVER_VERSION` in `src/version.ts` and `version` in `package.json`, from
  `0.53.0` to `0.54.0`.

`script/smoke.mjs` reads both from `src/version.ts` and checks that the testing
endpoint serves exactly its eight tools and stays out of the root bundle.
Enabling execution is a separate change: it requires a non-empty
`LIVE_INSTANCE_PINS`, the indexed API and replacing the refusals, none of
which this change does.
