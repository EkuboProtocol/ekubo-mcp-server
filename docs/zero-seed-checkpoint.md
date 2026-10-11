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
bun script/zero-seed-api-parity.ts /home/moody/Work/ekubo/artifacts/eku-1523/actual-handler-golden.json
bun run lint
bun run build
```

The parity harness hash-checks the accepted actual API handler goldens, then uses
synthetic transport to consume both emitted WETH orders and histories. This is
consumer validation of captured real-handler output, not a fresh SQL/HTTP
integration run. It deliberately makes no network requests. API response shape
and indexed fee semantics are unchanged.

## Still required before delivery

- Replace the obsolete registered staged tools, ABIs, tests and documentation;
  this checkpoint does not register a second implementation or enable support.
- Single budgeted read-reference installation preview; bind requested supply and
  actual supply/L, creator, exact config, unchanged signed start/expiry and all
  disclosures to the stored plan.
- Exact current create/claim ABI and opaque owner decoder; hash/length/expiry/
  tamper controls, refusal of all claim sinks and mismatched installation pairs.
- Quoter parity on its accepted request contract and current `0x03c8` router;
  skipAhead=0/noPartial, positive output bounds and inclusive fresh deadline.
  Enforce the executable-budget hold at the actual public preparation entrypoint.
- Separate upper-bound token residue from per-asset Core unbooked dust. Neither
  is creator fees or claimable principal. No shared <=90 bound.
- Assembled local synthetic plan/decoder/API/quoter tests and inspectable exact
  head/base/tree packet for downstream owner integration and final QA/Sage.

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
