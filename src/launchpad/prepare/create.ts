import { type Address, encodeFunctionData, getAddress, zeroAddress } from "viem";
import { z } from "zod";
import { errorResultDecodePlan } from "../../abi-decode.js";
import { executionPlan } from "../../execution-plan.js";
import { type ChainFactory, DEADLINE_SECONDS, type PrepareContext, approval, outputHeader, prepareContext, quoteDecimals } from "./context.js";
import { NATIVE_TOKEN, type PrepareEnv, launchRouterAbi } from "./contracts.js";
import { INT128_MAX, MAX_TICK, MAX_TICK_SPACING, MIN_TICK, Q64, feePercent, priceAtTick, utf8Length } from "./encoding.js";
import { creationFees } from "./fees.js";
import { address, chainId, rawAmount, sender, slippageBps } from "./schema.js";
import { MIGRATION_LOCK_NOTE, PRICE_NOTE, UNTRUSTED_NOTE, prepareError, warning } from "./templates.js";

/** Hosted caps for the prototype. Provisional; not a production fee decision. */
export const INITIAL_FEE_CAP = Q64 / 10n;
export const FINAL_FEE_CAP = Q64 / 100n;
const MAX_STRING_BYTES = 31;

const q64Fee = z.string().regex(/^(0|[1-9][0-9]{0,19})$/, "a decimal Q0.64 integer string");
const tick = z.number().int().min(MIN_TICK).max(MAX_TICK);

