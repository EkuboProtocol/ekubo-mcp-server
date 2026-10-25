import { encodeQuoteCalldata, encodeRoutes, MAX_SQRT_RATIO, MIN_SQRT_RATIO, YUL_ROUTER_ABI } from "@ekubo/yul-router-sdk";
import { type Address, decodeFunctionResult, getAddress, type Hex, zeroAddress } from "viem";
import { DEFAULT_SWAP_DEADLINE_MINUTES } from "../../swap-deadline.js";
import { preparedTransaction, preparedUiAction } from "../../ui-actions.js";
import { prepareSwapFromQuote } from "../../yul-router.js";
import type { Launch } from "./api.js";
import { blockSummary, type ChainContext, chainContext, erc20Read, feeAtBlock, getLaunch, launchApi, poolKeyOf } from "./context.js";
import type { PoolKey } from "./codec.js";
import type { LaunchpadEnv } from "./deployment.js";
import { invalidArgument, LaunchpadError } from "./errors.js";
import { feePercent } from "./fee.js";
import { type Block, Reverted } from "./rpc.js";

export const DEFAULT_SLIPPAGE_BPS = 50;
const MAX_INT128 = (1n << 127n) - 1n;

export interface TradeInput {
  chain_id: string;
  sender: string;
  pool_id: string;
  side: "buy" | "sell";
  amount: string;
  slippage_bps?: number;
  deadline_minutes?: number;
  recipient?: string;
}

function checkAmount(amount: string): bigint {
  const value = BigInt(amount);
  if (value === 0n || value > MAX_INT128) throw invalidArgument("amount", "must be from 1 to 2^127 - 1 base units of the input token");
  return value;
}

function hop(key: PoolKey, tokenIn: Address) {
  const inIsToken1 = BigInt(tokenIn) === BigInt(key.token1);
  return { type: "forwarded" as const, pool_key: key, sqrt_ratio_limit: `0x${(inIsToken1 ? MAX_SQRT_RATIO : MIN_SQRT_RATIO).toString(16)}` as Hex, skip_ahead: 0 };
}

/** router.quote of the exact-input forwarded hop at the block; the gross output after the creator fee. */
async function quote(context: ChainContext, sender: Address, key: PoolKey, tokenIn: Address, tokenOut: Address, amount: bigint, block: Block) {
  const swap = hop(key, tokenIn);
  const route = encodeRoutes({
    specifiedToken: tokenIn, calculatedToken: tokenOut, calculatedAmountThreshold: false,
    multiHops: [{ specifiedAmount: amount, hops: [{ type: "forwarded", poolKey: key, sqrtRatioLimit: BigInt(swap.sqrt_ratio_limit), skipAhead: 0 }] }],
  });
  let data: Hex;
  try {
    data = await context.rpc.call(context.deployment.router, encodeQuoteCalldata(route), { from: sender, block });
  } catch (error) {
    if (!(error instanceof Reverted)) throw error;
    throw new LaunchpadError("quote_reverted", `The router quote reverted${error.errorName === null ? "" : ` with ${error.errorName}`}. Nothing was prepared; the amount may exceed what the launch can fill.`, { argument: "amount", retryable: false, contract_error: error.errorName });
  }
  const [, , specified, calculated] = decodeFunctionResult({ abi: YUL_ROUTER_ABI, functionName: "quote", data }) as readonly [Address, Address, bigint, bigint];
  if (specified !== amount || calculated <= 0n) {
    throw new LaunchpadError("insufficient_liquidity", "The launch cannot fill this exact input in full (it stops at its upper price, and has no bid before buyers pay in). Nothing was prepared; lower amount.", { argument: "amount", retryable: false, quoted_input: specified.toString(), quoted_output: calculated.toString() });
  }
  return { swap, output: calculated };
}

function checkRecipient(recipient: Address, context: ChainContext, key: PoolKey): void {
  const refused = [zeroAddress, context.deployment.core, context.deployment.extension, context.deployment.periphery, context.deployment.router, key.token0, key.token1];
  if (refused.some((sink) => getAddress(sink) === recipient)) throw invalidArgument("recipient", "must not be the zero address, Core, the launch contracts, the router or either pool token; output sent there is lost");
}

