import { fakeArtifactStore } from "./fake-r2.js";
import { describe, expect, it } from "bun:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  numberToHex,
  parseAbi,
} from "viem";
import { ServiceError } from "../src/core.js";
import {
  getVe33Allocations,
  prepareVe33Reallocation,
  toPoolKeyArgument,
} from "../src/ve33.js";

const chainId = "4663";
const owner = "0x1111111111111111111111111111111111111111" as const;
const veToken = "0x2222222222222222222222222222222222222222" as const;
const ve33 = "0x3333333333333333333333333333333333333333" as const;
const token0 = "0x0000000000000000000000000000000000000000" as const;
const token1 = "0x4444444444444444444444444444444444444444" as const;
const token2 = "0x5555555555555555555555555555555555555555" as const;
const now = 1_800_000_000;
const endA = now + 1_000_000;
const endB = now + 2_000_000;
const saltNonce = `0x${"42".repeat(32)}` as const;
const zeroPoolId = numberToHex(0n, { size: 32 });

type PoolFixture = {
  token0: `0x${string}`;
  token1: `0x${string}`;
  fee: string;
  tick_spacing: string;
  extension: `0x${string}`;
  stableswap_params: null;
};

const poolA: PoolFixture = {
  token0,
  token1,
  fee: "0",
  tick_spacing: "0x4",
  extension: ve33,
  stableswap_params: null,
};
const poolB: PoolFixture = {
  token0,
  token1: token2,
  fee: "0",
  tick_spacing: "0x10",
  extension: ve33,
  stableswap_params: null,
};

const poolId = (pool: PoolFixture) =>
  keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "token0", type: "address" },
            { name: "token1", type: "address" },
            { name: "config", type: "bytes32" },
          ],
        },
      ],
      [
        toPoolKeyArgument({
          token0: pool.token0,
          token1: pool.token1,
          fee: pool.fee,
          tickSpacing: Number(pool.tick_spacing),
          extension: pool.extension,
          stableswapParams: null,
        }),
      ],
    ),
  );

function tokenFixture({
  veId,
  amount,
  end = endA,
  pool = poolA,
  poolKeyId = "1",
  swapFee = "10",
  weight = amount,
  poolTotalWeight = "1000",
}: {
  veId: bigint;
  amount: string;
  end?: number;
  pool?: PoolFixture | null;
  poolKeyId?: string;
  swapFee?: string;
  weight?: string;
  poolTotalWeight?: string;
}) {
  return {
    chain_id: numberToHex(BigInt(chainId)),
    owner,
    ve_token_address: veToken,
    ve33_address: ve33,
    token_id: numberToHex(veId),
    stake_id: numberToHex((veId << 64n) | BigInt(end), { size: 32 }),
    amount,
    end_time: end.toString(),
    voted_pool_id: pool === null ? null : poolId(pool),
    voted_pool_key: pool,
    pool_key_id: pool === null ? null : poolKeyId,
    applied_vote_weight: pool === null ? null : weight,
    voted_swap_fee: pool === null ? null : swapFee,
    pool_total_vote_weight: pool === null ? null : poolTotalWeight,
    minted_at: null,
    mint_transaction_hash: null,
    last_stake_changed_event_id: `-${veId}`,
    last_transfer_event_id: `-${veId + 100n}`,
  };
}

const catalog = [
  {
    chain_id: chainId,
    pool_key_id: "1",
    pool_id: poolId(poolA),
    extension: ve33,
    pool_key: poolA,
    pool_state: {},
  },
  {
    chain_id: chainId,
    pool_key_id: "2",
    pool_id: poolId(poolB),
    extension: ve33,
    pool_key: poolB,
    pool_state: {},
  },
];

