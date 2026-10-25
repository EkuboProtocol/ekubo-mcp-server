# Zero-seed MCP checkpoint — not a handoff

Local only. Release HOLD. Every hosted tool refuses; the live pin list is empty.

## Tick-rate revision (evm-contracts 3d6378f, `tick_rate_v2`)

The consumer ABI freeze of evm-contracts `3d6378f585591dc7eabeea6976932c30524bb8ea`
replaces `uint32 feeDuration` with `uint64 decayRateX32` (Q32.32 ticks per
second) in the 10th `LaunchParameters` field: `create` `0xf91810d2`,
`previewInstallation` `0xb665ec4d`, `LaunchCreated` `0x8f81ce1b…5888`, full
ABI SHA-256 `89ff4d15…4eaadd` / `a6d43b36…0ddb07`. The fee is
`finalFee + floor(excess * toFixed(tickToSqrtRatio(-m)) / 2^128)` with
`m = floor(rate * t / 2^32)`, saturating to `finalFee` after
`381061679028371455 / rate` seconds; `finalFee` is a floor, not an end. Every
pin now names its `feeModel`; new creates and previews are prepared only for a
`tick_rate_v2` pin, and the `43d6628` deployment below (`fixed_base_duration_v1`)
keeps its ABI and math for reads and claims only.

- **Fee math** (`fee.ts`): `tickFactorQ128` ports the negative-tick
  `tickToSqrtRatio` and the compact `toFixed` rounding. Against the contracts'
  own v7 vector file (vendored verbatim as
  `test/fixtures/launchpad/zero-seed-launch-vectors-3d6378f.json`, sha256
  `4c1245ca…66605`, from the independent 150-digit Python oracle): all 40 fee
  rows through `uint256.max`, the five SHA-256 digest chains, the five tables,
  the tick steps at 1/4 and just under 1/10 tick per second (fractional
  accumulation) and the six saturation seconds.
- **Conversions**: `HALF_LIFE_X32_E30 = 5954091920683119788732747343471285361579197626`;
  `86400 → 68913100933`, `600 → 9923486534471`, `3600 → 1653914422411`,
  `604800 → 9844728704`, `86400.5 → 68912702133`; displays `86400.000001`,
  `600.000000`, `693147.527133`, `0.000322` for `2^64 - 1`, `null` for 0. Every
  sampled integer half-life to 10^6 s and the pinned rates round-trip exactly.
  The vector note `693151.527…` for 2 ticks/s is a typo; the constant and the
  note's own "8.0225408233 days" give `693147.527133`.
