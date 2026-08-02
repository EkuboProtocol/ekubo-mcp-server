import { fixedSqrtRatioToFloat } from "@ekubo/sdk";
import {
  encodeRoute,
  YUL_ROUTER_ABI,
  YUL_ROUTER_ADDRESS,
  type Hop,
} from "@ekubo/yul-router-sdk";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import {
  functionResultDecodePlan,
  localWalletDecoderHandoff,
  sqrtRatioFloatSemanticCodec,
} from "./abi-decode.js";
import { type Env, getTokens, ServiceError } from "./core.js";
import { decodePoolConfig, getPool } from "./pools.js";
import {
  erc20ApprovalTransaction,
  preparedTransaction,
  preparedUiAction,
} from "./ui-actions.js";

type Fetcher = typeof fetch;

const V3_CORE = getAddress("0x00000000000014aA86C5d3c41765bb24e11bd701");
const CORE_DATA_FETCHER_V3 = getAddress(
  "0xF68F25CA6C817733b7B15a42191AE72A34d56a2B",
);
const MEV_CAPTURE_V3 = getAddress("0x5555fF9Ff2757500BF4EE020DcfD0210CFfa41Be");
const VE33 = getAddress("0xD18685a514E59b06d59824e16Db07e73345d9953");
const NATIVE_TOKEN = getAddress("0x0000000000000000000000000000000000000000");
const TARGET_PRICE_SPECIFIED_AMOUNT = -(1n << 127n);

const CORE_DATA_FETCHER_ABI = [
  {
    type: "function",
    name: "poolPrice",
    inputs: [
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "config", type: "bytes32" },
        ],
      },
    ],
    outputs: [
      { name: "sqrtRatio", type: "uint96" },
      { name: "tick", type: "int32" },
    ],
    stateMutability: "view",
  },
] as const;

export interface PrepareFixPoolPriceInput {
  chainId: string;
  sender: string;
  coreAddress: string;
  poolId: string;
  baseToken: string;
  targetPrice: string;
  pendingCurrentSqrtRatio?: string;
  quoteResult?: {
    specifiedToken: string;
    calculatedToken: string;
    specifiedAmount: string;
    calculatedAmount: string;
    blockNumber?: string;
    blockHash?: Hex;
  };
}

