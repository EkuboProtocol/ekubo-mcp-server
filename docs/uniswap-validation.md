# Uniswap validation — 2026-09-09

Account: `testing`, `0x2271161c21145065B7ca3cDd51e5Ecbcb1eE8Ba4`.

All 23 transactions below were simulated through Ekubo Wallet, authorized by its existing policy, and confirmed with successful finalized receipts. Tests used the account’s existing ETH on Base and Arbitrum; no bridge was necessary. Setup swapped 0.0001 ETH to USDC per chain. Liquidity deposits were roughly 0.00001 ETH or less plus USDC and were fully withdrawn.

| Chain | Operation | Transaction |
| --- | --- | --- |
| Base | baseSwap | [0xf82ec252bc…](https://basescan.org/tx/0xf82ec252bcf7900f9901feabf0cea65191e9d74e6675cb7c4de0f5be7f8387f0) |
| Base | baseV3Mint | [0x158175d69b…](https://basescan.org/tx/0x158175d69b76afc3f5a1a0d1600d5d643e73c43cd698cf911b432985ae45dc29) |
| Base | baseV3Collect | [0xc0b8725daf…](https://basescan.org/tx/0xc0b8725dafc3b192c1a5f5e769a1da616af53a0cd9d16855c99c18aebe89d5b2) |
| Base | baseV3Increase | [0x43ba95996d…](https://basescan.org/tx/0x43ba95996d4876d56558bf6889c6272f766a049dc5e096546bc64379ceca72da) |
| Base | baseV3Remove | [0x07cab80fde…](https://basescan.org/tx/0x07cab80fde9e5aec62939c8d435be50efcd1eaff6d935a4ddd3d5c10e739b7d0) |
| Base | baseV2Mint | [0x1bc2c23b7d…](https://basescan.org/tx/0x1bc2c23b7de048865a10323acf32b24bdb8aa548badfb03dd55f289d79b44f8f) |
| Base | baseV2Remove | [0x6a9ed30d99…](https://basescan.org/tx/0x6a9ed30d996d3f03e5fe52527074af2208ea059654e49158597f023c514ef654) |
| Base | baseV4Mint | [0x41012d59b4…](https://basescan.org/tx/0x41012d59b48d0ddf136aa123dcc6b7f377b7fb8711a955157711a137db79a70d) |
| Base | baseV4Increase | [0x1e84bcdee7…](https://basescan.org/tx/0x1e84bcdee7b4ccce24778296d821658d4b08993a7b669f765a5dc32458f82669) |
| Base | baseV4Collect | [0x3fc36d52c7…](https://basescan.org/tx/0x3fc36d52c74226b709b5391af2c2f76b63cfa1ce88f1c37bdbb316248892eba5) |
| Base | baseV4RemoveHalf | [0x1965ebd92d…](https://basescan.org/tx/0x1965ebd92debc81f1999d124079377c1fb5ac1669f5c944d342acc7763e296a4) |
| Base | baseV4Remove | [0x41eb0e15ec…](https://basescan.org/tx/0x41eb0e15ecf0a56c6d7f5944fc13b0568000f1a05fbddd3d5c05da3518e2752c) |
| Arbitrum | arbSwap | [0x2fd1b615bc…](https://arbiscan.io/tx/0x2fd1b615bca3dd75632b961576bac5d79b09601869dfdd93638625b297aa256f) |
| Arbitrum | arbV4Mint | [0x1fb938bb97…](https://arbiscan.io/tx/0x1fb938bb97b4c12258d8fd658854b035a1c1b1e5e322431aca8e63d920db6d64) |
| Arbitrum | arbV4Increase | [0x3fe846a5a4…](https://arbiscan.io/tx/0x3fe846a5a4047d5636c2c7363ac9021feeeb7e5b8694a419914fd7eaeea6f374) |
| Arbitrum | arbV4Collect | [0xc094a246d9…](https://arbiscan.io/tx/0xc094a246d953c5271f679d89f219331ef5d6df85a3450ebf3ba32dcee17c1659) |
| Arbitrum | arbV4Remove | [0xd6f7fbf234…](https://arbiscan.io/tx/0xd6f7fbf2340af0b6d2d5bc859d6c922c048c81d102b8842f027bc150ff654d48) |
| Arbitrum | arbV3Mint | [0x810d64c40b…](https://arbiscan.io/tx/0x810d64c40b87e46f04182dc41198e23be24545a2b9adc915dfd7ca9700de52a8) |
| Arbitrum | arbV3Increase | [0x013a6b3326…](https://arbiscan.io/tx/0x013a6b33264670badc5a287f4408c85c7341baf2ae84ee9ebae927551c545f4b) |
| Arbitrum | arbV3Collect | [0xa49524f5ed…](https://arbiscan.io/tx/0xa49524f5ede9ea418c23d03705a2bebca19a50562d8089977a37a4a989d36250) |
| Arbitrum | arbV3Remove | [0x109984006d…](https://arbiscan.io/tx/0x109984006dbd627dbaa63bee4f8fdbf540babed6686b3b13f55f28a639a976d0) |
| Arbitrum | arbV2Mint | [0x3b903a6e16…](https://arbiscan.io/tx/0x3b903a6e165b8d4d07cf6359cb740d0eeeda18fc8658871cebbaf178a68bdf38) |
| Arbitrum | arbV2Remove | [0x4522ac9067…](https://arbiscan.io/tx/0x4522ac906799f5e810b80e39c8b805df022947dd89cd40773d5d32b7f5c3b0a1) |

## Coverage

- V2 on both chains: native ETH + USDC deposit, exact LP withdrawal, native unwrapping and LP allowance cleanup.
- V3 on both chains: mint, increase, fee claim, full withdrawal, native unwrapping and NFT burn. Base fee collection returned nonzero ETH fees; the Arbitrum fee-only claim returned zero at execution and withdrawal later collected accrued amounts.
- V4 on both chains: mint, increase, fee claim, full withdrawal and burn. Base additionally exercised an exact partial decrease before burning the remainder. Base fee collection returned nonzero ETH fees; the low-liquidity Arbitrum test pool had no fees to collect.
- V4 Base used the indexed ETH/USDC pool ID `0xe070797535b13431808f8fc81fdbe7b41362960ed0b55bc2b6117c49c51b7eb9` with immutable fee 3000. Arbitrum used existing ETH/USDC fee-625 pool `0xda07cfebdfb3164fa2c7aa4110cc8b5917f003e8a6fa8b077e15635d9782876b`. The latter differs from the displayed fee-625 indexed pool, whose immutable fee is 500; this finding drove the mandatory pool-ID hash check and discovery key resolution.
- Only Base and Arbitrum received live transaction tests. Ethereum, Optimism, Unichain and Robinhood have pinned deployment configuration; no claim is made of live transaction coverage there.

## Final chain state

After the final receipts, wallet reads confirmed:

- Base/Arbitrum V2 LP balances and router allowances: zero.
- Base V3 NFT `5959871` and Arbitrum V3 NFT `5687386`: burned, ownerOf reverts, testing-wallet NFT balances zero.
- Base V4 NFT `3030379` and Arbitrum V4 NFT `203369`: burned, ownerOf reverts, liquidity zero.
- Tested USDC/WETH ERC20 allowances and V4 Permit2 allowance amounts: zero. Permit2 treats expiration zero as the current timestamp; the remaining timestamp does not grant an allowance.

## Public API checks

`bun script/uniswap-data-smoke.ts` fetched discovery, details, price/volume history and V3/V4 depth ticks across both chains and all three versions. Responses contained nonempty volume series in all six cases. Five initial price series were nonempty; Base V3’s first pool returned a field-level upstream price-history error while volume and ticks remained available. A second Base V3 pool (`0x8c7080564B5A792A33Ef2FD473fbA6364d5495e5`) returned 168 price points and 28 volume points without errors. The tool exposes partial errors without fabricating a replacement series.

## Regression checks

`bun test`, `bun run lint`, `bun run build`, and `bun run check` are required. The tests exercise wallet artifact validation and an actual MCP tools/call → artifact fetch, not just local calldata helpers. Unit regressions cover V4 display-fee/key mismatches, packed signed ticks, explicit full-burn semantics, stale deadlines, amount overflow, invalid ranges, native refunds and both approval layers.

Recorded receipt gas fees on chain 8453: 0.000013687927429279 ETH (receipt gas_used × effective_gas_price; rollup-specific extra fee accounting may differ).

Recorded receipt gas fees on chain 42161: 0.000059942856896 ETH (receipt gas_used × effective_gas_price; rollup-specific extra fee accounting may differ).

## Robinhood (4663)

Robinhood uses the V2/V3/V4 addresses and WETH from the pinned SDK and the interface API's `ROBINHOOD` chain enum. Regression coverage checks all three add-liquidity transaction targets and the canonical V2 WETH/USDG pair derivation.

Live wallet reads succeeded for V2 WETH/USDG reserves, supply and factory; V3 WETH/USDG canonical pool, price, liquidity, fee and tick spacing; and V4 WETH/STATICS pool state and position-manager counter. No Robinhood transactions were submitted.

Public API checks returned V2 price/volume history (100/17 points), V3 price/volume history (168/28 points) and 100 depth ticks, and V4 price history (116 points) and 64 depth ticks. V4 volume fields returned explicit upstream errors. V3 discovery returned a pool with `first: 2`, but a subsequent `first: 10` request returned no pools, causing the strict smoke test to fail; direct pool queries still succeeded. Indexed data availability is therefore partial and can vary by request. Run the chain-specific smoke check with `bun script/uniswap-data-smoke.ts 4663`.
