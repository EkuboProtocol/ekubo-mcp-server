---
name: use-sky
description: Discover current Sky Savings USDS state directly through official Sky documentation and the user's wallet, then prepare sUSDS deposit, withdrawal, or redemption plans through the Ekubo MCP. Use for Sky savings-rate questions and USDS/sUSDS actions. Never route live protocol data through the Ekubo MCP.
---

# Use Sky

Use the MCP only for its fixed deployment and transaction constructor. Obtain all changing state directly.

## Workflow

1. Read `references/discovery.md`.
2. Call `get_sky_savings_deployment` and require Ethereum chain 1 with the exact returned USDS and sUSDS addresses.
3. Consult official Sky documentation directly and use the user's wallet/RPC to read current ERC-4626 state. The Ekubo MCP must not proxy these requests.
4. Confirm whether the user wants to deposit an exact USDS amount, withdraw an exact USDS amount, or redeem an exact sUSDS share amount. Confirm receiver and owner when they differ from the sender.
5. Read the matching `previewDeposit`, `previewWithdraw`, or `previewRedeem` result at a recent block and show the expected shares/assets. Also read the matching `max*` limit and balances.
6. Call the matching `prepare_sky_savings_*` tool.
7. Pass `execution_plan_reference` unchanged to the wallet and require fresh simulation immediately before authorization.

## Important limitation

The canonical direct ERC-4626 methods have no deadline or minimum-output argument. A preview does not bind execution. Keep the discovery-to-signing interval short and rely on exact wallet simulation; stop if the simulated result materially differs from what the user reviewed.

Default receiver and owner to the connected sender. Never infer wallet addresses from machine state.
