import {
  encodeFunctionData,
  parseAbi,
  getCreate2Address,
  keccak256,
  encodePacked,
} from "viem";
import { z } from "zod";
import {
  actionSchema,
  tokensSchema,
  amountsSchema,
  uintSchema,
  deployment,
  deadline,
  pair,
  amounts,
  positive,
  uint,
  plan,
} from "./common.js";
export const V2_ABI = parseAbi([
  "function addLiquidity(address tokenA,address tokenB,uint256 amountADesired,uint256 amountBDesired,uint256 amountAMin,uint256 amountBMin,address to,uint256 deadline) returns (uint256 amountA,uint256 amountB,uint256 liquidity)",
  "function addLiquidityETH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline) payable returns (uint256 amountToken,uint256 amountETH,uint256 liquidity)",
  "function removeLiquidity(address tokenA,address tokenB,uint256 liquidity,uint256 amountAMin,uint256 amountBMin,address to,uint256 deadline) returns (uint256 amountA,uint256 amountB)",
  "function removeLiquidityETH(address token,uint256 liquidity,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline) returns (uint256 amountToken,uint256 amountETH)",
]);
export const v2AddSchema = actionSchema.extend({
  ...tokensSchema,
  ...amountsSchema,
  use_native: z.boolean().default(false),
});
export const v2RemoveSchema = actionSchema.extend({
  ...tokensSchema,
  liquidity: uintSchema,
  amount0_min: uintSchema,
  amount1_min: uintSchema,
  unwrap_native: z.boolean().default(false),
});
export function v2PairAddress(
  chain: string,
  token0: `0x${string}`,
  token1: `0x${string}`,
) {
  pair(token0, token1);
  return getCreate2Address({
    from: deployment(chain).v2_factory,
    salt: keccak256(encodePacked(["address", "address"], [token0, token1])),
    bytecodeHash:
      "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f",
  });
}
function nativeAmounts(
  input: { chain_id: string; token0: `0x${string}`; token1: `0x${string}` },
  a0: bigint,
  a1: bigint,
  m0: bigint,
  m1: bigint,
) {
  const weth = deployment(input.chain_id).wrapped_native;
  if (input.token0 === weth)
    return {
      token: input.token1,
      amount: a1,
      min: m1,
      native: a0,
      nativeMin: m0,
    };
  if (input.token1 === weth)
    return {
      token: input.token0,
      amount: a0,
      min: m0,
      native: a1,
      nativeMin: m1,
    };
  throw new Error("Native operation requires wrapped native in the pair");
}
export function prepareV2Add(raw: z.input<typeof v2AddSchema>) {
  const input = v2AddSchema.parse(raw);
  pair(input.token0, input.token1);
  const expiry = deadline(input),
    d = deployment(input.chain_id),
    [a0, a1, m0, m1] = amounts(input);
  if (input.use_native) {
    const n = nativeAmounts(input, a0, a1, m0, m1);
    return plan(
      input,
      "uniswap_v2_add_liquidity",
      d.v2_router,
      encodeFunctionData({
        abi: V2_ABI,
        functionName: "addLiquidityETH",
        args: [n.token, n.amount, n.min, n.nativeMin, input.sender, expiry],
      }),
      n.native,
      [{ token: n.token, amount: n.amount }],
    );
  }
  return plan(
    input,
    "uniswap_v2_add_liquidity",
    d.v2_router,
    encodeFunctionData({
      abi: V2_ABI,
      functionName: "addLiquidity",
      args: [input.token0, input.token1, a0, a1, m0, m1, input.sender, expiry],
    }),
    0n,
    [
      { token: input.token0, amount: a0 },
      { token: input.token1, amount: a1 },
    ],
  );
}
export function prepareV2Remove(raw: z.input<typeof v2RemoveSchema>) {
  const input = v2RemoveSchema.parse(raw);
  pair(input.token0, input.token1);
  const expiry = deadline(input),
    d = deployment(input.chain_id),
    liquidity = positive(input.liquidity);
  const m0 = uint(input.amount0_min),
    m1 = uint(input.amount1_min);
  const spending = [
    {
      token: v2PairAddress(input.chain_id, input.token0, input.token1),
      amount: liquidity,
    },
  ];
  if (input.unwrap_native) {
    const n = nativeAmounts(input, 0n, 0n, m0, m1);
    return plan(
      input,
      "uniswap_v2_remove_liquidity",
      d.v2_router,
      encodeFunctionData({
        abi: V2_ABI,
        functionName: "removeLiquidityETH",
        args: [n.token, liquidity, n.min, n.nativeMin, input.sender, expiry],
      }),
      0n,
      spending,
    );
  }
  return plan(
    input,
    "uniswap_v2_remove_liquidity",
    d.v2_router,
    encodeFunctionData({
      abi: V2_ABI,
      functionName: "removeLiquidity",
      args: [
        input.token0,
        input.token1,
        liquidity,
        m0,
        m1,
        input.sender,
        expiry,
      ],
    }),
    0n,
    spending,
  );
}
