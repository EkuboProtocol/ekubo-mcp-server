import { type Address, encodeFunctionData, getAddress } from "viem";
import { z } from "zod";
import { errorResultDecodePlan } from "../../abi-decode.js";
import { executionPlan } from "../../execution-plan.js";
import { type Deps, type PrepareContext, outputHeader, prepareContext } from "./context.js";
import { NATIVE_TOKEN, type PrepareEnv, launchRouterAbi, launchpadErrorsAbi } from "./contracts.js";
import {
  HOSTED_MAX_MIGRATION_TICK_WIDTH,
  INT128_MAX,
  MAX_TICK,
  MAX_TICK_SPACING,
  MIN_TICK,
  Q64,
  feePercent,
  priceAtTick,
  utf8Length,
} from "./encoding.js";
import { creationFees } from "./fees.js";
import { address, chainId, rawAmount, sender, slippageBps } from "./schema.js";
import { MIGRATION_LOCK_NOTE, PRICE_NOTE, UNTRUSTED_NOTE, prepareError, warning } from "./templates.js";

/** Hosted caps for the prototype. Provisional; not a production fee decision. */
export const INITIAL_FEE_CAP = Q64 / 10n;
export const FINAL_FEE_CAP = Q64 / 100n;
const MAX_STRING_BYTES = 31;
const NATIVE_DECIMALS = 18;
/** A start this close to the pinned block may have passed by the time the transaction lands. */
const START_MARGIN_SECONDS = 1200n;

const q64Fee = z.string().regex(/^(0|[1-9][0-9]{0,19})$/, "a decimal Q0.64 integer string");
const tick = z.number().int().min(MIN_TICK).max(MAX_TICK);

export const prepareCreateSchema = z.object({
  chain_id: chainId,
  sender: sender.describe(
    "The wallet account that signs LaunchRouter.create. It becomes the launch's creator: the only account that can claim creator fees, permanently. The plan is bound to it.",
  ),
  slippage_bps: slippageBps.describe(
    "Required on every launchpad preparation call, with no default. Creation moves no funds, so no threshold is derived from it here.",
  ),
  quote_token: address.describe("Quote asset. The hosted launchpad accepts only native ETH, the zero address."),
  name: z.string().max(256).describe("Token name, 1 to 31 UTF-8 bytes. Immutable."),
  symbol: z.string().max(256).describe("Token symbol, 1 to 31 UTF-8 bytes. Immutable."),
  decimals: z.number().int().min(0).max(255),
  total_supply: rawAmount.describe("Whole supply in raw units, all minted to the extension. The creator receives no allocation."),
  start_time: z.number().int().positive().describe("Unix seconds. Must be after the latest block. Supply releases linearly from here."),
  end_time: z.number().int().positive().describe("Unix seconds, after start_time. After it anyone can advance the launch."),
  target_tick: tick.describe("Bottom of the launch price range, as a tick of raw quote units per raw launch token."),
  upper_tick: tick.describe("Top of the launch price range. Buys stop here."),
  tick_spacing: z.number().int().min(1).max(MAX_TICK_SPACING),
  initial_fee: q64Fee.describe(`Creator fee at start_time, Q0.64 (2^64 = 100%). Hosted cap ${INITIAL_FEE_CAP} (10%).`),
  final_fee: q64Fee.describe(`Creator fee at end_time and the terminal pool fee, Q0.64. Hosted cap ${FINAL_FEE_CAP} (1%).`),
  migration_tick_lower: tick.describe(
    `Lowest terminal price, as a tick, at which principal may migrate. The hosted bounds may span at most ${HOSTED_MAX_MIGRATION_TICK_WIDTH} ticks, just under a 2x price ratio.`,
  ),
  migration_tick_upper: tick.describe("Highest terminal price, as a tick, at which principal may migrate."),
});

export type PrepareCreateInput = z.output<typeof prepareCreateSchema>;

function checkStrings(input: PrepareCreateInput) {
  for (const field of ["name", "symbol"] as const) {
    const length = utf8Length(input[field]);
    if (length < 1 || length > MAX_STRING_BYTES) throw prepareError("string_too_long", { field, max_bytes: MAX_STRING_BYTES });
  }
}

function checkFees(initialFee: bigint, finalFee: bigint) {
  if (initialFee > INITIAL_FEE_CAP) throw prepareError("fee_above_cap", { field: "initial_fee", cap_q64: INITIAL_FEE_CAP.toString() });
  if (finalFee > FINAL_FEE_CAP) throw prepareError("fee_above_cap", { field: "final_fee", cap_q64: FINAL_FEE_CAP.toString() });
  if (initialFee < finalFee) throw prepareError("fee_order");
}

function checkSupply(totalSupply: bigint) {
  if (totalSupply === 0n || totalSupply > INT128_MAX) throw prepareError("invalid_supply");
}

function checkSchedule(input: PrepareCreateInput, blockTimestamp: bigint) {
  if (BigInt(input.start_time) <= blockTimestamp) {
    throw prepareError("start_time_not_future", { block_timestamp: blockTimestamp.toString() });
  }
  if (input.end_time <= input.start_time) throw prepareError("invalid_schedule");
}

