import type { FixtureBundle } from "../../src/launchpad/analytics/fixture-source.js";
import {
  launchpadGetAnalytics,
  launchpadGetLaunch,
  launchpadGetProvenance,
  launchpadSearch,
  launchpadStats,
  type LaunchpadEnv,
} from "../../src/launchpad/analytics/tools.js";
import { addr, ChainBuilder, LaunchSim } from "./chain-builder.js";

export const E18 = 10n ** 18n;
export const CHAIN = 31337;

export function fixtureEnv(bundle: FixtureBundle): LaunchpadEnv {
  return { LAUNCHPAD_SOURCE: "fixture", LAUNCHPAD_FIXTURE: JSON.stringify(bundle) };
}

// Responses are plain JSON objects; tests index into them freely.
export type Json = any;

export const tools = {
  search: (b: FixtureBundle, args: Record<string, unknown> = {}): Promise<Json> =>
    launchpadSearch(fixtureEnv(b), { chain_id: CHAIN, ...args } as never),
  launch: (b: FixtureBundle, args: Record<string, unknown>): Promise<Json> =>
    launchpadGetLaunch(fixtureEnv(b), { chain_id: CHAIN, ...args } as never),
  provenance: (b: FixtureBundle, args: Record<string, unknown>): Promise<Json> =>
    launchpadGetProvenance(fixtureEnv(b), { chain_id: CHAIN, ...args } as never),
  analytics: (b: FixtureBundle, args: Record<string, unknown>): Promise<Json> =>
    launchpadGetAnalytics(fixtureEnv(b), { chain_id: CHAIN, ...args } as never),
  stats: (b: FixtureBundle): Promise<Json> => launchpadStats(fixtureEnv(b), CHAIN),
};

export const SENDER = addr(0x5e, "e");
export const PAYER = addr(0x9a, "e");
export const BENEFICIARY = addr(0xbe, "e");
export const BUYER_A = addr(0xa1, "b");
export const BUYER_B = addr(0xb2, "b");
export const RECIPIENT_R = addr(0x77, "b");
export const TOKEN = addr(0x70, "d");

/**
 * Block 100 genesis, 101 creation, start_time at block 105, end_time ten
 * blocks later. One routed buy at block 106 deploys 100k and buys 50k with a
 * 5k creator fee.
 */
export function standardLaunch(options: { decimals?: number; supply?: bigint } = {}) {
  const chain = new ChainBuilder();
  chain.block();
  const start = chain.options.first_timestamp + 5 * chain.options.block_time;
  const unit = 10n ** BigInt(options.decimals ?? 18);
  const sim = new LaunchSim(chain, TOKEN, {
    owner: BENEFICIARY,
    startTime: start,
    endTime: start + 120,
    decimals: options.decimals,
    totalSupply: options.supply ?? 1_000_000n * unit,
  });
  chain.block((b) => sim.create(b, SENDER, PAYER));
  chain.blocksUntil(105);
  chain.block((b) =>
    sim.buy(b, {
      payer: BUYER_A,
      quoteIn: 1n * E18,
      tokenOut: 50_000n * unit,
      fee: 5_000n * unit,
      deploy: 100_000n * unit,
    }),
  );
  return { chain, sim, unit, start };
}

/** Every string value in a JSON tree. */
export function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) strings(item, out);
  return out;
}

export function withoutEnvelope(response: Json): Json {
  const { as_of: _a, source: _s, limitations: _l, ...rest } = response;
  return rest;
}