export async function prepareFixPoolPrice(
  env: Env,
  input: PrepareFixPoolPriceInput,
  fetcher: Fetcher = fetch,
) {
  const sender = getAddress(input.sender);
  const coreAddress = getAddress(input.coreAddress);
  if (coreAddress !== V3_CORE) {
    throw new ServiceError(
      "unsupported_core",
      "The interface's fix-price action supports the current v3 Core only",
    );
  }
  const pool = await getPool(
    env,
    { chainId: input.chainId, coreAddress, poolId: input.poolId },
    fetcher,
  );
  const poolKey = pool.pool_key;
  const baseToken = getAddress(input.baseToken);
  if (baseToken !== poolKey.token0 && baseToken !== poolKey.token1) {
    throw new ServiceError(
      "invalid_base_token",
      "base_token must be token0 or token1 of the selected pool",
    );
  }
  const quoteToken =
    baseToken === poolKey.token0 ? poolKey.token1 : poolKey.token0;
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
  const baseDecimals = tokenDecimals(tokens, baseToken);
  const quoteDecimals = tokenDecimals(tokens, quoteToken);
  const target = targetSqrtRatio({
    humanPrice: input.targetPrice,
    baseDecimals,
    quoteDecimals,
    baseIsToken0: baseToken === poolKey.token0,
  });
  let targetSqrtRatioFloat: bigint;
  try {
    targetSqrtRatioFloat = fixedSqrtRatioToFloat(target.fixed);
  } catch (error) {
    throw new ServiceError(
      "target_price_out_of_range",
      error instanceof Error ? error.message : "Target price cannot be encoded",
    );
  }
  const readData = encodeFunctionData({
    abi: CORE_DATA_FETCHER_ABI,
    functionName: "poolPrice",
    args: [poolKey],
  });
  const currentPriceQuery = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: CORE_DATA_FETCHER_V3, data: readData }, "pending"],
  } as const;
  const currentPriceDecodePlan = functionResultDecodePlan(
    CORE_DATA_FETCHER_ABI,
    "poolPrice",
    { semanticCodecs: [sqrtRatioFloatSemanticCodec("sqrtRatio")] },
  );
  const currentPriceResultDecoder = localWalletDecoderHandoff({
    chainId: input.chainId,
    id: `ekubo-pool-price-${pool.pool_id}`,
    to: CORE_DATA_FETCHER_V3,
    data: readData,
    decode: currentPriceDecodePlan,
  });

  const shared = {
    schema_version: "1",
    action: "ekubo_fix_pool_price",
    agent_confirmation_required: false,
    wallet_validation_required: true,
    request: {
      chain_id: input.chainId,
      sender,
      core_address: coreAddress,
      pool_id: pool.pool_id,
      base_token: baseToken,
      quote_token: quoteToken,
      target_price: input.targetPrice,
    },
    pool: {
      pool_key: poolKey,
      decoded_config: decodePoolConfig(poolKey.config),
      indexed_state: pool.pool_state,
    },
    tokens,
    target: {
      human_price_quote_per_base: input.targetPrice,
      fixed_q128_sqrt_ratio: target.fixed.toString(),
      compact_sqrt_ratio: targetSqrtRatioFloat.toString(),
    },
  };

  if (input.pendingCurrentSqrtRatio === undefined) {
    return {
      ...shared,
      phase: "read_current_price",
      execution_plan_ready: false,
      current_price_query: {
        rpc_request: currentPriceQuery,
        decode_as: "(uint96 sqrtRatio,int32 tick)",
        local_decode_plan: currentPriceDecodePlan,
        result_decoder: currentPriceResultDecoder,
        resume:
          "Call this tool again with pending_current_sqrt_ratio set to decoded sqrtRatio.",
      },
      next_phase: "quote",
      wallet_handoff: {
        instruction:
          "Use the wallet's call API for this supplied read when available; do not ask for agent-level confirmation or reconstruct the calldata with Cast.",
      },
    };
  }

  const currentSqrtRatio = unsigned(
    input.pendingCurrentSqrtRatio,
    96,
    "pending_current_sqrt_ratio",
  );
  if (currentSqrtRatio === targetSqrtRatioFloat) {
    throw new ServiceError(
      "target_already_reached",
      "The pending pool price already equals the selected target",
    );
  }
  const priceIncreasing = targetSqrtRatioFloat > currentSqrtRatio;
  const specifiedToken = priceIncreasing ? poolKey.token0 : poolKey.token1;
  const calculatedToken = priceIncreasing ? poolKey.token1 : poolKey.token0;
  const hop = fixPriceHop(
    poolKey,
    decodePoolConfig(poolKey.config).extension,
    targetSqrtRatioFloat,
  );
  const quoteRoute = encodeRoute({
    specifiedToken,
    calculatedToken,
    specifiedAmount: TARGET_PRICE_SPECIFIED_AMOUNT,
    calculatedAmountThreshold: false,
    hops: [hop],
  });
  const quoteCalldata = encodeFunctionData({
    abi: YUL_ROUTER_ABI,
    functionName: "quote",
    args: [quoteRoute],
  });
  const quoteQuery = {
    jsonrpc: "2.0",
    id: 2,
    method: "eth_call",
    params: [{ to: YUL_ROUTER_ADDRESS, data: quoteCalldata }, "pending"],
  } as const;
  const quoteDecodePlan = functionResultDecodePlan(YUL_ROUTER_ABI, "quote");
  const quoteResultDecoder = localWalletDecoderHandoff({
    chainId: input.chainId,
    id: `ekubo-fix-price-quote-${pool.pool_id}`,
    to: YUL_ROUTER_ADDRESS,
    data: quoteCalldata,
    decode: quoteDecodePlan,
  });

  if (input.quoteResult === undefined) {
    return {
      ...shared,
      phase: "quote",
      execution_plan_ready: false,
      current_price: {
        compact_sqrt_ratio: currentSqrtRatio.toString(),
        direction: priceIncreasing ? "increase" : "decrease",
      },
      quote_query: {
        rpc_request: quoteQuery,
        decode_as:
          "(address specifiedToken,address calculatedToken,int256 specifiedAmount,int256 calculatedAmount)",
        local_decode_plan: quoteDecodePlan,
        result_decoder: quoteResultDecoder,
        resume:
          "Call this tool again with the exact decoded quote_result. Do not alter token addresses or signed amounts.",
      },
      next_phase: "execute",
      wallet_handoff: {
        instruction:
          "Use the wallet's call API for this supplied quote when available; do not ask for agent-level confirmation or reconstruct the calldata with Cast.",
      },
    };
  }

  const quoteSpecifiedToken = getAddress(input.quoteResult.specifiedToken);
  const quoteCalculatedToken = getAddress(input.quoteResult.calculatedToken);
  const quotedSpecifiedAmount = signed(
    input.quoteResult.specifiedAmount,
    "specified_amount",
  );
  const quotedCalculatedAmount = signed(
    input.quoteResult.calculatedAmount,
    "calculated_amount",
  );
  if (
    quoteSpecifiedToken !== specifiedToken ||
    quoteCalculatedToken !== calculatedToken ||
    quotedSpecifiedAmount >= 0n ||
    quotedCalculatedAmount >= 0n
  ) {
    throw new ServiceError(
      "quote_mismatch",
      "The decoded quote tokens or signed amounts do not match the target-price route",
    );
  }
  const requiredInputAmount = -quotedCalculatedAmount;
  const expectedOutputAmount = -quotedSpecifiedAmount;
  const executionRoute = encodeRoute({
    specifiedToken,
    calculatedToken,
    specifiedAmount: TARGET_PRICE_SPECIFIED_AMOUNT,
    calculatedAmountThreshold: quotedCalculatedAmount,
    hops: [hop],
  });
  const nativeValue =
    calculatedToken === NATIVE_TOKEN ? requiredInputAmount : 0n;
  const approvals =
    calculatedToken === NATIVE_TOKEN
      ? []
      : [
          erc20ApprovalTransaction(
            input.chainId,
            calculatedToken,
            YUL_ROUTER_ADDRESS,
            requiredInputAmount,
          ),
        ];
  const transaction = preparedTransaction(
    input.chainId,
    YUL_ROUTER_ADDRESS,
    executionRoute,
    nativeValue,
  );

  return {
    ...preparedUiAction({
      action: "ekubo_fix_pool_price",
      chainId: input.chainId,
      sender,
      request: shared.request,
      decodedCalls: [
        ...approvals.map((approval, index) => ({
          order: index + 1,
          function: "approve",
          target: approval.to,
          arguments: {
            spender: YUL_ROUTER_ADDRESS,
            amount: requiredInputAmount.toString(),
          },
        })),
        {
          order: approvals.length + 1,
          function: "execute_target_price_route",
          target: YUL_ROUTER_ADDRESS,
          arguments: {
            pool_key: poolKey,
            target_sqrt_ratio: targetSqrtRatioFloat.toString(),
            allow_partial: true,
            specified_token: specifiedToken,
            calculated_token: calculatedToken,
            specified_amount: TARGET_PRICE_SPECIFIED_AMOUNT.toString(),
            calculated_amount_threshold: quotedCalculatedAmount.toString(),
          },
        },
      ],
      approvals,
      transaction,
      details: {
        phase: "execute",
        pool: shared.pool,
        target: shared.target,
        current_sqrt_ratio: currentSqrtRatio.toString(),
        direction: priceIncreasing ? "increase" : "decrease",
        input_token: calculatedToken,
        output_token: specifiedToken,
        maximum_input_amount: requiredInputAmount.toString(),
        expected_output_amount: expectedOutputAmount.toString(),
        quote_block_number: input.quoteResult.blockNumber ?? null,
        quote_block_hash: input.quoteResult.blockHash ?? null,
        partial_fill_stops_at_target: true,
      },
      onchainValidation: {
        current_price_query: {
          rpc_request: currentPriceQuery,
          local_decode_plan: currentPriceDecodePlan,
          result_decoder: currentPriceResultDecoder,
        },
        quote_query: {
          rpc_request: quoteQuery,
          local_decode_plan: quoteDecodePlan,
          result_decoder: quoteResultDecoder,
        },
        instruction:
          "Immediately before signing, rerun both supplied pending reads, verify the current price remains on the same side of the target, verify the quote tuple still matches, and simulate the exact execution plan.",
      },
    }),
    phase: "execute",
    next_phase: null,
  };
}

