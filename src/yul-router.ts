import {
  encodeQuoteCalldata,
  encodeRoutes,
  type Hop,
  YUL_ROUTER_ADDRESS,
} from "@ekubo/yul-router-sdk";
import {
  type Address,
  encodeFunctionData,
  getAddress,
  type Hex,
  hexToBigInt,
  maxInt128,
  minInt128,
  numberToHex,
} from "viem";

export interface EvmQuoterPoolKey {
  token0: Address;
  token1: Address;
  config: Hex;
}

export type EvmQuoterRouteNode =
  | {
      swap: {
        type: "core" | "forwarded";
        pool_key: EvmQuoterPoolKey;
        sqrt_ratio_limit: Hex;
        skip_ahead: number;
        /** Core forward target of a forwarded hop, when it differs from or restates the pool extension. */
        forwardee?: Address;
        /** The hop may fill less than its specified amount (ScheduledLaunch pools). */
        allow_partial?: boolean;
      };
      wrapped_token?: never;
    }
  | {
      wrapped_token: {
        underlying: Address;
        wrapped: Address;
      };
      swap?: never;
    };

export type EvmQuoterQuoteType = "exact_input" | "exact_output";

export interface EvmQuoterQuote {
  block_number: number | string | bigint;
  block_hash: Hex;
  total_calculated: string;
  estimated_gas_cost: number;
  price_impact: number | null;
  splits: readonly {
    amount_specified: string;
    amount_calculated: string;
    route: readonly EvmQuoterRouteNode[];
  }[];
}

export interface BuildQuoterQuoteUrlParameters {
  quoterUrl: string;
  chainId: number | string | bigint;
  tokenIn: Address;
  tokenOut: Address;
  quoteType: EvmQuoterQuoteType;
  amount: string | bigint;
}

export interface PrepareSwapFromQuoteParameters {
  quote: EvmQuoterQuote;
  tokenIn: Address;
  tokenOut: Address;
  quoteType: EvmQuoterQuoteType;
  amount: string | bigint;
  slippageBps: number | bigint;
  recipient?: Address;
  routerAddress?: Address;
}

export interface PreparedSwap {
  quoteType: EvmQuoterQuoteType;
  /**
   * The quote fills less than the requested amount through a single
   * allow_partial hop. The route specifies only the filled amount.
   */
  partialFill: boolean;
  /** The specified amount the route swaps: the requested amount, or less on a partial fill. */
  filledAmount: bigint;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  minimumAmountOut: bigint | null;
  maximumAmountIn: bigint | null;
  calculatedAmountThreshold: bigint;
  slippageBps: bigint;
  block: {
    number: bigint;
    hash: Hex;
  };
  route: Hex;
  quoteCalldata: Hex;
  transaction: {
    to: Address;
    data: Hex;
    value: bigint;
  };
  approval: {
    token: Address;
    spender: Address;
    amount: bigint;
    transaction: {
      to: Address;
      data: Hex;
      value: bigint;
    };
  } | null;
  recipient: Address | null;
  estimatedRouteGas: number;
  priceImpact: number | null;
}

export function buildQuoterQuoteUrl({
  quoterUrl,
  chainId,
  tokenIn,
  tokenOut,
  quoteType,
  amount,
}: BuildQuoterQuoteUrlParameters): string {
  const chain = parseUnsignedRawAmount(chainId, "chainId");
  if (chain === 0n) throw new Error("chainId must be greater than zero");
  if (quoteType !== "exact_input" && quoteType !== "exact_output") {
    throw new Error(`unsupported quote type: ${String(quoteType)}`);
  }

  const input = getAddress(tokenIn);
  const output = getAddress(tokenOut);
  if (input === output) {
    throw new Error("quote input and output tokens must differ");
  }

  const positiveAmount = parsePositiveAmount(amount, "amount");
  const exactOutput = quoteType === "exact_output";
  const signedAmount = exactOutput ? -positiveAmount : positiveAmount;
  assertInt128(signedAmount, "signed quote amount");
  const specifiedToken = exactOutput ? output : input;
  const otherToken = exactOutput ? input : output;
  const base = quoterUrl.replace(/\/+$/, "");
  if (base.length === 0) throw new Error("quoterUrl must not be empty");

  return `${base}/${chain}/${signedAmount}/${specifiedToken}/${otherToken}`;
}

