import { encodeFunctionData, parseAbi, zeroAddress, type Hex } from "viem";
import { z } from "zod";
import {
  actionSchema,
  tokensSchema,
  amountsSchema,
  ticksSchema,
  uintSchema,
  deployment,
  deadline,
  pair,
  ticks,
  amounts,
  positive,
  uint,
  plan,
} from "./common.js";

export const V3_ABI = parseAbi([
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable returns (uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable returns (uint256 amount0,uint256 amount1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) payable returns (uint256 amount0,uint256 amount1)",
  "function burn(uint256 tokenId) payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function refundETH() payable",
  "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
  "function sweepToken(address token,uint256 amountMinimum,address recipient) payable",
  "function createAndInitializePoolIfNecessary(address token0,address token1,uint24 fee,uint160 sqrtPriceX96) payable returns (address pool)",
  "function positions(uint256 tokenId) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner,uint256 index) view returns (uint256)",
]);
export const v3AddSchema = actionSchema.extend({
  ...tokensSchema,
  ...amountsSchema,
  ...ticksSchema,
  fee: z.number().int().min(1).max(999999),
  token_id: uintSchema.optional(),
  use_native: z.boolean().default(false),
  initialize_sqrt_price_x96: uintSchema.optional(),
});
export const v3RemoveSchema = actionSchema.extend({
  ...tokensSchema,
  token_id: uintSchema,
  liquidity: uintSchema,
  amount0_min: uintSchema,
  amount1_min: uintSchema,
  burn: z.boolean().default(false),
  unwrap_native: z.boolean().default(false),
});
export const v3CollectSchema = actionSchema.extend({
  ...tokensSchema,
  token_id: uintSchema,
  unwrap_native: z.boolean().default(false),
});
const MAX128 = (1n << 128n) - 1n;
function multicall(calls: Hex[]) {
  return encodeFunctionData({
    abi: V3_ABI,
    functionName: "multicall",
    args: [calls],
  });
}
function nativeSide(
  input: z.infer<typeof v3AddSchema>,
  a0: bigint,
  a1: bigint,
) {
  const weth = deployment(input.chain_id).wrapped_native;
  if (!input.use_native) return 0n;
  if (input.token0 === weth) return a0;
  if (input.token1 === weth) return a1;
  throw new Error("use_native requires wrapped native in the pair");
}
export function prepareV3Add(raw: z.input<typeof v3AddSchema>) {
  const input = v3AddSchema.parse(raw);
  pair(input.token0, input.token1);
  ticks(input);
  const expiry = deadline(input),
    d = deployment(input.chain_id);
  const [a0, a1, m0, m1] = amounts(input);
  const calls: Hex[] = [];
  if (input.initialize_sqrt_price_x96 !== undefined) {
    if (input.token_id !== undefined)
      throw new Error("Pool initialization is only supported for mint");
    calls.push(
      encodeFunctionData({
        abi: V3_ABI,
        functionName: "createAndInitializePoolIfNecessary",
        args: [
          input.token0,
          input.token1,
          input.fee,
          positive(input.initialize_sqrt_price_x96, 160),
        ],
      }),
    );
  }
  const shared = {
    amount0Desired: a0,
    amount1Desired: a1,
    amount0Min: m0,
    amount1Min: m1,
    deadline: expiry,
  };
  calls.push(
    input.token_id === undefined
      ? encodeFunctionData({
          abi: V3_ABI,
          functionName: "mint",
          args: [
            {
              ...shared,
              token0: input.token0,
              token1: input.token1,
              fee: input.fee,
              tickLower: input.tick_lower,
              tickUpper: input.tick_upper,
              recipient: input.sender,
            },
          ],
        })
      : encodeFunctionData({
          abi: V3_ABI,
          functionName: "increaseLiquidity",
          args: [{ ...shared, tokenId: uint(input.token_id) }],
        }),
  );
  const value = nativeSide(input, a0, a1);
  if (input.use_native)
    calls.push(encodeFunctionData({ abi: V3_ABI, functionName: "refundETH" }));
  const spending = [
    { token: input.token0, amount: a0 },
    { token: input.token1, amount: a1 },
  ].filter((s) => !(input.use_native && s.token === d.wrapped_native));
  return plan(
    input,
    "uniswap_v3_add_liquidity",
    d.v3_position_manager,
    multicall(calls),
    value,
    spending,
  );
}
function collection(input: z.infer<typeof v3CollectSchema>): Hex[] {
  const calls: Hex[] = [
    encodeFunctionData({
      abi: V3_ABI,
      functionName: "collect",
      args: [
        {
          tokenId: uint(input.token_id),
          recipient: input.unwrap_native ? zeroAddress : input.sender,
          amount0Max: MAX128,
          amount1Max: MAX128,
        },
      ],
    }),
  ];
  if (!input.unwrap_native) return calls;
  const weth = deployment(input.chain_id).wrapped_native;
  if (input.token0 !== weth && input.token1 !== weth)
    throw new Error("unwrap_native requires wrapped native in the pair");
  calls.push(
    encodeFunctionData({
      abi: V3_ABI,
      functionName: "unwrapWETH9",
      args: [0n, input.sender],
    }),
  );
  calls.push(
    encodeFunctionData({
      abi: V3_ABI,
      functionName: "sweepToken",
      args: [
        input.token0 === weth ? input.token1 : input.token0,
        0n,
        input.sender,
      ],
    }),
  );
  return calls;
}
export function prepareV3Remove(raw: z.input<typeof v3RemoveSchema>) {
  const input = v3RemoveSchema.parse(raw);
  pair(input.token0, input.token1);
  const calls: Hex[] = [
    encodeFunctionData({
      abi: V3_ABI,
      functionName: "decreaseLiquidity",
      args: [
        {
          tokenId: uint(input.token_id),
          liquidity: positive(input.liquidity, 128),
          amount0Min: uint(input.amount0_min),
          amount1Min: uint(input.amount1_min),
          deadline: deadline(input),
        },
      ],
    }),
    ...collection(input),
  ];
  if (input.burn)
    calls.push(
      encodeFunctionData({
        abi: V3_ABI,
        functionName: "burn",
        args: [uint(input.token_id)],
      }),
    );
  return plan(
    input,
    "uniswap_v3_remove_liquidity",
    deployment(input.chain_id).v3_position_manager,
    multicall(calls),
  );
}
export function prepareV3Collect(raw: z.input<typeof v3CollectSchema>) {
  const input = v3CollectSchema.parse(raw);
  pair(input.token0, input.token1);
  deadline(input);
  return plan(
    input,
    "uniswap_v3_collect_fees",
    deployment(input.chain_id).v3_position_manager,
    multicall(collection(input)),
  );
}