function checkTicks(input: PrepareCreateInput) {
  const spacing = input.tick_spacing;
  if (input.target_tick >= input.upper_tick) throw prepareError("invalid_ticks", { field: "upper_tick" });
  for (const field of ["target_tick", "upper_tick"] as const) {
    if (input[field] % spacing !== 0) throw prepareError("invalid_ticks", { field });
  }
  if (input.migration_tick_lower >= input.migration_tick_upper) throw prepareError("invalid_migration_bounds");
  const width = input.migration_tick_upper - input.migration_tick_lower;
  if (width > HOSTED_MAX_MIGRATION_TICK_WIDTH) {
    throw prepareError("migration_bounds_too_wide", { width_ticks: width, max_width_ticks: HOSTED_MAX_MIGRATION_TICK_WIDTH });
  }
}

function checkQuoteAsset(allowlist: Address[], quoteToken: Address) {
  if (!allowlist.includes(quoteToken)) throw prepareError("quote_asset_not_allowed", { allowed_quote_tokens: allowlist });
}

/**
 * The `LaunchConfig` tuple, field for field in ABI order. `owner` is the
 * LaunchRouter itself: the router overwrites it with its own address and
 * records the signer as creator, so the calldata states what takes effect.
 */
function launchConfig(input: PrepareCreateInput, router: Address, quoteToken: Address, amounts: { totalSupply: bigint; initialFee: bigint; finalFee: bigint }) {
  return {
    owner: router,
    quoteToken,
    name: input.name,
    symbol: input.symbol,
    decimals: input.decimals,
    totalSupply: amounts.totalSupply,
    startTime: BigInt(input.start_time),
    endTime: BigInt(input.end_time),
    targetTick: input.target_tick,
    upperTick: input.upper_tick,
    tickSpacing: input.tick_spacing,
    initialFee: amounts.initialFee,
    finalFee: amounts.finalFee,
    migrationTickLower: input.migration_tick_lower,
    migrationTickUpper: input.migration_tick_upper,
  };
}

function createWarnings(context: PrepareContext, startTime: number) {
  return [
    ...(BigInt(startTime) < context.block.timestamp + START_MARGIN_SECONDS ? [warning("start_time_soon")] : []),
    warning("creator_is_permanent"),
    warning("migration_may_stay_pending"),
  ];
}

function migrationBounds(input: PrepareCreateInput) {
  return {
    tick_lower: input.migration_tick_lower,
    tick_upper: input.migration_tick_upper,
    price_lower: priceAtTick(input.migration_tick_lower, input.decimals, NATIVE_DECIMALS),
    price_upper: priceAtTick(input.migration_tick_upper, input.decimals, NATIVE_DECIMALS),
    unit: "quote per whole launch token",
    note: MIGRATION_LOCK_NOTE,
  };
}

function launchRange(input: PrepareCreateInput) {
  return {
    target_tick: input.target_tick,
    upper_tick: input.upper_tick,
    tick_spacing: input.tick_spacing,
    target_price: priceAtTick(input.target_tick, input.decimals, NATIVE_DECIMALS),
    upper_price: priceAtTick(input.upper_tick, input.decimals, NATIVE_DECIMALS),
    unit: "quote per whole launch token",
    price_note: PRICE_NOTE,
  };
}

export async function launchpadPrepareCreate(env: PrepareEnv, raw: z.input<typeof prepareCreateSchema>, deps: Partial<Deps> = {}) {
  const input = prepareCreateSchema.parse(raw);
  checkStrings(input);
  const amounts = {
    totalSupply: BigInt(input.total_supply),
    initialFee: BigInt(input.initial_fee),
    finalFee: BigInt(input.final_fee),
  };
  const quoteToken = getAddress(input.quote_token);
  checkFees(amounts.initialFee, amounts.finalFee);
  checkSupply(amounts.totalSupply);
  checkTicks(input);
  checkQuoteAsset([NATIVE_TOKEN], quoteToken);
  const context = await prepareContext(env, input, deps);
  checkSchedule(input, context.block.timestamp);
  const router = context.manifest.contracts.launch_router;
  const chain = context.manifest.chain_id.toString();
  const plan = executionPlan({
    chainId: chain,
    sender: context.sender,
    transaction: {
      chain_id: chain,
      to: router,
      data: encodeFunctionData({ abi: launchRouterAbi, functionName: "create", args: [launchConfig(input, router, quoteToken, amounts)] }),
      value: "0",
    },
    revertDecode: errorResultDecodePlan(launchpadErrorsAbi),
  });
  return {
    ...outputHeader(context),
    action: "create_launch",
    contract: router,
    value: "0",
    token_approvals: [],
    fee_claimant: context.sender,
    fee_claimant_role: "creator: the account that signs this create; recorded by LaunchRouter and not transferable",
    reference: null,
    launch: {
      quote_token: quoteToken,
      quote_decimals: NATIVE_DECIMALS,
      decimals: input.decimals,
      total_supply: amounts.totalSupply.toString(),
      start_time: input.start_time,
      end_time: input.end_time,
      initial_fee: { q64: amounts.initialFee.toString(), percent: feePercent(amounts.initialFee) },
      final_fee: { q64: amounts.finalFee.toString(), percent: feePercent(amounts.finalFee) },
      range: launchRange(input),
    },
    migration_bounds: migrationBounds(input),
    fees: creationFees({ ...amounts, claimant: context.sender, lockedLiquidity: context.manifest.contracts.locked_launch_liquidity }),
    warnings: createWarnings(context, input.start_time),
    untrusted: { name: input.name, symbol: input.symbol, note: UNTRUSTED_NOTE },
    execution_plan: plan,
  };
}