export function prepareSwapFromQuote({
  quote,
  tokenIn: requestedTokenIn,
  tokenOut: requestedTokenOut,
  quoteType,
  amount,
  slippageBps,
  recipient,
  routerAddress = YUL_ROUTER_ADDRESS,
}: PrepareSwapFromQuoteParameters): PreparedSwap {
  if (quoteType !== "exact_input" && quoteType !== "exact_output") {
    throw new Error(`unsupported quote type: ${String(quoteType)}`);
  }
  if (!Array.isArray(quote.splits) || quote.splits.length === 0) {
    throw new Error("quote must contain at least one split");
  }
  if (
    !Number.isSafeInteger(quote.estimated_gas_cost) ||
    quote.estimated_gas_cost < 0
  ) {
    throw new Error("estimated_gas_cost must be a nonnegative safe integer");
  }
  if (
    quote.price_impact !== null &&
    (typeof quote.price_impact !== "number" ||
      !Number.isFinite(quote.price_impact))
  ) {
    throw new Error("price_impact must be a finite number or null");
  }

  const tokenIn = getAddress(requestedTokenIn);
  const tokenOut = getAddress(requestedTokenOut);
  if (tokenIn === tokenOut) {
    throw new Error("quote input and output tokens must differ");
  }

  const requestedAmount = parsePositiveAmount(amount, "amount");
  const bps = parseSlippageBps(slippageBps);
  const isExactOutput = quoteType === "exact_output";
  const expectedSpecified = isExactOutput ? -requestedAmount : requestedAmount;
  assertInt128(expectedSpecified, "specified amount");
  const quotedCalculated = parseSignedRawAmount(
    quote.total_calculated,
    "total_calculated",
  );
  if (
    quotedCalculated === 0n ||
    (isExactOutput ? quotedCalculated > 0n : quotedCalculated < 0n)
  ) {
    throw new Error("total_calculated has the wrong sign for the quote type");
  }
  const specifiedTotal = quote.splits.reduce(
    (total, split) =>
      total + parseSignedRawAmount(split.amount_specified, "amount_specified"),
    0n,
  );
  const partialFill =
    specifiedTotal !== expectedSpecified && isPartialFill(quote, expectedSpecified, specifiedTotal);
  const filledAmount = partialFill
    ? isExactOutput
      ? -specifiedTotal
      : specifiedTotal
    : requestedAmount;
  const amountIn = isExactOutput ? -quotedCalculated : filledAmount;
  const amountOut = isExactOutput ? filledAmount : quotedCalculated;
  const calculatedTotal = quote.splits.reduce(
    (total, split) =>
      total +
      parseSignedRawAmount(split.amount_calculated, "amount_calculated"),
    0n,
  );
  if (specifiedTotal !== expectedSpecified && !partialFill) {
    throw new Error(
      `quote split specified total ${specifiedTotal} does not match ${expectedSpecified}`,
    );
  }
  if (calculatedTotal !== quotedCalculated) {
    throw new Error(
      `quote split calculated total ${calculatedTotal} does not match ${quotedCalculated}`,
    );
  }

  const calculatedAmountThreshold = isExactOutput
    ? -divideRoundingUp(amountIn * (10_000n + bps), 10_000n)
    : maxBigInt(1n, (amountOut * 10_000n) / (10_000n + bps));
  assertInt128(calculatedAmountThreshold, "calculatedAmountThreshold");

  const specifiedToken = isExactOutput ? tokenOut : tokenIn;
  const calculatedToken = isExactOutput ? tokenIn : tokenOut;
  const route = encodeRoutes({
    specifiedToken,
    calculatedToken,
    calculatedAmountThreshold,
    recipient,
    multiHops: quote.splits.map((split) => ({
      specifiedAmount: BigInt(split.amount_specified),
      hops: split.route.map(quoterNodeToHop),
    })),
  });

  const router = getAddress(routerAddress);
  const inputLimit = isExactOutput ? -calculatedAmountThreshold : amountIn;
  const isNativeInput = hexToBigInt(tokenIn) === 0n;

  return {
    quoteType,
    partialFill,
    filledAmount,
    tokenIn,
    tokenOut,
    amountIn,
    amountOut,
    minimumAmountOut: isExactOutput ? null : calculatedAmountThreshold,
    maximumAmountIn: isExactOutput ? inputLimit : null,
    calculatedAmountThreshold,
    slippageBps: bps,
    block: {
      number: parseUnsignedRawAmount(quote.block_number, "block_number"),
      hash: normalizeBlockHash(quote.block_hash),
    },
    route,
    quoteCalldata: encodeQuoteCalldata(route),
    transaction: {
      to: router,
      data: route,
      value: isNativeInput ? inputLimit : 0n,
    },
    approval: isNativeInput
      ? null
      : {
          token: tokenIn,
          spender: router,
          amount: inputLimit,
          transaction: {
            to: tokenIn,
            data: encodeFunctionData({
              abi: ERC20_APPROVE_ABI,
              functionName: "approve",
              args: [router, inputLimit],
            }),
            value: 0n,
          },
        },
    recipient: recipient === undefined ? null : getAddress(recipient),
    estimatedRouteGas: quote.estimated_gas_cost,
    priceImpact: quote.price_impact,
  };
}