async function approvalNeeded(context: ChainContext, sender: Address, token: Address, amount: bigint, block: Block): Promise<boolean> {
  if (token === zeroAddress) return false;
  return BigInt(await erc20Read(context, token, "allowance", [sender, context.deployment.router], block)) < amount;
}

function tokens(launch: Launch, side: "buy" | "sell") {
  return side === "buy" ? [launch.quote_token.address, launch.token.address] : [launch.token.address, launch.quote_token.address];
}

export async function prepareTrade(env: LaunchpadEnv, input: TradeInput) {
  const amount = checkAmount(input.amount);
  const sender = getAddress(input.sender);
  const recipient = getAddress(input.recipient ?? sender);
  const slippage = input.slippage_bps ?? DEFAULT_SLIPPAGE_BPS;
  const context = await chainContext(env, input.chain_id);
  const launch = await launchApi(env).launch(input.chain_id, input.pool_id.toLowerCase() as Hex);
  const key = poolKeyOf(launch, context.deployment);
  checkRecipient(recipient, context, key);
  const block = await context.rpc.latestBlock();
  const onchain = await getLaunch(context, launch.pool_id, block);
  if (block.timestamp < onchain.schedule.tradingStart) {
    throw new LaunchpadError("trading_not_started", `Trading opens at Unix ${onchain.schedule.tradingStart}; the latest block is ${block.timestamp}. Nothing was prepared; call again after trading opens.`, { retryable: true, trading_start: onchain.schedule.tradingStart.toString() });
  }
  const [tokenIn, tokenOut] = tokens(launch, input.side);
  const [quoted, fee] = await Promise.all([quote(context, sender, key, tokenIn, tokenOut, amount, block), feeAtBlock(context, launch.pool_id, block)]);
  const deadline = Number(block.timestamp) + (input.deadline_minutes ?? DEFAULT_SWAP_DEADLINE_MINUTES) * 60;
  const prepared = prepareSwapFromQuote({
    quote: {
      block_number: block.number, block_hash: block.hash, total_calculated: quoted.output.toString(), estimated_gas_cost: 0, price_impact: null,
      splits: [{ amount_specified: amount.toString(), amount_calculated: quoted.output.toString(), route: [{ swap: quoted.swap }] }],
    },
    tokenIn, tokenOut, quoteType: "exact_input", amount, slippageBps: slippage,
    recipient: recipient === sender ? undefined : recipient, deadline, routerAddress: context.deployment.router,
  });
  const approve = prepared.approval !== null && await approvalNeeded(context, sender, tokenIn, amount, block);
  const steps = [
    ...(approve ? [{ kind: "approval" as const, transaction: preparedTransaction(input.chain_id, prepared.approval!.transaction.to, prepared.approval!.transaction.data, 0n) }] : []),
    { kind: "execution" as const, transaction: preparedTransaction(input.chain_id, prepared.transaction.to, prepared.transaction.data, prepared.transaction.value) },
  ];
  const minimum = prepared.minimumAmountOut!.toString();
  return preparedUiAction({
    action: "launchpad_trade",
    chainId: input.chain_id,
    sender,
    request: { chain_id: input.chain_id, sender, pool_id: launch.pool_id, side: input.side, amount: amount.toString(), slippage_bps: slippage, deadline },
    steps,
    atomicBatchRequired: false,
    details: {
      summary: `${input.side === "buy" ? "Buy" : "Sell"} with exactly ${amount} base units of ${tokenIn}; expect ${quoted.output} base units of ${tokenOut} after the ${feePercent(fee)} creator fee, at least ${minimum} (slippage ${slippage} bps) or the swap reverts; valid until Unix ${deadline}.`,
      token_in: tokenIn, token_out: tokenOut, amount_in: amount.toString(), expected_amount_out: quoted.output.toString(),
      minimum_amount_out: minimum, slippage_bps: slippage, deadline: String(deadline),
      creator_fee_q64: fee.toString(), creator_fee_percent: feePercent(fee), approval_included: approve,
      recipient, quoted_at: blockSummary(block),
    },
  });
}
