import {
  EVM_MAX_TICK,
  EVM_MIN_TICK,
  fixedSqrtRatioToFloat,
  maxLiquidityForTokenAmounts,
  MAX_U128,
  toSqrtRatio,
} from "@ekubo/sdk";
import {
  type Abi,
  type Address,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  keccak256,
  numberToHex,
  stringToHex,
} from "viem";
import {
  errorResultDecodePlan,
  functionReadCall,
  readCallsBundle,
} from "./abi-decode.js";
import { type Env, getTokens, ServiceError } from "./core.js";
import {
  executionPlan,
  executionPlanFromSteps,
  type PreparedTransaction,
  transactionIdentity,
} from "./execution-plan.js";
import { decodePoolConfig, derivePoolId, getPool } from "./pools.js";
import {
  buildPositionStateReadPlan,
  positionStateQuery,
  positionTokenIdentifiers,
} from "./position-state.js";
import { getOwnedIndexedPosition } from "./positions.js";

type Fetcher = typeof fetch;

const NATIVE_TOKEN = getAddress("0x0000000000000000000000000000000000000000");
const V3_CORE_ADDRESS = getAddress(
  "0x00000000000014aA86C5d3c41765bb24e11bd701",
);
const V3_POSITIONS_ADDRESS = getAddress(
  "0x02D9876A21AF7545f8632C3af76eC90b5ad4b66D",
);
const VE33_POSITIONS_ADDRESS = getAddress(
  "0xdA38ac72CE7220c4dd7719d114ef94eDadb8f068",
);
const VE33_EXTENSION_ADDRESS = getAddress(
  "0xD18685a514E59b06d59824e16Db07e73345d9953",
);
const ROBINHOOD_STONX_ADDRESS = getAddress(
  "0x570C5aa79c798E7A418412cC8399ae5bcCe570C5",
);

const POOL_KEY_COMPONENTS = [
  { name: "token0", type: "address", internalType: "address" },
  { name: "token1", type: "address", internalType: "address" },
  { name: "config", type: "bytes32", internalType: "PoolConfig" },
] as const;

