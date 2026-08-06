import { fakeArtifactStore } from "./fake-r2.js";
import { describe, expect, it } from "bun:test";
import type { Env } from "../src/core.js";
import { getLiquidityOpportunities } from "../src/opportunities.js";
import { derivePoolId } from "../src/pools.js";

const env = {
  ARTIFACT_STORE: fakeArtifactStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused",
  ACROSS_API_KEY: "unused",
  ACROSS_INTEGRATOR_ID: "unused",
  DUNE_API_KEY: "unused",
} satisfies Env;

const chainId = "4663";
const token0 = "0x0000000000000000000000000000000000000000";
const token1 = "0x1111111111111111111111111111111111111111";
const reward = "0x570C5aa79c798E7A418412cC8399ae5bcCe570C5";
const core = "0x00000000000014aA86C5d3c41765bb24e11bd701";
const boostedExtension = "0xd4b54d0ca6979da05f25895e6e269e678ba00f9e";
const ve33Extension = "0xD18685a514E59b06d59824e16Db07e73345d9953";
const nowMs = Date.parse("2026-08-02T12:00:00.000Z");

const boostedPoolId = derivePoolId({
  token0,
  token1,
  fee: "1844674407370955",
  tickSpacing: 1024,
  extension: boostedExtension,
}).pool_id;
const ve33PoolId = derivePoolId({
  token0,
  token1,
  fee: "0",
  tickSpacing: 1024,
  extension: ve33Extension,
}).pool_id;

function stats() {
  return {
    volume0_24h: "1000000000000000000",
    volume1_24h: "2000000000",
    fees0_24h: "1000000000000000",
    fees1_24h: "2000000",
    ve33_fees0_24h: "0",
    ve33_fees1_24h: "0",
    tvl0_delta_24h: "0",
    tvl1_delta_24h: "0",
    tvl0_total: "1000000000000000000",
    tvl1_total: "2000000000",
    depth0: "500000000000000000",
    depth1: "1000000000",
  };
}

