---
name: use-morpho
description: Discover current Morpho Vault V2 opportunities directly through Morpho's public API and the user's wallet, then prepare guarded deposit, withdraw, or redeem plans through the Ekubo MCP. Use for Morpho vault discovery, APY or liquidity comparisons, deposits, and exits. Never route live protocol data through the Ekubo MCP.
---

# Use Morpho

Discover live state yourself, bind it to the MCP's fixed deployment catalog, and let the wallet validate the exact plan.

## Workflow

1. Read `references/discovery.md` before querying Morpho.
2. Query `https://api.morpho.org/graphql` directly for Vault V2 discovery. Do not ask the Ekubo MCP to fetch, relay, cache, or authenticate this request.
3. Call `get_morpho_vaults`, then keep only a live result whose chain ID, vault address, and asset address exactly match one returned fixed entry. Reject warnings, delisted vaults, asset mismatches, or unsupported chains.
4. Use the user's wallet/RPC and the official Morpho SDK for current vault accounting. Treat GraphQL as discovery, not execution state.
5. Confirm the user's exact asset amount or share amount, chain, vault, recipient, and whether this is a deposit, exact-asset withdrawal, or exact-share redemption.
6. For deposits, derive `max_share_price_ray` from fresh onchain `vaultData` and the user's slippage tolerance through the official SDK. Never guess it, use an APY as a substitute, or set an unbounded value. Keep tolerance at or below the SDK's 10% cap; prefer its 0.03% default unless the user chooses otherwise.
7. Call the matching `prepare_morpho_vault_*` tool. Do not copy executable calldata from GraphQL or another website.
8. Pass the returned `execution_plan_reference` unchanged to the wallet. Require exact simulation against the connected chain/account immediately before authorization.

## Action choice

- Deposit assets: `prepare_morpho_vault_deposit`. This uses Bundler3 through GeneralAdapter1 and enforces the supplied maximum share price onchain.
- Withdraw an exact asset amount: `prepare_morpho_vault_withdraw`.
- Exit by exact shares, especially a full balance: `prepare_morpho_vault_redeem`.

Default `recipient` and `owner` to the connected sender. Use another address only when the user explicitly names it. Never infer an address from local files, environment variables, or browsing history.

## Safety gates

- Stop if live vault identity does not match the fixed catalog.
- Stop if the wallet cannot obtain fresh vault state or simulate the whole atomic plan.
- Explain curator and allocation risk; APY is variable and is not a guarantee.
- Re-discover and re-prepare after a revert or stale quote. Never retry reverted calldata unchanged.
