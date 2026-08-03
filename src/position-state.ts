import {
  encodeEvmConcentratedPoolConfig,
  encodeEvmStableswapPoolConfig,
  encodeEvmV2ConcentratedPoolConfig,
  encodeEvmV2StableswapPoolConfig,
} from "@ekubo/sdk";
import {
  type Abi,
  type Address,
  encodeFunctionData,
  getAddress,
  type Hex,
  multicall3Abi,
  numberToHex,
} from "viem";
import {
  functionResultDecodePlan,
  localWalletDecoderHandoff,
} from "./abi-decode.js";
import { ServiceError } from "./core.js";
import { assertWalletAbiDecodePlan } from "./wallet-compatibility.js";

export const MULTICALL3_ADDRESS = getAddress(
  "0xcA11bde05977b3631167028862bE2a173976CA11",
);

const POSITIONS_V2_ADDRESS = getAddress(
  "0xA37cc341634AFD9E0919D334606E676dbAb63E17",
);
const POSITIONS_V3_ADDRESS = getAddress(
  "0x02D9876A21AF7545f8632C3af76eC90b5ad4b66D",
);
const VE33_POSITIONS_ADDRESS = getAddress(
  "0xdA38ac72CE7220c4dd7719d114ef94eDadb8f068",
);
const VE33_ADDRESS = getAddress("0xD18685a514E59b06d59824e16Db07e73345d9953");
const TWAMM_V2_ADDRESS = getAddress(
  "0xd4279c050da1f5c5b2830558c7a08e57e12b54ec",
);
const TWAMM_V3_ADDRESS = getAddress(
  "0xd47f1b1edcfeabb08f6ebd8fc337c27e636c75ba",
);
const OLD_TWAMM_V3_ADDRESS = getAddress(
  "0xd4F1060cB9c1A13e1d2d20379b8aa2cF7541eD9b",
);
const SUPPORTED_EVM_CHAIN_IDS = new Set([
  "1",
  "4663",
  "8453",
  "42161",
  "84532",
  "46630",
  "421614",
  "11155111",
]);

const POOL_KEY_COMPONENTS = [
  { name: "token0", type: "address", internalType: "address" },
  { name: "token1", type: "address", internalType: "address" },
  { name: "config", type: "bytes32", internalType: "PoolConfig" },
] as const;

