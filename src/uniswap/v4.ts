import { verifyV4Pool } from "./pool-key.js";
import { Actions, V4Planner } from "@uniswap/v4-sdk";
import { encodeFunctionData, parseAbi, zeroAddress, type Hex } from "viem";
import { z } from "zod";
import {
  actionSchema,
  tokensSchema,
  ticksSchema,
  addressSchema,
  uintSchema,
  bytesSchema,
  deployment,
  deadline,
  pair,
  ticks,
  positive,
  uint,
} from "./common.js";
import {
  erc20ApprovalTransaction,
  preparedTransaction,
  preparedUiAction,
} from "../ui-actions.js";
import type { ExecutionPlanStepInput } from "../execution-plan.js";
export const V4_ABI = parseAbi([
  "function modifyLiquidities(bytes unlockData,uint256 deadline) payable",
  "function initializePool((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,uint160 sqrtPriceX96) payable returns (int24 tick)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function nextTokenId() view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)",
  "function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,uint256 info)",
]);
export const PERMIT2_ABI = parseAbi([
  "function approve(address token,address spender,uint160 amount,uint48 expiration)",
  "function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)",
]);
const poolFields = {
  pool_id: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  ...tokensSchema,
  fee: z.number().int().min(0).max(8388608),
  tick_spacing: ticksSchema.tick_spacing,
  hooks: addressSchema.default(zeroAddress),
  hook_data: bytesSchema.default("0x"),
};
export const v4AddSchema = actionSchema.extend({
  ...poolFields,
  ...ticksSchema,
  liquidity: uintSchema,
  amount0_max: uintSchema,
  amount1_max: uintSchema,
  token_id: uintSchema.optional(),
  initialize_sqrt_price_x96: uintSchema.optional(),
});
export const v4RemoveSchema = actionSchema.extend({
  ...poolFields,
  token_id: uintSchema,
  liquidity: uintSchema,
  amount0_min: uintSchema,
  amount1_min: uintSchema,
  burn: z.boolean().default(false),
});
export const v4CollectSchema = actionSchema.extend({
  ...poolFields,
  token_id: uintSchema,
});
function validatePool(
  input: z.infer<typeof v4CollectSchema> | z.infer<typeof v4AddSchema>,
) {
  pair(input.token0, input.token1, true);
  verifyV4Pool(input);
  if (input.fee > 1000000 && input.fee !== 8388608)
    throw new Error(
      "Invalid V4 fee: use <=1000000 or the dynamic fee flag 8388608",
    );
  if (input.fee === 8388608 && input.hooks === zeroAddress)
    throw new Error("Dynamic fees require a hook");
}
function key(input: z.infer<typeof v4AddSchema>) {
  return {
    currency0: input.token0,
    currency1: input.token1,
    fee: input.fee,
    tickSpacing: input.tick_spacing,
    hooks: input.hooks,
  };
}
function approvalSteps(
  input: z.infer<typeof v4AddSchema>,
  cleanup: boolean,
): ExecutionPlanStepInput[] {
  const d = deployment(input.chain_id),
    kind = cleanup ? "allowance_cleanup" : "approval";
  return [
    { token: input.token0, amount: uint(input.amount0_max, 128) },
    { token: input.token1, amount: uint(input.amount1_max, 128) },
  ]
    .filter((s) => s.token !== zeroAddress && s.amount > 0n)
    .flatMap((s) => {
      const amount = cleanup ? 0n : s.amount;
      const erc20 = {
        kind,
        transaction: erc20ApprovalTransaction(
          input.chain_id,
          s.token,
          d.permit2,
          amount,
        ),
      } as ExecutionPlanStepInput;
      const permit = {
        kind,
        transaction: preparedTransaction(
          input.chain_id,
          d.permit2,
          encodeFunctionData({
            abi: PERMIT2_ABI,
            functionName: "approve",
            args: [
              s.token,
              d.v4_position_manager,
              amount,
              cleanup ? 0 : Number(deadline(input)),
            ],
          }),
          0n,
        ),
      } as ExecutionPlanStepInput;
      return cleanup ? [permit, erc20] : [erc20, permit];
    });
}
function modify(planner: V4Planner, expiry: bigint) {
  return encodeFunctionData({
    abi: V4_ABI,
    functionName: "modifyLiquidities",
    args: [planner.finalize() as Hex, expiry],
  });
}
export function prepareV4Add(raw: z.input<typeof v4AddSchema>) {
  const input = v4AddSchema.parse(raw);
  validatePool(input);
  ticks(input);
  const expiry = deadline(input),
    d = deployment(input.chain_id),
    liquidity = positive(input.liquidity, 128);
  const a0 = uint(input.amount0_max, 128),
    a1 = uint(input.amount1_max, 128);
  if (a0 + a1 === 0n)
    throw new Error("At least one maximum amount must be positive");
  const planner = new V4Planner(),
    calls: Hex[] = [];
  addPositionAction(planner, input, liquidity, a0, a1);
  if (input.token0 === zeroAddress)
    planner.addAction(Actions.SWEEP, [zeroAddress, input.sender]);
  if (input.initialize_sqrt_price_x96 !== undefined) {
    if (input.token_id !== undefined)
      throw new Error("Pool initialization is only supported for mint");
    calls.push(
      encodeFunctionData({
        abi: V4_ABI,
        functionName: "initializePool",
        args: [key(input), positive(input.initialize_sqrt_price_x96, 160)],
      }),
    );
  }
  calls.push(modify(planner, expiry));
  const transaction = preparedTransaction(
    input.chain_id,
    d.v4_position_manager,
    encodeFunctionData({
      abi: V4_ABI,
      functionName: "multicall",
      args: [calls],
    }),
    input.token0 === zeroAddress ? a0 : 0n,
  );
  return preparedUiAction({
    action: "uniswap_v4_add_liquidity",
    chainId: input.chain_id,
    sender: input.sender,
    request: input,
    steps: [
      ...approvalSteps(input, false),
      { kind: "execution", transaction },
      ...approvalSteps(input, true),
    ],
    atomicBatchRequired: true,
    details: {
      protocol: "uniswap",
      live_state_queried: false,
      hook_data: input.hook_data,
      exact_permit2_approval_and_cleanup: true,
    },
  });
}
function addPositionAction(
  planner: V4Planner,
  input: z.infer<typeof v4AddSchema>,
  liquidity: bigint,
  a0: bigint,
  a1: bigint,
) {
  if (input.token_id === undefined) {
    planner.addAction(Actions.MINT_POSITION, [
      key(input),
      input.tick_lower,
      input.tick_upper,
      liquidity.toString(),
      a0.toString(),
      a1.toString(),
      input.sender,
      input.hook_data,
    ]);
    planner.addAction(Actions.SETTLE_PAIR, [input.token0, input.token1]);
  } else {
    planner.addAction(Actions.INCREASE_LIQUIDITY, [
      uint(input.token_id).toString(),
      liquidity.toString(),
      a0.toString(),
      a1.toString(),
      input.hook_data,
    ]);
    planner.addAction(Actions.CLOSE_CURRENCY, [input.token0]);
    planner.addAction(Actions.CLOSE_CURRENCY, [input.token1]);
  }
}
function withdrawal(
  input: z.infer<typeof v4CollectSchema>,
  planner: V4Planner,
  action: string,
) {
  validatePool(input);
  planner.addAction(Actions.TAKE_PAIR, [
    input.token0,
    input.token1,
    input.sender,
  ]);
  return preparedUiAction({
    action,
    chainId: input.chain_id,
    sender: input.sender,
    request: input,
    transaction: preparedTransaction(
      input.chain_id,
      deployment(input.chain_id).v4_position_manager,
      modify(planner, deadline(input)),
      0n,
    ),
    details: { protocol: "uniswap", live_state_queried: false },
  });
}
export function prepareV4Remove(raw: z.input<typeof v4RemoveSchema>) {
  const input = v4RemoveSchema.parse(raw),
    planner = new V4Planner();
  const id = uint(input.token_id).toString(),
    liq = uint(input.liquidity, 128).toString(),
    a0 = uint(input.amount0_min, 128).toString(),
    a1 = uint(input.amount1_min, 128).toString();
  if (input.burn) {
    if (liq !== "0")
      throw new Error(
        "burn removes the entire position: set liquidity to 0 and minima for the full withdrawal",
      );
    planner.addAction(Actions.BURN_POSITION, [id, a0, a1, input.hook_data]);
  } else {
    positive(liq, 128);
    planner.addAction(Actions.DECREASE_LIQUIDITY, [
      id,
      liq,
      a0,
      a1,
      input.hook_data,
    ]);
  }
  return withdrawal(input, planner, "uniswap_v4_remove_liquidity");
}
export function prepareV4Collect(raw: z.input<typeof v4CollectSchema>) {
  const input = v4CollectSchema.parse(raw),
    planner = new V4Planner();
  planner.addAction(Actions.DECREASE_LIQUIDITY, [
    uint(input.token_id).toString(),
    "0",
    "0",
    "0",
    input.hook_data,
  ]);
  return withdrawal(input, planner, "uniswap_v4_collect_fees");
}
