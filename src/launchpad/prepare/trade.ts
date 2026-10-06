import { type Address, decodeFunctionResult, encodeFunctionData, getAddress, type Hex } from "viem";
import { z } from "zod";
import { errorResultDecodePlan } from "../../abi-decode.js";
import { executionPlan, type PreparedTransaction } from "../../execution-plan.js";
import { buildQuoterQuoteUrl, type EvmQuoterQuote, prepareSwapFromQuote } from "../../yul-router.js";
import { type Deps, type PrepareContext, outputHeader, prepareContext } from "./context.js";
import { type PrepareEnv, launchpadErrorsAbi, scheduledLaunchAbi } from "./contracts.js";
import { INT128_MAX, feePercent, poolId } from "./encoding.js";
import { tradeFees } from "./fees.js";
import { type LaunchStage, type ResolvedLaunch, launchStage, resolveLaunch } from "./launch.js";
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

const ROUTE_NOTE =
  "quoter-service chose this route over every indexed Ekubo pool. During the launch, a launch pool hop is a forwarded hop to the ScheduledLaunch extension; after completion the route uses the terminal pool or any other pool.";

export function quoterBase(env: PrepareEnv): string {
  const base = env.LAUNCHPAD_QUOTER_URL || env.EKUBO_QUOTER_URL;
  if (base === undefined || base === "") throw prepareError("launchpad_not_configured");
  return base;
}

async function fetchQuote(context: PrepareContext, url: string): Promise<EvmQuoterQuote> {
  let response: Response;
  try {
    response = await context.fetcher(url, { headers: { accept: "application/json" } });
  } catch {
    throw prepareError("quoter_unavailable");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw prepareError("quoter_unavailable", { status: response.status });
  }
  if (!response.ok) {
    const error = (body as { error?: unknown } | null)?.error;
    throw prepareError("no_route", { status: response.status, quoter_error: typeof error === "string" ? error : null });
  }
  const quote = body as EvmQuoterQuote;
  if (!Array.isArray(quote?.splits)) throw prepareError("quoter_invalid_response");
  return quote;
}

interface RouteHop {
  type: "core" | "forwarded" | "wrapper";
  pool_id: Hex | null;
  extension: Address | null;
  launch_pool: boolean;
  this_launch: boolean;
  forwardee: Address | null;
  allow_partial: boolean;
}

/**
 * Every swap hop through the manifest's ScheduledLaunch must be a forwarded
 * hop to that extension, and no forwarded hop may name a forwardee other than
 * its pool's extension. Anything else is refused before a plan is built.
 */
function routeHops(context: PrepareContext, launch: ResolvedLaunch, quote: EvmQuoterQuote): RouteHop[][] {
  const extension = context.manifest.contracts.scheduled_launch;
  return quote.splits.map((split) =>
    split.route.map((node) => {
      if (node.swap === undefined) {
        return { type: "wrapper", pool_id: null, extension: null, launch_pool: false, this_launch: false, forwardee: null, allow_partial: false };
      }
      const key = node.swap.pool_key;
      const poolExtension = getAddress(`0x${BigInt(key.config).toString(16).padStart(64, "0").slice(0, 40)}`);
      const forwardee = node.swap.forwardee === undefined ? null : getAddress(node.swap.forwardee);
      const launchPool = poolExtension === extension;
      if (launchPool && node.swap.type !== "forwarded") throw prepareError("quoter_invalid_response", { reason: "launch_pool_not_forwarded" });
      if (forwardee !== null && forwardee !== poolExtension) throw prepareError("quoter_invalid_response", { reason: "unexpected_forwardee" });
      const id = poolId({ token0: getAddress(key.token0), token1: getAddress(key.token1), config: key.config });
      return {
        type: node.swap.type,
        pool_id: id,
        extension: poolExtension,
        launch_pool: launchPool,
        this_launch: id === launch.poolId,
        forwardee,
        allow_partial: node.swap.allow_partial === true,
      };
    }),
  );
}

async function feeAtBlock(context: PrepareContext, launch: ResolvedLaunch): Promise<bigint> {
  const result = await context.chain.call({
    from: context.sender,
    to: context.manifest.contracts.scheduled_launch,
    data: encodeFunctionData({ abi: scheduledLaunchAbi, functionName: "feeAt", args: [launch.poolId] }),
    block: context.block,
  });
  if (!result.ok) throw prepareError("rpc_unavailable");
  return decodeFunctionResult({ abi: scheduledLaunchAbi, functionName: "feeAt", data: result.data }) as bigint;
}

const tx = (chain: string, t: { to: Address; data: Hex; value: bigint }): PreparedTransaction => ({
  chain_id: chain,
  to: t.to,
  data: t.data,
  value: t.value.toString(),
});

function checkPhase(stage: LaunchStage, launch: ResolvedLaunch) {
  if (stage === "scheduled") throw prepareError("launch_not_started", { start_time: launch.state.startTime.toString() });
  if (stage === "ended_pending_advance") throw prepareError("launch_needs_advance", { phase: stage });
}

