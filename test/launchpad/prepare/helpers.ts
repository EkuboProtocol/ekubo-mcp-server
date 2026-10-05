import { zeroAddress } from "viem";
import { launchpadPrepareCreate } from "../../../src/launchpad/prepare/create.js";
import { BLOCK, env, FakeChain, SENDER } from "./fake-chain.js";

// Tests index into plain JSON results freely.
export type Json = any;

export function createArgs(overrides: Record<string, unknown> = {}) {
  return {
    chain_id: 1,
    sender: SENDER,
    slippage_bps: 50,
    owner: SENDER,
    quote_token: zeroAddress,
    name: "Prototype Token",
    symbol: "PROTO",
    decimals: 18,
    total_supply: (10n ** 27n).toString(),
    quote_amount: (10n ** 16n).toString(),
    start_time: Number(BLOCK.timestamp) + 3600,
    end_time: Number(BLOCK.timestamp) + 3600 + 86_400,
    target_tick: -27_631_000,
    upper_tick: -18_420_000,
    tick_spacing: 1000,
    initial_fee: ((1n << 64n) / 20n).toString(),
    final_fee: ((1n << 64n) / 200n).toString(),
    migration_tick_lower: -20_000_000,
    migration_tick_upper: -18_000_000,
    ...overrides,
  };
}

export async function create(overrides: Record<string, unknown> = {}, extraEnv: Record<string, unknown> = {}): Promise<Json> {
  const chain = new FakeChain();
  return launchpadPrepareCreate(env(extraEnv), createArgs(overrides) as never, () => chain);
}

export async function rejection(overrides: Record<string, unknown>, extraEnv: Record<string, unknown> = {}): Promise<Json> {
  try {
    await create(overrides, extraEnv);
  } catch (error) {
    const e = error as { code?: string; message: string; details?: unknown; issues?: unknown };
    return { code: e.code ?? "schema", message: e.message, details: e.details };
  }
  throw new Error("expected a rejection");
}

