# EVM interface transaction parity

Audited against `ekubo/interface` commit `a5e285a0b` on 2026-08-02. The MCP
server is EVM-only; this matrix covers every EVM transaction submission path in
the interface. Starknet interface transactions are outside this server's chain
model and are not claimed here.

The invariant for every prepare tool is the same: the response supplies exact
calldata, native value, approvals, multicalls, and the complete ordered list of
top-level transactions. A wallet may validate, simulate, sign, and submit that
list, but must not construct calls or decide what transactions belong in it.

| Interface source                                                              | Action                                                         | MCP coverage                                                         |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `useEvmSwapMainAction.ts`                                                     | Ekubo/0x/Across swap or bridge                                 | `prepare_swap`                                                 |
| `useEvmSwapMainAction.ts`                                                     | Direct WETH wrap/unwrap                                        | `prepare_wrap_unwrap`                                          |
| `EvmCreatePosition.tsx`, `useDepositLiquidity.ts`                             | Initialize pool, mint position, deposit, refund native token   | `prepare_lp_position_deposit`                                  |
| `EvmManagePosition.tsx`                                                       | Add liquidity                                                  | `prepare_lp_position_deposit`                                  |
| `EvmManagePosition.tsx`, `useWithdrawLiquidityWrite.ts`                       | Partial/full withdrawal plus fees/rewards                      | `prepare_lp_position_withdraw`                                 |
| `EvmManagePosition.tsx`                                                       | Transfer LP NFT                                                | `prepare_lp_position_transfer`                                 |
| Position earnings controls                                                    | Collect LP fees or Ve33 rewards                                | `prepare_lp_position_earnings_claim`                           |
| `EvmFixPrice.tsx`                                                             | Read current price, quote, approve, execute target-price route | `prepare_fix_pool_price`                                       |
| `useEvmDcaCreateOrderData.ts`, `useCreateTwammOrderCall.ts`, `EvmAuction.tsx` | Create DCA/TWAMM order or join auction                         | `prepare_twamm_order`                                          |
| `useWithdrawProceeds.ts`                                                      | Collect TWAMM proceeds                                         | `prepare_twamm_order_collection`                               |
| `useStopTwammOrder.ts`                                                        | Collect proceeds and stop active TWAMM sale rates              | `prepare_twamm_order_stop`                                     |
| `useExecuteTwammVirtualOrders.ts`                                             | Permissionless virtual-order execution                         | `prepare_twamm_virtual_orders`                                 |
| `EvmCreateAuction.tsx`, `useCreateAuctionCall.ts`                             | Create auction                                                 | `prepare_auction_create`                                       |
| `EvmAuction.tsx`                                                              | Complete auction and optionally initialize graduation pool     | `prepare_auction_complete`                                     |
| `EvmAuction.tsx`                                                              | Collect creator proceeds                                       | `prepare_auction_creator_proceeds`                             |
| `EvmManualBoost.tsx`                                                          | Approve and boost a pool                                       | `prepare_manual_pool_boost`                                    |
| `EvmOracleCapacity.tsx`                                                       | Expand oracle capacity                                         | `prepare_oracle_capacity_expansion`                            |
| `EvmRevokeApprovals.tsx`                                                      | Revoke one or many ERC-20 approvals                            | `prepare_approval_revocations`                                 |
| `UnwrapOldGekubo.tsx`                                                         | Approve and route old gEKUBO unwrap                            | `prepare_old_gekubo_unwrap`                             |
| `useEvmRewardsClaims.ts`                                                      | Claim one reward or aggregate independent claims               | `prepare_rewards_claim`                                        |
| `EvmClaimRecoveryFund.tsx`                                                    | Sign conditions and claim Recovery Fund tokens                 | `prepare_recovery_fund_claim`                                  |
| `EvmRevenueBuybacks.tsx`                                                      | Collect ended orders, withdraw protocol fees, and roll tokens  | `prepare_revenue_buybacks`                                     |
| `EvmVeStonx.tsx`                                                              | Create a new stake                                             | `prepare_ve33_stake`                                           |
| `EvmVeStonx.tsx`                                                              | Increase an existing stake                                     | `prepare_ve33_increase_stake`                                  |
| `EvmVeStonx.tsx`                                                              | Merge stakes with fee preservation                             | `prepare_ve33_merge`                                           |
| `EvmVeStonx.tsx`                                                              | Extend voted or unvoted stake                                  | `prepare_ve33_extend`                                          |
| `EvmVeStonx.tsx`                                                              | Claim one/all voter fees                                       | `prepare_ve33_claim_fees`, `prepare_ve33_claim_all_fees` |
| `EvmVeStonx.tsx`                                                              | Withdraw expired stake                                         | `prepare_ve33_withdraw`                                        |
| `EvmVeStonxVote.tsx`                                                          | Split and change one vote allocation                           | `prepare_ve33_vote`                                            |
| Portfolio allocation workflow                                                 | State-validated multi-NFT voting reallocation                  | `prepare_ve33_reallocation`                                    |

`useApprovalStatus.ts` is a shared transaction helper rather than a separate
business action. Every preparer that spends an ERC-20 includes its exact
approval transaction in the returned execution plan. The dedicated revocation
page is covered separately above.

Plans matching interface submissions made with `forceAtomic` list
`atomic_batch` in `required_capabilities`. This currently includes swaps with
an approval or allowance cleanup and the approval-plus-route old gEKUBO
migration. A wallet that does not implement a required capability must reject
such a plan rather than adapt it.
