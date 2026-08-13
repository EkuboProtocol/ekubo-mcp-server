# Lido direct discovery

Canonical documentation:

- Current Ethereum deployment addresses: <https://docs.lido.fi/deployed-contracts/>
- stETH staking contract and live limit views: <https://docs.lido.fi/contracts/lido/>
- Withdrawal queue semantics and ABI: <https://docs.lido.fi/contracts/withdrawal-queue-erc721/>
- Token integration guidance: <https://docs.lido.fi/guides/lido-tokens-integration-guide/>

Use the user's wallet/RPC for current reads:

- stETH: `isStakingPaused()`, `getCurrentStakeLimit()`, balances, and allowances.
- wstETH: `getWstETHByStETH(stETHAmount)`, `getStETHByWstETH(wstETHAmount)`, and balances.
- Withdrawal queue: `getWithdrawalRequests(owner)`, `getWithdrawalStatus(requestIds)`, `ownerOf(requestId)`, and optionally `getClaimableEther` with valid hints.

The simple `claimWithdrawal(requestId)` method needs no caller-supplied checkpoint hint, but still requires a request owned by the sender that is finalized and unclaimed. Report the observation block/time and never use calldata returned by a website or analytics API.