export const prepareCreateSchema = z.object({
  chain_id: chainId,
  sender,
  slippage_bps: slippageBps.describe(
    "Required on every launchpad preparation call, with no default. Creation pays exactly quote_amount, so no threshold is derived from it here.",
  ),
  owner: address.describe(
    "The fee beneficiary: the only address that can claim creator fees. Any payer can name any address, so it is not proof of who created the token.",
  ),
  quote_token: address.describe("Quote asset. The zero address is native ETH. Must be on the hosted allowlist."),
  name: z.string().max(256).describe("Token name, 1 to 31 UTF-8 bytes. Immutable."),
  symbol: z.string().max(256).describe("Token symbol, 1 to 31 UTF-8 bytes. Immutable."),
  decimals: z.number().int().min(0).max(255),
  total_supply: rawAmount.describe("Whole supply in raw units, all minted to the extension. The beneficiary receives no allocation."),
  quote_amount: rawAmount.optional().describe("Optional quote seed in raw units, paid by sender. Omit for none."),
  start_time: z.number().int().positive().describe("Unix seconds. Must be after the latest block. Supply releases linearly from here."),
  end_time: z.number().int().positive().describe("Unix seconds, after start_time. After it anyone can advance the launch."),
  target_tick: tick.describe("Bottom of the launch price range, as a tick of raw quote units per raw launch token."),
  upper_tick: tick.describe("Top of the launch price range. Buys stop here."),
  tick_spacing: z.number().int().min(1).max(MAX_TICK_SPACING),
  initial_fee: q64Fee.describe(`Creator fee at start_time, Q0.64 (2^64 = 100%). Hosted cap ${INITIAL_FEE_CAP} (10%).`),
  final_fee: q64Fee.describe(`Creator fee at end_time and the terminal pool fee, Q0.64. Hosted cap ${FINAL_FEE_CAP} (1%).`),
  migration_tick_lower: tick.describe("Lowest terminal price, as a tick, at which principal may migrate."),
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

function checkAmounts(totalSupply: bigint, quoteAmount: bigint, owner: Address) {
  if (owner === zeroAddress) throw prepareError("invalid_owner");
  if (totalSupply === 0n || totalSupply > INT128_MAX || quoteAmount > INT128_MAX) throw prepareError("invalid_supply");
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
}

function checkQuoteAsset(context: PrepareContext, quoteToken: Address) {
  if (!context.manifest.quote_allowlist.includes(quoteToken)) {
    throw prepareError("quote_asset_not_allowed", { allowed_quote_tokens: context.manifest.quote_allowlist });
  }
}

/** The `LaunchConfig` tuple, field for field in ABI order. */
function launchConfig(input: PrepareCreateInput, owner: Address, quoteToken: Address, amounts: { totalSupply: bigint; quoteAmount: bigint; initialFee: bigint; finalFee: bigint }) {
  return {
    owner,
    quoteToken,
    name: input.name,
    symbol: input.symbol,
    decimals: input.decimals,
    totalSupply: amounts.totalSupply,
    quoteAmount: amounts.quoteAmount,
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

function deadlineFor(context: PrepareContext, startTime: number): bigint {
  const window = context.block.timestamp + DEADLINE_SECONDS;
  const start = BigInt(startTime);
  return start < window ? start : window;
}

function createWarnings(context: PrepareContext, owner: Address, startTime: number) {
  return [
    ...(owner === context.sender ? [] : [warning("beneficiary_differs_from_sender")]),
    ...(BigInt(startTime) < context.block.timestamp + DEADLINE_SECONDS ? [warning("start_time_within_deadline")] : []),
    warning("migration_may_stay_pending"),
  ];
}

function migrationBounds(input: PrepareCreateInput, quoteDecimals: number) {
  return {
    tick_lower: input.migration_tick_lower,
    tick_upper: input.migration_tick_upper,
    price_lower: priceAtTick(input.migration_tick_lower, input.decimals, quoteDecimals),
    price_upper: priceAtTick(input.migration_tick_upper, input.decimals, quoteDecimals),
    unit: "quote per whole launch token",
    note: MIGRATION_LOCK_NOTE,
  };
}

function launchRange(input: PrepareCreateInput, quoteDecimals: number) {
  return {
    target_tick: input.target_tick,
    upper_tick: input.upper_tick,
    tick_spacing: input.tick_spacing,
    target_price: priceAtTick(input.target_tick, input.decimals, quoteDecimals),
    upper_price: priceAtTick(input.upper_tick, input.decimals, quoteDecimals),
    unit: "quote per whole launch token",
    price_note: PRICE_NOTE,
  };
}

export async function launchpadPrepareCreate(env: PrepareEnv, raw: z.input<typeof prepareCreateSchema>, chainFactory: ChainFactory) {
  const input = prepareCreateSchema.parse(raw);
  checkStrings(input);
  const amounts = {
    totalSupply: BigInt(input.total_supply),
    quoteAmount: BigInt(input.quote_amount ?? "0"),
    initialFee: BigInt(input.initial_fee),
    finalFee: BigInt(input.final_fee),
  };
  const owner = getAddress(input.owner);
  const quoteToken = getAddress(input.quote_token);
  checkFees(amounts.initialFee, amounts.finalFee);
  checkAmounts(amounts.totalSupply, amounts.quoteAmount, owner);
  checkTicks(input);
  const context = await prepareContext(env, input, chainFactory);
  checkQuoteAsset(context, quoteToken);
  checkSchedule(input, context.block.timestamp);
  const decimals = await quoteDecimals(context, quoteToken);
  const router = context.manifest.contracts.launch_router;
  const deadline = deadlineFor(context, input.start_time);
  const native = quoteToken === NATIVE_TOKEN;
  const chain = context.manifest.chain_id.toString();
  const plan = executionPlan({
    chainId: chain,
    sender: context.sender,
    approvals: native || amounts.quoteAmount === 0n ? [] : [approval(context.manifest.chain_id, quoteToken, router, amounts.quoteAmount)],
    transaction: {
      chain_id: chain,
      to: router,
      data: encodeFunctionData({
        abi: launchRouterAbi,
        functionName: "create",
        args: [launchConfig(input, owner, quoteToken, amounts), deadline],
      }),
      value: native ? amounts.quoteAmount.toString() : "0",
    },
    revertDecode: errorResultDecodePlan(launchRouterAbi),
  });
  return {
    ...outputHeader(context),
    action: "create_launch",
    beneficiary: owner,
    beneficiary_is_sender: owner === context.sender,
    launch: {
      quote_token: quoteToken,
      quote_decimals: decimals,
      decimals: input.decimals,
      total_supply: amounts.totalSupply.toString(),
      quote_amount: amounts.quoteAmount.toString(),
      start_time: input.start_time,
      end_time: input.end_time,
      initial_fee: { q64: amounts.initialFee.toString(), percent: feePercent(amounts.initialFee) },
      final_fee: { q64: amounts.finalFee.toString(), percent: feePercent(amounts.finalFee) },
      range: launchRange(input, decimals),
    },
    migration_bounds: migrationBounds(input, decimals),
    deadline: deadline.toString(),
    fees: creationFees({ ...amounts, beneficiary: owner, lockedLiquidity: context.manifest.contracts.locked_launch_liquidity }),
    warnings: createWarnings(context, owner, input.start_time),
    untrusted: { name: input.name, symbol: input.symbol, note: UNTRUSTED_NOTE },
    execution_plan: plan,
  };
}
