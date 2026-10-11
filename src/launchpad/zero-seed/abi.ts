import { parseAbi } from "viem";

// Exact create/preview/claim signatures from the frozen d6aeb58 ABI. The local
// parity test compares these encodings with the hash-pinned full compiled ABI;
// this subset is not represented as the full compiled artifact.
export const zeroSeedAbi = parseAbi([
  "struct Parameters { address quoteToken; string name; string symbol; uint8 decimals; uint128 supply; uint128 liquidity; int32 askTick; int32 upperTick; uint32 tickSpacing; uint64 tradingStart; uint32 feeDuration; uint64 initialFee; uint64 finalFee; bytes32 salt; }",
  "struct PoolKey { address token0; address token1; bytes32 config; }",
  "struct Installation { address token; PoolKey poolKey; bytes32 positionId; int32 initialTick; uint128 liquidity; uint128 installedSupply; }",
  "function previewInstallation(address creator, Parameters parameters) view returns (Installation installation)",
  "function create(Parameters parameters) returns (Installation installation)",
  "function claimFees(PoolKey poolKey, address recipient) returns (uint128 amount0, uint128 amount1)",
]);