- **Local chain** (`script/zero-seed-local-chain.ts`, now run on the `3d6378f`
  artifacts): writes `zero-seed-tick-rate-local-chain.json` (sha256
  `bdf34f8c…707fcafc`; two fresh-anvil runs byte-identical). The instance is the
  indexer's v2 replay instance (indexer `7f373e5`, `local-chain-v2.json`):
  extension `0x5135fd3e…2263d` (runtime `0xe08ad382…dfc3`, the freeze's pin),
  periphery `0xfb2e7927…61e9`. Ten launches from the producer's own preview and
  create, at rates 600 s, one day, 1, 0 and `2^64 - 1` and at the maximum fee;
  fourteen swaps whose emitted rate equals the TS schedule (decaying, constant
  and at-floor phases); three claims and a transfer; the chain refuses the v1
  create, a rising fee and a `2^64` rate word, and accepts rates 0 and
  `2^64 - 1`.
- **API**: `zero-seed-launch-api/v5` of api `06fc548f544c88a16b878212ec0a489f03a2cde0`,
  both goldens byte-identical (`d9e6a646…aedf2` fixed-base, `727dd25d…05fe`
  tick-rate) and the `/launches*` OpenAPI (`2d77056b…edf2`) equal to the
  consumed schemas. v4 is refused.
- **Parity**: `script/zero-seed-abi-parity.ts` takes either or both revisions'
  full compiled ABIs and identifies each by hash (84 controls for both).
- **Wallet handoff**: `test/fixtures/launchpad/zero-seed-wallet-handoff-v5.json`
  (written by `script/zero-seed-wallet-fixtures.ts`, rebuilt byte for byte by
  the tests): six creates with their preview read, sealed create, summary and
  `summary_keccak256`; four claims, one of them on the v1 pin; nine refusals.
  Unsigned and never sent.

Reproduce the tick-rate chain as below with `EVM_CONTRACTS=<evm-contracts at
3d6378f, after forge build>` and the output
`test/fixtures/launchpad/zero-seed-tick-rate-local-chain.json`.

## Basis (fixed_base_duration_v1, kept as recorded)

evm-contracts `43d6628841b3ce91dafa048b7ceef64bed55fc8e` (tree `9ab869d1…`):
extension ABI SHA-256 `efae9388…90d1e41e`, periphery ABI SHA-256
`df24d9f0…bebe7305` (`jq -cS .abi`, no trailing newline; both unchanged),
runtime templates `0x19d7461a…` (20,402 bytes) and `0x76db610a…`,
MintableERC20 init code `0x25da7fd3…` (unchanged). The extension's
constructor is `(core)`; the quote is `LaunchParameters.quoteToken`, per
launch. Every uint64 initial and final fee is accepted (`MAX_CREATOR_FEE =
2^64 - 1`, just under 100%); `InvalidFeeSchedule()` (`0xf75a271a`) refuses
only a rising fee or a zero duration.

Against `550afc4` the only change is the installation of a launch whose token
is token0 (an ERC-20 quote above the token address). The installed liquidity is
now `floor(supply * lower * upper / (2^128 * (upper - lower)))`, the largest
liquidity whose rounded-up Core debit fits the requested supply; the shared
helper it replaced floored `lower * upper / 2^128` first and could install
less at low prices, sinking the difference. Token1 (native ETH) installations,
selectors, topics, structs, the fee table and settlement are unchanged. The
MCP has no installation mirror: it reads `previewInstallation` and checks its
bounds, so only the pins and fixtures changed.
`test/fixtures/launchpad/zero-seed-interface-43d6628.json` is the canonical
interface manifest (`manifest_sha256` `6be8bd0a…18906629`), vendored verbatim;
its `creator_fee_range` verdicts are replayed against the parameter
validation. `zero-seed-fee-decay-vectors.json` holds the protocol generator's
independent fee vectors, unchanged.

## Local chain

`script/zero-seed-local-chain.ts` drives a fresh anvil chain from the compiled
`43d6628` artifacts:

1. Core's runtime is placed at its canonical address (runtime hash equal to
   Base Core, `0xc5f90c9d…`) and the checkout's plain 18-decimal
   `test/TestToken.sol` runtime at `0xff…ff` (runtime `0xe8ccd7c4…`, the one
   reviewed local ERC-20 quote). Block 1 deploys `test/LaunchTestRouter.sol`.
2. Block 2 deploys, through the CREATE2 deployer, the one extension at the
   first salt whose address starts with `0x51` and its periphery at salt 0,
   exactly as the indexer's replay generator does, so both chains share the
   one pin (extension `0x519c5f79…08211f`, periphery `0x0df4e2a7…7e8ef4`,
   equal to indexer `91a7036`).
   `runtime.ts` verifies both runtimes and every immutable before the pin is
   accepted.
3. The MCP preview, create producer and owner decoder run over that chain for
   a native-ETH launch (launch token1) and a test-ERC-20 launch (launch
   token0), each requesting `1e27`; the exact `create` they produced, carrying
   the requested supply, executes from the owner. The script checks Core's
   `PositionUpdated` against the installed supply (quote side 0, liquidity
   delta equal to `LaunchCreated.liquidity`), one `Transfer(0x0, 0x0, sink)`
   (none when the sink is zero),
   `totalSupply == requested` and `balanceOf(address(0)) == sink`, and
   attributes the creator from the periphery's event.
4. Native buys and sells (exact-in and exact-out), and an ERC-20 buy and sell,
   run through `LaunchTestRouter`. These swaps only build the chain's fee and
   claim history; the router-plan tests use real quoter output (below).
5. The owner claims both launches to a recipient, transfers the native launch,
   the old owner's claim reverts `OwnerOnly`, and the new owner claims. The
   chain also refuses a nonzero quote without code (`UnsupportedQuoteToken`),
   the earlier `0x687ba810` create, and a rising fee or a zero duration
   (`InvalidFeeSchedule`), and accepts a create at the maximum fee.
6. Three more launches come from the producer's own create: the reference
   schedule 50% -> 0.3% over 3,600 s (native), the maximum `2^64 - 1` -> 0.3%
   over 3,600 s (native) and flat at the maximum over 1 s (ERC-20), and one
   buy runs on each maximum-fee launch.
