# Exact-input swap protection

`get_quotes_with_plans` accepts `sender` with exactly one protection mode:

- `slippage_bps`: existing integer basis points, 0–10000. Explicit zero remains
  zero. Existing exact-input/output behavior is unchanged.
- `max_output_loss`: nonnegative decimal integer **string in output-token base
  units**, exact input only. It caps loss from the final quoted output, not from
  a USD oracle, an earlier indicative quote, or the input token's face value.

Omit sender and both protections for indicative quotes. There is no protection
default. Supplying both modes, an absolute budget without sender, fractional
base units, or an absolute budget with exact output fails before upstream calls.
An absolute budget at least as large as quoted output produces no executable
plan. Machine amount fields remain exact decimal strings.

## Provider capabilities

| Provider | Existing upstream tolerance | Absolute budget behavior |
| --- | --- | --- |
| Ekubo | Locally encoded signed integer router threshold; legacy whole bps | `minimum = amount_out - max_output_loss`, exact bigint subtraction, including one base unit. |
| 0x | `slippageBps` integer; also `slippagePpm` integer, 1 ppm = 0.01 bps | A fresh zero-bps baseline establishes output; floor `budget * 1000000 / baseline_output` to whole ppm and request new provider calldata. Verify the final `minBuyAmount` permits a positive loss no larger than the budget. Return only that final quote/plan. Explicit zero uses the checked baseline. |
| Across | Decimal fraction `slippage` (bps / 10000), split across swap legs | Unsupported by this adapter; no upstream call for absolute-budget requests. |
| LayerZero | Numeric percentage `options.feeTolerance.amount` (bps / 100), fee variance rather than an absolute output amount | Unsupported by this adapter; no upstream call for absolute-budget requests. |
| LI.FI | Numeric decimal fraction `slippage` (bps / 10000), returns `estimate.toAmountMin` | Unsupported by this adapter; no upstream call for absolute-budget requests. |

The three cross-chain APIs document fractional numeric tolerance, but do not
specify a guaranteed smallest enforced quantum in these references. This change
does not claim arbitrary fractional precision or translate their multi-leg/fee
tolerances into an absolute output guarantee. Whole-bps requests remain as before.

0x positive budgets below one ppm fail with `unsupported_swap_protection`, not a
zero-bps substitution. Price changes between its two quotes can make the final
bound invalid: the adapter rejects it rather than looping, widening the budget,
or rewriting calldata. A missing/malformed minimum is `invalid_upstream_response`.
Provider limitations appear in `unavailable_sources`; an invalid Ekubo budget
appears in `execution_unavailable`. Other usable quotes remain available.

Absolute-mode execution metadata includes `max_output_loss` and
`slippage_bps: null`, never a misleading zero-bps claim. The actual enforced
minimum is `execution.quote.minimum_amount_out`. The requested maximum budget
and the actual permitted loss may differ for a quantized provider.

## Gas-sized example

For a synthetic six-decimal stablecoin fixture selling `168413941673` base units
with quoted output `168620010171`, a $0.26517 budget at $1/output token is
`max_output_loss: "265170"`. Convert external gas value into output base units
**rounding down** before calling; this tool does not price currencies.

- Ekubo minimum: `168619745001`, exactly `265170` base units loss.
- 0x: floor to 1 ppm, not 1 bp. The offline provider fixture returns minimum
  `168619841551`, permitting `168620` base units loss ($0.168620), below budget.
  Actual API rounding can differ by a base unit; the returned minimum is always
  checked against the integer budget.
- A whole-bps bound would permit roughly $16.86, not the requested gas-sized loss.

All calculations use bigint; no floating-point token-amount arithmetic. The
offline boundary tests compare exact Ekubo router bytes and decode a synthetic
0x AllowanceHolder/Settler ABI fixture to verify the returned provider minimum is
preserved in the plan. These are not live swap or wallet-execution proofs.

## Freshness and failure recovery

A pinned-block simulation is not a guarantee of approval-time price or execution.
The 0x Settler custom error `TooMuchSlippage(address,uint256,uint256)` has selector
`0x97a6f3b9`: an execution protection failure, even when reported during wallet
preparation before any transaction hash exists. The selector alone cannot reveal
the token, expected/actual amounts, shortfall, or whether it fit a gas budget.

After a revert, obtain new quote/calldata and wallet simulation/owner authorization;
never retry reverted bytes or widen protection automatically. The plan policy
distinguishes `execution_reverted` → `reprepare_plan`, transient `rpc_error` →
`retry_same_plan` only while unexpired, and setup failures → `user_review`.
An expired artifact returns 404; rerun the tool, preserving the requested budget.
Preparation, simulation, authorization, submission and confirmation stay distinct.

## Primary references

- [0x AllowanceHolder quote API](https://docs.0x.org/api-reference/evm-ap-is/swap/allowanceholder-getquote.md), accessed 2026-10-28: whole bps, whole ppm, and returned `minBuyAmount`.
- [0x Settler errors](https://github.com/0xProject/0x-settler/blob/master/src/core/SettlerErrors.sol): selector and full revert ABI.
- [0x AllowedSlippage](https://github.com/0xProject/0x-settler/blob/master/src/interfaces/ISettlerBase.sol) and [AllowanceHolder](https://github.com/0xProject/0x-settler/blob/master/src/allowanceholder/IAllowanceHolder.sol): offline fixture ABI.
- [Across swap approval](https://docs.across.to/api-reference/swap/approval/get): fractional tolerance and per-leg allocation.
- [LayerZero request quotes](https://docs.layerzero.network/v2/developers/value-transfer-api/api-reference/quotes.md): numeric percent fee tolerance.
- [LI.FI quote](https://docs.li.fi/api-reference/get-a-quote-for-a-token-transfer.md): numeric decimal fraction, range 0–1, and minimum received.

This is an English-only tool endpoint: DOM accessibility, viewport checks and
locale negotiation do not apply. Acceptance exercises discovery and tools/call,
artifact integrity/fetch/expiry and error recovery through `worker.fetch`, using
mocked upstreams. No signing, funds movement, deployment or live reproduction is
part of these tests.
