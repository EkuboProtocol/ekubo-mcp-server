# Zero-seed MCP checkpoint — not a handoff

Origin: [board launchpad feature](/EKU/issues/EKU-637),
delivery [EKU-1524](/EKU/issues/EKU-1524), coordinated under
[EKU-822](/EKU/issues/EKU-822). Draft/local only, Cloud Wallet first. Release HOLD.

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

[EKU-1574](/EKU/issues/EKU-1574) adds unregistered `abi.ts`, `installation.ts`
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
`/mcp/launchpad` catalog (revision `2026-10-11.launchpad-zero-seed-hold`) is
now `src/launchpad/zero-seed/tools.ts`: list returns empty without a request;
detail, swaps, claims, create and claim preparation refuse with
`launch_support_disabled`; trade preparation refuses with
`executable_budget_not_proven`. No tool returns or stores a reference.
`launchpad://disclosures` carries the five mechanism disclosures (draft).
`test/launchpad/zero-seed-endpoint.test.ts` drives the real worker.

The shared swap path (`src/yul-router.ts`, `src/core.ts`) no longer accepts
the single-hop `allow_partial` partial fill added for ScheduledLaunch at
`e6b2080`: a hop with `allow_partial: true` is refused and the split total must
equal the request exactly. The ScheduledLaunch partial-fill fixture is deleted.

## Exact upstream basis

| Input | Head / hash |
| --- | --- |
| Freeze revision | `ceebe872-8deb-4858-a192-8c013516def1` |
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

Quoter request acceptance additionally binds the CTO request disposition on
[EKU-1550](/EKU/issues/EKU-1550) and gas disposition on
[EKU-1566](/EKU/issues/EKU-1566). `estimated_gas_cost` **must not** become a
transaction gas limit, UserOp budget, execution affordability decision or owner
assurance. Frame estimate `50650` is below measured cold-router gas
`120773–121931`; neither is a general bound. The executable-use refusal helper
must be wired into the replacement tool surface before any handoff. No wallet
simulation or live call is authorized to close this gap.

## Reproduce the smallest verification

From the task worktree:

```sh
bun test test/launchpad/zero-seed-policy.test.ts
bun test test/launchpad/zero-seed-preview.test.ts
bun test test/launchpad/zero-seed-owner.test.ts test/launchpad/zero-seed-endpoint.test.ts test/discovery.test.ts test/protocols.test.ts test/mcp-modern.test.ts test/yul-router.test.ts
bun script/zero-seed-abi-parity.ts /home/moody/Work/ekubo/artifacts/eku-1528/ZeroSeedLaunch.abi.json
bun script/zero-seed-api-parity.ts /home/moody/Work/ekubo/artifacts/eku-1523/actual-handler-golden.json
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
create / two claim statements matching the EKU-1513 examples byte for byte;
rates are Q0.64 plus four-decimal half-up percentages. Additive `fields.binding`
(requested vs installed supply/L, token, pool key, position, expiry) and
`fields.rounding` (upper launch-token residue separate from per-asset Core
unbooked dust; neither claimable principal nor fees; not known at creation, no
shared bound) sit inside the schema's free `fields` object.

Fixed in `policy.ts`: `validateClaimRecipient` mapped sinks with
`.map(getAddress)`, passing the array index as the EIP-1191 chain id, so Core,
extension and token sinks with checksum letters were not refused. A
mixed-case control now fails on the old code and passes.

## Still required before delivery

- Deterministic token/initcode identity and captured actual preview arithmetic
  (preview return values in tests are synthetic doubles).
- Quoter parity on the accepted request contract and current `0x03c8` router:
  skipAhead=0/noPartial, positive min output/finite max input, inclusive fresh
  deadline; consumer stays non-executable behind the public refusal.
- Reproducible API/quoter/decoder parity at the same block/time in both orders
  and the final exact head/base/tree packet for owner integration and QA/Sage.

## Stop/reset and NOT PROVEN

No runtime was started, no provider or connected-wallet call was made, and no
data reset is needed for this checkpoint. Stop means no launch routing or
executable references. Never revive staged/arbitrary-quote ABI or use the
zero-filled runtime template as an executed pin. Do not reset shared worktrees.
Discard only disposable local fixtures created by the owning harness. An app
rollback cannot refund, withdraw, rebalance or migrate immutable principal.

Producer/opaque-decoder parity, end-to-end timing enforcement, executable budgets,
live provenance/registration/assets, mined UserOps, full WETH metadata,
hosting/retention/oncall/costs, external audit, final QA/Sage and release are
NOT PROVEN. No merge/deploy/signing/issuance/provider/credential/live-wallet,
policy/authority/permissions/model, spend or publication action is authorized.
