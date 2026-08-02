import {
  EVM_MAX_TICK,
  EVM_MIN_TICK,
  floatSqrtRatioToFixed,
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
import { type Env, getTokens, ServiceError } from "./core.js";
import {
  executionPlan,
  type PreparedTransaction,
  transactionIdentity,
} from "./execution-plan.js";
import { decodePoolConfig, getPool } from "./pools.js";

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

const POOL_KEY_COMPONENTS = [
  { name: "token0", type: "address", internalType: "address" },
  { name: "token1", type: "address", internalType: "address" },
  { name: "config", type: "bytes32", internalType: "PoolConfig" },
] as const;

const POSITIONS_DEPOSIT_ABI = [
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

const OWNER_OF_ABI = [
  {
    type: "function",
    name: "ownerOf",
    inputs: [{ name: "id", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "owner", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
] as const satisfies Abi;

export async function prepareLpPositionDeposit(
  env: Env,
  input: {
    chainId: string;
    sender: string;
    coreAddress: string;
    poolId: string;
    mode: "mint_new" | "add_liquidity";
    tokenId?: string;
    tickLower: number;
    tickUpper: number;
    maxAmount0: string;
    maxAmount1: string;
    slippageBps: number;
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
    input.tokenId === undefined ? undefined : unsigned(input.tokenId, "token_id");
  if (
    (input.mode === "mint_new" && tokenId !== undefined) ||
    (input.mode === "add_liquidity" && tokenId === undefined)
  ) {
    throw new ServiceError(
      "invalid_mode",
      "mint_new must omit token_id; add_liquidity must provide token_id",
    );
  }

  const pool = await getPool(
    env,
    {
      chainId: input.chainId,
      coreAddress,
      poolId: input.poolId,
    },
    fetcher,
  );
  if (pool.pool_state === null) {
    throw new ServiceError(
      "pool_state_unavailable",
      "The indexed pool has no state snapshot; LP slippage cannot be calculated safely",
    );
  }
  const sqrtRatioValue = pool.pool_state.sqrt_ratio;
  if (typeof sqrtRatioValue !== "string") {
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

  const sqrtPrice = floatSqrtRatioToFixed(unsigned(sqrtRatioValue, "sqrt_ratio"));
  const expectedLiquidity = maxLiquidityForTokenAmounts({
    sqrtPrice,
    sqrtPriceLower: toSqrtRatio(input.tickLower, "evm"),
    sqrtPriceUpper: toSqrtRatio(input.tickUpper, "evm"),
    amountBase: maxAmount0,
    amountQuote: maxAmount1,
  });
  if (expectedLiquidity <= 0n || expectedLiquidity > MAX_U128) {
    throw new ServiceError(
      "invalid_liquidity",
      "The supplied amounts and range do not produce positive uint128 liquidity at the indexed price",
    );
  }
  const minLiquidity =
    (expectedLiquidity * BigInt(10_000 - input.slippageBps)) / 10_000n;
  if (minLiquidity <= 0n) {
    throw new ServiceError(
      "invalid_liquidity",
      "Slippage-adjusted minimum liquidity must remain positive",
    );
  }

  const extension = normalizeAddress(decodedConfig.extension);
  const positionsAddress =
    extension === VE33_EXTENSION_ADDRESS
      ? VE33_POSITIONS_ADDRESS
      : V3_POSITIONS_ADDRESS;
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
  const calls = [
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
  const transactionData =
    calls.length === 1
      ? calls[0]
      : encodeFunctionData({
          abi: POSITIONS_DEPOSIT_ABI,
          functionName: "multicall",
          args: [calls],
        });
  const approvals = [
    ...(poolKey.token0 === NATIVE_TOKEN
      ? []
      : [erc20Approval(input.chainId, poolKey.token0, positionsAddress, maxAmount0)]),
    ...(poolKey.token1 === NATIVE_TOKEN
      ? []
      : [erc20Approval(input.chainId, poolKey.token1, positionsAddress, maxAmount1)]),
  ].filter((approval) => approval.amount > 0n);
  const approvalTransactions = approvals.map((approval) => approval.transaction);
  const cleanupTransactions = approvals.map((approval) =>
    erc20Approval(input.chainId, approval.token, positionsAddress, 0n).transaction,
  );
  const transaction: PreparedTransaction = {
    chain_id: input.chainId,
    to: positionsAddress,
    data: transactionData,
    value: nativeValue.toString(),
  };
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
  const ownerValidation =
    tokenId === undefined
      ? null
      : {
          status: "not_executed",
          expected_owner: sender,
          rpc_request: {
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [
              {
                to: positionsAddress,
                data: encodeFunctionData({
                  abi: OWNER_OF_ABI,
                  functionName: "ownerOf",
                  args: [tokenId],
                }),
              },
              "pending",
            ],
          },
          decode_as: "address",
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
    transaction: transactionIdentity(transaction),
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
    requires_user_confirmation: true,
    confirmation_ready: true,
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
    },
    pool: {
      pool_key: poolKey,
      decoded_config: decodedConfig,
      indexed_state: pool.pool_state,
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
      expected_liquidity_at_indexed_price: expectedLiquidity.toString(),
      minimum_liquidity: minLiquidity.toString(),
      slippage_bps: input.slippageBps,
      note: "Wallet simulation against current chain state is mandatory because the indexed price snapshot may be up to 180 seconds old.",
    },
    decoded_calls: [
      {
        order: 1,
        function:
          input.mode === "mint_new" ? "mintAndDeposit" : "deposit",
        arguments: depositArguments,
      },
      ...(nativeValue === 0n
        ? []
        : [
            {
              order: 2,
              function: "refundNativeToken",
              arguments: {},
            },
          ]),
    ],
    approvals: approvalTransactions,
    transaction,
    post_execution_transactions: cleanupTransactions,
    onchain_validation: {
      owner: ownerValidation,
      exact_transaction_simulation_required: true,
    },
    execution_plan: executionPlan({
      chainId: input.chainId,
      sender,
      approvals: approvalTransactions,
      transaction,
      postExecutionTransactions: cleanupTransactions,
    }),
    wallet_policy_requirements: {
      allowed_chain_id: input.chainId,
      allowed_targets: [
        ...new Set([
          ...approvalTransactions.map((approval) => approval.to),
          positionsAddress,
        ]),
      ],
      allowed_approval_spender: positionsAddress,
      native_value_in_plan: nativeValue.toString(),
      required_max_native_value_per_batch_at_least: nativeValue.toString(),
      calldata_selectors: [
        ...(approvalTransactions.length === 0
          ? []
          : [
              {
                target: "erc20_tokens",
                function: "approve",
                selector: approvalSelector,
              },
            ]),
        {
          target: positionsAddress,
          function: calls.length === 1 ? "deposit" : "multicall",
          selector: transactionData.slice(0, 10),
        },
        {
          target: positionsAddress,
          function:
            input.mode === "mint_new" ? "mintAndDeposit" : "deposit",
          selector: depositCall.slice(0, 10),
          nested_in_multicall: calls.length > 1,
        },
        ...(nativeValue === 0n
          ? []
          : [
              {
                target: positionsAddress,
                function: "refundNativeToken",
                selector: refundSelector,
                nested_in_multicall: true,
              },
            ]),
      ],
      note: "The wallet owns policy authorization. This Ekubo server cannot modify an allowed-target, spender, native-value, or calldata-selector policy.",
    },
    confirmation: {
      instruction:
        "Show the exact pool, range, token maxima, minimum liquidity, approvals, native value, manager, and plan_id. Require explicit confirmation before asking a wallet MCP to sign or submit.",
      no_cast_required:
        "All calldata is complete. Pass execution_plan directly to the wallet MCP; do not reconstruct it with Cast.",
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

function unsigned(value: string | number, label: string) {
  if (
    (typeof value === "string" &&
      !/^(?:(?:0|[1-9][0-9]*)|0x[0-9a-fA-F]+)$/.test(value)) ||
    (typeof value === "number" &&
      (!Number.isSafeInteger(value) || value < 0))
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
