# Launchpad (prototype)

Non-production. The tools target evm-contracts `40e5bb1` (PR #380, src tree
`92def448`): `ScheduledLaunch`, `LockedLaunchLiquidity` and the `LaunchRouter`
periphery, next to the deployed Core, TWAMM and Yul router. No launchpad
contract is deployed; the Base manifest below is a proposal. Connect to
`/mcp/launchpad`; the tools are not part of the root `/mcp` bundle. Discovery
is at `/tools?protocol=launchpad`.

## Configuration

| Variable | Meaning |
| --- | --- |
| `LAUNCHPAD_MANIFEST` | The deployment manifest: `chain_id`, `git_revision` (must equal the bundled ABIs' revision) and `contracts.{core,twamm,router,scheduled_launch,locked_launch_liquidity,launch_router}.{address,code_hash}`. `router` is the production Yul router. A `test_quote_token` or a non-null `reference_tier` is refused. |
| `LAUNCHPAD_RPC_URL` | JSON-RPC endpoint of the manifest's chain, for the point reads below. |
| `LAUNCHPAD_API_URL` | Data API serving `/launches` (api PR #191). Defaults to `EKUBO_API_URL`. |
| `LAUNCHPAD_QUOTER_URL` | quoter-service (PR #84). Defaults to `EKUBO_QUOTER_URL`. |

Unset manifest or RPC: every tool returns `launchpad_not_configured`.

Proposed Base manifest (chain 8453), addresses predicted by the EKU-816 dry run
with the default salt: ScheduledLaunch `0x5184f618B2d6cE625d9fDB9770E151a9B84EdB81`,
LockedLaunchLiquidity `0x4B4e88581110396a09E3Bc313199b96Ab1D8ADEA`, LaunchRouter
`0x9dae609a75Ac80BB84448a14823199faC514aeDb`, with Core
`0x00000000000014aA86C5d3c41765bb24e11bd701`, TWAMM
`0xd47f1B1eDCfEaBb08F6eBd8FC337c27E636C75BA` and the Yul router
`0x7B2aA7Ecc0B5936b7C52E6259A19C3BA557d0748`. Code hashes are filled in from the
chain after deployment.

## Tools

| Tool | Data | Plan target |
| --- | --- | --- |
| `launchpad_list_launches` | api `GET /launches` | none |
| `launchpad_get_launch` | api `GET /launches/{chain}/{pool}`; provenance from the chain: the extension's code hash and `LaunchRouter.creator` | none |
| `launchpad_get_stats` | api `GET /launches/{chain}/{pool}/stats` | none |
| `launchpad_get_swaps` | api `GET /launches/{chain}/{pool}/swaps` | none |
| `launchpad_prepare_create` | chain (deployment check) | `LaunchRouter.create(config)`, value 0, no approval |
| `launchpad_prepare_trade` | api (launch), chain (`getLaunch`, `feeAt`), quoter-service (route) | Yul router swap; ERC-20 approval first for a sell |
| `launchpad_prepare_advance` | api (launch), chain (`getLaunch`; Core saved balance once complete) | `ScheduledLaunch.advance(PoolKey)` or `LockedLaunchLiquidity.migrate(launchId)` |
| `launchpad_prepare_claim_fees` | api (launch), chain (`getLaunch`, `LaunchRouter.creator`, `claimFees` from the sender) | `LaunchRouter.claimFees(PoolKey, recipient)`, creator only |

There is no fund tool.

A launch is named by its exact token address or pool id, never by name or
symbol. The api has no token filter, so a token lookup pages `/launches`
(200 per page, at most 10 pages).

### Hosted rules

- Quote asset: native ETH only.
- Fees: initial at most 10%, final at most 1%, never increasing.
- Migration bounds at most 693,147 ticks wide (just under 2x). The contract's
  ceiling of 2,302,585 is not offered.
- Creation always goes through `LaunchRouter.create`, never a direct
  `LAUNCH_CREATE` forward. The router records the signer as creator, the only
  account that can claim creator fees; `LaunchCreated.owner` is never used for
  attribution.
- Every create output carries `reference: null`.

### Deployment check

Before any plan, each preparation call reads at one pinned block the runtime
code of all six manifest addresses and compares its keccak256 with the
manifest, then reads back `ScheduledLaunch.LIQUIDITY()`, `ScheduledLaunch.TWAMM()`,
`LaunchRouter.EXTENSION()`, `LaunchRouter.LIQUIDITY()` and
`LockedLaunchLiquidity.EXTENSION()`. Any mismatch is `deployment_mismatch`.

### Trades

`launchpad_prepare_trade` asks quoter-service for the pair and amount and
encodes the answer with `prepareSwapFromQuote`, the same path as
`get_quotes_with_plans`, for the manifest's Yul router. A launch-pool hop must
be a forwarded hop whose forwardee is the manifest's ScheduledLaunch. When the
quoter marks a single hop `allow_partial` and fills less than requested, the
route specifies only the filled amount and the output warns `partial_fill`.

### Requests per call

No tool reads logs. Counts per call, measured on the anvil fork:

| Tool | JSON-RPC | api | quoter |
| --- | --- | --- | --- |
| `launchpad_prepare_create` | 1 `eth_getBlockByNumber`, 6 `eth_getCode`, 5 `eth_call` | 0 | 0 |
| `launchpad_prepare_trade` | 1, 6, 7 `eth_call` (6 after completion) | 2 by token | 1 |
| `launchpad_prepare_advance` (advance) | 1, 6, 6 `eth_call` | 2 | 0 |
| `launchpad_prepare_advance` (migrate) | 1, 6, 6 `eth_call`, 1 `eth_getStorageAt` | 2 | 0 |
| `launchpad_prepare_claim_fees` | 1, 6, 8 `eth_call` | 2 | 0 |
| `launchpad_get_launch` | 1, 1 `eth_getCode`, 1 `eth_call` | 2 by token, 1 by pool id | 0 |
| list, stats, swaps | 0 | 1 to 2 | 0 |

### Anvil test

`test/launchpad/anvil.test.ts` runs create, buy, claim, advance and migrate
against a local fork from evm-contracts `script/launchpad-local.sh`
(`KEEP_ANVIL=1`), standing in for the api and quoter-service in their
documented shapes. Set `LAUNCHPAD_ANVIL_RPC` and `LAUNCHPAD_ANVIL_MANIFEST`.
