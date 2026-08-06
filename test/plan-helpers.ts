import { decodeFunctionData, erc20Abi, parseAbi } from "viem";
import {
  POSITIONS_DEPOSIT_ABI,
  POSITIONS_V2_WITHDRAW_ABI,
  POSITIONS_V3_WITHDRAW_ABI,
  VE33_WITHDRAW_AND_CLAIM_REWARDS_ABI,
} from "../src/liquidity.js";

export const VE_TOKEN_ABI = parseAbi([
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function balanceOf(address owner) view returns (uint256 result)",
  "function ownerOf(uint256 id) view returns (address result)",
  "function stakes(uint256 id) view returns (uint128 amount,uint64 endTime)",
  "function votingPower(uint256 veId) view returns (uint256 result)",
  "function voteState(uint256 veId) view returns (bytes32 poolId,uint128 weight,uint64 votedSwapFee,uint128 claimable0,uint128 claimable1)",
  "function claimPoolFees(uint256 veId, (address token0,address token1,bytes32 config) poolKey, address recipient) payable returns (uint128 amount0,uint128 amount1)",
  "function claimPoolFeesToSelf(uint256 veId, (address token0,address token1,bytes32 config) poolKey) payable returns (uint128 amount0,uint128 amount1)",
  "function clearVote(uint256 veId) payable",
  "function vote(uint256 veId, (address token0,address token1,bytes32 config) poolKey, uint64 swapFee) payable",
  "function splitStake(uint256 veId, uint128 amount, bytes32 salt) payable returns (uint256 splitVeId)",
  "function claimPoolFeesAndMergeStakesToSelf(uint256 fromVeId, uint256 toVeId, (address token0,address token1,bytes32 config) poolKey) payable returns (uint128 amount0,uint128 amount1,uint128 nextAmount)",
  "function mergeStakes(uint256 fromVeId, uint256 toVeId) payable returns (uint128 nextAmount)",
  "function claimPoolFeesAndExtendStakeToSelfForDuration(uint256 veId, uint32 duration, (address token0,address token1,bytes32 config) poolKey) payable returns (uint128 amount0,uint128 amount1)",
  "function claimPoolFeesAndExtendStakeToSelfMaxDuration(uint256 veId, (address token0,address token1,bytes32 config) poolKey) payable returns (uint128 amount0,uint128 amount1)",
  "function extendStakeForDuration(uint256 veId, uint32 duration) payable",
  "function extendStakeMaxDuration(uint256 veId) payable",
  "function increaseStakeAmount(uint256 veId, uint128 amount) payable",
  "function withdrawStakeToSelf(uint256 veId) payable returns (uint128 amount)",
  "function stakeForDuration(uint128 amount, uint32 duration, bytes32 salt) payable returns (uint256 veId)",
  "function stakeMaxDuration(uint128 amount, bytes32 salt) payable returns (uint256 veId)",
]);


