---
name: use-lido
description: Discover current Lido staking, token conversion, and withdrawal-queue state directly through official Lido documentation and the user's wallet, then prepare staking, wrapping, unwrapping, withdrawal-request, or claim plans through the Ekubo MCP. Use for stETH, wstETH, unstETH, staking, and protocol withdrawals. Never route live protocol data through the Ekubo MCP.
---

# Use Lido

Separate immediate token operations from Lido's asynchronous withdrawal queue, and bind every action to fresh wallet reads.

## Workflow

1. Read `references/discovery.md`.
2. Call `get_lido_deployment`. Require Ethereum chain 1 and exact matches for stETH, wstETH, and WithdrawalQueueERC721.
3. Use official Lido docs and the user's wallet/RPC directly for all changing state. The Ekubo MCP must not relay or cache it.
4. Confirm the requested operation and amount:
   - stake native ETH for stETH;
   - wrap stETH into non-rebasing wstETH;
   - unwrap wstETH into rebasing stETH;
   - request an asynchronous protocol withdrawal from stETH;
   - claim a finalized unstETH request.
5. Perform the operation-specific reads below, show material consequences, then call the matching `prepare_lido_*` tool.
6. Pass `execution_plan_reference` unchanged to the wallet. Require exact simulation before authorization.

## Operation-specific gates

- Stake: read `isStakingPaused()` and `getCurrentStakeLimit()` from stETH. Stop if paused or the amount exceeds the current limit.
- Wrap/unwrap: read the corresponding stETH/wstETH conversion and the user's balance. Explain rebasing stETH versus non-rebasing wstETH.
- Request withdrawal: each stETH request must be 100 wei through 1000 stETH. Explain that the action is irreversible, mints an unstETH NFT, is not immediately claimable, stops earning rewards while queued, and can settle below 1:1 after extraordinary losses.
- Claim: read `ownerOf(requestId)` and `getWithdrawalStatus([requestId])`. Proceed only when sender owns it and it is finalized and unclaimed.

Default NFT owner and recipients to the connected sender. Use a referral or different owner only when the user explicitly supplies it. Never infer addresses from local state.