function fixPriceHop(
  poolKey: { token0: Address; token1: Address; config: Hex },
  extensionValue: string,
  sqrtRatioLimit: bigint,
): Hop {
  const extension = getAddress(extensionValue);
  const shared = { poolKey, sqrtRatioLimit, allowPartial: true } as const;
  return extension === MEV_CAPTURE_V3 || extension === VE33
    ? { type: "forwarded", ...shared }
    : { type: "core", ...shared };
}

function tokenDecimals(tokens: Record<string, unknown>[], address: Address) {
  const token = tokens.find(
    (candidate) =>
      typeof candidate.address === "string" &&
      BigInt(candidate.address) === BigInt(address),
  );
  if (
    token === undefined ||
    typeof token.decimals !== "number" ||
    !Number.isInteger(token.decimals) ||
    token.decimals < 0 ||
    token.decimals > 255
  ) {
    throw new ServiceError(
      "invalid_token_metadata",
      `Token metadata is missing valid decimals for ${address}`,
    );
  }
  return token.decimals;
}

function targetSqrtRatio(input: {
  humanPrice: string;
  baseDecimals: number;
  quoteDecimals: number;
  baseIsToken0: boolean;
}) {
  let { numerator, denominator } = positiveDecimalFraction(input.humanPrice);
  const decimalShift = input.quoteDecimals - input.baseDecimals;
  if (decimalShift >= 0) numerator *= 10n ** BigInt(decimalShift);
  else denominator *= 10n ** BigInt(-decimalShift);
  if (!input.baseIsToken0) {
    [numerator, denominator] = [denominator, numerator];
  }
  const fixedSquared = (numerator << 256n) / denominator;
  const fixed = integerSqrt(fixedSquared);
  if (fixed === 0n) {
    throw new ServiceError(
      "target_price_out_of_range",
      "target_price is too small to encode",
    );
  }
  return { fixed };
}

function positiveDecimalFraction(value: string) {
  const match = /^(?:([0-9]+)(?:\.([0-9]*))?|\.([0-9]+))$/.exec(value);
  if (!match) {
    throw new ServiceError(
      "invalid_price",
      "target_price must be a positive non-exponential decimal string",
    );
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? match[3] ?? "";
  const numerator = BigInt(`${whole}${fraction}`);
  if (numerator === 0n) {
    throw new ServiceError("invalid_price", "target_price must be positive");
  }
  return { numerator, denominator: 10n ** BigInt(fraction.length) };
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

function unsigned(value: string, bits: number, label: string) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ServiceError("invalid_integer", `${label} must be decimal`);
  }
  const parsed = BigInt(value);
  if (parsed >= 1n << BigInt(bits)) {
    throw new ServiceError("integer_overflow", `${label} must fit uint${bits}`);
  }
  return parsed;
}

function signed(value: string, label: string) {
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ServiceError(
      "invalid_integer",
      `${label} must be signed decimal`,
    );
  }
  const parsed = BigInt(value);
  if (parsed < -(1n << 255n) || parsed >= 1n << 255n) {
    throw new ServiceError("integer_overflow", `${label} must fit int256`);
  }
  return parsed;
}
