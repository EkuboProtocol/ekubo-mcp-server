import { encodeRoutes } from "@ekubo/yul-router-sdk";
import { type Address, concatHex, getAddress, type Hex, maxInt128, numberToHex, zeroAddress } from "viem";
import { z } from "zod";
import { exactOutputMultiplier, feeAt, feePercent, feePhase } from "./fee.js";
import { address, bytes32, decimal, requireLocalPin } from "./installation.js";
import { type InstancePin, NATIVE_QUOTE, ZeroSeedError } from "./policy.js";

/** Base Yul router whose runtime (keccak 0x32ba8475…) executed the accepted local router vectors. */
export const ZERO_SEED_ROUTER = "0x03c8b90854b90aa22448b11e885f692972da441c";
const FLAG_RECIPIENT = 0x01;
const FLAG_DEADLINE = 0x02;
// flags(1) + multihop count(1) + specified(20) + calculated(20) + threshold(16) + recipient(20)
const HEADER_BYTES = 78;

const anyAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase());
const signed = z.string().regex(/^-?(0|[1-9][0-9]*)$/);

/** Launch quote query, plus the path amount/tokens. A native quote is address(0). */
export const QuoterRequest = z.strictObject({
  amount: signed, specified_token: address, other_token: address, extension: address,
  min_output: decimal.optional(), max_input: decimal.optional(), deadline: decimal,
  allow_partial: z.boolean().optional(),
});
export type QuoterRequestInput = z.infer<typeof QuoterRequest>;

const Hop = z.strictObject({
  type: z.literal("forwarded"), forwardee: anyAddress, skip_ahead: z.literal(0),
  sqrt_ratio_limit: z.string().regex(/^0x[0-9a-f]{1,24}$/),
  pool_key: z.strictObject({ token0: anyAddress, token1: anyAddress, config: bytes32 }),
});
/** Existing QuoteResponse shape, restricted to one split with one forwarded hop and no price impact. */
export const QuoterResponse = z.strictObject({
  block_number: z.number().int().nonnegative(), block_hash: bytes32, estimated_gas_cost: z.number().int().nonnegative(),
  price_impact: z.null(), total_calculated: decimal,
  splits: z.tuple([z.strictObject({
    amount_specified: signed, amount_calculated: decimal, route: z.tuple([z.strictObject({ swap: Hop })]),
  })]),
});
export type QuoterResponseInput = z.input<typeof QuoterResponse>;

export interface IndexedContext { blockNumber: string; blockHash: string; blockTime: string }

function parse<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ZeroSeedError(code);
  return result.data;
}

function inRange(value: string | undefined): bigint {
  if (value === undefined) throw new ZeroSeedError("invalid_argument");
  const amount = BigInt(value);
  if (amount < 1n || amount > maxInt128) throw new ZeroSeedError("invalid_argument");
  return amount;
}

/** Exactly one guard, on the side the amount's sign selects; returns the router threshold. */
function guardThreshold(request: QuoterRequestInput): bigint {
  if (request.allow_partial === true) throw new ZeroSeedError("partial_fill");
  const amount = BigInt(request.amount);
  if (amount === 0n || amount > maxInt128 || -amount > maxInt128) throw new ZeroSeedError("invalid_argument");
  if (amount > 0n) {
    if (request.max_input !== undefined) throw new ZeroSeedError("invalid_argument");
    return inRange(request.min_output);
  }
  if (request.min_output !== undefined) throw new ZeroSeedError("invalid_argument");
  return -inRange(request.max_input);
}

function checkDeadline(deadline: bigint, context: IndexedContext, freshTime: bigint): void {
  // The router's deadline field is uint32 seconds; the bound is inclusive.
  if (deadline > 0xffffffffn) throw new ZeroSeedError("deadline_out_of_range");
  if (BigInt(context.blockTime) > deadline || freshTime > deadline) throw new ZeroSeedError("deadline_expired");
}