export const POSITIONS_DEPOSIT_ABI = [
  {
    type: "error",
    name: "DepositFailedDueToSlippage",
    inputs: [
      { name: "liquidity", type: "uint128", internalType: "uint128" },
      { name: "minLiquidity", type: "uint128", internalType: "uint128" },
    ],
  },
  {
    type: "error",
    name: "DepositFailedDueToPriceMovement",
    inputs: [],
  },
  { type: "error", name: "DepositOverflow", inputs: [] },
  {
    type: "error",
    name: "InvalidTick",
    inputs: [{ name: "tick", type: "int32", internalType: "int32" }],
  },
  { type: "error", name: "InvalidPoolExtension", inputs: [] },
  {
    type: "function",
    name: "maybeInitializePool",
    inputs: [
      {
        name: "poolKey",
        type: "tuple",
        internalType: "struct PoolKey",
        components: POOL_KEY_COMPONENTS,
      },
      { name: "tick", type: "int32", internalType: "int32" },
    ],
    outputs: [
      { name: "initialized", type: "bool", internalType: "bool" },
      { name: "sqrtRatio", type: "uint96", internalType: "SqrtRatio" },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "deposit",
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
      { name: "maxAmount0", type: "uint128", internalType: "uint128" },
      { name: "maxAmount1", type: "uint128", internalType: "uint128" },
      { name: "minLiquidity", type: "uint128", internalType: "uint128" },
    ],
    outputs: [
      { name: "liquidity", type: "uint128", internalType: "uint128" },
      { name: "amount0", type: "uint128", internalType: "uint128" },
      { name: "amount1", type: "uint128", internalType: "uint128" },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "mintAndDeposit",
    inputs: [
      {
        name: "poolKey",
        type: "tuple",
        internalType: "struct PoolKey",
        components: POOL_KEY_COMPONENTS,
      },
      { name: "tickLower", type: "int32", internalType: "int32" },
      { name: "tickUpper", type: "int32", internalType: "int32" },
      { name: "maxAmount0", type: "uint128", internalType: "uint128" },
      { name: "maxAmount1", type: "uint128", internalType: "uint128" },
      { name: "minLiquidity", type: "uint128", internalType: "uint128" },
    ],
    outputs: [
      { name: "id", type: "uint256", internalType: "uint256" },
      { name: "liquidity", type: "uint128", internalType: "uint128" },
      { name: "amount0", type: "uint128", internalType: "uint128" },
      { name: "amount1", type: "uint128", internalType: "uint128" },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "refundNativeToken",
    inputs: [],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "multicall",
    inputs: [{ name: "data", type: "bytes[]", internalType: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]", internalType: "bytes[]" }],
    stateMutability: "payable",
  },
] as const satisfies Abi;

export const OWNER_OF_ABI = [
  {
    type: "function",
    name: "ownerOf",
    inputs: [{ name: "id", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "owner", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
] as const satisfies Abi;

const POSITIONS_V3_COLLECT_FEES_ABI = [
  {
    type: "function",
    name: "collectFees",
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
      { name: "recipient", type: "address", internalType: "address" },
    ],
    outputs: [
      { name: "amount0", type: "uint128", internalType: "uint128" },
      { name: "amount1", type: "uint128", internalType: "uint128" },
    ],
    stateMutability: "payable",
  },
] as const satisfies Abi;

export const POSITIONS_V2_WITHDRAW_ABI = [
  {
    type: "function",
    name: "withdraw",
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
      { name: "liquidity", type: "uint128", internalType: "uint128" },
      { name: "recipient", type: "address", internalType: "address" },
      { name: "withFees", type: "bool", internalType: "bool" },
    ],
    outputs: POSITIONS_V3_COLLECT_FEES_ABI[0].outputs,
    stateMutability: "payable",
  },
] as const satisfies Abi;

export const POSITIONS_V3_WITHDRAW_ABI = [
  {
    type: "function",
    name: "withdraw",
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
      { name: "liquidity", type: "uint128", internalType: "uint128" },
      { name: "recipient", type: "address", internalType: "address" },
      { name: "withFees", type: "bool", internalType: "bool" },
    ],
    outputs: POSITIONS_V3_COLLECT_FEES_ABI[0].outputs,
    stateMutability: "payable",
  },
] as const satisfies Abi;

export const VE33_WITHDRAW_AND_CLAIM_REWARDS_ABI = [
  {
    type: "function",
    name: "withdrawAndClaimRewards",
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
      { name: "liquidity", type: "uint128", internalType: "uint128" },
      { name: "recipient", type: "address", internalType: "address" },
    ],
    outputs: [
      ...POSITIONS_V3_COLLECT_FEES_ABI[0].outputs,
      { name: "rewardAmount", type: "uint256", internalType: "uint256" },
    ],
    stateMutability: "payable",
  },
] as const satisfies Abi;

const VE33_CLAIM_REWARDS_ABI = [
  {
    type: "function",
    name: "claimRewards",
    inputs: POSITIONS_V3_COLLECT_FEES_ABI[0].inputs,
    outputs: [{ name: "amount", type: "uint256", internalType: "uint256" }],
    stateMutability: "payable",
  },
] as const satisfies Abi;

export const STAKE_TOKEN_ABI = [
  {
    type: "function",
    name: "stakeToken",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
] as const satisfies Abi;

export function preparePoolInitialization(input: {
  chainId: string;
  sender: string;
  coreAddress: string;
  poolKey: { token0: string; token1: string; config: Hex };
  initialTick: number;
}) {
  const sender = normalizeAddress(input.sender);
  const coreAddress = normalizeAddress(input.coreAddress);
  if (coreAddress !== V3_CORE_ADDRESS) {
    throw new ServiceError(
      "unsupported_core",
      "First-class pool initialization preparation currently supports the v3 Core only",
    );
  }
  if (
    !Number.isInteger(input.initialTick) ||
    input.initialTick < EVM_MIN_TICK ||
    input.initialTick > EVM_MAX_TICK
  ) {
    throw new ServiceError(
      "invalid_initial_tick",
      "initial_tick must be an integer within the EVM tick range",
    );
  }

  const pool = derivePoolId(input.poolKey);
  const decodedConfig = decodePoolConfig(pool.pool_key.config);
  const positionsAddress = positionsAddressForExtension(
    decodedConfig.extension,
  );
  const expectedSqrtRatio = toSqrtRatio(input.initialTick, "evm");
  const data = encodeFunctionData({
    abi: POSITIONS_DEPOSIT_ABI,
    functionName: "maybeInitializePool",
    args: [pool.pool_key, input.initialTick],
  });
  const transaction: PreparedTransaction = {
    chain_id: input.chainId,
    to: positionsAddress,
    data,
    value: "0",
  };
  const identity = {
    action: "initialize_pool",
    chain_id: input.chainId,
    sender,
    core_address: coreAddress,
    pool_id: pool.pool_id,
    initial_tick: input.initialTick,
    transaction: transactionIdentity(transaction),
  };

  return {
    schema_version: "1",
    action: "ekubo_initialize_pool",
    plan_id: keccak256(stringToHex(JSON.stringify(identity))),
    execution_plan_ready: true,
    agent_confirmation_required: false,
    wallet_validation_required: true,
    request: {
      chain_id: input.chainId,
      sender,
      core_address: coreAddress,
      pool_id: pool.pool_id,
      pool_key: pool.pool_key,
      initial_tick: input.initialTick,
    },
    pool: {
      pool_id: pool.pool_id,
      pool_id_decimal: pool.pool_id_decimal,
      pool_key: pool.pool_key,
      decoded_config: decodedConfig,
      initialization: {
        function: "maybeInitializePool",
        idempotent_if_already_initialized: true,
        expected_fixed_q128_sqrt_ratio: expectedSqrtRatio.toString(),
        expected_compact_sqrt_ratio:
          fixedSqrtRatioToFloat(expectedSqrtRatio).toString(),
        note: "If the pool is already initialized, maybeInitializePool preserves its existing price. If it is not initialized, this tick fixes its initial price.",
      },
    },
    positions_manager: {
      address: positionsAddress,
      contract:
        positionsAddress === VE33_POSITIONS_ADDRESS
          ? "Ve33Positions"
          : "Positions",
      resource_uri: `ekubo://contracts/evm/${input.chainId}/${positionsAddress}`,
    },
    execution_plan: executionPlan({
      chainId: input.chainId,
      sender,
      approvals: [],
      transaction,
      postExecutionTransactions: [],
    }),
    wallet_handoff: {
      instruction:
        "Pass this complete plan to the wallet for current-state simulation, presentation, authorization, and submission. Verify the initial tick because the first successful initialization fixes the pool price.",
      calldata_complete:
        "All calldata is complete. Pass the execution_plan_reference envelope unchanged as the wallet's reference argument; do not reconstruct maybeInitializePool with Cast or another encoder.",
    },
  };
}

export async function prepareLpPositionDeposit(
  env: Env,
  input: {
    chainId: string;
    sender: string;
    coreAddress: string;
    poolId?: string;
    poolKey?: { token0: string; token1: string; config: Hex };
    poolInitialized?: boolean;
    mode: "mint_new" | "add_liquidity";
    tokenId?: string;
    tickLower: number;
    tickUpper: number;
    maxAmount0: string;
    maxAmount1: string;
    slippageBps: number;
    initialTick?: number;
  },
  fetcher: Fetcher = fetch,
) {
  const sender = normalizeAddress(input.sender);
  const coreAddress = normalizeAddress(input.coreAddress);
  if (coreAddress !== V3_CORE_ADDRESS) {
    throw new ServiceError(
      "unsupported_core",
      "First-class LP deposit preparation currently supports the v3 Core returned by v3 pool candidates",
    );
  }
  validateBounds(input.tickLower, input.tickUpper);
  const maxAmount0 = uint128(input.maxAmount0, "max_amount0");
  const maxAmount1 = uint128(input.maxAmount1, "max_amount1");
  if (maxAmount0 === 0n && maxAmount1 === 0n) {
    throw new ServiceError(
      "invalid_amounts",
      "At least one maximum token amount must be positive",
    );
  }
  const tokenId =
    input.tokenId === undefined
      ? undefined
      : unsigned(input.tokenId, "token_id");
  if (
    (input.mode === "mint_new" && tokenId !== undefined) ||
    (input.mode === "add_liquidity" && tokenId === undefined)
  ) {
    throw new ServiceError(
      "invalid_mode",
      "mint_new must omit token_id; add_liquidity must provide token_id",
    );
  }

  if (input.poolId === undefined && input.poolKey === undefined) {
    throw new ServiceError(
      "missing_pool_identity",
      "Provide pool_id for an indexed pool or an exact pool_key for a new pool",
    );
  }
  const suppliedPool =
    input.poolKey === undefined
      ? undefined
      : derivePoolId({
          token0: input.poolKey.token0,
          token1: input.poolKey.token1,
          config: input.poolKey.config,
        });
  if (
    suppliedPool !== undefined &&
    input.poolId !== undefined &&
    BigInt(suppliedPool.pool_id) !== BigInt(input.poolId)
  ) {
    throw new ServiceError(
      "pool_id_mismatch",
      "The supplied pool_key does not derive to pool_id",
      { supplied_pool_id: input.poolId, derived_pool_id: suppliedPool.pool_id },
    );
  }
  if (input.poolInitialized === false && suppliedPool === undefined) {
    throw new ServiceError(
      "pool_key_required",
      "An uninitialized pool requires its exact pool_key; it cannot be recovered from the index",
    );
  }
  const pool =
    suppliedPool !== undefined && input.poolInitialized === false
      ? {
          chain_id: input.chainId,
          core_address: coreAddress,
          pool_id: suppliedPool.pool_id,
          pool_id_decimal: suppliedPool.pool_id_decimal,
          pool_key: suppliedPool.pool_key,
          decoded_config: suppliedPool.decoded_config,
          pool_state: null,
        }
      : await getPool(
          env,
          {
            chainId: input.chainId,
            coreAddress,
            poolId:
              input.poolId ??
              (suppliedPool as NonNullable<typeof suppliedPool>).pool_id,
          },
          fetcher,
        );
  if (
    suppliedPool !== undefined &&
    (pool.pool_key.token0 !== suppliedPool.pool_key.token0 ||
      pool.pool_key.token1 !== suppliedPool.pool_key.token1 ||
      pool.pool_key.config.toLowerCase() !==
        suppliedPool.pool_key.config.toLowerCase())
  ) {
    throw new ServiceError(
      "pool_key_mismatch",
      "The indexed pool key does not match the supplied exact pool_key",
    );
  }
  const isInitialized = input.poolInitialized ?? pool.pool_state !== null;
  if (!isInitialized && input.mode !== "mint_new") {
    throw new ServiceError(
      "uninitialized_pool",
      "Liquidity can only be added to an existing NFT after the pool is initialized",
    );
  }
  if (
    !isInitialized &&
    (input.initialTick === undefined ||
      !Number.isInteger(input.initialTick) ||
      input.initialTick < EVM_MIN_TICK ||
      input.initialTick > EVM_MAX_TICK)
  ) {
    throw new ServiceError(
      "initial_tick_required",
      "An uninitialized pool requires an initial_tick within the EVM tick range",
    );
  }
  const sqrtRatioValue = pool.pool_state?.sqrt_ratio;
  if (isInitialized && typeof sqrtRatioValue !== "string") {
    throw new ServiceError(
      "invalid_upstream_response",
      "Indexed pool state has no exact sqrt_ratio",
    );
  }
  const decodedConfig = decodePoolConfig(pool.pool_key.config);
  if (
    decodedConfig.pool_type === "concentrated" &&
    (input.tickLower % decodedConfig.tick_spacing !== 0 ||
      input.tickUpper % decodedConfig.tick_spacing !== 0)
  ) {
    throw new ServiceError(
      "invalid_bounds",
      `Concentrated position bounds must be multiples of tick spacing ${decodedConfig.tick_spacing}`,
    );
  }

  const sqrtPrice = isInitialized
    ? unsigned(sqrtRatioValue as string, "sqrt_ratio")
    : toSqrtRatio(input.initialTick as number, "evm");
  const liquidityAtIndexedPrice = maxLiquidityForTokenAmounts({
    sqrtPrice,
    sqrtPriceLower: toSqrtRatio(input.tickLower, "evm"),
    sqrtPriceUpper: toSqrtRatio(input.tickUpper, "evm"),
    amountBase: maxAmount0,
    amountQuote: maxAmount1,
  });
  if (liquidityAtIndexedPrice <= 0n || liquidityAtIndexedPrice > MAX_U128) {
    throw new ServiceError(
      "invalid_liquidity",
      "The supplied amounts and range do not produce positive uint128 liquidity at the indexed price",
    );
  }
  const sqrtPriceLower = toSqrtRatio(input.tickLower, "evm");
  const sqrtPriceUpper = toSqrtRatio(input.tickUpper, "evm");
  const priceSlippageFactor = BigInt(10_000 + input.slippageBps);
  const sqrtPriceSquared = sqrtPrice * sqrtPrice;
  const minSlippageSqrtPrice = integerSqrt(
    (sqrtPriceSquared * 10_000n) / priceSlippageFactor,
  );
  const maxSlippageSqrtPrice = integerSqrt(
    (sqrtPriceSquared * priceSlippageFactor) / 10_000n,
  );
  const liquidityAtMinSlippagePrice = maxLiquidityForTokenAmounts({
    sqrtPrice: minSlippageSqrtPrice,
    sqrtPriceLower,
    sqrtPriceUpper,
    amountBase: maxAmount0,
    amountQuote: maxAmount1,
  });
  const liquidityAtMaxSlippagePrice = maxLiquidityForTokenAmounts({
    sqrtPrice: maxSlippageSqrtPrice,
    sqrtPriceLower,
    sqrtPriceUpper,
    amountBase: maxAmount0,
    amountQuote: maxAmount1,
  });
  const minLiquidity =
    liquidityAtMinSlippagePrice < liquidityAtMaxSlippagePrice
      ? liquidityAtMinSlippagePrice
      : liquidityAtMaxSlippagePrice;
  if (minLiquidity <= 0n) {
    throw new ServiceError(
      "invalid_liquidity",
      "Slippage-adjusted minimum liquidity must remain positive",
    );
  }

  const positionsAddress = positionsAddressForExtension(
    decodedConfig.extension,
  );
  const poolKey = pool.pool_key;
  const depositCall =
    input.mode === "mint_new"
      ? encodeFunctionData({
          abi: POSITIONS_DEPOSIT_ABI,
          functionName: "mintAndDeposit",
          args: [
            poolKey,
            input.tickLower,
            input.tickUpper,
            maxAmount0,
            maxAmount1,
            minLiquidity,
          ],
        })
      : encodeFunctionData({
          abi: POSITIONS_DEPOSIT_ABI,
          functionName: "deposit",
          args: [
            tokenId as bigint,
            poolKey,
            input.tickLower,
            input.tickUpper,
            maxAmount0,
            maxAmount1,
            minLiquidity,
          ],
        });
  const nativeValue =
    poolKey.token0 === NATIVE_TOKEN
      ? maxAmount0
      : poolKey.token1 === NATIVE_TOKEN
        ? maxAmount1
        : 0n;
  const initializeCall = isInitialized
    ? null
    : encodeFunctionData({
        abi: POSITIONS_DEPOSIT_ABI,
        functionName: "maybeInitializePool",
        args: [poolKey, input.initialTick as number],
      });
  const calls = [
    ...(initializeCall === null ? [] : [initializeCall]),
    depositCall,
    ...(nativeValue === 0n
      ? []
      : [
          encodeFunctionData({
            abi: POSITIONS_DEPOSIT_ABI,
            functionName: "refundNativeToken",
          }),
        ]),
  ];
  // One step per Positions call rather than a `multicall` payload. A wallet
  // cannot police an opaque `bytes[]`, so nesting would reduce the whole
  // deposit to a single allowlisted target; separate steps are each decoded and
  // authorized. `refundNativeToken` still returns the unspent remainder because
  // the batch is atomic and the contract sweeps its own balance either way.
  const depositIndex = initializeCall === null ? 0 : 1;
  const approvals = [
    ...(poolKey.token0 === NATIVE_TOKEN
      ? []
      : [
          erc20Approval(
            input.chainId,
            poolKey.token0,
            positionsAddress,
            maxAmount0,
          ),
        ]),
    ...(poolKey.token1 === NATIVE_TOKEN
      ? []
      : [
          erc20Approval(
            input.chainId,
            poolKey.token1,
            positionsAddress,
            maxAmount1,
          ),
        ]),
  ].filter((approval) => approval.amount > 0n);
  const approvalTransactions = approvals.map(
    (approval) => approval.transaction,
  );
  const cleanupTransactions = approvals.map(
    (approval) =>
      erc20Approval(input.chainId, approval.token, positionsAddress, 0n)
        .transaction,
  );
  const transactions: PreparedTransaction[] = calls.map((data, index) => ({
    chain_id: input.chainId,
    to: positionsAddress,
    data,
    value: index === depositIndex ? nativeValue.toString() : "0",
  }));
  const transaction: PreparedTransaction | null =
    transactions.length === 1 ? transactions[0] : null;
  const tokens = await getTokens(
    env,
    {
      tokens: [
        { chainId: input.chainId, address: poolKey.token0 },
        { chainId: input.chainId, address: poolKey.token1 },
      ],
    },
    fetcher,
  );
  const ownerReadData =
    tokenId === undefined
      ? null
      : encodeFunctionData({
          abi: OWNER_OF_ABI,
          functionName: "ownerOf",
          args: [tokenId],
        });
  const ownerValidation =
    tokenId === undefined
      ? null
      : {
          status: "not_executed",
          expected_owner: sender,
          decode_as: "address",
          read_calls: readCallsBundle({
            chainId: input.chainId,
            calls: [
              functionReadCall({
                id: `ekubo-lp-owner-${tokenId}`,
                to: positionsAddress,
                data: ownerReadData!,
                abi: OWNER_OF_ABI,
                functionName: "ownerOf",
              }),
            ],
          }),
        };
  const identity = {
    action: input.mode,
    chain_id: input.chainId,
    sender,
    pool_id: pool.pool_id,
    positions_address: positionsAddress,
    token_id: tokenId?.toString() ?? null,
    bounds: { lower: input.tickLower, upper: input.tickUpper },
    max_amount0: maxAmount0.toString(),
    max_amount1: maxAmount1.toString(),
    min_liquidity: minLiquidity.toString(),
    approvals: approvalTransactions.map(transactionIdentity),
    transactions: transactions.map(transactionIdentity),
    cleanup: cleanupTransactions.map(transactionIdentity),
  };
  const depositArguments = {
    ...(tokenId === undefined ? {} : { token_id: tokenId.toString() }),
    pool_key: poolKey,
    tick_lower: input.tickLower,
    tick_upper: input.tickUpper,
    max_amount0: maxAmount0.toString(),
    max_amount1: maxAmount1.toString(),
    min_liquidity: minLiquidity.toString(),
  };
  const approvalSelector = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [positionsAddress, 0n],
  }).slice(0, 10);
  const refundSelector = encodeFunctionData({
    abi: POSITIONS_DEPOSIT_ABI,
    functionName: "refundNativeToken",
  }).slice(0, 10);

  return {
    schema_version: "1",
    action:
      input.mode === "mint_new"
        ? "ekubo_mint_lp_position"
        : "ekubo_add_lp_liquidity",
    plan_id: keccak256(stringToHex(JSON.stringify(identity))),
    execution_plan_ready: true,
    agent_confirmation_required: false,
    wallet_validation_required: true,
    request: {
      chain_id: input.chainId,
      sender,
      core_address: coreAddress,
      pool_id: pool.pool_id,
      mode: input.mode,
      token_id: tokenId?.toString() ?? null,
      bounds: { lower: input.tickLower, upper: input.tickUpper },
      max_amount0: maxAmount0.toString(),
      max_amount1: maxAmount1.toString(),
      slippage_bps: input.slippageBps,
      initial_tick: input.initialTick ?? null,
    },
    pool: {
      pool_key: poolKey,
      decoded_config: decodedConfig,
      indexed_state: pool.pool_state,
      initialized_before_plan: isInitialized,
      initialization:
        initializeCall === null
          ? null
          : {
              initial_tick: input.initialTick,
              expected_fixed_q128_sqrt_ratio: sqrtPrice.toString(),
              expected_compact_sqrt_ratio:
                fixedSqrtRatioToFloat(sqrtPrice).toString(),
            },
      indexed_state_cache_max_age_seconds: 180,
    },
    tokens,
    positions_manager: {
      address: positionsAddress,
      contract:
        positionsAddress === VE33_POSITIONS_ADDRESS
          ? "Ve33Positions"
          : "Positions",
      resource_uri: `ekubo://contracts/evm/${input.chainId}/${positionsAddress}`,
    },
    liquidity_protection: {
      expected_liquidity_at_indexed_price: liquidityAtIndexedPrice.toString(),
      minimum_liquidity: minLiquidity.toString(),
      slippage_bps: input.slippageBps,
      note: "Wallet simulation against current chain state is mandatory because the indexed price snapshot may be up to 180 seconds old.",
    },
    onchain_validation: {
      owner: ownerValidation,
      exact_transaction_simulation_required: true,
    },
    execution_plan: executionPlanFromSteps({
      chainId: input.chainId,
      sender,
      steps: [
        ...approvalTransactions.map((prepared) => ({
          kind: "approval" as const,
          transaction: prepared,
        })),
        ...transactions.map((prepared) => ({
          kind: "execution" as const,
          transaction: prepared,
          revertDecode: errorResultDecodePlan(POSITIONS_DEPOSIT_ABI),
        })),
        ...cleanupTransactions.map((prepared) => ({
          kind: "allowance_cleanup" as const,
          transaction: prepared,
        })),
      ],
      atomicBatchRequired:
        approvalTransactions.length +
          transactions.length +
          cleanupTransactions.length >
        1,
    }),
    wallet_handoff: {
      instruction:
        "Pass the complete plan to the wallet's simulation and authorization flow. Do not ask for separate agent-level confirmation; the wallet presents the simulated result and collects authorization or signature.",
      calldata_complete:
        "All calldata is complete. Pass the execution_plan_reference envelope unchanged as the wallet's reference argument; do not reconstruct it with Cast or another encoder.",
    },
  };
}

function positionsAddressForExtension(extension: string) {
  return normalizeAddress(extension) === VE33_EXTENSION_ADDRESS
    ? VE33_POSITIONS_ADDRESS
    : V3_POSITIONS_ADDRESS;
}

export async function prepareLpPositionEarningsClaim(
  env: Env,
  input: {
    chainId: string;
    sender: string;
    positionsAddress: string;
    tokenId: string;
    recipient?: string;
  },
  fetcher: Fetcher = fetch,
) {
  const sender = normalizeAddress(input.sender);
  const recipient = normalizeAddress(input.recipient ?? input.sender);
  const owned = await getOwnedIndexedPosition(
    env,
    {
      owner: sender,
      chainId: input.chainId,
      positionsAddress: input.positionsAddress,
      tokenId: input.tokenId,
    },
    fetcher,
  );
  const currentStateQuery = buildPositionStateReadPlan(
    owned.indexedPosition,
    owned.owner,
  );
  if (!currentStateQuery.available) {
    throw new ServiceError(
      currentStateQuery.reason,
      "First-class earnings claims require a supported EVM Positions manager",
      currentStateQuery,
    );
  }
  const stakeTokenReadData = encodeFunctionData({
    abi: STAKE_TOKEN_ABI,
    functionName: "stakeToken",
  });

  const { manager_version: managerVersion, pool_key: poolKey } =
    currentStateQuery;
  const bounds = currentStateQuery.bounds;
  const tokenId = owned.tokenId;
  let action: "collect_fees" | "claim_rewards";
  let implementationFunction: "collectFees" | "withdraw" | "claimRewards";
  let transactionData: Hex;
  let decodedArguments: Record<string, unknown>;
  let transactionResultFields: readonly { name: string; type: string }[];

  if (managerVersion === "positions_v2") {
    action = "collect_fees";
    implementationFunction = "withdraw";
    decodedArguments = {
      token_id: tokenId.toString(),
      pool_key: poolKey,
      bounds,
      liquidity: "0",
      recipient,
      with_fees: true,
    };
    transactionData = encodeFunctionData({
      abi: POSITIONS_V2_WITHDRAW_ABI,
      functionName: "withdraw",
      args: [tokenId, poolKey, bounds, 0n, recipient, true],
    });
    transactionResultFields = POSITIONS_V2_WITHDRAW_ABI[0].outputs;
  } else if (managerVersion === "ve33_positions_v3") {
    action = "claim_rewards";
    implementationFunction = "claimRewards";
    decodedArguments = {
      token_id: tokenId.toString(),
      pool_key: poolKey,
      tick_lower: bounds.lower,
      tick_upper: bounds.upper,
      recipient,
    };
    transactionData = encodeFunctionData({
      abi: VE33_CLAIM_REWARDS_ABI,
      functionName: "claimRewards",
      args: [tokenId, poolKey, bounds.lower, bounds.upper, recipient],
    });
    transactionResultFields = VE33_CLAIM_REWARDS_ABI[0].outputs;
  } else {
    action = "collect_fees";
    implementationFunction = "collectFees";
    decodedArguments = {
      token_id: tokenId.toString(),
      pool_key: poolKey,
      tick_lower: bounds.lower,
      tick_upper: bounds.upper,
      recipient,
    };
    transactionData = encodeFunctionData({
      abi: POSITIONS_V3_COLLECT_FEES_ABI,
      functionName: "collectFees",
      args: [tokenId, poolKey, bounds.lower, bounds.upper, recipient],
    });
    transactionResultFields = POSITIONS_V3_COLLECT_FEES_ABI[0].outputs;
  }

  const transaction: PreparedTransaction = {
    chain_id: owned.chainId,
    to: owned.positionsAddress,
    data: transactionData,
    value: "0",
  };
  const tokenIdentifiers = [
    ...positionTokenIdentifiers(owned.indexedPosition),
    ...(managerVersion === "ve33_positions_v3" && owned.chainId === "4663"
      ? [{ chainId: owned.chainId, address: ROBINHOOD_STONX_ADDRESS }]
      : []),
  ];
  const tokens = await getTokens(env, { tokens: tokenIdentifiers }, fetcher);
  const identity = {
    action,
    chain_id: owned.chainId,
    sender,
    recipient,
    positions_address: owned.positionsAddress,
    token_id: tokenId.toString(),
    pool_key: poolKey,
    bounds,
    transaction: transactionIdentity(transaction),
  };

  return {
    schema_version: "1",
    action:
      action === "collect_fees"
        ? "ekubo_collect_lp_position_fees"
        : "ekubo_claim_lp_position_rewards",
    plan_id: keccak256(stringToHex(JSON.stringify(identity))),
    execution_plan_ready: true,
    agent_confirmation_required: false,
    wallet_validation_required: true,
    request: {
      chain_id: owned.chainId,
      sender,
      recipient,
      positions_address: owned.positionsAddress,
      token_id: tokenId.toString(),
    },
    claim: {
      kind: action,
      implementation_function: implementationFunction,
      removes_liquidity: false,
      burns_or_transfers_nft: false,
      pool_key: poolKey,
      bounds,
    },
    tokens,
    execution_plan: executionPlan({
      chainId: owned.chainId,
      sender,
      transaction,
    }),
    onchain_validation: {
      status: "not_executed",
      // One stored bundle covers the position-state aggregate and, for Ve33,
      // the stakeToken read: both always execute together on this chain.
      current_state_query: (() => {
        const { state_call, semantics, ...stateRest } = currentStateQuery;
        return {
          ...stateRest,
          state_call_id: state_call.id,
          read_calls: readCallsBundle({
            chainId: owned.chainId,
            calls:
              managerVersion === "ve33_positions_v3"
                ? [
                    state_call,
                    functionReadCall({
                      id: `ekubo-stake-token-${owned.positionsAddress}`,
                      to: owned.positionsAddress,
                      data: stakeTokenReadData,
                      abi: STAKE_TOKEN_ABI,
                      functionName: "stakeToken",
                    }),
                  ]
                : [state_call],
          }),
          semantics,
        };
      })(),
      claimable_result_fields:
        managerVersion === "ve33_positions_v3"
          ? ["rewardAmount"]
          : ["fees0", "fees1"],
      instruction:
        "Pass current_state_query.read_calls_reference unchanged as wallet_batch_eth_call's reference argument. Require every inner call to succeed, compare decoded owner with expected_owner locally, retain the raw result, and pass the decoded claimable amount with the plan to the wallet. Then have the wallet simulate the exact execution transaction immediately before authorization and submission.",
    },
    reward_token:
      managerVersion === "ve33_positions_v3"
        ? {
            known_address:
              owned.chainId === "4663" ? ROBINHOOD_STONX_ADDRESS : null,
            decode_as: "address",
            call_id: `ekubo-stake-token-${owned.positionsAddress}`,
            note: "Decoded from the stakeToken call inside current_state_query's stored read bundle.",
          }
        : null,
    wallet_handoff: {
      instruction:
        "Pass the current decoded fees or rewards and the complete plan to the wallet's simulation and authorization flow. Do not ask for separate agent-level confirmation.",
      calldata_complete:
        "All calldata is complete. Pass the execution_plan_reference envelope unchanged as the wallet's reference argument; do not reconstruct it with Cast or another encoder.",
    },
  };
}

interface SingleLpPositionWithdrawInput {
  chainId: string;
  sender: string;
  positionsAddress: string;
  tokenId: string;
  liquidity: string;
  recipient?: string;
}

interface BatchLpPositionWithdrawInput {
  chainId: string;
  sender: string;
  withdrawals: Array<Omit<SingleLpPositionWithdrawInput, "chainId" | "sender">>;
}

export async function prepareLpPositionWithdraw(
  env: Env,
  input: BatchLpPositionWithdrawInput,
  fetcher: Fetcher = fetch,
) {
  if (input.withdrawals.length === 0 || input.withdrawals.length > 100) {
    throw new ServiceError(
      "invalid_withdrawals",
      "Provide between 1 and 100 LP position withdrawals",
    );
  }

  const sender = normalizeAddress(input.sender);
  const positionIds = new Set<string>();
  for (const withdrawal of input.withdrawals) {
    const id = `${normalizeAddress(withdrawal.positionsAddress)}:${unsigned(withdrawal.tokenId, "token_id")}`;
    if (positionIds.has(id)) {
      throw new ServiceError(
        "duplicate_withdrawal",
        "A many-at-a-time withdrawal request may include each position only once",
        { positions_address: withdrawal.positionsAddress, token_id: withdrawal.tokenId },
      );
    }
    positionIds.add(id);
  }

  const prepared = await Promise.all(
    input.withdrawals.map((withdrawal) =>
      prepareSingleLpPositionWithdraw(
        env,
        { chainId: input.chainId, sender, ...withdrawal },
        fetcher,
      ),
    ),
  );
  // Each withdrawal's plan is the only statement of its transactions, so the
  // batch reads them back out of it rather than keeping a second copy.
  const transactions = prepared.flatMap((withdrawal) =>
    withdrawal.execution_plan.ordered_steps.map(({ transaction }) => ({
      chain_id: transaction.chain_id,
      to: transaction.to,
      data: transaction.data,
      value: transaction.value,
    })),
  );
  const identity = {
    action: "withdraw_liquidity_batch",
    chain_id: input.chainId,
    sender,
    withdrawals: prepared.map((withdrawal) => withdrawal.plan_id),
    transactions: transactions.map(transactionIdentity),
  };

  return {
    schema_version: "1",
    action: "ekubo_withdraw_lp_positions",
    plan_id: keccak256(stringToHex(JSON.stringify(identity))),
    execution_plan_ready: true,
    agent_confirmation_required: false,
    wallet_validation_required: true,
    request: {
      chain_id: input.chainId,
      sender,
      withdrawals: prepared.map((withdrawal) => withdrawal.request),
    },
    withdrawals: prepared.map((withdrawal, index) => ({
      order: index + 1,
      plan_id: withdrawal.plan_id,
      request: withdrawal.request,
      withdrawal: withdrawal.withdrawal,
      output_protection: withdrawal.output_protection,
      position: withdrawal.position,
      tokens: withdrawal.tokens,
      onchain_validation: withdrawal.onchain_validation,
    })),
    execution_plan: executionPlanFromSteps({
      chainId: input.chainId,
      sender,
      steps: transactions.map((transaction) => ({
        kind: "execution" as const,
        transaction,
      })),
      atomicBatchRequired: transactions.length > 1,
      simulationFailurePolicy: withdrawalSimulationFailurePolicy(),
    }),
    onchain_validation: {
      status: "not_executed",
      current_state_queries: prepared.map((withdrawal, index) => ({
        order: index + 1,
        plan_id: withdrawal.plan_id,
        ...withdrawal.onchain_validation,
      })),
      instruction:
        "Execute every current_state_query at pending and require every individual ownership, liquidity, and earnings check to pass. Then have the wallet simulate the exact complete plan as one batch immediately before authorization and submission; discard the whole plan if any value changed.",
    },
    wallet_handoff: {
      instruction:
        "Pass every validated withdrawal and the complete multi-call plan's execution_plan_reference to the wallet. The calls may target unrelated positions or managers; the wallet is allowed to batch them into one transaction. Do not ask for separate agent-level confirmation.",
      calldata_complete:
        "All calldata and the complete ordered transaction list are supplied. Pass the execution_plan_reference envelope unchanged as the wallet's reference argument; do not reconstruct, omit, or add calls.",
    },
  };
}

async function prepareSingleLpPositionWithdraw(
  env: Env,
  input: SingleLpPositionWithdrawInput,
  fetcher: Fetcher = fetch,
) {
  const sender = normalizeAddress(input.sender);
  const recipient = normalizeAddress(input.recipient ?? input.sender);
  const liquidity = uint128(input.liquidity, "liquidity");
  if (liquidity === 0n) {
    throw new ServiceError(
      "invalid_liquidity",
      "Withdrawal liquidity must be positive; use ekubo_prepare_lp_position_earnings_claim for a fees- or rewards-only action",
    );
  }
  const owned = await getOwnedIndexedPosition(
    env,
    {
      owner: sender,
      chainId: input.chainId,
      positionsAddress: input.positionsAddress,
      tokenId: input.tokenId,
    },
    fetcher,
  );
  const currentStateQuery = buildPositionStateReadPlan(
    owned.indexedPosition,
    owned.owner,
  );
  if (!currentStateQuery.available) {
    throw new ServiceError(
      currentStateQuery.reason,
      "First-class LP withdrawal requires a supported EVM Positions manager",
      currentStateQuery,
    );
  }

  const { manager_version: managerVersion, pool_key: poolKey } =
    currentStateQuery;
  const bounds = currentStateQuery.bounds;
  const tokenId = owned.tokenId;
  let implementationFunction: "withdraw" | "withdrawAndClaimRewards";
  let transactionData: Hex;
  let decodedArguments: Record<string, unknown>;
  let transactionResultFields: readonly { name: string; type: string }[];

  if (managerVersion === "positions_v2") {
    implementationFunction = "withdraw";
    decodedArguments = {
      token_id: tokenId.toString(),
      pool_key: poolKey,
      bounds,
      liquidity: liquidity.toString(),
      recipient,
      with_fees: true,
    };
    transactionData = encodeFunctionData({
      abi: POSITIONS_V2_WITHDRAW_ABI,
      functionName: "withdraw",
      args: [tokenId, poolKey, bounds, liquidity, recipient, true],
    });
    transactionResultFields = POSITIONS_V2_WITHDRAW_ABI[0].outputs;
  } else if (managerVersion === "ve33_positions_v3") {
    implementationFunction = "withdrawAndClaimRewards";
    decodedArguments = {
      token_id: tokenId.toString(),
      pool_key: poolKey,
      tick_lower: bounds.lower,
      tick_upper: bounds.upper,
      liquidity: liquidity.toString(),
      recipient,
    };
    transactionData = encodeFunctionData({
      abi: VE33_WITHDRAW_AND_CLAIM_REWARDS_ABI,
      functionName: "withdrawAndClaimRewards",
      args: [
        tokenId,
        poolKey,
        bounds.lower,
        bounds.upper,
        liquidity,
        recipient,
      ],
    });
    transactionResultFields = VE33_WITHDRAW_AND_CLAIM_REWARDS_ABI[0].outputs;
  } else {
    implementationFunction = "withdraw";
    decodedArguments = {
      token_id: tokenId.toString(),
      pool_key: poolKey,
      tick_lower: bounds.lower,
      tick_upper: bounds.upper,
      liquidity: liquidity.toString(),
      recipient,
      with_fees: true,
    };
    transactionData = encodeFunctionData({
      abi: POSITIONS_V3_WITHDRAW_ABI,
      functionName: "withdraw",
      args: [
        tokenId,
        poolKey,
        bounds.lower,
        bounds.upper,
        liquidity,
        recipient,
        true,
      ],
    });
    transactionResultFields = POSITIONS_V3_WITHDRAW_ABI[0].outputs;
  }

  const transaction: PreparedTransaction = {
    chain_id: owned.chainId,
    to: owned.positionsAddress,
    data: transactionData,
    value: "0",
  };
  const indexedLiquidity = exactIndexedLiquidity(
    owned.indexedPosition.liquidity,
  );
  const tokenIdentifiers = [
    ...positionTokenIdentifiers(owned.indexedPosition),
    ...(managerVersion === "ve33_positions_v3" && owned.chainId === "4663"
      ? [{ chainId: owned.chainId, address: ROBINHOOD_STONX_ADDRESS }]
      : []),
  ];
  const tokens = await getTokens(env, { tokens: tokenIdentifiers }, fetcher);
  const identity = {
    action: "withdraw_liquidity",
    chain_id: owned.chainId,
    sender,
    recipient,
    positions_address: owned.positionsAddress,
    token_id: tokenId.toString(),
    pool_key: poolKey,
    bounds,
    liquidity: liquidity.toString(),
    transaction: transactionIdentity(transaction),
  };

  return {
    schema_version: "1",
    action: "ekubo_withdraw_lp_position",
    plan_id: keccak256(stringToHex(JSON.stringify(identity))),
    execution_plan_ready: true,
    agent_confirmation_required: false,
    wallet_validation_required: true,
    request: {
      chain_id: owned.chainId,
      sender,
      recipient,
      positions_address: owned.positionsAddress,
      token_id: tokenId.toString(),
      liquidity: liquidity.toString(),
    },
    withdrawal: {
      implementation_function: implementationFunction,
      requested_liquidity: liquidity.toString(),
      indexed_liquidity: indexedLiquidity?.toString() ?? null,
      requested_share_bps_of_indexed_liquidity:
        indexedLiquidity === null || indexedLiquidity === 0n
          ? null
          : ((liquidity * 10_000n) / indexedLiquidity).toString(),
      full_withdrawal_by_indexed_snapshot:
        indexedLiquidity === null ? null : liquidity === indexedLiquidity,
      collects_fees: managerVersion !== "ve33_positions_v3",
      claims_ve33_rewards: managerVersion === "ve33_positions_v3",
      burns_or_transfers_nft: false,
      note: "The indexed liquidity comparison is informational. The pending current-state query and exact wallet simulation are authoritative.",
    },
    output_protection: {
      contract_minimum_amounts_supported: false,
      principal_estimate:
        "After decoding the pending current-state query, multiply principal0 and principal1 by requested_liquidity / decoded current liquidity. Standard fees0/fees1 or the Ve33 rewardAmount are collected in full by this withdrawal.",
      requirement:
        "Because the manager withdrawal methods have no minimum-token-output arguments, pass the pending estimate to the wallet and simulate the exact transaction immediately before wallet authorization and submission.",
    },
    position: {
      pool_key: poolKey,
      bounds,
      manager_version: managerVersion,
    },
    tokens,
    execution_plan: executionPlan({
      chainId: owned.chainId,
      sender,
      transaction,
      simulationFailurePolicy: withdrawalSimulationFailurePolicy(),
    }),
    onchain_validation: {
      status: "not_executed",
      current_state_query: positionStateQuery(currentStateQuery),
      required_current_liquidity_at_least: liquidity.toString(),
      instruction:
        "Pass current_state_query.read_calls_reference unchanged as wallet_batch_eth_call's reference argument. Require every inner call to succeed, compare decoded owner with expected_owner locally, and require decoded liquidity at least requested_liquidity. Retain the raw result, pass current principal plus fees or Ve33 rewards to the wallet with the plan, simulate the exact withdrawal immediately before authorization and submission, and discard the plan if any value changed.",
    },
    wallet_handoff: {
      instruction:
        "Pass requested liquidity, its share of current liquidity, expected principal and earnings, recipient, manager, exact call, plan_id, and the complete plan to the wallet. Do not ask for separate agent-level confirmation.",
      calldata_complete:
        "All calldata and the complete transaction list are supplied. Pass the execution_plan_reference envelope unchanged as the wallet's reference argument; do not reconstruct or add calls with Cast or another encoder.",
    },
  };
}

function withdrawalSimulationFailurePolicy() {
  return {
    rpc_error: {
      action: "retry_same_plan" as const,
      instruction:
        "Retry the same withdrawal plan after a transient RPC or local simulation infrastructure failure, but only if its pending validation is still current.",
    },
    execution_reverted: {
      action: "reprepare_plan" as const,
      instruction:
        "The withdrawal reverted against current ownership, liquidity, earnings, or recipient state. Do not retry these bytes; rerun pending validation and prepare a fresh withdrawal plan.",
    },
    simulation_setup_error: {
      action: "user_review" as const,
      instruction:
        "Check the wallet, chain, RPC, and delegation configuration before preparing or submitting another withdrawal.",
    },
  };
}

function erc20Approval(
  chainId: string,
  token: Address,
  spender: Address,
  amount: bigint,
) {
  return {
    token,
    amount,
    transaction: {
      chain_id: chainId,
      to: token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, amount],
      }),
      value: "0",
    } satisfies PreparedTransaction,
  };
}