type Prepared = ReturnType<typeof prepareSwapFromQuote>;

/** quoter-service's route for the trade, encoded for the manifest's Yul router exactly as the swap tools encode it. */
async function routeTrade(context: PrepareContext, launch: ResolvedLaunch, input: PrepareTradeInput, quoterUrl: string) {
  const buy = input.side === "buy";
  const tokenIn = buy ? launch.quoteToken : launch.token;
  const tokenOut = buy ? launch.token : launch.quoteToken;
  const amount = BigInt(input.amount);
  const url = buildQuoterQuoteUrl({ quoterUrl, chainId: context.manifest.chain_id, tokenIn, tokenOut, quoteType: input.amount_kind, amount });
  const quote = await fetchQuote(context, url);
  const hops = routeHops(context, launch, quote);
  try {
    const prepared = prepareSwapFromQuote({
      quote,
      tokenIn,
      tokenOut,
      quoteType: input.amount_kind,
      amount,
      slippageBps: input.slippage_bps,
      recipient: context.sender,
      routerAddress: context.manifest.contracts.router,
    });
    return { prepared, hops, tokenIn };
  } catch (error) {
    throw prepareError("quoter_invalid_response", { reason: (error as Error).message });
  }
}

/** The approval, swap and, for an exact output, the allowance reset, in the swap tools' order. */
function tradePlan(context: PrepareContext, prepared: Prepared, exactOutput: boolean) {
  const chain = context.manifest.chain_id.toString();
  const approval = prepared.approval;
  const approvals = approval === null ? [] : [tx(chain, approval.transaction)];
  const cleanup =
    exactOutput && approval !== null
      ? [tx(chain, { to: approval.token, data: encodeFunctionData({ abi: ERC20_APPROVE, functionName: "approve", args: [approval.spender, 0n] }), value: 0n })]
      : [];
  return executionPlan({
    chainId: chain,
    sender: context.sender,
    approvals,
    transaction: tx(chain, prepared.transaction),
    postExecutionTransactions: cleanup,
    atomicBatchRequired: approvals.length > 0 || cleanup.length > 0,
    revertDecode: errorResultDecodePlan(launchpadErrorsAbi),
  });
}

function quoteView(prepared: Prepared, amount: string) {
  return {
    source: "quoter-service",
    quoter_block_number: prepared.block.number.toString(),
    quoter_block_hash: prepared.block.hash,
    requested_amount: amount,
    filled_amount: prepared.filledAmount.toString(),
    partial_fill: prepared.partialFill,
    amount_in: prepared.amountIn.toString(),
    amount_out: prepared.amountOut.toString(),
    fee_inclusive: true,
    estimated_route_gas: prepared.estimatedRouteGas,
    price_impact: prepared.priceImpact,
  };
}

export async function launchpadPrepareTrade(env: PrepareEnv, raw: z.input<typeof prepareTradeSchema>, deps: Partial<Deps> = {}) {
  const input = prepareTradeSchema.parse(raw);
  const amount = BigInt(input.amount);
  if (amount === 0n || amount > INT128_MAX) throw prepareError("invalid_amount");
  const quoterUrl = quoterBase(env);
  const context = await prepareContext(env, input, deps);
  const launch = await resolveLaunch(context, { token: input.token });
  const stage = launchStage(launch, context.block.timestamp);
  checkPhase(stage, launch);
  const { prepared, hops, tokenIn } = await routeTrade(context, launch, input, quoterUrl);
  const launchHop = hops.flat().some((hop) => hop.this_launch);
  const fee = launchHop && stage === "launch" ? await feeAtBlock(context, launch) : null;
  return {
    ...outputHeader(context),
    action: "trade",
    contract: prepared.transaction.to,
    token: launch.token,
    quote_token: launch.quoteToken,
    pool_id: launch.poolId,
    phase: stage,
    side: input.side,
    amount_kind: input.amount_kind,
    recipient: context.sender,
    quote: quoteView(prepared, input.amount),
    route: { splits: hops, note: ROUTE_NOTE },
    creator_fee_at_block: fee === null ? null : { q64: fee.toString(), percent: feePercent(fee) },
    threshold: {
      calculated_amount_threshold: prepared.calculatedAmountThreshold.toString(),
      meaning: input.amount_kind === "exact_input" ? "minimum_output" : "maximum_input",
      note: THRESHOLD_NOTE,
    },
    max_payment: { token: tokenIn, amount: (prepared.maximumAmountIn ?? prepared.amountIn).toString() },
    fees: tradeFees({ launchHop, feeAtBlock: fee, claimant: launch.indexed.creator }),
    warnings: prepared.partialFill ? [warning("partial_fill")] : [],
    execution_plan: tradePlan(context, prepared, input.amount_kind === "exact_output"),
  };
}

const ERC20_APPROVE = [
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
