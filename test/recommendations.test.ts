import { describe, expect, it } from "bun:test";
import { numberToHex } from "viem";
import { ServiceError } from "../src/core.js";
import { getStonxAllocationRecommendation } from "../src/recommendations.js";

const chainId = "4663";
const veToken = "0x9d7008E169D040B6c0140eb92E7cA82B12643497" as const;
const ve33 = "0xD18685a514E59b06d59824e16Db07e73345d9953" as const;
const token0 = "0x0000000000000000000000000000000000000000" as const;
const token1 = "0x0000000000000000000000000000000000000001" as const;
const token2 = "0x0000000000000000000000000000000000000002" as const;
const token3 = "0x0000000000000000000000000000000000000003" as const;

const recommendationRows = [
  recommendationRow({
    pair: "ETH/A",
    token1,
    symbol1: "A",
    weight: 6_000,
    cap: 7_000,
    priority: 1,
  }),
  recommendationRow({
    pair: "ETH/B",
    token1: token2,
    symbol1: "B",
    weight: 3_000,
    cap: 3_500,
    priority: 2,
  }),
  recommendationRow({
    pair: "ETH/C",
    token1: token3,
    symbol1: "C",
    weight: 1_000,
    cap: 1_000,
    priority: 3,
  }),
];

const pools = [
  poolRow("10", token1, 4),
  poolRow("20", token2, 4_096),
  poolRow("21", token2, 1_024),
];

const env = {
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused",
  ACROSS_API_KEY: "unused",
  ACROSS_INTEGRATOR_ID: "unused",
  DUNE_API_KEY: "private-test-key",
};

describe("STONX allocation recommendations", () => {
  it("returns provider-neutral, canonical, exact 10,000-bps execution targets", async () => {
    const result = await getStonxAllocationRecommendation(
      env,
      { chainId, veToken, ve33 },
      recommendationFetcher(),
    );

    expect(result.execution_ready).toBe(true);
    expect(result.recommendation_count).toBe(3);
    expect(result.executable_target_count).toBe(2);
    expect(result.unavailable_weight_bps).toBe(1_000);
    expect(result.redistributed_weight_bps).toBe(1_000);
    expect(result.target_total_weight_bps).toBe(10_000);
    expect(result.targets).toEqual([
      { pool_key_id: "10", swap_fee: "123", weight_bps: 6_667 },
      { pool_key_id: "21", swap_fee: "123", weight_bps: 3_333 },
    ]);
    expect(result.recommendations[1].initialized_pool).toMatchObject({
      pool_key_id: "21",
      tick_spacing: 1_024,
    });
    expect(result.recommendations[2]).toMatchObject({
      pair: "ETH/C",
      executable_weight_bps: null,
      execution_status: "pool_not_initialized",
    });
    expect(result.safe_execution_workflow).toMatchObject({
      all_current_voter_fees_are_claimed_first: true,
      ownership_or_nft_transfer_calls_are_forbidden: true,
      recommendation_tool_constructs_no_transaction: true,
    });
    expect(result).not.toHaveProperty("transaction");
    expect(JSON.stringify(result)).not.toMatch(/dune|8187907|api\.dune/i);
  });

  it("fails closed with a provider-neutral error when recommendations are unavailable", async () => {
    const missing = await getStonxAllocationRecommendation(
      { ...env, DUNE_API_KEY: "" },
      { chainId, veToken, ve33 },
      recommendationFetcher(),
    ).catch((error) => error);
    expect(missing).toBeInstanceOf(ServiceError);
    expect((missing as ServiceError).code).toBe(
      "allocation_recommendations_not_configured",
    );
    expect((missing as Error).message).not.toMatch(/dune|query|8187907/i);

    const unavailable = await getStonxAllocationRecommendation(
      env,
      { chainId, veToken, ve33 },
      recommendationFetcher(401),
    ).catch((error) => error);
    expect(unavailable).toBeInstanceOf(ServiceError);
    expect((unavailable as ServiceError).code).toBe(
      "allocation_recommendations_unavailable",
    );
    expect(JSON.stringify(unavailable)).not.toMatch(/dune|8187907|api\.dune/i);
  });
});

function recommendationRow({
  pair,
  token1: asset1,
  symbol1,
  weight,
  cap,
  priority,
}: {
  pair: string;
  token1: `0x${string}`;
  symbol1: string;
  weight: number;
  cap: number;
  priority: number;
}) {
  return {
    allocation_bucket: "production",
    priority_rank: priority,
    pair,
    pair_key: `${token0}:${asset1}`,
    asset0_address: token0,
    asset0_symbol: "ETH",
    asset1_address: asset1,
    asset1_symbol: symbol1,
    target_weight_bps: weight,
    target_weight_pct: weight / 100,
    suggested_swap_fee_bps: 0.0000000000000000667,
    suggested_swap_fee_q64: "123",
    last_7d_gross_fees_usd: 100,
    last_7d_volume_usd: 1_000,
    recent_vs_prior_fee_trend_pct: 5,
    momentum_flag: "normal",
    evidence_confidence: "high",
    allocation_cap_bps: cap,
    allocation_reason: "Recent fee opportunity.",
    required_action: "Verify the pool.",
    plan_total_weight_bps: 10_000,
    fee_discount_pct: 25,
  };
}

function poolRow(poolKeyId: string, asset1: `0x${string}`, tickSpacing: number) {
  return {
    chain_id: chainId,
    pool_key_id: poolKeyId,
    pool_id: numberToHex(BigInt(poolKeyId), { size: 32 }),
    token0,
    token1: asset1,
    extension: ve33,
    tick_spacing: tickSpacing,
    pool_state: {},
  };
}

function recommendationFetcher(status = 200) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    if (url.hostname === "api.dune.com") {
      if (status !== 200) {
        return Response.json(
          { error: "Dune provider detail must not escape" },
          { status },
        );
      }
      expect(new Headers(init?.headers).get("X-Dune-API-Key")).toBe(
        "private-test-key",
      );
      expect(url.searchParams.get("limit")).toBe("100");
      return Response.json({
        state: "QUERY_STATE_COMPLETED",
        submitted_at: "2026-08-01T19:42:40.766983Z",
        result: {
          metadata: { total_row_count: recommendationRows.length },
          rows: recommendationRows,
        },
      });
    }
    return Response.json({
      data: pools,
      total_vote_weight: "1000",
      pagination: {
        page: 1,
        pageSize: 200,
        totalPages: 1,
        totalItems: pools.length,
      },
    });
  }) as typeof fetch;
}