const OWNER_OF_ABI = [
  {
    type: "function",
    name: "ownerOf",
    inputs: [{ name: "id", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "owner", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
] as const satisfies Abi;

const POSITIONS_V3_STATE_ABI = [
  {
    type: "function",
    name: "getPositionFeesAndLiquidity",
    inputs: [
      { name: "id", type: "uint256", internalType: "uint256" },
      {
        name: "poolKey",
        type: "tuple",
        internalType: "struct PoolKey",
        components: POOL_KEY_COMPONENTS,
      },
      { name: "tickLower", type: "int32", internalType: "int32" },
      { name: "tickUpper", type: "int32", internalType: "int32" },
    ],
    outputs: [
      { name: "liquidity", type: "uint128", internalType: "uint128" },
      { name: "principal0", type: "uint128", internalType: "uint128" },
      { name: "principal1", type: "uint128", internalType: "uint128" },
      { name: "fees0", type: "uint128", internalType: "uint128" },
      { name: "fees1", type: "uint128", internalType: "uint128" },
    ],
    stateMutability: "view",
  },
] as const satisfies Abi;

const POSITIONS_V2_STATE_ABI = [
  {
    ...POSITIONS_V3_STATE_ABI[0],
    inputs: [
      { name: "id", type: "uint256", internalType: "uint256" },
      {
        name: "poolKey",
        type: "tuple",
        internalType: "struct PoolKey",
        components: POOL_KEY_COMPONENTS,
      },
      {
        name: "bounds",
        type: "tuple",
        internalType: "struct Bounds",
        components: [
          { name: "lower", type: "int32", internalType: "int32" },
          { name: "upper", type: "int32", internalType: "int32" },
        ],
      },
    ],
  },
] as const satisfies Abi;

const VE33_POSITIONS_STATE_ABI = [
  {
    type: "function",
    name: "getPositionRewardsAndLiquidity",
    inputs: POSITIONS_V3_STATE_ABI[0].inputs,
    outputs: [
      { name: "liquidity", type: "uint128", internalType: "uint128" },
      { name: "principal0", type: "uint128", internalType: "uint128" },
      { name: "principal1", type: "uint128", internalType: "uint128" },
      { name: "rewardAmount", type: "uint256", internalType: "uint256" },
    ],
    stateMutability: "view",
  },
] as const satisfies Abi;

const POOL_REFRESH_ABI = [
  {
    type: "function",
    name: "lockAndExecuteVirtualOrders",
    inputs: [
      {
        name: "poolKey",
        type: "tuple",
        internalType: "struct PoolKey",
        components: POOL_KEY_COMPONENTS,
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const satisfies Abi;

const VE33_REFRESH_ABI = [
  {
    type: "function",
    name: "maybeAccumulateRewards",
    inputs: POOL_REFRESH_ABI[0].inputs,
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const satisfies Abi;

export interface IndexedPoolKey {
  token0: string;
  token1: string;
  fee: string;
  tick_spacing?: string | number | null;
  extension: string;
  stableswap_params?: {
    center_tick: number;
    amplification: number;
  } | null;
}

export interface IndexedPosition {
  id: string;
  chain_id: string | number;
  positions_address: string;
  pool_key: IndexedPoolKey;
  bounds: { lower: number; upper: number };
  [key: string]: unknown;
}

type ManagerVersion = "positions_v2" | "positions_v3" | "ve33_positions_v3";

interface InnerCall {
  purpose: string;
  target: Address;
  abi: Abi;
  functionName: string;
  callData: Hex;
  stateMutability: "view" | "nonpayable";
  resultFields: readonly { name: string; type: string }[];
}

export function buildPositionStateReadPlan(
  position: IndexedPosition,
  expectedOwner?: string,
) {
  const chainId = BigInt(position.chain_id).toString();
  if (!SUPPORTED_EVM_CHAIN_IDS.has(chainId)) {
    return {
      available: false as const,
      reason: "unsupported_evm_chain",
      chain_id: chainId,
      positions_address: position.positions_address,
      token_id: BigInt(position.id).toString(),
      guidance:
        "This exact eth_call builder covers the EVM chains supported by the Ekubo interface. Use the indexed fields directly for a non-EVM position.",
    };
  }
  const positionsAddress = normalizeAddress(position.positions_address);
  const managerVersion = positionManagerVersion(positionsAddress);
  if (managerVersion === undefined) {
    return {
      available: false as const,
      reason: "unsupported_positions_manager",
      chain_id: chainId,
      positions_address: positionsAddress,
      token_id: BigInt(position.id).toString(),
      guidance:
        "No first-class pending-state read is available for this manager deployment. The contract resource may be inspected for provenance, but clients and wallets must not invent calldata.",
    };
  }

  validateBounds(position.bounds);
  const poolKey = encodePositionPoolKey(position.pool_key, managerVersion);
  const tokenId = BigInt(position.id);
  const calls = positionStateCalls({
    positionsAddress,
    managerVersion,
    tokenId,
    poolKey,
    bounds: position.bounds,
  });
  const refresh = calls.find(
    (call) =>
      call.purpose === "accumulate_ve33_rewards_in_simulation" ||
      call.purpose === "execute_twamm_virtual_orders_in_simulation",
  );
  const expectedOwnerValue =
    expectedOwner ??
    (typeof position.owner === "string" ? position.owner : undefined);
  const normalizedExpectedOwner =
    expectedOwnerValue === undefined
      ? null
      : normalizeAddress(expectedOwnerValue);

  const aggregateData = encodeFunctionData({
    abi: multicall3Abi,
    functionName: "aggregate3",
    args: [
      calls.map((call) => ({
        target: call.target,
        allowFailure: false,
        callData: call.callData,
      })),
    ],
  });
  const stateResultIndex = calls.findIndex(
    (call) => call.purpose === "position_state",
  );
  const ownerResultIndex = calls.findIndex(
    (call) => call.purpose === "current_owner",
  );
  const decodePlan = {
    kind: "multicall3" as const,
    abi: multicall3Abi,
    function_name: "aggregate3",
    required: true,
    expected_result_count: calls.length,
    results: calls.map((call, index) => ({
      index,
      required_success: true,
      ...(call.resultFields.length === 0
        ? {}
        : { decode: functionResultDecodePlan(call.abi, call.functionName) }),
    })),
  };
  assertWalletAbiDecodePlan(decodePlan);

  return {
    available: true as const,
    chain_id: chainId,
    block_parameter: "pending",
    positions_address: positionsAddress,
    manager_version: managerVersion,
    token_id: tokenId.toString(),
    expected_owner: normalizedExpectedOwner,
    pool_key: poolKey,
    bounds: position.bounds,
    rpc_request: {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: MULTICALL3_ADDRESS, data: aggregateData }, "pending"],
    },
    // Every inner call's bytes are already encoded inside the aggregate in
    // rpc_request, so they are described here rather than repeated. The result
    // field lists live in local_decode_plan and are not restated either.
    inner_calls: calls.map((call, index) => ({
      index,
      purpose: call.purpose,
      target: call.target,
      function: call.functionName,
      state_mutability: call.stateMutability,
    })),
    result_indexes: {
      position_state: stateResultIndex,
      current_owner: ownerResultIndex,
      integer_serialization:
        "Serialize every decoded integer as a decimal string before returning it through JSON.",
    },
    local_decode_plan: decodePlan,
    result_decoder: localWalletDecoderHandoff({
      chainId,
      id: `ekubo-position-state-${tokenId}`,
      to: MULTICALL3_ADDRESS,
      data: aggregateData,
      decode: decodePlan,
    }),
    semantics: {
      read_only: true,
      never_broadcast:
        "This aggregate contains simulated state-changing refresh calls for TWAMM or Ve33 when required. Use it only as eth_call; never submit it as a transaction.",
      atomic_refresh:
        refresh === undefined
          ? "No pre-read refresh is required for this pool extension."
          : "The refresh and position read must remain in this single ordered aggregate eth_call so the read observes the simulated temporary state.",
      historical_replay:
        "For a historical snapshot, reuse the identical to/data and replace pending with the target block number encoded as a JSON-RPC quantity.",
    },
  };
}

export function positionTokenIdentifiers(position: IndexedPosition) {
  const chainId = BigInt(position.chain_id).toString();
  return [position.pool_key.token0, position.pool_key.token1].map(
    (address) => ({
      chainId,
      address,
    }),
  );
}

function positionStateCalls(input: {
  positionsAddress: Address;
  managerVersion: ManagerVersion;
  tokenId: bigint;
  poolKey: { token0: Address; token1: Address; config: Hex };
  bounds: { lower: number; upper: number };
}): InnerCall[] {
  const calls: InnerCall[] = [];
  const refresh = refreshCall(
    configExtension(input.poolKey.config),
    input.poolKey,
    input.managerVersion,
  );
  if (refresh !== undefined) calls.push(refresh);

  if (input.managerVersion === "positions_v2") {
    calls.push({
      purpose: "position_state",
      target: input.positionsAddress,
      abi: POSITIONS_V2_STATE_ABI,
      functionName: "getPositionFeesAndLiquidity",
      callData: encodeFunctionData({
        abi: POSITIONS_V2_STATE_ABI,
        functionName: "getPositionFeesAndLiquidity",
        args: [input.tokenId, input.poolKey, input.bounds],
      }),
      stateMutability: "view",
      resultFields: POSITIONS_V2_STATE_ABI[0].outputs,
    });
  } else if (input.managerVersion === "ve33_positions_v3") {
    calls.push({
      purpose: "position_state",
      target: input.positionsAddress,
      abi: VE33_POSITIONS_STATE_ABI,
      functionName: "getPositionRewardsAndLiquidity",
      callData: encodeFunctionData({
        abi: VE33_POSITIONS_STATE_ABI,
        functionName: "getPositionRewardsAndLiquidity",
        args: [
          input.tokenId,
          input.poolKey,
          input.bounds.lower,
          input.bounds.upper,
        ],
      }),
      stateMutability: "view",
      resultFields: VE33_POSITIONS_STATE_ABI[0].outputs,
    });
  } else {
    calls.push({
      purpose: "position_state",
      target: input.positionsAddress,
      abi: POSITIONS_V3_STATE_ABI,
      functionName: "getPositionFeesAndLiquidity",
      callData: encodeFunctionData({
        abi: POSITIONS_V3_STATE_ABI,
        functionName: "getPositionFeesAndLiquidity",
        args: [
          input.tokenId,
          input.poolKey,
          input.bounds.lower,
          input.bounds.upper,
        ],
      }),
      stateMutability: "view",
      resultFields: POSITIONS_V3_STATE_ABI[0].outputs,
    });
  }

  calls.push({
    purpose: "current_owner",
    target: input.positionsAddress,
    abi: OWNER_OF_ABI,
    functionName: "ownerOf",
    callData: encodeFunctionData({
      abi: OWNER_OF_ABI,
      functionName: "ownerOf",
      args: [input.tokenId],
    }),
    stateMutability: "view",
    resultFields: OWNER_OF_ABI[0].outputs,
  });
  return calls;
}

function configExtension(config: Hex): Address {
  return getAddress(`0x${config.slice(2, 42)}`);
}

function refreshCall(
  extension: string,
  poolKey: { token0: Address; token1: Address; config: Hex },
  managerVersion: ManagerVersion,
): InnerCall | undefined {
  const normalizedExtension = normalizeAddress(extension);
  if (managerVersion === "ve33_positions_v3") {
    if (normalizedExtension !== VE33_ADDRESS) {
      throw new ServiceError(
        "invalid_position",
        "Ve33Positions can only be queried with the canonical Ve33 extension",
      );
    }
    return {
      purpose: "accumulate_ve33_rewards_in_simulation",
      target: VE33_ADDRESS,
      abi: VE33_REFRESH_ABI,
      functionName: "maybeAccumulateRewards",
      callData: encodeFunctionData({
        abi: VE33_REFRESH_ABI,
        functionName: "maybeAccumulateRewards",
        args: [poolKey],
      }),
      stateMutability: "nonpayable",
      resultFields: [],
    };
  }

  const twammAddress =
    managerVersion === "positions_v2"
      ? normalizedExtension === TWAMM_V2_ADDRESS
        ? TWAMM_V2_ADDRESS
        : undefined
      : normalizedExtension === TWAMM_V3_ADDRESS
        ? TWAMM_V3_ADDRESS
        : normalizedExtension === OLD_TWAMM_V3_ADDRESS
          ? OLD_TWAMM_V3_ADDRESS
          : undefined;
  if (twammAddress === undefined) return undefined;
  return {
    purpose: "execute_twamm_virtual_orders_in_simulation",
    target: twammAddress,
    abi: POOL_REFRESH_ABI,
    functionName: "lockAndExecuteVirtualOrders",
    callData: encodeFunctionData({
      abi: POOL_REFRESH_ABI,
      functionName: "lockAndExecuteVirtualOrders",
      args: [poolKey],
    }),
    stateMutability: "nonpayable",
    resultFields: [],
  };
}

function encodePositionPoolKey(
  input: IndexedPoolKey,
  managerVersion: ManagerVersion,
) {
  const token0 = normalizeAddress(input.token0);
  const token1 = normalizeAddress(input.token1);
  if (BigInt(token0) >= BigInt(token1)) {
    throw new ServiceError(
      "invalid_position",
      "position pool_key.token0 must be numerically less than token1",
    );
  }
  const fee = unsigned(input.fee, "position pool_key.fee");
  if (fee > (1n << 64n) - 1n) {
    throw new ServiceError(
      "invalid_position",
      "position pool fee exceeds uint64",
    );
  }
  const extension = normalizeAddress(input.extension);
  const config =
    managerVersion === "positions_v2"
      ? encodeV2PoolConfig(input, fee, extension)
      : encodeV3PoolConfig(input, fee, extension);
  return { token0, token1, config };
}

function encodeV3PoolConfig(
  input: IndexedPoolKey,
  fee: bigint,
  extension: Address,
): Hex {
  if (
    input.stableswap_params !== null &&
    input.stableswap_params !== undefined
  ) {
    return encodeEvmStableswapPoolConfig({
      fee,
      centerTick: input.stableswap_params.center_tick,
      amplification: input.stableswap_params.amplification,
      extension,
    });
  }
  const tickSpacing = unsigned(
    input.tick_spacing ?? "0",
    "position pool_key.tick_spacing",
  );
  if (tickSpacing < 1n || tickSpacing > 698_605n) {
    throw new ServiceError(
      "invalid_position",
      "concentrated position tick spacing must be between 1 and 698605",
    );
  }
  return encodeEvmConcentratedPoolConfig({
    fee,
    tickSpacing: Number(tickSpacing),
    extension,
  });
}

function encodeV2PoolConfig(
  input: IndexedPoolKey,
  fee: bigint,
  extension: Address,
): Hex {
  try {
    if (
      input.stableswap_params !== null &&
      input.stableswap_params !== undefined
    ) {
      return encodeEvmV2StableswapPoolConfig({
        fee,
        centerTick: input.stableswap_params.center_tick,
        amplification: input.stableswap_params.amplification,
        extension,
      });
    }
    return encodeEvmV2ConcentratedPoolConfig({
      fee,
      tickSpacing: unsigned(
        input.tick_spacing ?? "0",
        "position pool_key.tick_spacing",
      ),
      extension,
    });
  } catch (error) {
    throw new ServiceError(
      "invalid_position",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function positionManagerVersion(address: Address): ManagerVersion | undefined {
  if (address === POSITIONS_V2_ADDRESS) return "positions_v2";
  if (address === POSITIONS_V3_ADDRESS) return "positions_v3";
  if (address === VE33_POSITIONS_ADDRESS) return "ve33_positions_v3";
  return undefined;
}

function normalizeAddress(value: string): Address {
  try {
    return getAddress(numberToHex(BigInt(value), { size: 20 }));
  } catch {
    throw new ServiceError(
      "invalid_position",
      `position address must fit in 20 bytes: ${value}`,
    );
  }
}

function unsigned(value: string | number, label: string): bigint {
  if (
    (typeof value === "string" &&
      !/^(?:(?:0|[1-9][0-9]*)|0x[0-9a-fA-F]+)$/.test(value)) ||
    (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
  ) {
    throw new ServiceError(
      "invalid_position",
      `${label} must be an unsigned decimal or hexadecimal integer`,
    );
  }
  return BigInt(value);
}

function validateBounds(bounds: { lower: number; upper: number }) {
  if (
    !Number.isInteger(bounds.lower) ||
    !Number.isInteger(bounds.upper) ||
    bounds.lower < -0x8000_0000 ||
    bounds.upper > 0x7fff_ffff ||
    bounds.lower >= bounds.upper
  ) {
    throw new ServiceError(
      "invalid_position",
      "position bounds must be ordered signed int32 values",
    );
  }
}
