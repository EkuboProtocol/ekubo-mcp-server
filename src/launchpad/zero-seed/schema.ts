import { z } from "zod";

// Exact shapes consumed from api#191 head 230afd4, not historical templates.
export const SchemaVersion = z.literal("zero-seed-launch-api/v1");
const U = z.string().regex(/^(0|[1-9][0-9]*)$/);
const I = z.string().regex(/^(0|-?[1-9][0-9]*)$/);
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
const PoolKey = z.strictObject({
  core_address: Address, token0: Address, token1: Address, config: Bytes32,
  fee: z.literal("0"), tick_spacing: z.number().int().positive(), extension: Address,
});
export const FeeSchedule = z.strictObject({
  trading_start: Seconds, fee_duration: z.number().int().positive(), fee_end: Seconds,
  initial_fee: U, final_fee: U,
  phase: z.enum(["before_trading_start", "fee_decay", "final_fee"]),
  fee_rate: U, evaluated_at: Seconds,
});
export const LaunchSummary = z.strictObject({
  schema_version: SchemaVersion, chain_id: U, pool_id: Bytes32, pool_key: PoolKey,
  token: Token, quote_token: Token, launch_token_is_token1: z.boolean(), creator: Address,
  ask_tick: z.number().int(), upper_tick: z.number().int(), fee_schedule: FeeSchedule,
  created: EventRef, as_of: BlockRef,
});
const SideAmounts = z.strictObject({ launch_token: U, quote_token: U });
const LedgerSide = z.strictObject({ accrued: U, claimed: U, unclaimed: U });
export const LaunchDetail = LaunchSummary.extend({
  principal: z.strictObject({
    position_id: Bytes32, tick_lower: z.number().int(), tick_upper: z.number().int(),
    liquidity: U, installed_supply: U, locked: z.literal(true), withdrawable: z.literal(false),
    pool_reserves: SideAmounts, reserves_basis: z.literal("core_pool_balance"),
  }),
  fee_ledger: z.strictObject({
    holder: Address, transferable: z.literal(false), launch_token: LedgerSide, quote_token: LedgerSide,
    swap_count: z.number().int().nonnegative(), claim_count: z.number().int().nonnegative(), last_event_id: I,
  }),
  inventory: z.strictObject({ trading_open: z.boolean(), no_bid: z.boolean(), price_tick: z.number().int() }),
});
export const LaunchList = z.strictObject({
  schema_version: SchemaVersion, data: z.array(LaunchSummary), next_cursor: z.string().nullable(), as_of: BlockRef,
});
export const Swap = z.strictObject({
  event: EventRef, forwarding_locker: Address, direction: z.enum(["buy", "sell", "zero_fill"]),
  launch_token_delta: I, quote_token_delta: I, fee_rate: U, fee_amount: U,
  fee_asset: z.enum(["launch_token", "quote_token"]),
});
export const Claim = z.strictObject({
  event: EventRef, creator: Address, recipient: Address, launch_token_amount: U, quote_token_amount: U,
});
const PageIdentity = z.strictObject({
  schema_version: SchemaVersion, chain_id: U, pool_id: Bytes32, next_cursor: z.string().nullable(), as_of: BlockRef,
});
export const SwapPage = PageIdentity.extend({ data: z.array(Swap) });
export const ClaimPage = PageIdentity.extend({ data: z.array(Claim) });