const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function quoterNodeToHop(node: EvmQuoterRouteNode): Hop {
  if (node.wrapped_token !== undefined) {
    return {
      type: "wrapper",
      underlying: node.wrapped_token.underlying,
      wrapped: node.wrapped_token.wrapped,
    };
  }
  if (node.swap === undefined) {
    throw new Error("unknown EVM quoter route node");
  }

  const common = {
    poolKey: node.swap.pool_key,
    sqrtRatioLimit: BigInt(node.swap.sqrt_ratio_limit),
    skipAhead: node.swap.skip_ahead,
    ...(node.swap.allow_partial === true ? { allowPartial: true } : {}),
  };
  switch (node.swap.type) {
    case "core":
      if (node.swap.forwardee !== undefined) {
        throw new Error("a core hop cannot name a forwardee");
      }
      return { type: "core", ...common };
    case "forwarded":
      return {
        type: "forwarded",
        ...common,
        ...(node.swap.forwardee === undefined
          ? {}
          : { forwardee: getAddress(node.swap.forwardee) }),
      };
    default:
      throw new Error(
        `unsupported EVM quoter swap type: ${String(node.swap.type)}`,
      );
  }
}

/**
 * A partial fill is one split whose only hop is a swap with allow_partial,
 * filling a nonzero amount of the same sign as, and less than, the request.
 */
function isPartialFill(
  quote: EvmQuoterQuote,
  expectedSpecified: bigint,
  specifiedTotal: bigint,
): boolean {
  if (quote.splits.length !== 1 || quote.splits[0].route.length !== 1) {
    return false;
  }
  const hop = quote.splits[0].route[0];
  if (hop.swap === undefined || hop.swap.allow_partial !== true) return false;
  return expectedSpecified > 0n
    ? specifiedTotal > 0n && specifiedTotal < expectedSpecified
    : specifiedTotal < 0n && specifiedTotal > expectedSpecified;
}

function parsePositiveAmount(value: string | bigint, name: string): bigint {
  const amount =
    typeof value === "bigint" ? value : parseSignedRawAmount(value, name);
  if (amount <= 0n) throw new Error(`${name} must be greater than zero`);
  return amount;
}

function parseSignedRawAmount(value: string, name: string): bigint {
  if (!/^-?[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a base-10 integer string`);
  }
  return BigInt(value);
}

function parseUnsignedRawAmount(
  value: number | string | bigint,
  name: string,
): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a nonnegative safe integer`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    if (!/^[0-9]+$/.test(value)) {
      throw new Error(`${name} must be a nonnegative base-10 integer`);
    }
    return BigInt(value);
  }
  if (value < 0n) throw new Error(`${name} must be nonnegative`);
  return value;
}

function parseSlippageBps(value: number | bigint): bigint {
  const bps = parseUnsignedRawAmount(value, "slippageBps");
  if (bps > 10_000n) {
    throw new Error("slippageBps must be at most 10000");
  }
  return bps;
}

function assertInt128(value: bigint, name: string) {
  if (value < minInt128 || value > maxInt128) {
    throw new Error(`${name} does not fit in int128`);
  }
}

function divideRoundingUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function normalizeBlockHash(hash: Hex): Hex {
  try {
    return numberToHex(BigInt(hash), { size: 32 });
  } catch {
    throw new Error("block_hash must fit into bytes32");
  }
}