function checkHop(hop: z.infer<typeof Hop>, request: QuoterRequestInput, pin: InstancePin): void {
  // Swaps forward to the extension, never to the periphery, with the unchanged (PoolKey, SwapParameters) payload.
  if (request.extension !== pin.extension || hop.forwardee !== pin.extension ||
    BigInt(hop.pool_key.config) >> 96n !== BigInt(pin.extension)) throw new ZeroSeedError("launch_support_disabled");
  const pair = [hop.pool_key.token0, hop.pool_key.token1];
  const tokens = [request.specified_token, request.other_token];
  if (!pair.includes(pin.quote) || !tokens.every((token) => pair.includes(token)) || tokens[0] === tokens[1]) {
    throw new ZeroSeedError("quote_route_mismatch");
  }
  if (pin.quoteKind === "native" && hop.pool_key.token0 !== NATIVE_QUOTE) throw new ZeroSeedError("quote_route_mismatch");
}

/** Output sent to any of these is stranded or refused: they book nothing for a bare transfer. */
function checkRecipient(recipient: Address, hop: z.infer<typeof Hop>, pin: InstancePin): void {
  const refused = [zeroAddress, pin.core, pin.extension, pin.periphery, ZERO_SEED_ROUTER, hop.pool_key.token0,
    hop.pool_key.token1].map((sink) => getAddress(sink));
  if (refused.includes(getAddress(recipient))) throw new ZeroSeedError("invalid_recipient");
}

/**
 * Native settlement: ETH input is attached as value, never wrapped and never approved. An exact-input buy attaches
 * exactly the input; an exact-output buy attaches the maximum input and the router refunds what the swap does not
 * spend. Native output (a sell) attaches nothing. An ERC-20 input needs the sender's allowance to the router.
 */
function settlement(request: QuoterRequestInput, threshold: bigint, pin: InstancePin) {
  const amount = BigInt(request.amount);
  const input = amount > 0n ? request.specified_token : request.other_token;
  if (pin.quoteKind !== "native" || input !== NATIVE_QUOTE) {
    return { value: 0n, native: null, input_approval: { token: input, spender: ZERO_SEED_ROUTER,
      amount: (amount > 0n ? amount : -threshold).toString() } };
  }
  const exactIn = amount > 0n;
  const value = exactIn ? amount : -threshold;
  const native = exactIn
    ? { attached_value: value.toString(), spend: "exact" as const, refund: null }
    : { attached_value: value.toString(), spend: "at_most" as const,
      refund: "the router returns the unspent value to the sender in the same transaction" };
  return { value, input_approval: null, native: { ...native, wrapping: false, approval: false } };
}

function checkAmounts(response: z.infer<typeof QuoterResponse>, request: QuoterRequestInput, threshold: bigint): bigint {
  const [split] = response.splits;
  const calculated = BigInt(split.amount_calculated);
  if (split.amount_specified !== request.amount || response.total_calculated !== split.amount_calculated || calculated === 0n) {
    throw new ZeroSeedError("quote_amount_mismatch");
  }
  if (threshold > 0n ? calculated < threshold : calculated > -threshold) throw new ZeroSeedError("guard_not_met");
  return calculated;
}

function routerCalldata(input: {
  request: QuoterRequestInput; hop: z.infer<typeof Hop>; threshold: bigint; recipient: Address; deadline: bigint;
}): Hex {
  const { request, hop } = input;
  const route = encodeRoutes({
    specifiedToken: request.specified_token as Address, calculatedToken: request.other_token as Address,
    calculatedAmountThreshold: input.threshold, recipient: input.recipient,
    multiHops: [{ specifiedAmount: BigInt(request.amount), hops: [{
      type: "forwarded", forwardee: hop.forwardee as Address, skipAhead: 0,
      poolKey: { token0: hop.pool_key.token0 as Address, token1: hop.pool_key.token1 as Address, config: hop.pool_key.config as Hex },
      sqrtRatioLimit: BigInt(hop.sqrt_ratio_limit),
    }] }],
  });
  if (route.slice(2, 4) !== numberToHex(FLAG_RECIPIENT, { size: 1 }).slice(2)) throw new ZeroSeedError("router_layout_mismatch");
  // Current 0x03c8 layout: flag bit 1 adds a uint32 deadline directly after the recipient.
  const header = route.slice(4, 2 + HEADER_BYTES * 2);
  return concatHex([
    numberToHex(FLAG_RECIPIENT | FLAG_DEADLINE, { size: 1 }), `0x${header}`, numberToHex(input.deadline, { size: 4 }),
    `0x${route.slice(2 + HEADER_BYTES * 2)}`,
  ]).toLowerCase() as Hex;
}

