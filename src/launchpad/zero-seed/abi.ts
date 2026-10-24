import { parseAbi } from "viem";

// Subsets of the ZeroSeedLaunch extension and ZeroSeedLaunchPeriphery ABIs at evm-contracts 43d6628. Users call
// only the periphery; swaps reach the extension through Core.forward. Each launch names its own quote token in
// LaunchParameters (address(0) is native ETH); `supply` is the requested supply, and the contract derives the
// liquidity from it and mints the uninstallable remainder to address(0). There is no liquidity input and no decay
// factor (the decay has a fixed 600 s half-life). script/zero-seed-abi-parity.ts compares these encodings with the
// hash-pinned full compiled ABIs.
const LAUNCH_PARAMETERS =
  "struct LaunchParameters { string name; string symbol; uint8 decimals; uint128 supply; address quoteToken; int32 askTick; int32 upperTick; uint32 tickSpacing; uint64 tradingStart; uint32 feeDuration; uint64 initialFee; uint64 finalFee; bytes32 salt; }";
const POOL_KEY = "struct PoolKey { address token0; address token1; bytes32 config; }";
const INSTALLATION =
  "struct Installation { address token; PoolKey poolKey; bytes32 positionId; int32 initialTick; uint128 liquidity; uint128 installedSupply; }";

export const peripheryAbi = parseAbi([
  LAUNCH_PARAMETERS,
  POOL_KEY,
  INSTALLATION,
  "function previewInstallation(address owner, LaunchParameters parameters) view returns (Installation installation)",
  "function create(LaunchParameters parameters) returns (Installation installation)",
  "function claimFees(PoolKey poolKey, address recipient) returns (uint128 amount0, uint128 amount1)",
  "function transferLaunch(bytes32 poolId, address newOwner)",
  "function launchOwner(bytes32 poolId) view returns (address owner)",
  "function LAUNCH() view returns (address launch)",
  "event LaunchOwnerChanged(bytes32 indexed poolId, address indexed previousOwner, address indexed newOwner)",
  "event LaunchFeesClaimed(bytes32 indexed poolId, address indexed owner, address indexed recipient, uint128 amount0, uint128 amount1)",
  "error OwnerOnly()",
  "error InvalidOwner()",
  "error InvalidRecipient()",
]);

export const extensionAbi = parseAbi([
  LAUNCH_PARAMETERS,
  POOL_KEY,
  "event LaunchCreated(bytes32 indexed poolId, address indexed token, address indexed controller, PoolKey poolKey, bytes32 positionId, uint128 liquidity, LaunchParameters parameters)",
  "event LaunchSwapped(bytes32 indexed poolId, address indexed locker, int128 delta0, int128 delta1, uint64 feeRate, uint128 feeAmount, bool feeIsToken1)",
  "event CreatorFeesClaimed(bytes32 indexed poolId, address indexed controller, uint128 amount0, uint128 amount1)",
  "error UnsupportedQuoteToken()",
  "error ZeroLiquidity()",
  "error LiquidityAboveTickCap(uint128 liquidity, uint128 cap)",
]);

export const CREATE_SIGNATURE =
  "create((string,string,uint8,uint128,address,int32,int32,uint32,uint64,uint32,uint64,uint64,bytes32))";
export const CREATE_SELECTOR = "0x662af306";
export const PREVIEW_SELECTOR = "0x917c1163";
export const LAUNCH_CREATED_TOPIC = "0x3a4e811187f4a8c0b72396e9d7ca13aeed62eb97a599a24af1ed99066041098f";
export const CLAIM_SELECTOR = "0x6906b4c0";
export const TRANSFER_SELECTOR = "0x8b1cb36f";
export const LAUNCH_OWNER_SELECTOR = "0x60ac0b66";

/** The one read the producer stores for the wallet; wallet decode plans take function entries only. */
export const previewAbi = peripheryAbi.filter((entry) => entry.type === "function" && entry.name === "previewInstallation");