function fixtureFetcher(
  tokens: Record<string, unknown>[],
  pools: Record<string, unknown>[] = catalog,
) {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith("/pools")) {
      return Response.json({
        data: pools,
        total_vote_weight: "1000",
        pagination: {
          page: 1,
          pageSize: 200,
          totalPages: pools.length === 0 ? 0 : 1,
          totalItems: pools.length,
        },
      });
    }
    return Response.json({
      data: tokens,
      pagination: {
        page: 1,
        pageSize: 100,
        totalPages: tokens.length === 0 ? 0 : 1,
        totalItems: tokens.length,
      },
    });
  }) as typeof fetch;
}

const env = {
  ARTIFACT_STORE: fakeArtifactStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused",
  ACROSS_API_KEY: "unused",
  ACROSS_INTEGRATOR_ID: "unused",
  DUNE_API_KEY: "unused",
};

describe("safe VeToken allocation workflows", () => {
  it("shows aggregate pool, fee, NFT, and total allocations with one explicit on-chain validation request", async () => {
    const tokens = [
      tokenFixture({ veId: 1n, amount: "600", weight: "590" }),
      tokenFixture({ veId: 2n, amount: "300", weight: "290" }),
      tokenFixture({ veId: 3n, amount: "100", pool: null }),
    ];
    const result = await getVe33Allocations(
      env,
      { chainId, veToken, owner },
      fixtureFetcher(tokens),
      now,
    );

    expect(result.schema_version).toBe("2");
    expect(result.state_id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.snapshot).toMatchObject({
      indexed_owned_ve_tokens: 3,
      active_vote_ve_tokens: 2,
      unvoted_ve_tokens: 1,
    });
    expect(result.totals).toMatchObject({
      stake_amount: "1000",
      allocated_stake_amount: "900",
      unvoted_stake_amount: "100",
      applied_vote_weight: "880",
    });
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]).toMatchObject({
      pool_key_id: "1",
      account_stake_amount: "900",
      account_applied_vote_weight: "880",
    });
    expect(result.allocations[0].ve_tokens).toHaveLength(2);
    expect(
      BigInt(
        result.allocations[0].selected_swap_fees[0]
          .projected_current_voting_power,
      ),
    ).toBeGreaterThan(0n);
    expect(result.unvoted).toHaveLength(1);
    expect("provider_validation" in result).toBe(false);
    expect(result.onchain_validation).toMatchObject({
      status: "not_executed",
      required_before_signing: true,
      read_calls: {
        chain_id: chainId,
      },
    });
    expect(result.onchain_validation.calls).toHaveLength(13);
    const stateCall = result.onchain_validation.read_calls.calls[0];
    expect(stateCall.id).toBe("ekubo-ve33-portfolio-state");
    expect(stateCall.to).toBe(veToken);
    expect(stateCall.data).toStartWith("0xac9650d8");
    expect(result.onchain_validation.calls.slice(0, 5).map((call) => call.expectation)).toEqual([
      { comparison: "equals", path: "$", value: "3" },
      { comparison: "equals", path: "$", value: owner },
      { comparison: "fields_equal", fields: { amount: "600", endTime: endA.toString() } },
      {
        comparison: "fields_equal",
        fields: { poolId: poolId(poolA), weight: "590", votedSwapFee: "10" },
      },
      {
        comparison: "observe_dynamic",
        note: "Dynamic at the provider block; use this value for the final displayed projection.",
      },
    ]);
    expect(stateCall.decode).toMatchObject({
      kind: "function_result_bytes_array",
      function_name: "multicall",
      expected_result_count: 13,
      required: true,
    });
    expect(
      (stateCall.decode as { results: Record<string, unknown>[] }).results.every(
        (entry) =>
          Object.keys(entry).sort().join(",") === "decode,index" &&
          (entry.decode as { kind?: string } | undefined)?.kind ===
            "function_result",
      ),
    ).toBe(true);
  });

  it("claims every active NFT first, including zero-fee states, then splits and votes atomically", async () => {
    const tokens = [
      tokenFixture({ veId: 1n, amount: "600", weight: "590", swapFee: "0" }),
      tokenFixture({
        veId: 2n,
        amount: "300",
        pool: poolB,
        poolKeyId: "2",
        weight: "290",
        swapFee: "20",
      }),
      tokenFixture({ veId: 3n, amount: "100", pool: null }),
    ];
    const fetcher = fixtureFetcher(tokens);
    const current = await getVe33Allocations(
      env,
      { chainId, veToken, owner },
      fetcher,
      now,
    );
    const plan = await prepareVe33Reallocation(
      env,
      {
        chainId,
        veToken,
        sender: owner,
        currentStateId: current.state_id,
        targets: [
          { poolKeyId: "1", swapFee: "0", weightBps: 5_000 },
          { poolKeyId: "2", swapFee: "20", weightBps: 5_000 },
        ],
        saltNonce,
      },
      fetcher,
      now,
    );

    expect(plan.operation_counts).toEqual({
      fee_claims: 2,
      splits: 1,
      votes: 3,
      total_calls: 6,
    });
    expect(plan.schema_version).toBe("2");
    expect("provider_validation" in plan).toBe(false);
    expect(plan.onchain_validation).toMatchObject({
      status: "not_executed",
      required_before_signing: true,
      read_calls: {
        chain_id: chainId,
      },
    });
    expect(plan.onchain_validation.read_calls.calls[0].to).toBe(veToken);
    expect(plan.onchain_validation.calls).toHaveLength(13);
    expect(plan.calls.map((call) => call.type)).toEqual([
      "claim_pool_fees",
      "claim_pool_fees",
      "split_stake",
      "vote",
      "vote",
      "vote",
    ]);
    expect(plan.calls[0]).toMatchObject({ ve_id: "1", recipient: owner });
    expect(plan.calls[1]).toMatchObject({ ve_id: "2", recipient: owner });
    expect(plan.calls.some((call) => call.ve_id === "3")).toBe(false);
    expect(plan.safety).toMatchObject({
      one_atomic_vetoken_batch: true,
      all_current_fee_claims_are_first: true,
      claims_are_unconditional_even_when_claimable_is_zero: true,
      no_merges: true,
      no_lock_extensions: true,
      no_withdrawals: true,
      no_burns: true,
      no_explicit_clear_vote_calls: true,
      unvoted_ve_tokens_are_untouched: true,
    });
    const targetAmounts = plan.target_allocation.map(
      (target) => target.stake_amount,
    );
    expect(targetAmounts).toEqual(["450", "450"]);

    // Each veToken call is its own step now, so there is no outer call to
    // unwrap and the wallet can decode every one of them.
    expect(plan.transaction).toBeNull();
    expect(plan.transactions).toHaveLength(6);
    expect(plan.execution_plan?.required_capabilities).toContain(
      "atomic_batch",
    );
    const allowed = parseAbi([
      "function claimPoolFeesToSelf(uint256 veId,(address token0,address token1,bytes32 config) poolKey) payable returns (uint128,uint128)",
      "function splitStake(uint256 veId,uint128 amount,bytes32 salt) payable returns (uint256)",
      "function vote(uint256 veId,(address token0,address token1,bytes32 config) poolKey,uint64 swapFee) payable",
    ]);
    expect(
      plan.transactions.map(
        ({ data }) => decodeFunctionData({ abi: allowed, data }).functionName,
      ),
    ).toEqual([
      "claimPoolFeesToSelf",
      "claimPoolFeesToSelf",
      "splitStake",
      "vote",
      "vote",
      "vote",
    ]);
  });

  it("compacts active NFTs, extends the survivor to max, and creates one NFT per target", async () => {
    const tokens = [
      tokenFixture({ veId: 1n, amount: "600", end: endA, weight: "590" }),
      tokenFixture({
        veId: 2n,
        amount: "300",
        end: endB,
        pool: poolB,
        poolKeyId: "2",
        weight: "290",
        swapFee: "20",
      }),
    ];
    const fetcher = fixtureFetcher(tokens);
    const current = await getVe33Allocations(
      env,
      { chainId, veToken, owner },
      fetcher,
      now,
    );
    const plan = await prepareVe33Reallocation(
      env,
      {
        chainId,
        veToken,
        sender: owner,
        currentStateId: current.state_id,
        targets: [
          { poolKeyId: "1", swapFee: "10", weightBps: 5_000 },
          { poolKeyId: "2", swapFee: "20", weightBps: 5_000 },
        ],
        saltNonce,
        strategy: "compact_max_lock",
      },
      fetcher,
      now,
    );

    expect(plan.schema_version).toBe("3");
    expect(plan.strategy).toBe("compact_max_lock");
    expect(plan.calls.map((call) => call.type)).toEqual([
      "claim_fees_and_extend_max",
      "claim_fees_and_merge_stake",
      "split_stake",
      "vote",
      "vote",
    ]);
    expect(plan.operation_counts).toEqual({
      fee_claim_and_extensions: 1,
      fee_claim_and_merges: 1,
      fee_claims: 2,
      lock_extensions: 1,
      merges: 1,
      source_nft_burns: 1,
      splits: 1,
      votes: 2,
      total_calls: 5,
    });
    expect("compact_portfolio" in plan).toBe(true);
    if (!("compact_portfolio" in plan)) {
      throw new Error("expected compact reallocation plan");
    }
    expect(plan.compact_portfolio).toMatchObject({
      maximum_voting_nfts: 25,
      final_voting_nft_count: 2,
      surviving_ve_id: "1",
      burned_source_ve_ids: ["2"],
    });
    expect(plan.target_allocation).toHaveLength(2);
    expect(
      plan.target_allocation.every((target) => target.ve_tokens.length === 1),
    ).toBe(true);
    expect(plan.safety).toMatchObject({
      every_vote_is_claimed_before_it_is_cleared: true,
      final_one_voting_nft_per_target_pool: true,
      final_voting_nft_count_at_most_25: true,
      burns_redundant_source_nfts: true,
      max_lock_extension_is_explicit: true,
    });

    expect(plan.transaction).toBeNull();
    const allowed = parseAbi([
      "function claimPoolFeesAndExtendStakeToSelfMaxDuration(uint256 veId,(address token0,address token1,bytes32 config) poolKey) payable returns (uint128,uint128)",
      "function claimPoolFeesAndMergeStakesToSelf(uint256 fromVeId,uint256 toVeId,(address token0,address token1,bytes32 config) poolKey) payable returns (uint128,uint128,uint128)",
      "function splitStake(uint256 veId,uint128 amount,bytes32 salt) payable returns (uint256)",
      "function vote(uint256 veId,(address token0,address token1,bytes32 config) poolKey,uint64 swapFee) payable",
    ]);
    expect(
      plan.transactions.map(
        ({ data }) => decodeFunctionData({ abi: allowed, data }).functionName,
      ),
    ).toEqual([
      "claimPoolFeesAndExtendStakeToSelfMaxDuration",
      "claimPoolFeesAndMergeStakesToSelf",
      "splitStake",
      "vote",
      "vote",
    ]);
  });

  it("apportions every lock-end cohort independently so target weight shares decay together", async () => {
    const tokens = [
      tokenFixture({ veId: 1n, amount: "1000", end: endA }),
      tokenFixture({
        veId: 2n,
        amount: "3000",
        end: endB,
        pool: poolB,
        poolKeyId: "2",
        swapFee: "20",
      }),
    ];
    const fetcher = fixtureFetcher(tokens);
    const current = await getVe33Allocations(
      env,
      { chainId, veToken, owner },
      fetcher,
      now,
    );
    const plan = await prepareVe33Reallocation(
      env,
      {
        chainId,
        veToken,
        sender: owner,
        currentStateId: current.state_id,
        targets: [
          { poolKeyId: "1", swapFee: "10", weightBps: 2_500 },
          { poolKeyId: "2", swapFee: "20", weightBps: 7_500 },
        ],
        saltNonce,
      },
      fetcher,
      now,
    );
    expect(plan.operation_counts.splits).toBe(2);
    expect(plan.target_allocation.map((target) => target.stake_amount)).toEqual([
      "1000",
      "3000",
    ]);
    for (const target of plan.target_allocation) {
      const byEnd = new Map<string, bigint>();
      for (const token of target.ve_tokens) {
        byEnd.set(
          token.end_time,
          (byEnd.get(token.end_time) ?? 0n) + BigInt(token.stake_amount),
        );
      }
      const expectedA = target.target_weight_bps === 2_500 ? 250n : 750n;
      const expectedB = target.target_weight_bps === 2_500 ? 750n : 2_250n;
      expect(byEnd.get(endA.toString())).toBe(expectedA);
      expect(byEnd.get(endB.toString())).toBe(expectedB);
    }
  });

  it("rejects a stale reviewed state before resolving target pools", async () => {
    const tokens = [tokenFixture({ veId: 1n, amount: "1000" })];
    let poolRequests = 0;
    const base = fixtureFetcher(tokens);
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(input.toString()).pathname.endsWith("/pools")) poolRequests++;
      return base(input, init);
    }) as typeof fetch;
    const error = await prepareVe33Reallocation(
      env,
      {
        chainId,
        veToken,
        sender: owner,
        currentStateId: `0x${"ff".repeat(32)}`,
        targets: [{ poolKeyId: "1", swapFee: "10", weightBps: 10_000 }],
        saltNonce,
      },
      fetcher,
      now,
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("ve33_state_changed");
    expect(poolRequests).toBe(0);
  });

  it("rejects invalid target totals and expired active votes", async () => {
    const tokens = [tokenFixture({ veId: 1n, amount: "1000" })];
    const fetcher = fixtureFetcher(tokens);
    const current = await getVe33Allocations(
      env,
      { chainId, veToken, owner },
      fetcher,
      now,
    );
    const invalidTotal = await prepareVe33Reallocation(
      env,
      {
        chainId,
        veToken,
        sender: owner,
        currentStateId: current.state_id,
        targets: [{ poolKeyId: "1", swapFee: "10", weightBps: 9_999 }],
        saltNonce,
      },
      fetcher,
      now,
    ).catch((caught) => caught);
    expect((invalidTotal as ServiceError).code).toBe("invalid_ve33_intent");

    const expiredTokens = [
      tokenFixture({ veId: 1n, amount: "1000", end: now }),
    ];
    const expiredFetcher = fixtureFetcher(expiredTokens);
    const expiredCurrent = await getVe33Allocations(
      env,
      { chainId, veToken, owner },
      expiredFetcher,
      now,
    );
    const expired = await prepareVe33Reallocation(
      env,
      {
        chainId,
        veToken,
        sender: owner,
        currentStateId: expiredCurrent.state_id,
        targets: [{ poolKeyId: "1", swapFee: "10", weightBps: 10_000 }],
        saltNonce,
      },
      expiredFetcher,
      now,
    ).catch((caught) => caught);
    expect((expired as ServiceError).code).toBe("expired_ve33_votes");
  });

  it("commits every source-state field that can invalidate a reviewed plan", async () => {
    const base = tokenFixture({ veId: 1n, amount: "1000" });
    const baseline = await getVe33Allocations(
      env,
      { chainId, veToken, owner },
      fixtureFetcher([base]),
      now,
    );
    const variants = [
      { ...base, amount: "1001" },
      tokenFixture({
        veId: 1n,
        amount: "1000",
        pool: poolB,
        poolKeyId: "2",
        swapFee: "20",
      }),
      { ...base, last_stake_changed_event_id: "-999" },
      { ...base, last_transfer_event_id: "-998" },
    ];

    for (const token of variants) {
      const changed = await getVe33Allocations(
        env,
        { chainId, veToken, owner },
        fixtureFetcher([token]),
        now,
      );
      expect(changed.state_id).not.toBe(baseline.state_id);
    }
  });

  it("rejects conflicting pool totals in one indexed portfolio snapshot", async () => {
    const error = await getVe33Allocations(
      env,
      { chainId, veToken, owner },
      fixtureFetcher([
        tokenFixture({ veId: 1n, amount: "600", poolTotalWeight: "1000" }),
        tokenFixture({ veId: 2n, amount: "400", poolTotalWeight: "1001" }),
      ]),
      now,
    ).catch((caught) => caught);
    expect((error as ServiceError).code).toBe("invalid_upstream_response");
  });

  it("still claims and re-votes one unchanged NFT in one atomic multicall", async () => {
    const tokens = [tokenFixture({ veId: 1n, amount: "1000" })];
    const fetcher = fixtureFetcher(tokens);
    const current = await getVe33Allocations(
      env,
      { chainId, veToken, owner },
      fetcher,
      now,
    );
    const plan = await prepareVe33Reallocation(
      env,
      {
        chainId,
        veToken,
        sender: owner,
        currentStateId: current.state_id,
        targets: [{ poolKeyId: "1", swapFee: "10", weightBps: 10_000 }],
        saltNonce,
      },
      fetcher,
      now,
    );

    expect(plan.calls.map((call) => call.type)).toEqual([
      "claim_pool_fees",
      "vote",
    ]);
    expect(plan.operation_counts).toEqual({
      fee_claims: 1,
      splits: 0,
      votes: 1,
      total_calls: 2,
    });
    expect(plan.target_allocation[0]).toMatchObject({
      target_weight_bps: 10_000,
      projected_weight_bps_rounded: 10_000,
      projected_weight_bps_difference: 0,
    });
    expect(plan.projection.total_projected_vote_weight).not.toBe("0");
    // No outer multicall: every veToken call is a step the wallet can decode.
    expect(plan.transaction).toBeNull();
    expect(plan.transactions.length).toBeGreaterThan(1);
  });

  it("compiles an exact fee-first allocation plan across the 25-pool limit", async () => {
    const generated = Array.from({ length: 25 }, (_, index) => {
      const pool: PoolFixture = {
        token0,
        token1: numberToHex(BigInt(index + 1), { size: 20 }),
        fee: "0",
        tick_spacing: "4",
        extension: ve33,
        stableswap_params: null,
      };
      return {
        pool,
        catalog: {
          chain_id: chainId,
          pool_key_id: String(index + 1_000),
          pool_id: poolId(pool),
          extension: ve33,
          pool_key: pool,
          pool_state: {},
        },
      };
    });
    const tokens = [tokenFixture({ veId: 1n, amount: "1000000" })];
    const fetcher = fixtureFetcher(
      tokens,
      generated.map(({ catalog }) => catalog),
    );
    const current = await getVe33Allocations(
      env,
      { chainId, veToken, owner },
      fetcher,
      now,
    );
    const plan = await prepareVe33Reallocation(
      env,
      {
        chainId,
        veToken,
        sender: owner,
        currentStateId: current.state_id,
        targets: generated.map(({ catalog }, index) => ({
          poolKeyId: catalog.pool_key_id,
          swapFee: String(index),
          weightBps: 400,
        })),
        saltNonce,
      },
      fetcher,
      now,
    );

    expect(plan.target_allocation).toHaveLength(25);
    expect(plan.operation_counts).toEqual({
      fee_claims: 1,
      splits: 24,
      votes: 25,
      total_calls: 50,
    });
    expect(
      plan.target_allocation.reduce(
        (sum, target) => sum + target.target_weight_bps,
        0,
      ),
    ).toBe(10_000);
    expect(plan.calls[0].type).toBe("claim_pool_fees");
    expect(plan.transaction_safety).toMatchObject({
      only_allowlisted_vetoken_functions: true,
      ownership_or_nft_transfer_calls: 0,
    });
  });

  it("rejects missing, uninitialized, and inconsistent target pools", async () => {
    const tokens = [tokenFixture({ veId: 1n, amount: "1000" })];
    const current = await getVe33Allocations(
      env,
      { chainId, veToken, owner },
      fixtureFetcher(tokens),
      now,
    );
    const intent = {
      chainId,
      veToken,
      sender: owner,
      currentStateId: current.state_id,
      saltNonce,
    };

    const unknown = await prepareVe33Reallocation(
      env,
      {
        ...intent,
        targets: [{ poolKeyId: "999", swapFee: "10", weightBps: 10_000 }],
      },
      fixtureFetcher(tokens),
      now,
    ).catch((caught) => caught);
    expect((unknown as ServiceError).code).toBe("unknown_ve33_pool");

    const uninitializedCatalog = catalog.map((pool) =>
      pool.pool_key_id === "1" ? { ...pool, pool_state: null } : pool,
    );
    const uninitialized = await prepareVe33Reallocation(
      env,
      {
        ...intent,
        targets: [{ poolKeyId: "1", swapFee: "10", weightBps: 10_000 }],
      },
      fixtureFetcher(tokens, uninitializedCatalog),
      now,
    ).catch((caught) => caught);
    expect((uninitialized as ServiceError).code).toBe(
      "uninitialized_ve33_pool",
    );

    const inconsistentCatalog = catalog.map((pool) =>
      pool.pool_key_id === "1" ? { ...pool, pool_id: zeroPoolId } : pool,
    );
    const inconsistent = await prepareVe33Reallocation(
      env,
      {
        ...intent,
        targets: [{ poolKeyId: "1", swapFee: "10", weightBps: 10_000 }],
      },
      fixtureFetcher(tokens, inconsistentCatalog),
      now,
    ).catch((caught) => caught);
    expect((inconsistent as ServiceError).code).toBe(
      "invalid_upstream_response",
    );
  });

  it("rejects no-op portfolios and target shares that cannot receive one unit", async () => {
    const unvotedTokens = [
      tokenFixture({ veId: 1n, amount: "1000", pool: null }),
    ];
    const unvotedFetcher = fixtureFetcher(unvotedTokens);
    const unvotedCurrent = await getVe33Allocations(
      env,
      { chainId, veToken, owner },
      unvotedFetcher,
      now,
    );
    const noActive = await prepareVe33Reallocation(
      env,
      {
        chainId,
        veToken,
        sender: owner,
        currentStateId: unvotedCurrent.state_id,
        targets: [{ poolKeyId: "1", swapFee: "10", weightBps: 10_000 }],
        saltNonce,
      },
      unvotedFetcher,
      now,
    ).catch((caught) => caught);
    expect((noActive as ServiceError).code).toBe("no_active_ve33_votes");

    const tokens = [tokenFixture({ veId: 1n, amount: "1000" })];
    const fetcher = fixtureFetcher(tokens);
    const current = await getVe33Allocations(
      env,
      { chainId, veToken, owner },
      fetcher,
      now,
    );
    const roundsToZero = await prepareVe33Reallocation(
      env,
      {
        chainId,
        veToken,
        sender: owner,
        currentStateId: current.state_id,
        targets: [
          { poolKeyId: "1", swapFee: "10", weightBps: 1 },
          { poolKeyId: "2", swapFee: "20", weightBps: 9_999 },
        ],
        saltNonce,
      },
      fetcher,
      now,
    ).catch((caught) => caught);
    expect((roundsToZero as ServiceError).code).toBe(
      "ve33_target_rounds_to_zero",
    );
  });

  it("preserves every source unit and fee-first ordering across varied portfolios", async () => {
    let randomState = 0x5eed1234;
    const random = () => {
      randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
      return randomState;
    };

    for (let iteration = 0; iteration < 64; iteration++) {
      const tokenCount = 1 + (random() % 8);
      const tokens = Array.from({ length: tokenCount }, (_, index) => {
        const usePoolB = random() % 2 === 0;
        return tokenFixture({
          veId: BigInt(index + 1),
          amount: String(10_000 + (random() % 1_000_000)),
          end: random() % 2 === 0 ? endA : endB,
          pool: usePoolB ? poolB : poolA,
          poolKeyId: usePoolB ? "2" : "1",
          swapFee: usePoolB ? "20" : "10",
          poolTotalWeight: "1000000000",
        });
      });
      const weightA = 1_000 + (random() % 8_001);
      const fetcher = fixtureFetcher(tokens);
      const current = await getVe33Allocations(
        env,
        { chainId, veToken, owner },
        fetcher,
        now,
      );
      const plan = await prepareVe33Reallocation(
        env,
        {
          chainId,
          veToken,
          sender: owner,
          currentStateId: current.state_id,
          targets: [
            { poolKeyId: "1", swapFee: "10", weightBps: weightA },
            { poolKeyId: "2", swapFee: "20", weightBps: 10_000 - weightA },
          ],
          saltNonce: numberToHex(BigInt(iteration + 1), { size: 32 }),
        },
        fetcher,
        now,
      );

      const callTypes = plan.calls.map((call) => call.type);
      expect(callTypes.slice(0, tokenCount)).toEqual(
        Array(tokenCount).fill("claim_pool_fees"),
      );
      expect(
        callTypes.slice(tokenCount).every((type, index, tail) =>
          type === "split_stake" ||
          (type === "vote" && !tail.slice(index + 1).includes("split_stake")),
        ),
      ).toBe(true);

      const pieces = plan.target_allocation.flatMap((target) => target.ve_tokens);
      expect(
        pieces.reduce((sum, piece) => sum + BigInt(piece.stake_amount), 0n),
      ).toBe(tokens.reduce((sum, token) => sum + BigInt(token.amount), 0n));
      expect(pieces.every((piece) => BigInt(piece.stake_amount) > 0n)).toBe(true);
      expect(
        pieces
          .filter((piece) => !piece.is_new)
          .map((piece) => piece.ve_id)
          .sort(),
      ).toEqual(tokens.map((token) => BigInt(token.token_id).toString()).sort());

      for (const end of [endA, endB]) {
        const cohortTotal = tokens
          .filter((token) => token.end_time === end.toString())
          .reduce((sum, token) => sum + BigInt(token.amount), 0n);
        if (cohortTotal === 0n) continue;
        const expected = apportionTwo(cohortTotal, weightA);
        expect(
          plan.target_allocation.map((target) =>
            target.ve_tokens
              .filter((piece) => piece.end_time === end.toString())
              .reduce((sum, piece) => sum + BigInt(piece.stake_amount), 0n),
          ),
        ).toEqual(expected);
      }
    }
  });
});

function apportionTwo(total: bigint, firstBps: number): bigint[] {
  const weights = [BigInt(firstBps), BigInt(10_000 - firstBps)];
  const amounts = weights.map((weight) => (total * weight) / 10_000n);
  let remainder = total - amounts[0] - amounts[1];
  const order = [0, 1].sort((left, right) => {
    const leftRemainder = (total * weights[left]) % 10_000n;
    const rightRemainder = (total * weights[right]) % 10_000n;
    return leftRemainder > rightRemainder
      ? -1
      : leftRemainder < rightRemainder
        ? 1
        : left - right;
  });
  for (const index of order) {
    if (remainder === 0n) break;
    amounts[index] += 1n;
    remainder -= 1n;
  }
  return amounts;
}