7. Two ERC-20 launches (launch token0) whose exact installation differs from
   the shared helper, from the producer's own preview and create: ticks
   `-88080384`/`-85983232`, spacing 524,288, requesting `1e30`, which installs
   liquidity `115073586432` and `999999999991410763432286846442` with a sink
   of `8589236567713153558` raw units (the helper installed `106052588672`
   and sank 7.84%); and the full width at spacing 1 requesting
   `170141183460469231694794709727778658247`, which installs liquidity
   `9223595582101085260` and the whole supply, with no sink mint (the helper
   was one liquidity unit short).

At `43d6628` it wrote `test/fixtures/launchpad/zero-seed-native-local-chain.json` (it
holds all seven launches; sha256 `b917c2b4…9aeba78b5`); two runs on fresh anvil
instances, inside an OS sandbox with no network, produced byte-identical files.
Reproduce:

```sh
anvil --port 8546 --chain-id 31337 --hardfork osaka --timestamp 1800000000 --base-fee 0 --gas-price 0 \
  --gas-limit 60000000 &
EVM_CONTRACTS=<evm-contracts at 43d6628, after forge build> RPC_URL=http://127.0.0.1:8546 \
  bun script/zero-seed-local-chain.ts test/fixtures/launchpad/zero-seed-native-local-chain.json
jq -cS .abi <ZeroSeedLaunch.json> | tr -d '\n' > ext.json
jq -cS .abi <ZeroSeedLaunchPeriphery.json> | tr -d '\n' > per.json
bun script/zero-seed-abi-parity.ts ext.json per.json
bun test test/launchpad
```

What the tests then check from that file: the pin equals the deployment, its
verified runtimes and its block, and equals the indexer's instance; each
artifact and owner summary is reproduced byte for byte; the create calldata
decodes to the requested supply for both quotes; the preview reports
requested, installed and sink exactly (sinks 578 native and 790 ERC-20); the
token, pool id, controller and initial owner equal the creation events, and
`LaunchCreated` decodes strictly (emitter, pair, pool, position, amounts) with
the creator attributed from `LaunchOwnerChanged(poolId, 0x0, owner)`; emitted
fee rates equal the TS schedule; a claim's ledger and payout events report the
same amounts the recipient received, once; ownership transfer moves the claim
right; the chain's refusals (`OwnerOnly`, `InvalidRecipient`, non-payable
value, `TradingNotStarted`, `UnsupportedQuoteToken`, the earlier selector,
`InvalidFeeSchedule`) match the MCP's. For the reference and maximum-fee
launches the owner decoder reproduces each summary from its sealed body, the
create calldata decodes to exactly the requested fees, `LaunchCreated` carries
them, no percentage reads `100.0000%`, the emitted rate at the maximum is
`2^64 - 1`, and an exact-input buy there nets `floor(gross / 2^64)`. For the
two exact token0 launches the preview, the sealed create, the owner summary
and Core's `PositionUpdated` agree on the liquidity, installed supply and sink
exactly, and the summary states that nothing is minted to address(0) when the
sink is zero.

## Backend API v4 (superseded by v5 above)

`src/launchpad/zero-seed/api.ts` consumes `zero-seed-launch-api/v4` of api
`620aa1154e276b829865204ba54bfc54f6c95537`: list (with `owner=` and
`creator=`), detail, swaps, claims and owners; every other schema version is
refused. The tests replay the backend's golden
(`test/fixtures/launchpad/zero-seed-api-v4-620aa11.golden.json`, sha256
`e2c5c070…9362d491`, byte-identical to the API's
`src/routes/launches/fixtures/zero-seed-launch-api-v4.golden.json`): actual
handler output over the indexer's replayed fork-free chain (indexer
`91a7036`, contracts `43d6628`), served by the current local pin. It includes
the low-price and full-width token0 launches at the exact installation and
the two launches created at the maximum fee: l5 (native, `2^64 - 1` -> 0.3%
over 3,600 s) and l6 (ERC-20, flat at `2^64 - 1`). Their detail, swaps,
claims and list rows parse through the client with `initial_fee` and, at
trading start, `fee_rate` exactly `18446744073709551615`; every indexed swap
rate equals the integer schedule at its block, an exact-input buy at the
maximum nets `floor(gross / 2^64)`, and no fee the MCP renders for them reads
100%. Fee fields are any uint64 (at most 20 digits, at most `2^64 - 1`), as
the published schema states; anything above is refused as an invalid
response. The consumed zod schemas equal the `/launches*` response schemas of
`openapi.json` at the same head
(`zero-seed-api-v4-620aa11.openapi-launches.json`, sha256 `721309ef…8dad27c5`,
unchanged since `cf05546`),
and every query parameter the client sends is published there.

