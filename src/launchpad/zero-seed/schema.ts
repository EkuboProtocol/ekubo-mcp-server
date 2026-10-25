import { z } from "zod";

// Exact shapes consumed from the backend API v5 (api 06fc548): the launch's own quote token and kind, requested,
// installed and sink supply, the periphery's owner identity and a fee schedule that is a union on the deployment's
// fee model (fixed_base_duration_v1, evm-contracts 43d6628; tick_rate_v2, 3d6378f). Any other schema version,
// including v4 without the model, v3 with principal.installed_supply and v2 with its decay_factor, is refused.
export const SchemaVersion = z.literal("zero-seed-launch-api/v5");
const U = z.string().regex(/^(0|[1-9][0-9]*)$/);
const I = z.string().regex(/^(0|-?[1-9][0-9]*)$/);
const UINT64_MAX = (1n << 64n) - 1n;
/** A Q0.64 fee rate, any uint64: value / 2^64, so the maximum is just under 100%, never exactly 100%. */
const Q64 = U.max(20).refine((value) => /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= UINT64_MAX).describe(
  "Q0.64 fee rate as a canonical decimal uint64 (0 to 18446744073709551615): the fee fraction is value / 2^64, so the maximum is just under 100%",
);
const Address = z.string().regex(/^0x[0-9a-f]{40}$/);
const Bytes32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const Seconds = z.number().int().nonnegative();
export const BlockRef = z.strictObject({
  block_number: U, block_hash: Bytes32, block_time: Seconds,
});
export const EventRef = BlockRef.extend({
  event_id: I,
  transaction_index: z.number().int().nonnegative(),
  event_index: z.number().int().nonnegative(),
  transaction_hash: Bytes32,
});
const Token = z.strictObject({
  address: Address, name: z.string().nullable(), symbol: z.string().nullable(),
  decimals: z.number().int().min(0).max(255).nullable(),
});
const QuoteToken = Token.extend({ kind: z.enum(["native", "erc20"]) });
const PoolKey = z.strictObject({
  core_address: Address, token0: Address, token1: Address, config: Bytes32,
  fee: z.literal("0"), tick_spacing: z.number().int().positive(), extension: Address,
});
/** fixed_base_duration_v1: unchanged from v4 apart from the discriminator. */
const FixedBaseDurationSchedule = z.strictObject({
  model: z.literal("fixed_base_duration_v1"),
  trading_start: Seconds, fee_duration: z.number().int().positive(), fee_end: Seconds,
  initial_fee: Q64, final_fee: Q64,
  decay: z.strictObject({ kind: z.literal("fixed_base_q128"), half_life_seconds: z.literal(600) }),
  phase: z.enum(["before_trading_start", "fee_decay", "final_fee"]),
  fee_rate: Q64, evaluated_at: Seconds,
});
const Uint64 = U.max(20).refine((value) => /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= UINT64_MAX);
// Descriptions as published, so the consumed schema equals the backend's OpenAPI.
const Floor = Q64.describe("Q0.64 long-run floor as a canonical decimal uint64: approached, not scheduled");
/** tick_rate_v2: final_fee is the long-run floor the fee approaches; there is no end time. */
const TickRateSchedule = z.strictObject({
  model: z.literal("tick_rate_v2"),
  trading_start: Seconds, initial_fee: Q64, final_fee: Floor,
  decay_rate_x32: Uint64.describe(
    "decayRateX32: unsigned Q32.32 ticks per second (2^32 = 1 tick/s) as a canonical decimal uint64; 0 keeps initial_fee"),
  half_life_seconds: z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{6}$/).nullable().describe(
    "Half-life of the excess over the floor, seconds with 6 decimals (floored), from the exact integer HALF_LIFE_X32_E30 = 5954091920683119788732747343471285361579197626; null for rate 0. Display only"),
  saturation_elapsed_seconds: U.nullable().describe(
    "floor(381061679028371455 / decay_rate_x32): after this many elapsed seconds the fee is exactly final_fee by numerical saturation; null for rate 0. Not a schedule end"),
  phase: z.enum(["before_trading_start", "decaying", "at_floor", "constant"]),
  fee_rate: Q64, evaluated_at: Seconds,
});
export const FeeSchedule = z.discriminatedUnion("model", [FixedBaseDurationSchedule, TickRateSchedule]);
/** Raw launch-token units: requested = totalSupply, installed in the position, sink = requested - installed at 0x0. */
export const Supply = z.strictObject({
  requested: U, installed: U, sink: U, sink_holder: z.literal("0x0000000000000000000000000000000000000000"),
});
/** `controller` is the periphery that forwarded the creation, `creator` the first owner, `owner` the current one. */
export const LaunchSummary = z.strictObject({
  schema_version: SchemaVersion, chain_id: U, pool_id: Bytes32, pool_key: PoolKey,
  token: Token, quote_token: QuoteToken, supply: Supply, launch_token_is_token1: z.boolean(),
  controller: Address, creator: Address, owner: Address,
  ask_tick: z.number().int(), upper_tick: z.number().int(), fee_schedule: FeeSchedule,
  created: EventRef, as_of: BlockRef,
});
const SideAmounts = z.strictObject({ launch_token: U, quote_token: U });
const LedgerSide = z.strictObject({ accrued: U, claimed: U, unclaimed: U });
export const LaunchDetail = LaunchSummary.extend({
  principal: z.strictObject({
    position_id: Bytes32, tick_lower: z.number().int(), tick_upper: z.number().int(),
    liquidity: U, locked: z.literal(true), withdrawable: z.literal(false),
    pool_reserves: SideAmounts, reserves_basis: z.literal("core_pool_balance"),
  }),
  fee_ledger: z.strictObject({
    holder: Address, transferable: z.literal(true), launch_token: LedgerSide, quote_token: LedgerSide,
    swap_count: z.number().int().nonnegative(), claim_count: z.number().int().nonnegative(),
    owner_change_count: z.number().int().positive(), last_event_id: I,
  }),
  inventory: z.strictObject({ trading_open: z.boolean(), no_bid: z.boolean(), price_tick: z.number().int() }),
});
export const LaunchList = z.strictObject({
  schema_version: SchemaVersion, data: z.array(LaunchSummary), next_cursor: z.string().nullable(), as_of: BlockRef,
});
export const Swap = z.strictObject({
  event: EventRef, forwarding_locker: Address, direction: z.enum(["buy", "sell", "zero_fill"]),
  launch_token_delta: I, quote_token_delta: I, fee_rate: Q64, fee_amount: U,
  fee_asset: z.enum(["launch_token", "quote_token"]),
});
/** One payout per row: the periphery's event, linked to the extension ledger event of the same transaction. */
export const Claim = z.strictObject({
  event: EventRef, ledger_event_id: I, owner: Address, recipient: Address,
  launch_token_amount: U, quote_token_amount: U,
});
export const OwnerChange = z.strictObject({
  event: EventRef, previous_owner: Address.nullable(), new_owner: Address,
});
const PageIdentity = z.strictObject({
  schema_version: SchemaVersion, chain_id: U, pool_id: Bytes32, next_cursor: z.string().nullable(), as_of: BlockRef,
});
export const SwapPage = PageIdentity.extend({ data: z.array(Swap) });
export const ClaimPage = PageIdentity.extend({ data: z.array(Claim) });
export const OwnerPage = PageIdentity.extend({ data: z.array(OwnerChange) });
