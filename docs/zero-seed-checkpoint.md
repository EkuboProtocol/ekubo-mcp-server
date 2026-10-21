# Zero-seed MCP checkpoint — not a handoff

Local only. Release HOLD. Every hosted tool refuses; the live pin list is empty.

## Basis

evm-contracts `40af6cb359b0de2f61f15e47b6622a00c48b5b08` (tree `f9925da3…`):
extension ABI SHA-256 `999068f8…48fcd4bf`, periphery ABI SHA-256
`df24d9f0…bebe7305` (`jq -cS .abi`, no trailing newline), runtime templates `0x39a99e30…` and `0x08216f69…`, MintableERC20
init code `0x25da7fd3…` (unchanged). The extension's constructor is `(core)`;
the quote is `LaunchParameters.quoteToken`, per launch.
`test/fixtures/launchpad/zero-seed-interface-40af6cb.json` is the canonical
interface manifest (`manifest_sha256` `5eb115a6…74079dcb`), vendored verbatim;
`zero-seed-fee-decay-vectors.json` holds the protocol generator's independent
fee vectors (the fee table is unchanged).

## Local chain

`script/zero-seed-local-chain.ts` drives a fresh anvil chain from the compiled
`40af6cb` artifacts:

1. Core's runtime is placed at its canonical address (runtime hash equal to
   Base Core, `0xc5f90c9d…`) and the checkout's plain 18-decimal
   `test/TestToken.sol` runtime at `0xff…ff` (runtime `0xe8ccd7c4…`, the one
   reviewed local ERC-20 quote). Block 1 deploys `test/LaunchTestRouter.sol`.
2. Block 2 deploys, through the CREATE2 deployer, the one extension at the
   first salt whose address starts with `0x51` and its periphery at salt 0,
   exactly as the indexer's replay generator does, so both chains share the
   one pin (extension `0x519ddb65…3ef34`, periphery `0x094511cf…111b4`).
   `runtime.ts` verifies both runtimes and every immutable before the pin is
   accepted.
3. The MCP preview, create producer and owner decoder run over that chain for
   a native-ETH launch (launch token1) and a test-ERC-20 launch (launch
   token0), each requesting `1e27`; the exact `create` they produced, carrying
   the requested supply, executes from the owner. The script checks Core's
   `PositionUpdated` against the installed supply (quote side 0, liquidity
   delta equal to `LaunchCreated.liquidity`), one `Transfer(0x0, 0x0, sink)`,
   `totalSupply == requested` and `balanceOf(address(0)) == sink`, and
   attributes the creator from the periphery's event.
4. Native buys and sells (exact-in and exact-out), and an ERC-20 buy and sell,
   run through `LaunchTestRouter`. These swaps only build the chain's fee and
   claim history; the router-plan tests use real quoter output (below).
5. The owner claims both launches to a recipient, transfers the native launch,
   the old owner's claim reverts `OwnerOnly`, and the new owner claims. The
   chain also refuses a nonzero quote without code (`UnsupportedQuoteToken`)
   and the earlier `0x687ba810` create.

It writes `test/fixtures/launchpad/zero-seed-native-local-chain.json` (it now
holds both launches; sha256 `fb4373ab…45413`); two runs on fresh anvil
instances produced byte-identical files. Reproduce:

```sh
anvil --port 8546 --chain-id 31337 --hardfork osaka --timestamp 1800000000 --base-fee 0 --gas-price 0 \
  --gas-limit 60000000 &
EVM_CONTRACTS=<evm-contracts at 40af6cb, after forge build> RPC_URL=http://127.0.0.1:8546 \
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
value, `TradingNotStarted`, `UnsupportedQuoteToken`, the earlier selector)
match the MCP's.

## Backend API v4

`src/launchpad/zero-seed/api.ts` consumes `zero-seed-launch-api/v4` of api
`8f18246a4904a43fa758bcd8aa2aae84def6c810`: list (with `owner=` and
`creator=`), detail, swaps, claims and owners; every other schema version is
refused. The tests replay the backend's golden
(`test/fixtures/launchpad/zero-seed-api-v4-8f18246.golden.json`, sha256
`0f808cd6…e8381186`, byte-identical to the API's
`src/routes/launches/fixtures/zero-seed-launch-api-v4.golden.json`): actual
handler output over the indexer's replayed fork-free chain (indexer
`d783593`). The consumed zod schemas equal the `/launches*` response schemas
of `openapi.json` at the same head
(`zero-seed-api-v4-8f18246.openapi-launches.json`), and every query parameter
the client sends is published there.

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
the quoter-service update for `40af6cb` is not consumed here. The swap path
did not change (forward payload, router layout, settlement), so the tests
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

- Quoter output and router plans against the `40af6cb` instance: the recorded
  quoter plans are of `4f1a306`, replayed with the extension substituted; the
  local chain's swaps use `LaunchTestRouter`, not the 0x03c8 router.
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
