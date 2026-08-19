import { fakeArtifactStore } from "./fake-r2.js";
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
  ARTIFACT_STORE: fakeArtifactStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused",
  ACROSS_API_KEY: "unused",
  ACROSS_INTEGRATOR_ID: "unused",
  LAYER_ZERO_API_KEY: "unused",
  LI_FI_API_KEY: "unused",
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
    expect(result.snapshot_refreshed_on_request).toBe(false);
    expect(result.snapshot_max_age_seconds).toBe(604_800);
    expect(result.snapshot_refresh_after_seconds).toBe(86_400);
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
      every_current_vote_is_claimed_before_it_is_cleared_or_moved: true,
      ownership_or_nft_transfer_calls_are_forbidden: true,
      recommendation_tool_constructs_no_transaction: true,
    });
    expect(result).not.toHaveProperty("transaction");
    expect(JSON.stringify(result)).not.toMatch(/dune|8187907|api\.dune/i);
  });

  it("ignores a stableswap pool sitting beside the pool it recommends", async () => {
    // Two stableswap pools appeared in the live Ve33 directory beside the
    // concentrated pools for the same pairs, and a required tick spacing made
    // one unparseable row fail every recommendation in the response.
    const result = await getStonxAllocationRecommendation(
      env,
      { chainId, veToken, ve33 },
      recommendationFetcher(200, recommendationRows, [
        ...pools,
        stableswapPoolRow("9001", token1),
        stableswapPoolRow("9002", token2),
      ]),
    );

    // Unchanged: the same pools are selected, by the same ids and weights, as
    // when no stableswap pool was in the directory at all.
    expect(result.execution_ready).toBe(true);
    expect(result.targets).toEqual([
      { pool_key_id: "10", swap_fee: "123", weight_bps: 6_667 },
      { pool_key_id: "21", swap_fee: "123", weight_bps: 3_333 },
    ]);
    expect(result.recommendations[1].initialized_pool).toMatchObject({
      pool_key_id: "21",
      tick_spacing: 1_024,
    });
  });

  it("reports a pair served only by a stableswap pool as unsupported", async () => {
    const result = await getStonxAllocationRecommendation(
      env,
      { chainId, veToken, ve33 },
      recommendationFetcher(200, recommendationRows, [
        stableswapPoolRow("9001", token1),
      ]),
    );

    // Distinct from pool_not_initialized: the pool exists, but a swap-fee-tier
    // recommendation is not a statement about a stableswap market, so it is
    // named rather than silently treated as missing.
    expect(result.recommendations[0]).toMatchObject({
      execution_status: "unsupported_pool_configuration",
      executable_weight_bps: null,
    });
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

  it("refreshes and returns a snapshot older than one day", async () => {
    const initialNow = Date.parse("2026-08-03T12:00:00.000Z");
    const refreshedAt = "2026-08-03T12:00:01.000Z";
    const requests: { method: string; pathname: string }[] = [];
    let clock = initialNow;
    let executionPolls = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      const method = init?.method ?? "GET";
      requests.push({ method, pathname: url.pathname });
      if (url.hostname !== "api.dune.com") {
        return poolResponse(pools);
      }
      expect(new Headers(init?.headers).get("X-Dune-API-Key")).toBe(
        "private-test-key",
      );
      if (url.pathname === "/api/v1/query/8187907/results") {
        return recommendationResponse("2026-08-02T11:59:59.999Z");
      }
      if (url.pathname === "/api/v1/query/8187907/execute") {
        expect(method).toBe("POST");
        return Response.json({
          execution_id: "refresh_1",
          state: "QUERY_STATE_PENDING",
        });
      }
      if (url.pathname === "/api/v1/execution/refresh_1/results") {
        executionPolls += 1;
        return executionPolls === 1
          ? Response.json({
              execution_id: "refresh_1",
              state: "QUERY_STATE_EXECUTING",
            })
          : recommendationResponse(refreshedAt);
      }
      throw new Error(`unexpected request ${method} ${url.pathname}`);
    }) as typeof fetch;

    const result = await getStonxAllocationRecommendation(
      env,
      { chainId, veToken, ve33 },
      fetcher,
      {
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
      },
    );

    expect(result.snapshot_at).toBe(refreshedAt);
    expect(result.snapshot_refreshed_on_request).toBe(true);
    expect(executionPolls).toBe(2);
    expect(requests).toContainEqual({
      method: "POST",
      pathname: "/api/v1/query/8187907/execute",
    });
  });

  it("reuses an already-running refresh instead of submitting another", async () => {
    const now = Date.parse("2026-08-03T12:00:00.000Z");
    let executeRequests = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.hostname !== "api.dune.com") return poolResponse(pools);
      if (url.pathname === "/api/v1/query/8187907/results") {
        return Response.json({
          execution_id: "refresh_in_progress",
          state: "QUERY_STATE_EXECUTING",
        });
      }
      if (url.pathname === "/api/v1/query/8187907/execute") {
        executeRequests += 1;
        throw new Error("must not submit a second refresh");
      }
      if (
        url.pathname ===
        "/api/v1/execution/refresh_in_progress/results"
      ) {
        return recommendationResponse("2026-08-03T11:59:59.000Z");
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url.pathname}`);
    }) as typeof fetch;

    const result = await getStonxAllocationRecommendation(
      env,
      { chainId, veToken, ve33 },
      fetcher,
      { now: () => now },
    );

    expect(result.snapshot_refreshed_on_request).toBe(true);
    expect(executeRequests).toBe(0);
  });

  it("fails closed when no snapshot is inside the usable window", async () => {
    const initialNow = Date.parse("2026-08-03T12:00:00.000Z");
    let clock = initialNow;
    let executeRequests = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.hostname !== "api.dune.com") return poolResponse(pools);
      if (url.pathname === "/api/v1/query/8187907/results") {
        // Well past the one-week ceiling, so there is nothing to fall back to.
        return recommendationResponse("2026-06-01T12:00:00.000Z");
      }
      if (url.pathname === "/api/v1/query/8187907/execute") {
        executeRequests += 1;
        return Response.json({
          execution_id: "refresh_timeout",
          state: "QUERY_STATE_PENDING",
        });
      }
      return Response.json({
        execution_id: "refresh_timeout",
        state: "QUERY_STATE_EXECUTING",
      });
    }) as typeof fetch;

    const error = await getStonxAllocationRecommendation(
      env,
      { chainId, veToken, ve33 },
      fetcher,
      {
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        refreshMaxWaitMs: 2_000,
        refreshPollIntervalMs: 1_000,
      },
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe(
      "allocation_recommendations_unavailable",
    );
    expect(executeRequests).toBe(1);
  });

  // The production outage this fixes: the upstream query runs at most once a
  // day, so every snapshot spends part of each day past the refresh threshold
  // with no newer run available. That must not take the tool offline.
  it("serves a day-old snapshot when the refresh never lands", async () => {
    const snapshotAt = "2026-08-01T12:00:00.000Z";
    let clock = Date.parse("2026-08-03T12:00:00.000Z");
    let executeRequests = 0;
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.hostname !== "api.dune.com") return poolResponse(pools);
      if (url.pathname === "/api/v1/query/8187907/results") {
        return recommendationResponse(snapshotAt);
      }
      if (url.pathname === "/api/v1/query/8187907/execute") {
        executeRequests += 1;
        return Response.json({
          execution_id: "refresh_never_lands",
          state: "QUERY_STATE_PENDING",
        });
      }
      return Response.json({
        execution_id: "refresh_never_lands",
        state: "QUERY_STATE_EXECUTING",
      });
    }) as typeof fetch;

    const result = await getStonxAllocationRecommendation(
      env,
      { chainId, veToken, ve33 },
      fetcher,
      {
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        refreshMaxWaitMs: 2_000,
        refreshPollIntervalMs: 1_000,
      },
    );

    // A refresh was attempted, and its failure did not discard the snapshot.
    expect(executeRequests).toBe(1);
    expect(result.snapshot_at).toBe(snapshotAt);
    expect(result.execution_ready).toBe(true);
    expect(result.target_total_weight_bps).toBe(10_000);
    // The caller is told exactly how stale the answer is rather than guessing.
    expect(result.snapshot_age_seconds).toBeGreaterThanOrEqual(2 * 86_400);
    expect(result.snapshot_refreshed_on_request).toBe(false);
  });

  it("caps executable recommendations at 25 pools and redistributes cutoff weight", async () => {
    const rows = Array.from({ length: 27 }, (_, index) =>
      recommendationRow({
        pair: `ETH/T${index + 1}`,
        token1: numberToHex(BigInt(index + 1), { size: 20 }),
        symbol1: `T${index + 1}`,
        weight: index < 25 ? 380 : 250,
        cap: index < 25 ? 400 : 250,
        priority: index + 1,
      }),
    );
    const poolRows = rows.map((row, index) =>
      poolRow(
        String(index + 1),
        row.asset1_address as `0x${string}`,
        1_024,
      ),
    );
    const result = await getStonxAllocationRecommendation(
      env,
      { chainId, veToken, ve33 },
      recommendationFetcher(200, rows, poolRows),
    );

    expect(result.execution_ready).toBe(true);
    expect(result.target_limit).toBe(25);
    expect(result.executable_target_count).toBe(25);
    expect(result.target_limit_excluded_weight_bps).toBe(500);
    expect(result.target_limit_excluded_recommendations).toHaveLength(2);
    expect(result.redistributed_weight_bps).toBe(500);
    expect(result.target_total_weight_bps).toBe(10_000);
    expect(result.targets.every(({ weight_bps }) => weight_bps === 400)).toBe(
      true,
    );
    expect(result.recommendations.slice(25).every(
      ({ execution_status }) => execution_status === "target_limit",
    )).toBe(true);
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

function stableswapPoolRow(poolKeyId: string, asset1: `0x${string}`) {
  return {
    chain_id: chainId,
    pool_key_id: poolKeyId,
    pool_id: numberToHex(BigInt(poolKeyId), { size: 32 }),
    token0,
    token1: asset1,
    extension: ve33,
    // A stableswap pool is priced by amplification around a center tick, so it
    // reports no tick spacing at all. This is the exact shape prod-api returns.
    tick_spacing: null,
    pool_state: {},
  };
}

function recommendationFetcher(
  status = 200,
  rows: Record<string, unknown>[] = recommendationRows,
  poolRows: Record<string, unknown>[] = pools,
  submittedAt = new Date().toISOString(),
) {
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
      return recommendationResponse(submittedAt, rows);
    }
    return poolResponse(poolRows);
  }) as typeof fetch;
}

function recommendationResponse(
  submittedAt: string,
  rows: Record<string, unknown>[] = recommendationRows,
) {
  return Response.json({
    state: "QUERY_STATE_COMPLETED",
    submitted_at: submittedAt,
    result: {
      metadata: { total_row_count: rows.length },
      rows,
    },
  });
}

function poolResponse(poolRows: Record<string, unknown>[]) {
  return Response.json({
    data: poolRows,
    total_vote_weight: "1000",
    pagination: {
      page: 1,
      pageSize: 200,
      totalPages: 1,
      totalItems: poolRows.length,
    },
  });
}
