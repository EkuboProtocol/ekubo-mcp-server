import { parseAbi } from "viem";

/**
 * The fee model of a deployment, fixed by its contract revision for its whole life and carried by its pin, never
 * inferred from an event or a row:
 * - fixed_base_duration_v1: evm-contracts 43d6628, `uint32 feeDuration`, a fixed 600 s half-life table rescaled to
 *   reach finalFee at the end of the duration.
 * - tick_rate_v2: evm-contracts 3d6378f, `uint64 decayRateX32` (unsigned Q32.32 ticks per second); finalFee is the
 *   long-run floor the fee approaches, with no end time.
 */
export type FeeModel = "fixed_base_duration_v1" | "tick_rate_v2";
export const FEE_MODELS = ["fixed_base_duration_v1", "tick_rate_v2"] as const satisfies readonly FeeModel[];

// Subsets of the ZeroSeedLaunch extension and ZeroSeedLaunchPeriphery ABIs of each revision. Users call only the
// periphery; swaps reach the extension through Core.forward. Each launch names its own quote token in
// LaunchParameters (address(0) is native ETH); `supply` is the requested supply, and the contract derives the
// liquidity from it and mints the uninstallable remainder to address(0). The two revisions differ only in the
// 10th LaunchParameters field, so in the create and preview selectors and the LaunchCreated topic.
// script/zero-seed-abi-parity.ts compares these encodings with the hash-pinned full compiled ABIs.
const PARAMETERS_V1 =
  "struct LaunchParameters { string name; string symbol; uint8 decimals; uint128 supply; address quoteToken; int32 askTick; int32 upperTick; uint32 tickSpacing; uint64 tradingStart; uint32 feeDuration; uint64 initialFee; uint64 finalFee; bytes32 salt; }";
const PARAMETERS_V2 =
  "struct LaunchParameters { string name; string symbol; uint8 decimals; uint128 supply; address quoteToken; int32 askTick; int32 upperTick; uint32 tickSpacing; uint64 tradingStart; uint64 decayRateX32; uint64 initialFee; uint64 finalFee; bytes32 salt; }";
const POOL_KEY = "struct PoolKey { address token0; address token1; bytes32 config; }";
const INSTALLATION =
  "struct Installation { address token; PoolKey poolKey; bytes32 positionId; int32 initialTick; uint128 liquidity; uint128 installedSupply; }";

const PERIPHERY = [
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
] as const;

const EXTENSION = [
  POOL_KEY,
  "event LaunchCreated(bytes32 indexed poolId, address indexed token, address indexed controller, PoolKey poolKey, bytes32 positionId, uint128 liquidity, LaunchParameters parameters)",
  "event LaunchSwapped(bytes32 indexed poolId, address indexed locker, int128 delta0, int128 delta1, uint64 feeRate, uint128 feeAmount, bool feeIsToken1)",
  "event CreatorFeesClaimed(bytes32 indexed poolId, address indexed controller, uint128 amount0, uint128 amount1)",
  "error UnsupportedQuoteToken()",
  "error ZeroLiquidity()",
  "error LiquidityAboveTickCap(uint128 liquidity, uint128 cap)",
  "error InvalidFeeSchedule()",
] as const;

/** evm-contracts 43d6628 (fixed_base_duration_v1): read and claim only; no new create is produced for it. */
export const peripheryAbiV1 = parseAbi([PARAMETERS_V1, ...PERIPHERY]);
export const extensionAbiV1 = parseAbi([PARAMETERS_V1, ...EXTENSION]);
/** evm-contracts 3d6378f (tick_rate_v2): the only revision new launches are prepared for. */
export const peripheryAbi = parseAbi([PARAMETERS_V2, ...PERIPHERY]);
export const extensionAbi = parseAbi([PARAMETERS_V2, ...EXTENSION]);

export const CREATE_SIGNATURE =
  "create((string,string,uint8,uint128,address,int32,int32,uint32,uint64,uint64,uint64,uint64,bytes32))";
export const CREATE_SELECTOR = "0xf91810d2";
export const PREVIEW_SELECTOR = "0xb665ec4d";
export const LAUNCH_CREATED_TOPIC = "0x8f81ce1beb182cad759aa1c797ef027d374f535fd0c08696441c32797c7a5888";
export const CREATE_SIGNATURE_V1 =
  "create((string,string,uint8,uint128,address,int32,int32,uint32,uint64,uint32,uint64,uint64,bytes32))";
export const CREATE_SELECTOR_V1 = "0x662af306";
export const PREVIEW_SELECTOR_V1 = "0x917c1163";
export const LAUNCH_CREATED_TOPIC_V1 = "0x3a4e811187f4a8c0b72396e9d7ca13aeed62eb97a599a24af1ed99066041098f";
/** Unchanged between the revisions. */
export const CLAIM_SELECTOR = "0x6906b4c0";
export const TRANSFER_SELECTOR = "0x8b1cb36f";
export const LAUNCH_OWNER_SELECTOR = "0x60ac0b66";

/** The exact ABI, selectors and creation topic of one fee model. */
export const MODEL_ABIS = Object.freeze({
  fixed_base_duration_v1: Object.freeze({
    periphery: peripheryAbiV1, extension: extensionAbiV1,
    createSelector: CREATE_SELECTOR_V1, previewSelector: PREVIEW_SELECTOR_V1, launchCreatedTopic: LAUNCH_CREATED_TOPIC_V1,
  }),
  tick_rate_v2: Object.freeze({
    periphery: peripheryAbi, extension: extensionAbi,
    createSelector: CREATE_SELECTOR, previewSelector: PREVIEW_SELECTOR, launchCreatedTopic: LAUNCH_CREATED_TOPIC,
  }),
});

/** The one read the producer stores for the wallet; wallet decode plans take function entries only. */
export const previewAbi = peripheryAbi.filter((entry) => entry.type === "function" && entry.name === "previewInstallation");
