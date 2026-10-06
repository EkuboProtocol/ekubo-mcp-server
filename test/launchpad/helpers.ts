import { zeroAddress } from "viem";
import { launchpadPrepareCreate } from "../../src/launchpad/prepare/create.js";
import { BLOCK, env, failure, harness, type Json, SENDER } from "./fake.js";

export function createArgs(overrides: Record<string, unknown> = {}) {
  return {
    chain_id: 1,
    sender: SENDER,
    slippage_bps: 50,
    quote_token: zeroAddress,
    name: "Prototype Token",
    symbol: "PROTO",
    decimals: 18,
    total_supply: (10n ** 27n).toString(),
    start_time: Number(BLOCK.timestamp) + 3600,
    end_time: Number(BLOCK.timestamp) + 3600 + 86_400,
    target_tick: -27_631_000,
    upper_tick: -18_420_000,
    tick_spacing: 1000,
    initial_fee: ((1n << 64n) / 20n).toString(),
    final_fee: ((1n << 64n) / 200n).toString(),
    migration_tick_lower: -20_000_000,
    migration_tick_upper: -19_500_000,
    ...overrides,
  };
}

export async function create(overrides: Record<string, unknown> = {}, manifestExtra: Record<string, unknown> = {}): Promise<Json> {
  const { deps } = harness();
  return launchpadPrepareCreate(env(manifestExtra), createArgs(overrides) as never, deps);
}

export function createRejection(overrides: Record<string, unknown> = {}, manifestExtra: Record<string, unknown> = {}) {
  return failure(() => create(overrides, manifestExtra));
}