function fixtureFetch(requests: string[]) {
  return (async (input: RequestInfo | URL) => {
    const url = input.toString();
    requests.push(url);
    if (url.includes("/overview/pairs")) {
      return Response.json({
        topPairs: [
          {
            ...stats(),
            chain_id: "0x1237",
            token0,
            token1,
            min_depth_percent: 0.05,
          },
        ],
      });
    }
    if (url.includes("/overview/boosted-fees-pools")) {
      return Response.json({
        pools: [
          {
            ...stats(),
            chain_id: "0x1237",
            token0,
            token1,
            pool_id: BigInt(boostedPoolId).toString(),
            fee: "1844674407370955",
            tick_spacing: 1024,
            core_address: core,
            extension: boostedExtension,
            depth_percent: 0.05,
            stableswap_params: null,
            boosts: {
              donate_rate0: "1",
              donate_rate1: "0",
              last_donated_time: 1,
              future_donation_deltas: [],
            },
          },
        ],
      });
    }
    if (url.includes("/campaigns")) {
      return Response.json({
        campaigns: [
          {
            slug: "active",
            name: "Active rewards",
            chain_id: "0x1237",
            coreAddress: core,
            allowedLockers: null,
            allowedExtensions: ["0x0"],
            startTime: "2026-08-01T00:00:00.000Z",
            endTime: "2026-08-03T00:00:00.000Z",
            rewardToken: reward,
            nextDropTime: null,
            pairs: [
              {
                token0,
                token1,
                scheduled: "0",
                distributed: "0",
                daily_rewards_token0: "500000000000000000",
                daily_rewards_token1: "500000000000000000",
                realized_volatility: null,
                depth_percent: 0.05,
                depth0: "500000000000000000",
                depth1: "1000000000",
              },
            ],
          },
        ],
      });
    }
    if (url.includes("/ve33/") && url.includes("/pools")) {
      return Response.json({
        data: [
          {
            ...stats(),
            chain_id: "0x1237",
            pool_key_id: "7",
            pool_id: ve33PoolId,
            token0,
            token1,
            fee: "0",
            tick_spacing: 1024,
            core_address: core,
            extension: ve33Extension,
            pool_key: {
              token0,
              token1,
              fee: "0x0",
              tick_spacing: "0x400",
              extension: ve33Extension,
              stableswap_params: null,
            },
            pool_state: { sqrt_ratio: "1", tick: 0, liquidity: "1" },
            pool_total_vote_weight: "100",
            swap_fee: "1",
            depth_percent: 0.05,
            last_event_id: "1",
          },
        ],
        total_vote_weight: "100",
        pagination: {
          page: 1,
          pageSize: 200,
          totalPages: 1,
          totalItems: 1,
        },
      });
    }
    if (url.includes("/tokens/batch")) {
      return Response.json([
        {
          chain_id: "0x1237",
          address: token0,
          name: "Ether",
          symbol: "ETH",
          decimals: 18,
          usd_price: 2000,
          visibility_priority: 1,
        },
        {
          chain_id: "0x1237",
          address: token1,
          name: "Dollar",
          symbol: "USD",
          decimals: 6,
          usd_price: 1,
          visibility_priority: 1,
        },
        {
          chain_id: "0x1237",
          address: reward,
          name: "STONX",
          symbol: "STONX",
          decimals: 18,
          usd_price: 2,
          visibility_priority: 1,
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("liquidity opportunities", () => {
  it("returns a provisional UI-equivalent feed plus a wallet-local ve33 read", async () => {
    const requests: string[] = [];
    const result = await getLiquidityOpportunities(
      env,
      {
        types: ["boosted_fees", "incentive", "ve33_emissions"],
        limit: 25,
      },
      fixtureFetch(requests),
      nowMs,
    );

    expect(result.status).toBe("provisional_local_read_required");
    expect(result.ranking_complete).toBe(false);
    expect(result.opportunities.map((opportunity) => opportunity.type)).toEqual([
      "boosted_fees",
      "incentive",
      "ve33_emissions",
    ]);
    expect(result.local_read_requirement).toMatchObject({
      status: "not_executed",
      chain_id: "4663",
      block_parameter: "pending",
      read_calls: {
        chain_id: "4663",
        calls: [
          {
            id: "ve33-emission-state",
            decode: {
              kind: "function_result",
              function_name: "getEmissionState",
            },
          },
        ],
      },
      resume: {
        arguments: {
          ve33_emission_state: {
            current_timestamp:
              "<wallet_batch_eth_call.results[0].decoded.currentTimestamp>",
            current_emission_rate:
              "<wallet_batch_eth_call.results[0].decoded.currentEmissionRate>",
            total_remaining_emissions:
              "<wallet_batch_eth_call.results[0].decoded.totalRemainingEmissions>",
          },
        },
      },
    });
    expect(requests.some((url) => url.includes("/tokens/batch?"))).toBe(true);
  });

  it("completes projection math and returns actionable pool handoffs", async () => {
    const currentEmissionRate = 1n << 32n;
    const result = await getLiquidityOpportunities(
      env,
      {
        chainId,
        types: ["boosted_fees", "incentive", "ve33_emissions"],
        limit: 25,
        ve33EmissionState: {
          currentTimestamp: "1785672000",
          currentEmissionRate: currentEmissionRate.toString(),
          totalRemainingEmissions: "1000000000000000000000",
        },
      },
      fixtureFetch([]),
      nowMs,
    );

    expect(result.status).toBe("complete");
    expect(result.ranking_complete).toBe(true);
    expect(result.local_read_requirement).toBeNull();
    const boosted = result.opportunities.find(
      (opportunity) => opportunity.type === "boosted_fees",
    );
    expect(boosted).toMatchObject({
      apr: 0.365,
      apr_percent: 36.5,
      pool: { pool_id: boostedPoolId },
      next_step: {
        inspect: { tool: "ekubo_get_pool" },
        prepare_deposit: { tool: "ekubo_prepare_lp_position_deposit" },
      },
    });
    const ve33 = result.opportunities.find(
      (opportunity) => opportunity.type === "ve33_emissions",
    );
    expect(ve33).toMatchObject({
      projected_emissions_24h: "86400",
      pool: { pool_id: ve33PoolId },
    });
    const incentive = result.opportunities.find(
      (opportunity) => opportunity.type === "incentive",
    );
    expect(incentive).toMatchObject({
      active_campaigns: [{ slug: "active", apr: 0.1825 }],
      next_step: { tool: "ekubo_get_position_pool_candidates" },
    });
  });

  it("does not require a ve33 read for a boosted-fees-only request", async () => {
    const result = await getLiquidityOpportunities(
      env,
      { chainId, types: ["boosted_fees"], limit: 1 },
      fixtureFetch([]),
      nowMs,
    );
    expect(result.status).toBe("complete");
    expect(result.local_read_requirement).toBeNull();
    expect(result.opportunities).toHaveLength(1);
  });
});
