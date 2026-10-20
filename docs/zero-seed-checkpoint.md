# Zero-seed MCP checkpoint — not a handoff

Draft/local only, Cloud Wallet first. Release HOLD.

## Implemented in this checkpoint

The unregistered `src/launchpad/zero-seed/` modules consume the actual frozen API
list/detail/swaps/claims shapes, with explicit body version and cursor parameters.
They validate pool-key identity, indexed-time fee arithmetic and block/time/hash
identity. Unsupported instance/quote pairs are dropped on lists and refused on
detail and histories. Support requires every local manifest field to match the
actual emitted instance, Core, constructor quote, executed extension runtime,
quote runtime and ABI pins. Hosted/live support is always empty.

Shared local checks implement checked uint64 creation timing, fresh expiry
refusal, 31 UTF-8-byte metadata and the exact five claim recipient sinks. These
are helper checks, **not yet producer/decoder enforcement**. No chain/RPC/wallet
reads occur. The existing artifact envelope and storage implementation are
untouched.

## Assembly continuation: single synthetic read

This continuation adds unregistered `abi.ts`, `installation.ts`
and `preview.ts` under `src/launchpad/zero-seed/`. These are still not the
registered producer or opaque owner decoder. `localInstallationPreview` uses
one `read_calls` bundle and passes its stored reference unchanged to a
**synthetic** wallet adapter. The tests use the existing `storeArtifact` with
in-memory storage and verify exact body length/integrity. Neither storage nor
the reference envelope changed. There are no provider calls or execution
artifacts; the returned receipt is explicitly non-executable.

The helper matches raw results by id at an exact input block number/hash/time,
requires canonical ABI return bytes, and binds creator, all requested config,
all emitted-instance pins, actual installed supply/liquidity and build/expiry.
It checks supported quote/instance/runtime/ABI, two address orders, pool config,
position geometry, positive amounts, exact protocol per-tick cap, checked
uint64 timing and 31 UTF-8-byte metadata. It snapshots input before awaiting
the read, then rechecks fresh time afterwards. Requested supply is not rewritten
in the receipt; actual supply and liquidity are separate. Trading start is
unchanged. A read failure never triggers an iterative adjustment.

`zero-seed-abi-parity.ts` verifies the full compiled ABI SHA256 before comparing
the selected create, preview and claim encodings and selectors. It does not
change the frozen ABI or represent the selected subset as the full artifact.
The encoded synthetic return amounts are test doubles, **not actual-handler
preview output or a proof of installation math**. Exact deterministic token
address/initcode binding, opaque byte decoding, claims, quoter parity and
replacement registration still need assembly. No acceptance or whole-stack
closure is claimed by this continuation.

## Assembly continuation: replaced registered surface