The client recomputes, per row: the launch's quote (native is `address(0)`,
token0, 18 decimals, null metadata) and whether it is supported (native, or a
reviewed ERC-20; others are dropped from lists and refused as details), the
pool key and id, the pinned instance (Core, extension and the periphery as
`controller`), the supply split (`0 < installed <= requested`, `sink =
requested - installed`, `sink_holder` `address(0)`), the fee rate and phase
from the fixed-base table at `evaluated_at`, and the position range. For a
detail the computed liquidity is nonzero, the current `owner` must hold the
ledger and each side's accrued must equal claimed plus unclaimed. On complete
history pages, swap fees sum to the accrued amounts, claim rows sum once to the
claimed amounts, and the owner history chains from `null` to `creator` to the
current `owner` with `owner_change_count` entries.

## Real quoter output

This evidence is of the earlier `4f1a306` deployment and is kept as recorded:
the quoter-service updates for `40af6cb`, `550afc4` and `43d6628` are not
consumed here. The swap path did not change (forward payload, router layout, settlement), so the tests
replay every recorded plan against the current pin with only the extension
address substituted, and require the produced calldata to equal the executed
calldata with only that address changed.

`script/zero-seed-quoter-plans.ts` runs the quoter's own LOCAL router harness
(quoter-service `a1ce2ee7a2546a74b7192bb926b3f0531a65b899`,
`tests/local-router`) on the indexer generator's fork-free chain (indexer
`200684630121eef0ce18c649cd5035f9b57cef60`, contracts `4f1a306`). For each of
the 20 guarded responses the quoter produced and executed (native l1, ERC-20
l2 at two blocks, ERC-20 l4; buy and sell; exact-in and exact-out), it builds
the MCP plan with `localSwapFromQuote` at the quote's block and executes it in
a reverted snapshot, once with the quote as the guard and once with a 1%
guard. It records `test/fixtures/launchpad/zero-seed-quoter-plans.json`:

```sh
ZERO_SEED_QUOTER_WORKTREE=<quoter-service at a1ce2ee, cargo deps cached> \
ZERO_SEED_INDEXER_WORKTREE=<indexer at 2006846, bun install run> \
ZERO_SEED_CONTRACTS_WORKTREE=<evm-contracts at 4f1a306, forge build run> \
ZERO_SEED_MCP_WORKTREE=<this repository at 807320c, bun install run> \
ZERO_SEED_SCRATCH_DIR=$(mktemp -d) bun script/zero-seed-quoter-plans.ts
bun test test/launchpad/zero-seed-swap.test.ts
```

The tests check that each plan is reproduced from the recorded quoter
response; with the quote as guard it is byte-identical to the transaction the
quoter's harness executed; the router forwarded exactly the
`abi.encode(PoolKey, SwapParameters)` built from the quoter's hop to the
extension (call trace from Core); the executed deltas equal the quote; the
indexed schedule gives the executed fee rate; native exact-in attaches
the input, native exact-out attaches the maximum and the trader pays exactly
the quote (the 1% plans are refunded the rest), the router keeps no ETH, no
approval and no ERC-20 quote event occurs on native trades, and sells and
ERC-20 inputs carry the router approval.

## NOT PROVEN

- Quoter output and router plans for a `tick_rate_v2` launch: the forward
  payload, router layout and settlement are unchanged at `3d6378f` and the plan
  computes the creator fee with the pin's model, but no quoter response for
  the v2 chain is recorded here (the quoter's own v2 evidence is separate).
- A cloud-wallet decoder replay of the v5 handoff fixture.

- Quoter output and router plans against the `43d6628` instance, at any rate
  including the maximum: the recorded quoter plans are of `4f1a306`, replayed
  with the extension substituted; the local chain's swaps use
  `LaunchTestRouter`, not the 0x03c8 router.
- That a reviewed ERC-20 quote still has its reviewed runtime at preview time:
  the producers resolve the quote from the reviewed list but cannot read the
  quote's codehash through an `eth_call` bundle; only the local harness checks
  it (`verifyQuoteRuntime`). The live list is empty.

- A deployed API or quoter service: the golden is handler output and the
  quotes come from the quoter's serializer in its test harness, both over a
  local replay chain, not HTTP responses from a running service.
- Live or fork execution, a launcher's real deployment, provenance and
  verification, mined UserOps, executable budgets and wallet simulation of
  these calls.
- External security review, parameter selection and approved disclosure copy.

No merge, deploy, signing, funds, credential or publication action is
authorized by this checkpoint.
