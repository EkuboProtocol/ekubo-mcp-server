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
   MCP router plan, executed in a later block at the same timestamp.
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

## NOT PROVEN

- The indexed launch API and the quoter for this contract version: no real API
  or quoter output has been consumed. The router quote stands in for the
  quoter locally; final integration needs the real responses.
- Live or fork execution, a launcher's real deployment, provenance and
  verification, mined UserOps, executable budgets and wallet simulation of
  these calls.
- External security review, parameter selection and approved disclosure copy.

No merge, deploy, signing, funds, credential or publication action is
authorized by this checkpoint.
