import {
  SqrtPriceMath,
  TickMath,
  maxLiquidityForAmounts,
} from "@uniswap/v3-sdk";
import JSBI from "jsbi";
import { z } from "zod";
import { uintSchema, ticksSchema, uint, positive, ticks } from "./common.js";
export const quoteSchema = z.object({
  ...ticksSchema,
  sqrt_price_x96: uintSchema,
  amount0: uintSchema,
  amount1: uintSchema,
  liquidity: uintSchema.optional(),
  slippage_bps: z.number().int().min(0).max(1000).default(50),
});
export function quoteUniswapLiquidity(raw: z.input<typeof quoteSchema>) {
  const input = quoteSchema.parse(raw);
  ticks(input);
  const price = JSBI.BigInt(positive(input.sqrt_price_x96, 160).toString());
  if (
    JSBI.lessThan(price, TickMath.MIN_SQRT_RATIO) ||
    JSBI.greaterThanOrEqual(price, TickMath.MAX_SQRT_RATIO)
  )
    throw new Error("sqrt_price_x96 is outside Uniswap's price bounds");
  const lower = TickMath.getSqrtRatioAtTick(input.tick_lower),
    upper = TickMath.getSqrtRatioAtTick(input.tick_upper);
  const liquidity =
    input.liquidity === undefined
      ? maxLiquidityForAmounts(
          price,
          lower,
          upper,
          uint(input.amount0).toString(),
          uint(input.amount1).toString(),
          true,
        )
      : JSBI.BigInt(positive(input.liquidity, 128).toString());
  positive(liquidity.toString(), 128);
  const mint = positionAmounts(price, lower, upper, liquidity, true);
  const burn = positionAmounts(price, lower, upper, liquidity, false);
  const bps = BigInt(input.slippage_bps);
  const max = (n: string) =>
    ((BigInt(n) * (10000n + bps) + 9999n) / 10000n).toString();
  const min = (n: string) => ((BigInt(n) * (10000n - bps)) / 10000n).toString();
  return {
    liquidity: liquidity.toString(),
    mint_amount0: mint[0],
    mint_amount1: mint[1],
    amount0_max: max(mint[0]),
    amount1_max: max(mint[1]),
    amount0_min: min(burn[0]),
    amount1_min: min(burn[1]),
    input_snapshot: input,
    live_state_queried: false,
    instructions:
      "Raw amounts for this supplied price/range snapshot. V4 uses exact liquidity plus maxima; V3 uses mint amounts as desired inputs. Bounds are token-amount tolerances, not a price quote or fee estimate. Maxima may exceed the input budgets by slippage. A zero bound on one side does not permit spending that currency; reprepare if price crosses the range. Refresh state and simulate before execution.",
  };
}
function positionAmounts(
  price: JSBI,
  lower: JSBI,
  upper: JSBI,
  liquidity: JSBI,
  roundUp: boolean,
): [string, string] {
  if (JSBI.lessThanOrEqual(price, lower))
    return [
      SqrtPriceMath.getAmount0Delta(
        lower,
        upper,
        liquidity,
        roundUp,
      ).toString(),
      "0",
    ];
  if (JSBI.greaterThanOrEqual(price, upper))
    return [
      "0",
      SqrtPriceMath.getAmount1Delta(
        lower,
        upper,
        liquidity,
        roundUp,
      ).toString(),
    ];
  return [
    SqrtPriceMath.getAmount0Delta(price, upper, liquidity, roundUp).toString(),
    SqrtPriceMath.getAmount1Delta(lower, price, liquidity, roundUp).toString(),
  ];
}
