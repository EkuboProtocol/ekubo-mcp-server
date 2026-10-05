import { type Address, decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import { z } from "zod";
import { errorResultDecodePlan } from "../../abi-decode.js";
import { executionPlan, type PreparedTransaction } from "../../execution-plan.js";
import { type ChainFactory, DEADLINE_SECONDS, type PrepareContext, approval, outputHeader, prepareContext } from "./context.js";
import { NATIVE_TOKEN, type PrepareEnv, launchRouterAbi, launchpadErrorsAbi, revertErrorName, routerAbi, scheduledLaunchAbi } from "./contracts.js";
import { INT128_MAX, type PoolKey, balanceUpdate, feePercent, sqrtRatioAtTick, swapParameters } from "./encoding.js";
import { launchTradeFees, terminalTradeFees } from "./fees.js";
import { type ResolvedLaunch, launchStage, resolveLaunch } from "./launch.js";
import { address, chainId, rawAmount, sender, slippageBps } from "./schema.js";
import { THRESHOLD_NOTE, prepareError, warning } from "./templates.js";

export const prepareTradeSchema = z.object({
  chain_id: chainId,
  sender,
  slippage_bps: slippageBps,
  token: address.describe("Exact launch token address. Names and symbols are not accepted."),
  side: z.enum(["buy", "sell"]).describe("buy pays the quote asset for the launch token; sell pays the launch token for the quote asset."),
  amount_kind: z.enum(["exact_input", "exact_output"]),
  amount: rawAmount.describe("Raw units of the input token for exact_input, of the output token for exact_output."),
});

export type PrepareTradeInput = z.output<typeof prepareTradeSchema>;

/** One swap request, oriented on the pool key. */
interface Orientation {
  isToken1: boolean;
  exactInput: boolean;
  amount: bigint;
  /** Signed as the contracts expect: positive exact input, negative exact output. */
  signedAmount: bigint;
  inputToken: Address;
  outputToken: Address;
}

function orient(launch: ResolvedLaunch, input: PrepareTradeInput): Orientation {
  const buy = input.side === "buy";
  const exactInput = input.amount_kind === "exact_input";
  const amount = BigInt(input.amount);
  if (amount === 0n || amount > INT128_MAX) throw prepareError("invalid_amount");
  const inputToken = buy ? launch.quoteToken : launch.token;
  const outputToken = buy ? launch.token : launch.quoteToken;
  const specified = exactInput ? inputToken : outputToken;
  return {
    isToken1: specified === launch.key.token1,
    exactInput,
    amount,
    signedAmount: exactInput ? amount : -amount,
    inputToken,
    outputToken,
  };
}

/**
 * The launch-phase price limit: the top of the launch range for a buy, the
 * target for a sell, in pool orientation. Never the default limit, which lets
 * a buy into an empty range push the price to the extreme and stall releases.
 */
function launchLimit(launch: ResolvedLaunch, side: "buy" | "sell") {
  const economicTick = side === "buy" ? launch.upperTick : launch.targetTick;
  const tick = launch.tokenIs0 ? economicTick : -economicTick;
  return {
    sqrt_ratio: sqrtRatioAtTick(tick),
    pool_tick: tick,
    position: side === "buy" ? "top_of_launch_range" : "bottom_of_launch_range",
  };
}

interface Quote {
  filledSpecified: bigint;
  /** From the swapper's side: positive is received, negative is paid. Fee-inclusive. */
  calculated: bigint;
}

function readQuote(update: Hex, orientation: Orientation): Quote {
  const { delta0, delta1 } = balanceUpdate(update);
  const [specified, calculated] = orientation.isToken1 ? [delta1, delta0] : [delta0, delta1];
  return { filledSpecified: specified, calculated: -calculated };
}

function threshold(quote: Quote, orientation: Orientation, slippageBps: number): bigint {
  const bps = BigInt(slippageBps);
  if (orientation.exactInput) return (quote.calculated * (10_000n - bps)) / 10_000n;
  const paid = -quote.calculated;
  return -((paid * (10_000n + bps) + 9_999n) / 10_000n);
}

function checkFill(quote: Quote, orientation: Orientation, partialAllowed: boolean) {
  const partial = quote.filledSpecified !== orientation.signedAmount;
  const fillable = quote.filledSpecified < 0n ? -quote.filledSpecified : quote.filledSpecified;
  if (partial && !partialAllowed) throw prepareError("partial_fill_not_allowed", { fillable_amount: fillable.toString() });
  if (orientation.exactInput && quote.calculated <= 0n) throw prepareError("no_output");
  return partial;
}

async function quoteCall(context: PrepareContext, to: Address, data: Hex) {
  const result = await context.chain.call({ from: context.sender, to, data, block: context.block });
  if (!result.ok) throw revertError(result.revert);
  return result.data;
}

/** A reverted quote as a tool error, naming the two contract refusals a caller can act on. */
function revertError(revert: Hex) {
  const errorName = revertErrorName(revert);
  const details = { revert_data: revert, error_name: errorName };
  if (errorName === "Reentrant") return prepareError("nested_routed_action", details);
  if (errorName === "PositionsThroughExtensionOnly") return prepareError("launch_pool_liquidity_rejected", details);
  return prepareError("quote_reverted", details);
}

/** The most the sender can pay: the full exact input, or the slippage-bounded maximum for an exact output. */
function maxPayment(orientation: Orientation, minCalculated: bigint): bigint {
  return orientation.exactInput ? orientation.amount : -minCalculated;
}

function fundingSteps(context: PrepareContext, orientation: Orientation, spender: Address, payment: bigint, cleanup: boolean) {
  if (orientation.inputToken === NATIVE_TOKEN) return { approvals: [], cleanup: [], value: payment };
  const chain = context.manifest.chain_id;
  return {
    approvals: [approval(chain, orientation.inputToken, spender, payment)],
    // An approval sized above the actual spend would outlive the call.
    cleanup: cleanup ? [approval(chain, orientation.inputToken, spender, 0n)] : [],
    value: 0n,
  };
}

function quoteView(quote: Quote, orientation: Orientation, contract: Address) {
  const abs = (value: bigint) => (value < 0n ? -value : value);
  return {
    contract,
    requested_amount: orientation.amount.toString(),
    filled_specified_amount: abs(quote.filledSpecified).toString(),
    calculated_amount: abs(quote.calculated).toString(),
    calculated_side: orientation.exactInput ? "output_received" : "input_paid",
    fee_inclusive: true,
  };
}

async function launchTrade(context: PrepareContext, launch: ResolvedLaunch, input: PrepareTradeInput) {
  const orientation = orient(launch, input);
  const router = context.manifest.contracts.launch_router;
  const limit = launchLimit(launch, input.side);
  const params = swapParameters(limit.sqrt_ratio, orientation.signedAmount, orientation.isToken1);
  const raw = await quoteCall(context, router, encodeFunctionData({ abi: launchRouterAbi, functionName: "quote", args: [launch.key, params] }));
  const [update, fee] = decodeFunctionResult({ abi: launchRouterAbi, functionName: "quote", data: raw }) as readonly [Hex, bigint];
  const quote = readQuote(update, orientation);
  // LaunchRouter fills exact inputs partially at the top of the range; exact outputs must fill.
  const partial = checkFill(quote, orientation, orientation.exactInput);
  const minCalculated = threshold(quote, orientation, input.slippage_bps);
  const payment = maxPayment(orientation, minCalculated);
  const funding = fundingSteps(context, orientation, router, payment, partial || !orientation.exactInput);
  const deadline = context.block.timestamp + DEADLINE_SECONDS;
  const transaction: PreparedTransaction = {
    chain_id: context.manifest.chain_id.toString(),
    to: router,
    data: encodeFunctionData({
      abi: launchRouterAbi,
      functionName: "swap",
      args: [launch.key, params, minCalculated, context.sender, deadline],
    }),
    value: funding.value.toString(),
  };
  return {
    trading_phase: "launch",
    quote: { ...quoteView(quote, orientation, router), fee_rate: { q64: fee.toString(), percent: feePercent(fee) } },
    price_limit: { sqrt_ratio: limit.sqrt_ratio.toString(), pool_tick: limit.pool_tick, position: limit.position },
    deadline: deadline.toString(),
    fees: launchTradeFees({ feeAtBlock: fee, beneficiary: launch.state.owner }),
    warnings: partial ? [warning("partial_fill")] : [],
    ...planFields(context, orientation, minCalculated, payment, funding, transaction),
  };
}

function planFields(
  context: PrepareContext,
  orientation: Orientation,
  minCalculated: bigint,
  payment: bigint,
  funding: { approvals: PreparedTransaction[]; cleanup: PreparedTransaction[] },
  transaction: PreparedTransaction,
) {
  return {
    threshold: {
      calculated_amount_threshold: minCalculated.toString(),
      meaning: orientation.exactInput ? "minimum_output" : "maximum_input",
      note: THRESHOLD_NOTE,
    },
    max_payment: { token: orientation.inputToken, amount: payment.toString() },
    execution_plan: executionPlan({
      chainId: context.manifest.chain_id.toString(),
      sender: context.sender,
      approvals: funding.approvals,
      transaction,
      postExecutionTransactions: funding.cleanup,
      revertDecode: errorResultDecodePlan(launchpadErrorsAbi),
    }),
  };
}

async function terminalKey(context: PrepareContext, launch: ResolvedLaunch): Promise<PoolKey> {
  const raw = await quoteCall(
    context,
    context.manifest.contracts.scheduled_launch,
    encodeFunctionData({ abi: scheduledLaunchAbi, functionName: "terminalPool", args: [launch.key] }),
  );
  return decodeFunctionResult({ abi: scheduledLaunchAbi, functionName: "terminalPool", data: raw }) as unknown as PoolKey;
}

function terminalTransaction(context: PrepareContext, key: PoolKey, params: Hex, minCalculated: bigint, orientation: Orientation, value: bigint): PreparedTransaction {
  const swap = encodeFunctionData({ abi: routerAbi, functionName: "swap", args: [key, params, minCalculated, context.sender] });
  // The router refunds unused native input only through refundNativeToken.
  const refund = value !== 0n && !orientation.exactInput;
  return {
    chain_id: context.manifest.chain_id.toString(),
    to: context.manifest.contracts.router,
    data: refund
      ? encodeFunctionData({ abi: routerAbi, functionName: "multicall", args: [[swap, encodeFunctionData({ abi: routerAbi, functionName: "refundNativeToken" })]] })
      : swap,
    value: value.toString(),
  };
}

async function terminalTrade(context: PrepareContext, launch: ResolvedLaunch, input: PrepareTradeInput) {
  const orientation = orient(launch, input);
  const router = context.manifest.contracts.router;
  const key = await terminalKey(context, launch);
  const raw = await quoteCall(
    context,
    router,
    encodeFunctionData({ abi: routerAbi, functionName: "quote", args: [key, orientation.isToken1, orientation.signedAmount, 0n, 0n] }),
  );
  const [update] = decodeFunctionResult({ abi: routerAbi, functionName: "quote", data: raw }) as readonly [Hex, Hex];
  const quote = readQuote(update, orientation);
  checkFill(quote, orientation, false);
  const minCalculated = threshold(quote, orientation, input.slippage_bps);
  const payment = maxPayment(orientation, minCalculated);
  const funding = fundingSteps(context, orientation, router, payment, !orientation.exactInput);
  const params = swapParameters(0n, orientation.signedAmount, orientation.isToken1);
  const poolFee = (BigInt(key.config) >> 32n) & ((1n << 64n) - 1n);
  return {
    trading_phase: "terminal",
    quote: quoteView(quote, orientation, router),
    price_limit: { sqrt_ratio: "0", position: "router_default" },
    deadline: null,
    fees: terminalTradeFees({ poolFee, lockedLiquidity: context.manifest.contracts.locked_launch_liquidity, beneficiary: launch.state.owner }),
    warnings: [],
    ...planFields(context, orientation, minCalculated, payment, funding, terminalTransaction(context, key, params, minCalculated, orientation, funding.value)),
  };
}

export async function launchpadPrepareTrade(env: PrepareEnv, raw: z.input<typeof prepareTradeSchema>, chainFactory: ChainFactory) {
  const input = prepareTradeSchema.parse(raw);
  const context = await prepareContext(env, input, chainFactory);
  const launch = await resolveLaunch(context, input.token);
  const stage = launchStage(launch, context.block.timestamp);
  if (stage === "scheduled") throw prepareError("launch_not_started", { start_time: launch.state.startTime.toString() });
  if (stage === "ended_pending_advance") throw prepareError("launch_needs_advance", { phase: stage });
  const body = stage === "launch" ? await launchTrade(context, launch, input) : await terminalTrade(context, launch, input);
  return {
    ...outputHeader(context),
    action: "trade",
    token: launch.token,
    quote_token: launch.quoteToken,
    pool_id: launch.poolId,
    side: input.side,
    amount_kind: input.amount_kind,
    recipient: context.sender,
    beneficiary: launch.state.owner,
    ...body,
  };
}