const HARVESTED_ABI = parseAbi([
  "function agreeToClaimConditions(address account,bytes signature)",
  "function balanceOf(address owner) view returns (uint256 result)",
  "function boost((address token0,address token1,bytes32 config) poolKey,uint64 startTime,uint64 endTime,uint112 rate0,uint112 rate1) payable returns (uint112,uint112)",
  "function claim((address owner,address token,bytes32 root) key,(uint256 index,address account,uint128 amount) claim,bytes32[] proof)",
  "function claim(address account,address token,uint256 amount)",
  "function claimPoolFees(uint256 veId, (address token0,address token1,bytes32 config) poolKey, address recipient) payable returns (uint128 amount0,uint128 amount1)",
  "function claimPoolFeesAndExtendStakeToSelfForDuration(uint256 veId, uint32 duration, (address token0,address token1,bytes32 config) poolKey) payable returns (uint128 amount0,uint128 amount1)",
  "function claimPoolFeesAndExtendStakeToSelfMaxDuration(uint256 veId, (address token0,address token1,bytes32 config) poolKey) payable returns (uint128 amount0,uint128 amount1)",
  "function claimPoolFeesAndMergeStakesToSelf(uint256 fromVeId, uint256 toVeId, (address token0,address token1,bytes32 config) poolKey) payable returns (uint128 amount0,uint128 amount1,uint128 nextAmount)",
  "function claimPoolFeesToSelf(uint256 veId, (address token0,address token1,bytes32 config) poolKey) payable returns (uint128 amount0,uint128 amount1)",
  "function clearVote(uint256 veId) payable",
  "function collect(address sellToken,uint64 fee,uint64 endTime) payable",
  "function collectCreatorProceeds(uint256 tokenId,(address token0,address token1,bytes32 config) auctionKey) payable",
  "function collectProceeds(uint256 id,(address token0,address token1,bytes32 config) orderKey) payable returns (uint128 proceeds)",
  "function completeAuctionAndStartBoost(uint256 tokenId,(address token0,address token1,bytes32 config) auctionKey) payable returns (uint128 creatorAmount,uint128 boostAmount,uint112 boostRate,uint64 boostEndTime)",
  "function decreaseSaleRate(uint256 id,(address token0,address token1,bytes32 config) orderKey,uint112 saleRateDecrease) payable returns (uint112 refund)",
  "function deposit() payable",
  "function expandCapacity(address token,uint32 minCapacity) returns (uint32 capacity)",
  "function extendStakeForDuration(uint256 veId, uint32 duration) payable",
  "function extendStakeMaxDuration(uint256 veId) payable",
  "function increaseSellAmount(uint256 id,(address token0,address token1,bytes32 config) orderKey,uint128 amount,uint112 maxSaleRate) payable returns (uint112 saleRate)",
  "function increaseStakeAmount(uint256 veId, uint128 amount) payable",
  "function isAvailable((address owner,address token,bytes32 root) key,uint256 index,uint128 amount) view returns (bool)",
  "function isClaimed((address owner,address token,bytes32 root) key,uint256 index) view returns (bool)",
  "function lockAndExecuteVirtualOrders((address token0,address token1,bytes32 config) poolKey)",
  "function maybeInitializeGraduationPool((address token0,address token1,bytes32 config) auctionKey,int32 tick) payable returns (bool initialized,uint96 sqrtRatio)",
  "function mergeStakes(uint256 fromVeId, uint256 toVeId) payable returns (uint128 nextAmount)",
  "function mint(bytes32 salt) payable returns (uint256 id)",
  "function mintAndIncreaseSellAmount((address token0,address token1,bytes32 config) orderKey,uint112 amount,uint112 maxSaleRate) payable returns (uint256 id,uint112 saleRate)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function ownerOf(uint256 id) view returns (address owner)",
  "function ownerOf(uint256 id) view returns (address result)",
  "function roll(address token) payable",
  "function safeTransferFrom(address from,address to,uint256 tokenId)",
  "function sellAmountByAuction(uint256 tokenId,(address token0,address token1,bytes32 config) auctionKey,uint128 amount) payable returns (uint112 saleRate)",
  "function splitStake(uint256 veId, uint128 amount, bytes32 salt) payable returns (uint256 splitVeId)",
  "function stakeForDuration(uint128 amount, uint32 duration, bytes32 salt) payable returns (uint256 veId)",
  "function stakeMaxDuration(uint128 amount, bytes32 salt) payable returns (uint256 veId)",
  "function stakes(uint256 id) view returns (uint128 amount,uint64 endTime)",
  "function vote(uint256 veId, (address token0,address token1,bytes32 config) poolKey, uint64 swapFee) payable",
  "function voteState(uint256 veId) view returns (bytes32 poolId,uint128 weight,uint64 votedSwapFee,uint128 claimable0,uint128 claimable1)",
  "function votingPower(uint256 veId) view returns (uint256 result)",
  "function withdraw(uint256 amount)",
  "function withdrawProtocolFees(address token0,address token1) payable",
  "function withdrawStakeToSelf(uint256 veId) payable returns (uint128 amount)",
]);

/** Every function these tests may see in a plan step. */
export const ALL_ABI = [
  ...HARVESTED_ABI,
  ...erc20Abi,
  ...VE_TOKEN_ABI,
  ...POSITIONS_DEPOSIT_ABI,
  ...POSITIONS_V2_WITHDRAW_ABI,
  ...POSITIONS_V3_WITHDRAW_ABI,
  ...VE33_WITHDRAW_AND_CLAIM_REWARDS_ABI,
];

/**
 * The execution plan is the only statement a prepared action makes about its
 * transactions, so tests read them back out of it rather than out of a
 * duplicated sibling field. Assertions written against decoded plan steps also
 * check what the plan actually does, rather than a label the server attached.
 */
// biome-ignore lint/suspicious/noExplicitAny: test helpers accept any prepared result
type Prepared = any;

export function planSteps(result: Prepared) {
  return result?.execution_plan?.ordered_steps ?? [];
}

export function planTransactions(result: Prepared) {
  return planSteps(result).map((step: Prepared) => step.transaction);
}

export function planStepKinds(result: Prepared): string[] {
  return planSteps(result).map((step: Prepared) => step.kind);
}

export function planValues(result: Prepared): string[] {
  return planTransactions(result).map((transaction: Prepared) =>
    String(transaction.value),
  );
}

export function planTotalValue(result: Prepared): bigint {
  return planTransactions(result).reduce(
    (total: bigint, transaction: Prepared) => total + BigInt(transaction.value),
    0n,
  );
}

export function planTargets(result: Prepared): string[] {
  return planTransactions(result).map(
    (transaction: Prepared) => transaction.to,
  );
}

/** Decoded function name of every step, using the supplied ABI. */
export function planFunctions(result: Prepared, abi: Prepared): string[] {
  return planTransactions(result).map(
    (transaction: Prepared) =>
      decodeFunctionData({ abi, data: transaction.data }).functionName,
  );
}

/** Decoded function name of one step. */
export function planFunction(
  result: Prepared,
  index: number,
  abi: Prepared,
): string {
  return decodeFunctionData({
    abi,
    data: planTransactions(result)[index].data,
  }).functionName;
}

/** Decoded arguments of every step, using the supplied ABI. */
export function planArgs(result: Prepared, abi: Prepared): readonly unknown[][] {
  return planTransactions(result).map(
    (transaction: Prepared) =>
      decodeFunctionData({ abi, data: transaction.data }).args ?? [],
  );
}