function normalizeAddress(value: string): Address {
  try {
    return getAddress(numberToHex(BigInt(value), { size: 20 }));
  } catch {
    throw new ServiceError(
      "invalid_address",
      `address must fit in 20 bytes: ${value}`,
    );
  }
}

function integerSqrt(value: bigint) {
  if (value < 0n) throw new Error("square root input must be nonnegative");
  if (value < 2n) return value;
  let left = 1n;
  let right = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
  while (left < right) {
    const midpoint = (left + right + 1n) >> 1n;
    if (midpoint <= value / midpoint) left = midpoint;
    else right = midpoint - 1n;
  }
  return left;
}

function unsigned(value: string | number, label: string) {
  if (
    (typeof value === "string" &&
      !/^(?:(?:0|[1-9][0-9]*)|0x[0-9a-fA-F]+)$/.test(value)) ||
    (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
  ) {
    throw new ServiceError(
      "invalid_input",
      `${label} must be an unsigned decimal or hexadecimal integer`,
    );
  }
  return BigInt(value);
}

function uint128(value: string, label: string) {
  const parsed = unsigned(value, label);
  if (parsed > MAX_U128) {
    throw new ServiceError("invalid_input", `${label} exceeds uint128`);
  }
  return parsed;
}

function validateBounds(lower: number, upper: number) {
  if (
    !Number.isInteger(lower) ||
    !Number.isInteger(upper) ||
    lower < EVM_MIN_TICK ||
    upper > EVM_MAX_TICK ||
    lower >= upper
  ) {
    throw new ServiceError(
      "invalid_bounds",
      `Bounds must be ordered integer ticks within ${EVM_MIN_TICK}..${EVM_MAX_TICK}`,
    );
  }
}

function exactIndexedLiquidity(value: unknown): bigint | null {
  if (
    typeof value !== "string" ||
    !/^(?:(?:0|[1-9][0-9]*)|0x[0-9a-fA-F]+)$/.test(value)
  ) {
    return null;
  }
  const parsed = BigInt(value);
  return parsed <= MAX_U128 ? parsed : null;
}
