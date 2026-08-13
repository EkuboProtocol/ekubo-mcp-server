# Morpho direct discovery

Use the official documentation at <https://docs.morpho.org/developers/api/get-started/> and send GraphQL requests directly to `https://api.morpho.org/graphql`.

An initial Vault V2 query can request:

```graphql
query VaultV2Discovery($chainIds: [Int!]!) {
  vaultV2s(first: 100, where: { chainId_in: $chainIds }) {
    items {
      address
      name
      symbol
      listed
      asset { address symbol decimals }
      chain { id network }
      totalAssets
      totalSupply
      totalAssetsUsd
      liquidity
      netApy
      warnings { type }
    }
  }
}
```

Use variables such as `{"chainIds":[1,8453]}`. Inspect the live schema if a field changes instead of inventing a response shape.

For a deposit bound, use current onchain vault data with `@morpho-org/morpho-sdk`, not the indexed totals alone. The high-level Vault V2 deposit builder forward-accrues the vault state and computes the guarded `maxSharePrice`; the built transaction's typed action exposes that value as `action.args.maxSharePrice`. Pass its decimal string to `prepare_morpho_vault_deposit`. The MCP reconstructs the official guarded route from its pinned SDK and fixed catalog.

Before wallet authorization, recheck the vault asset, listing/warnings, user balance, allowance, and exact transaction simulation. Report the observation time and block where available.