/** The indexed launch's own schedule, bound to the quoted pool: the API's served rate is not reused. */
export interface LaunchSchedule {
  pool_key: { token0: string; token1: string; config: string };
  fee_schedule: { trading_start: number; fee_duration: number; initial_fee: string; final_fee: string };
}

/** Creator fee rate the contract applies at the quote's indexed block time, from the exact integer schedule. */
function creatorFeeAt(launch: LaunchSchedule, hop: z.infer<typeof Hop>, blockTime: bigint) {
  const key = launch.pool_key;
  if (key.token0 !== hop.pool_key.token0 || key.token1 !== hop.pool_key.token1 || key.config !== hop.pool_key.config) {
    throw new ZeroSeedError("quote_route_mismatch");
  }
  const fee = launch.fee_schedule;
  const schedule = {
    tradingStart: BigInt(fee.trading_start), feeDuration: BigInt(fee.fee_duration), initialFee: BigInt(fee.initial_fee),
    finalFee: BigInt(fee.final_fee),
  };
  const rate = feeAt(schedule, blockTime);
  return {
    evaluated_at: blockTime.toString(), phase: feePhase(schedule, blockTime), rate_q64: rate.toString(),
    rate_percent: feePercent(rate), exact_output_multiplier: exactOutputMultiplier(rate),
    charged_on: "calculated_side" as const, recipient: "creator_fee_ledger" as const,
  };
}

/**
 * Consumes one accepted quoter request/response at its indexed block and encodes the 0x03c8 router call.
 * LOCAL and non-executable: the quoter's estimated_gas_cost is deliberately not read, and nothing here is a
 * gas limit, UserOp budget, affordability decision or owner assurance. The public entrypoint refuses.
 */
export function localSwapFromQuote(input: {
  pin: InstancePin; request: unknown; response: unknown; context: IndexedContext; recipient: Address; launch?: LaunchSchedule;
}, freshTime: bigint) {
  requireLocalPin(input.pin);
  const request = parse(QuoterRequest, input.request, "invalid_argument");
  const threshold = guardThreshold(request);
  const response = parse(QuoterResponse, input.response, "quote_response_invalid");
  if (String(response.block_number) !== input.context.blockNumber || response.block_hash !== input.context.blockHash) {
    throw new ZeroSeedError("quote_snapshot_mismatch");
  }
  const deadline = BigInt(request.deadline);
  checkDeadline(deadline, input.context, freshTime);
  const hop = response.splits[0].route[0].swap;
  checkHop(hop, request, input.pin);
  const calculated = checkAmounts(response, request, threshold);
  const recipient = address.parse(input.recipient.toLowerCase()) as Address;
  checkRecipient(recipient, hop, input.pin);
  const { value, native, input_approval } = settlement(request, threshold, input.pin);
  const creatorFee = input.launch === undefined ? {} : { creator_fee: creatorFeeAt(input.launch, hop, BigInt(input.context.blockTime)) };
  return {
    ...creatorFee,
    scope: "synthetic-local-non-executable" as const, executable: false as const, executionGuaranteed: false as const,
    router: ZERO_SEED_ROUTER, value: value.toString(), native, input_approval, data: routerCalldata({ request, hop, threshold, recipient, deadline }),
    quote_type: BigInt(request.amount) > 0n ? "exact_input" as const : "exact_output" as const,
    specified_amount: request.amount, calculated_amount: calculated.toString(), threshold: threshold.toString(),
    deadline: request.deadline, skip_ahead: 0 as const, partial_fill: false as const,
    block: { number: input.context.blockNumber, hash: input.context.blockHash, time: input.context.blockTime },
  };
}
