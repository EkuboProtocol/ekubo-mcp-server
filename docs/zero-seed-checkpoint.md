# Zero-seed MCP checkpoint — not a handoff

Local only. Release HOLD. Every hosted tool refuses; the live pin list is empty.

## Basis

evm-contracts `4f1a3060b099e8a50469848118f44c0c65cfab9a`: extension ABI
SHA-256 `21f9e2c0…a544254e`, periphery ABI SHA-256 `5c563488…d08a75`
(`jq -cS .abi`, no trailing newline), runtime templates `0x25637ad2…` and
`0x271683d2…`, MintableERC20 init code `0x25da7fd3…` (unchanged).
`test/fixtures/launchpad/zero-seed-interface-4f1a306.json` holds the fields of
the interface manifest this code consumes; `zero-seed-fee-decay-vectors.json`
holds the protocol generator's independent fee vectors.

## Local chain

`script/zero-seed-local-chain.ts` drives a fresh anvil chain from the compiled
`4f1a306` artifacts:

1. Core is built locally and placed at its canonical address (runtime hash
   equal to Base Core, `0xc5f90c9d…`); the Base 0x03c8 Yul router and the Base
   WETH9 runtimes are etched from the evm-contracts fixtures.
2. A launcher deploys, for a native quote and for a WETH quote, the extension
   through the CREATE2 deployer at the first salt whose address starts with
   `0x51`, then its periphery. `runtime.ts` verifies both runtimes and every
   immutable before the pins are accepted.
3. The MCP preview, create producer and owner decoder run over that chain; the
   exact `create` they produced executes from the owner.
4. Native buys and sells (exact-in and exact-out) and an ERC-20 buy run from
   router quotes read at block S, shaped as the quoter's response, through the
   MCP router plan, executed in a later block at the same timestamp. These
   swaps only build the chain's fee and claim history; the router-plan tests
   use real quoter output (below).
5. The owner claims to a recipient, transfers the launch, the old owner's
   claim reverts `OwnerOnly`, and the new owner claims.

It writes `test/fixtures/launchpad/zero-seed-native-local-chain.json`; two
runs produced byte-identical files. Reproduce:

```sh
anvil --port 8546 --chain-id 31337 --timestamp 1800000000 --base-fee 0 --gas-price 0 &
EVM_CONTRACTS=<evm-contracts at 4f1a306, after forge build> RPC_URL=http://127.0.0.1:8546 \
  bun script/zero-seed-local-chain.ts test/fixtures/launchpad/zero-seed-native-local-chain.json
jq -cS .abi <ZeroSeedLaunch.json> | tr -d '\n' > ext.json
jq -cS .abi <ZeroSeedLaunchPeriphery.json> | tr -d '\n' > per.json
bun script/zero-seed-abi-parity.ts ext.json per.json
bun test test/launchpad
```

What the tests then check from that file: the pins equal the deployment and
its verified runtimes; each artifact and owner summary is reproduced byte for
byte; the token, pool id, controller and initial owner equal the creation
events; native exact-in attaches exactly the input, native exact-out attaches
the maximum input and is refunded to the quoted input, the router keeps no
ETH, and sells need only the launch token's approval; emitted fee rates and
amounts equal the TS schedule; a claim's ledger and payout events report the
same amounts the recipient received, once; ownership transfer moves the claim
right; the chain's refusals (`OwnerOnly`, `InvalidRecipient`, non-payable
value, `TradingNotStarted`) match the MCP's.

## Backend API v3

`src/launchpad/zero-seed/api.ts` consumes `zero-seed-launch-api/v3` of api
`242954777a575431c79138114c22857202adcbc9` (the final head of the backend PR):
list (with `owner=` and `creator=`), detail, swaps, claims and owners. The
tests replay the backend's golden
(`test/fixtures/launchpad/zero-seed-api-v3-2429547.golden.json`, sha256
`edb0a36f…0ca516`, byte-identical to the API's
`src/routes/launches/fixtures/zero-seed-launch-api-v3.golden.json`): actual
handler output over the indexer's replayed fork-free chain. The consumed zod
schemas equal the `/launches*` response schemas of `openapi.json` at the same
head (`zero-seed-api-v3-2429547.openapi-launches.json`), and every query
parameter the client sends is published there.

The client recomputes, per row: quote kind (native is `address(0)`, token0,
18 decimals, null metadata), the pool key and id, the pinned instance (Core,
extension, quote and kind, and the periphery as `controller`), the fee rate
and phase from the fixed-base table at `evaluated_at`, and the position range.
For a detail the current `owner` must hold the ledger and each side's accrued
must equal claimed plus unclaimed. On complete history pages, swap fees sum
to the accrued amounts, claim rows sum once to the claimed amounts, and the
owner history chains from `null` to `creator` to the current `owner` with
`owner_change_count` entries.

These launches are on the indexer generator's chain, so
`BACKEND_REPLAY_PINS` pins the same two extensions with that chain's
peripheries; every runtime equals the MCP local chain's.

## Real quoter output

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
ZERO_SEED_SCRATCH_DIR=$(mktemp -d) bun script/zero-seed-quoter-plans.ts
bun test test/launchpad/zero-seed-swap.test.ts
```

The tests check that each plan is reproduced from the recorded quoter
response; with the quote as guard it is byte-identical to the transaction the
quoter's harness executed; the router forwarded exactly the
`abi.encode(PoolKey, SwapParameters)` built from the quoter's hop to the
extension (call trace from Core); the executed deltas equal the quote; the
API's indexed schedule gives the executed fee rate; native exact-in attaches
the input, native exact-out attaches the maximum and the trader pays exactly
the quote (the 1% plans are refunded the rest), the router keeps no ETH, no
approval and no ERC-20 quote event occurs on native trades, and sells and
ERC-20 inputs carry the router approval.

## NOT PROVEN

- A deployed API or quoter service: the golden is handler output and the
  quotes come from the quoter's serializer in its test harness, both over a
  local replay chain, not HTTP responses from a running service.
- Live or fork execution, a launcher's real deployment, provenance and
  verification, mined UserOps, executable budgets and wallet simulation of
  these calls.
- External security review, parameter selection and approved disclosure copy.

No merge, deploy, signing, funds, credential or publication action is
authorized by this checkpoint.