The staged ScheduledLaunch/LaunchRouter/LockedLaunchLiquidity tools, ABIs,
advance/migrate/fund paths, onboarding copy and their tests are deleted. The
launchpad catalog is now `src/launchpad/zero-seed/tools.ts`, served only at the
standalone testing endpoint `/mcp/launchpad-testing` (see
[launchpad.md](launchpad.md#where-the-tools-are-served)): list returns empty without a request;
detail, swaps, claims, create and claim preparation refuse with
`launch_support_disabled`; trade preparation refuses with
`executable_budget_not_proven`. No tool returns or stores a reference.
`launchpad://disclosures` carries the eight version-3 mechanism disclosures (draft).
`test/launchpad/zero-seed-endpoint.test.ts` drives the real worker.

The shared swap path (`src/yul-router.ts`, `src/core.ts`) no longer accepts
the single-hop `allow_partial` partial fill added for ScheduledLaunch at
`e6b2080`: a hop with `allow_partial: true` is refused and the split total must
equal the request exactly. The ScheduledLaunch partial-fill fixture is deleted.

## Exact upstream basis

| Input | Head / hash |
| --- | --- |
| Policy SHA256 | `7864a2d33a0fa8964922a5225653ed19842c590091f289eb4e29306feac6f6e1` |
| Protocol head | `d6aeb58d845aa29454f3ed8df15e84a306a6f26d` |
| Protocol ABI SHA256 | `189ff93c0f6fb64f6e7dd0675872bf6686692f8303e6218b8c2521bfa5ced215` |
| API head | `230afd458de0bc12463ec1816b047b858a3ecf41` |
| API tree | `f80e8116a5f5e20116b1521daff559f3425be517` |
| API base | `91232bb8bfeeb5757ddc3fb326738cd4a5343535` |
| Actual handler goldens SHA256 | `5e8e93cef1f23e02f8f54336fdcf0a7a81a3b36bb4984ed57cb991e5783df351` |
| Accepted LOCAL quoter head | `8352b2c7523c99eafe95d0c7706f0bb3c10e62ae` |
| Quoter tree | `7bfcd7dd453e847f663fbaf8d712a3a67ce40841` |
| Quoter implementation base | `f66fe706a64c9717ca4c4f74bb8b849b014fc48b` |
| Quoter accepted manifest SHA256 | `468b41c448c752dac171fcb88e95061b8601b12956189d5bc80b1e3bab7c65d8` |

`estimated_gas_cost` **must not** become a
transaction gas limit, UserOp budget, execution affordability decision or owner
assurance. Frame estimate `50650` is below measured cold-router gas
`120773–121931`; neither is a general bound. The executable-use refusal helper
must be wired into the replacement tool surface before any handoff. No wallet
simulation or live call is authorized to close this gap.

## Reproduce the smallest verification

From the repository root:

```sh
bun test test/launchpad/zero-seed-policy.test.ts
bun test test/launchpad/zero-seed-preview.test.ts
bun test test/launchpad/zero-seed-token.test.ts test/launchpad/zero-seed-swap.test.ts
bun test test/launchpad/zero-seed-owner.test.ts test/launchpad/zero-seed-endpoint.test.ts test/discovery.test.ts test/protocols.test.ts test/mcp-modern.test.ts test/yul-router.test.ts
bun test test/launchpad/zero-seed-fee.test.ts test/launchpad/zero-seed-api.test.ts
bun script/zero-seed-abi-parity.ts <jq -cS .abi of the b1cbb1c ZeroSeedLaunch artifact>
bun run lint
bun run build
```

The parity harness hash-checks the accepted actual API handler goldens, then uses
synthetic transport to consume both emitted WETH orders and histories. This is
consumer validation of captured real-handler output, not a fresh SQL/HTTP
integration run. It deliberately makes no network requests. API response shape
and indexed fee semantics are unchanged.

## Assembly continuation: local producer and opaque owner decoder

`src/launchpad/zero-seed/owner.ts` seals local, explicitly non-executable
create/claim bodies (`scope: synthetic-local-non-executable`,
`executable: false`) with the artifact envelope's keccak256/byte-length rules,
never storing them as an `execution_plan`. `localCreateBody` encodes `create`
from exactly the one bound preview (installed supply/L, unchanged signed start).
`decodeOwnerCreate`/`decodeOwnerClaim` check length, digest, strict schema and
canonical bytes, the exact local pin, target, creator and requested intent,
re-derive the installed pair and geometry, require canonical calldata equal to
the summary, and enforce fresh time in `[build, expiry)`. They emit
`zero-seed-launch-owner-summary/v1` with the frozen selectors and the five
create / two claim statements matching the reference examples byte for byte;
rates are Q0.64 plus four-decimal half-up percentages. Additive `fields.binding`
(requested vs installed supply/L, token, pool key, position, expiry) and
`fields.rounding` (upper launch-token residue separate from per-asset Core
unbooked dust; neither claimable principal nor fees; not known at creation, no
shared bound) sit inside the schema's free `fields` object.

Fixed in `policy.ts`: `validateClaimRecipient` mapped sinks with
`.map(getAddress)`, passing the array index as the EIP-1191 chain id, so Core,
extension and token sinks with checksum letters were not refused. A
mixed-case control now fails on the old code and passes.

## Assembly continuation: token identity, captured preview, quoter → router

- `token.ts` predicts the launch token exactly as `ZeroSeedLaunch._tokenAddress`:
  CREATE2 from the instance with salt `keccak256(abi.encode(creator, salt))`
  over the MintableERC20 creation code (`mintable-erc20.ts`, 4,419 bytes,
  keccak `0x25da7fd3…` from `pins.json`) plus `abi.encode(extension, name,
  symbol, decimals)`. The preview and the owner decoder both refuse an
  installation whose token is not that address (`preview_token_mismatch`).
  The prediction reproduces both emitted local tokens (l1 `0x89738a97…`,
  l3 `0x66b53575…`, salt 1).
- Test fixtures now use the actual creator, metadata, salt and the installed
  supply/L that the actual contract's `previewInstallation` returned for l1
  (token0) and l3 (token1). Unit-test timing stays synthetic boundary context.
- `swap.ts` consumes one accepted quoter request/response (request contract
  SHA256 `2319a23c…`). It needs one split with one forwarded hop through the
  pinned instance and requires `skip_ahead` 0. It refuses partial intent, wrong-side or
  missing guards, zero/over-int128 guards, a quote that misses the guard, and
  any snapshot, amount or route mismatch. The deadline is inclusive and must
  fit the router's uint32 field. The encoder reuses the SDK hop encoding and adds the current `0x03c8` deadline
  flag. Its output matches all 8 executed router calldatas byte for byte, in
  both orders. `estimated_gas_cost` is never read, and no gas, budget or
  reference is returned. `launchpad_prepare_trade` still refuses with
  `executable_budget_not_proven`.
- `script/zero-seed-stack-parity.ts` hash-pins the API goldens, router
  vectors, emitted chain, contract vectors and pins, then checks per order:
  API ↔ chain ↔ contract-vector identity and installed pair, the CREATE2 token,
  the preview → producer → owner decoder summary against the API detail, a claim
  to the API's claim recipient, quoter → router bytes, and the router input pool
  liquidity. For l3 the API tick at 1800001420 equals the quoter input tick at the
  same time. The two runs have different block hashes. The API golden has no l1
  tick at that time, so l1 is NOT COVERED.

## Stop/reset and NOT PROVEN

No runtime was started, no provider or connected-wallet call was made, and no
data reset is needed for this checkpoint. Stop means no launch routing or
executable references. Never revive staged/arbitrary-quote ABI or use the
zero-filled runtime template as an executed pin. Do not reset shared worktrees.
Discard only disposable local fixtures created by the owning harness. An app
rollback cannot refund, withdraw, rebalance or migrate immutable principal.

Same-blockhash API/quoter parity (the runs share time and state only), l1 tick
parity at the quoter time, mined UserOps, executable budgets, wallet simulation,
live provenance/registration/assets, mined UserOps, full WETH metadata,
hosting/retention/oncall/costs, external security review, final QA and release are
NOT PROVEN. No merge/deploy/signing/issuance/provider/credential/live-wallet,
policy/authority/permissions/model, spend or publication action is authorized.

## Draft exponential creator-fee decay

The modules now consume the draft fee interface at evm-contracts `b1cbb1c`
(ABI SHA-256 `bc51b39284a5a2a0970d3a804420762ce291dc01f9c21ddf31840e354a3792bb`,
`create` `0xd5f50468`, `previewInstallation` `0x5283ac38`; `claimFees` is
unchanged). The local pins are the constructor-executed draft instances
`0x5142e167…` (high WETH) and `0x51174b5d…` (low WETH). The live pin list is
still empty and every hosted tool still refuses. The catalog revision and
server version are bumped for this unpublished candidate (see
[launchpad.md](launchpad.md#release)).

- `fee.ts` mirrors `powQ64`, the endpoint-normalized schedule, the exact-input
  fee, the exact-output gross-up and the distinct uint128 helper and int128
  signed-delta limits, in BigInt.
- `zero-seed-fee.test.ts` checks, bit for bit, all 25,212 seconds of both
  study durations at 5/50/75/90/99%/max (the protocol's 12 SHA-256 chain
  digests), the 18 contract fee rows, the five integer-chord counterexamples
  (reproduced, not corrected), the equal-half-life comparator, the executed
  high-fee amount rows for both orders and 18/18 and 18/6, the helper and
  signed limits at every rate, the 8 executed local router swaps' emitted rate
  and fee, and `create`/`previewInstallation` bytes against independent `cast
  calldata`.
- `zero-seed-api.test.ts` consumes served API v2 bodies at two blocks, refuses
  v1, missing/zero/foreign factors and a linear rate, and runs both orders'
  preview → producer → owner decoder against the emitted `LaunchCreated`
  parameters and the served detail.
- The v1-pinned API and stack parity scripts are removed: their artifacts
  predate `decayFactor`. The API tick versus quoter tick comparison they made
  is NOT re-covered.

NOT PROVEN: live or fork execution, wallet simulation, executable budgets,
external security review, parameter selection, approved disclosure copy, and any Rust/Solidity
parity beyond the consumed vectors.
