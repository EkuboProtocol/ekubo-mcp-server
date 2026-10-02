import { parseAbi, toEventSelector } from "viem";

/**
 * Event signatures consumed by the engine. `PoolId`, `PositionId`,
 * `PoolBalanceUpdate` and `PoolState` are `bytes32` user types in Solidity,
 * so they encode as `bytes32`. `LaunchSwapped` and `LaunchRouted` follow the
 * EKU-645 interface contract; replace them with the ABI published alongside
 * the manifest if the Protocol Engineer changes an encoding.
 */
export const LAUNCH_CONFIG_TUPLE =
  "(address owner, address quoteToken, string name, string symbol, uint8 decimals, uint128 totalSupply, uint128 quoteAmount, uint64 startTime, uint64 endTime, int32 targetTick, int32 upperTick, uint32 tickSpacing, uint64 initialFee, uint64 finalFee, int32 migrationTickLower, int32 migrationTickUpper)";

export const scheduledLaunchEvents = parseAbi([
  `event LaunchCreated(bytes32 indexed poolId, address indexed token, address indexed owner, ${LAUNCH_CONFIG_TUPLE} config)`,
  "event LaunchAdvanced(bytes32 indexed poolId, uint128 deployed, bool complete)",
  "event CreatorFeesClaimed(bytes32 indexed poolId, address indexed recipient, uint128 amount0, uint128 amount1)",
  "event LaunchSwapped(bytes32 indexed poolId, address indexed locker, int128 delta0, int128 delta1, uint128 feeAmount, bool feeIsToken1)",
]);

export const lockedLaunchLiquidityEvents = parseAbi([
  "event PrincipalReceived(bytes32 indexed launchId, uint128 amount0, uint128 amount1)",
  "event LiquidityLocked(bytes32 indexed launchId, bytes32 indexed terminalPoolId, uint128 liquidity)",
  "event FeesClaimed(bytes32 indexed launchId, address indexed recipient, uint128 amount0, uint128 amount1)",
]);

export const launchRouterEvents = parseAbi([
  "event LaunchRouted(bytes32 indexed poolId, address indexed payer, address indexed recipient)",
]);

export const coreEvents = parseAbi([
  "event PositionUpdated(address locker, bytes32 poolId, bytes32 positionId, int128 liquidityDelta, bytes32 balanceUpdate, bytes32 stateAfter)",
  "event PositionFeesCollected(address locker, bytes32 poolId, bytes32 positionId, uint128 amount0, uint128 amount1)",
]);

export const erc20Events = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const TRANSFER_TOPIC = toEventSelector(erc20Events[0]);

export const PROTOCOL_EVENT_ABIS = {
  scheduled_launch: scheduledLaunchEvents,
  locked_launch_liquidity: lockedLaunchLiquidityEvents,
  launch_router: launchRouterEvents,
  core: coreEvents,
} as const;

/** Core's swap log: `log0(locker ‖ poolId ‖ balanceUpdate ‖ stateAfter)`, 116 bytes. */
export const CORE_SWAP_LOG_BYTES = 116;
