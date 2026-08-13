# Sky direct discovery

Canonical documentation:

- sUSDS behavior and deployment: <https://developers.skyeco.com/protocol/tokens/susds/>
- Active protocol deployment navigator: <https://developers.skyeco.com/quick-start/protocol-navigator/?group=all&module=susds&status=active>

On Ethereum, cross-check the fixed MCP result, then use the user's wallet/RPC to call the sUSDS ERC-4626 views directly:

- `asset()` must equal the fixed USDS address.
- `totalAssets()` and `totalSupply()` describe current vault accounting.
- `convertToShares(assets)` and `convertToAssets(shares)` provide conversions.
- `previewDeposit`, `previewWithdraw`, and `previewRedeem` estimate the selected action.
- `maxDeposit(receiver)`, `maxWithdraw(owner)`, and `maxRedeem(owner)` enforce current limits.
- Read USDS/sUSDS balances and relevant allowances for the connected account.

Use official Sky sources for product semantics. Treat any UI, explorer, or analytics output as secondary, and never use its calldata. Report the block number and observation time when available.
