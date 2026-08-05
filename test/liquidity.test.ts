import { fakePlanStore } from "./fake-kv.js";
import { describe, expect, it } from "bun:test";
import type { Env } from "../src/core.js";
import {
  prepareLpPositionDeposit,
  prepareLpPositionEarningsClaim,
  prepareLpPositionWithdraw,
  preparePoolInitialization,
} from "../src/liquidity.js";
import { derivePoolId } from "../src/pools.js";

const env = {
  PLAN_STORE: fakePlanStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused",
  ACROSS_API_KEY: "unused",
  ACROSS_INTEGRATOR_ID: "unused",
  DUNE_API_KEY: "unused",
} satisfies Env;

const native = "0x0000000000000000000000000000000000000000";
const usdg = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const aapl = "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9";
const core = "0x00000000000014aA86C5d3c41765bb24e11bd701";
const ve33 = "0xD18685a514E59b06d59824e16Db07e73345d9953";
const ve33Positions = "0xdA38ac72CE7220c4dd7719d114ef94eDadb8f068";
const positionsV3 = "0x02D9876A21AF7545f8632C3af76eC90b5ad4b66D";
const positionsV2 = "0xA37cc341634AFD9E0919D334606E676dbAb63E17";
const sender = "0xaf42bF32648740e62A754413EFFDEB1782ce5443";

describe("LP position preparation", () => {
  it("prepares standalone idempotent pool initialization", () => {
    const pool = derivePoolId({
      token0: native,
      token1: usdg,
      fee: "0",
      extension: ve33,
      tickSpacing: 1024,
    });
    const result = preparePoolInitialization({
      chainId: "4663",
      sender,
      coreAddress: core,
      poolKey: pool.pool_key,
      initialTick: -20_167_000,
    });

    expect(result).toMatchObject({
      action: "ekubo_initialize_pool",
      execution_plan_ready: true,
      request: {
        chain_id: "4663",
        pool_id: pool.pool_id,
        pool_key: pool.pool_key,
        initial_tick: -20_167_000,
      },
      positions_manager: {
        address: ve33Positions,
        contract: "Ve33Positions",
      },
      decoded_calls: [
        {
          function: "maybeInitializePool",
          target: ve33Positions,
        },
      ],
      transaction: { to: ve33Positions, value: "0" },
    });
    expect(result.pool.initialization.idempotent_if_already_initialized).toBe(
      true,
    );
    expect(result.execution_plan.ordered_steps).toHaveLength(1);
    expect(result.execution_plan.ordered_steps[0]?.kind).toBe("execution");
    expect(result.wallet_policy_requirements.calldata_selectors).toEqual([
      {
        target: ve33Positions,
        function: "maybeInitializePool",
        selector: result.transaction.data.slice(0, 10),
        nested_in_multicall: false,
      },
    ]);

    const standardPool = derivePoolId({
      token0: native,
      token1: usdg,
      fee: "1",
      extension: native,
      tickSpacing: 1,
    });
    expect(
      preparePoolInitialization({
        chainId: "1",
        sender,
        coreAddress: core,
        poolKey: standardPool.pool_key,
        initialTick: 0,
      }).positions_manager,
    ).toMatchObject({ address: positionsV3, contract: "Positions" });
  });

  it("builds approvals, a nonzero liquidity floor, native refund, and wallet plan", async () => {
    const pool = derivePoolId({
      token0: native,
      token1: usdg,
      fee: "0",
      extension: ve33,
      tickSpacing: 1024,
    });
    const result = await prepareLpPositionDeposit(
      env,
      {
        chainId: "4663",
        sender,
        coreAddress: core,
        poolId: pool.pool_id,
        mode: "mint_new",
        tickLower: -20_495_360,
        tickUpper: -19_787_776,
        maxAmount0: "100000000000000",
        maxAmount1: "185278",
        slippageBps: 50,
      },
      (async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith("/key")) {
          return Response.json({
            pool_key: {
              token0: native,
              token1: usdg,
              fee: "0x0",
              tick_spacing: "0x400",
              extension: ve33,
              stableswap_params: null,
            },
          });
        }
        if (url.includes("/positions?limit=1")) {
          return Response.json({
            data: [
              {
                pool_state: {
                  sqrt_ratio: "2086582449616150103124962850664448",
                  tick: -20_167_000,
                  liquidity: "1000000000000",
                },
              },
            ],
          });
        }
        if (url.includes("/tokens/batch?")) {
          return Response.json([
            { chain_id: "4663", address: native, symbol: "ETH", decimals: 18 },
            { chain_id: "4663", address: usdg, symbol: "USDG", decimals: 6 },
          ]);
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
    );

    expect(result.positions_manager.address).toBe(ve33Positions);
    expect(
      BigInt(result.liquidity_protection.minimum_liquidity),
    ).toBeGreaterThan(0n);
    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]?.to).toBe(
      "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    );
    expect(result.transaction.value).toBe("100000000000000");
    expect(result.transaction.data.slice(0, 10)).toBe("0xac9650d8");
    expect(result.decoded_calls.map((call) => call.function)).toEqual([
      "mintAndDeposit",
      "refundNativeToken",
    ]);
    expect(result.decoded_calls[0]?.arguments).toMatchObject({
      pool_key: pool.pool_key,
      tick_lower: -20_495_360,
      tick_upper: -19_787_776,
      max_amount0: "100000000000000",
      max_amount1: "185278",
      min_liquidity: result.liquidity_protection.minimum_liquidity,
    });
    expect(result.wallet_policy_requirements).toMatchObject({
      allowed_approval_spenders: [ve33Positions],
      native_value_in_plan: "100000000000000",
      required_max_native_value_per_batch_at_least: "100000000000000",
    });
    expect(
      result.wallet_policy_requirements.calldata_selectors.map(
        (selector) => selector.function,
      ),
    ).toEqual(["approve", "multicall", "mintAndDeposit", "refundNativeToken"]);
    expect(
      result.execution_plan.ordered_steps.map((step) => step.kind),
    ).toEqual(["approval", "execution", "allowance_cleanup"]);
    expect(result.wallet_handoff.calldata_complete).toContain("wallet tooling");
  });

  it("uses indexed Q128 prices and protects imbalanced deposits at slippage endpoints", async () => {
    const pool = derivePoolId({
      token0: usdg,
      token1: aapl,
      fee: "0",
      extension: ve33,
      tickSpacing: 1024,
    });
    const result = await prepareLpPositionDeposit(
      env,
      {
        chainId: "4663",
        sender,
        coreAddress: core,
        poolId: pool.pool_id,
        mode: "mint_new",
        tickLower: 21_835_776,
        tickUpper: 21_987_328,
        maxAmount0: "58775049870",
        maxAmount1: "24688761276276600317",
        slippageBps: 100,
      },
      (async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith("/key")) {
          return Response.json({
            pool_key: {
              token0: usdg,
              token1: aapl,
              fee: "0x0",
              tick_spacing: "0x400",
              extension: ve33,
              stableswap_params: null,
            },
          });
        }
        if (url.includes("/positions?limit=1")) {
          return Response.json({
            data: [
              {
                pool_state: {
                  sqrt_ratio: "19517224466909814455579508667699864543428608",
                  tick: 21_914_075,
                  liquidity: "578492742679486189",
                },
              },
            ],
          });
        }
        if (url.includes("/tokens/batch?")) {
          return Response.json([
            { chain_id: "4663", address: usdg, symbol: "USDG", decimals: 6 },
            { chain_id: "4663", address: aapl, symbol: "AAPL", decimals: 18 },
          ]);
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
    );

    expect(result.liquidity_protection.expected_liquidity_at_indexed_price).toBe(
      "11211571085399720",
    );
    expect(
      BigInt(result.liquidity_protection.minimum_liquidity),
    ).toBeLessThanOrEqual(11_211_571_085_399_720n);
    expect(
      BigInt(result.liquidity_protection.minimum_liquidity),
    ).toBeGreaterThan(0n);
    expect(result.execution_plan.ordered_steps[2]?.revert_decode).toMatchObject({
      kind: "error_result",
      required: false,
      abi: expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          name: "DepositFailedDueToSlippage",
        }),
      ]),
    });
  });

  it("rejects zero-slippage-floor patterns and mismatched modes", async () => {
    await expect(
      prepareLpPositionDeposit(env, {
        chainId: "4663",
        sender,
        coreAddress: core,
        poolId: "1",
        mode: "add_liquidity",
        tickLower: -1024,
        tickUpper: 1024,
        maxAmount0: "1",
        maxAmount1: "1",
        slippageBps: 50,
      }),
    ).rejects.toThrow("add_liquidity must provide token_id");
  });

  it("derives and initializes a new exact pool before minting", async () => {
    const pool = derivePoolId({
      token0: native,
      token1: usdg,
      fee: "0",
      extension: ve33,
      tickSpacing: 1024,
    });
    const result = await prepareLpPositionDeposit(
      env,
      {
        chainId: "4663",
        sender,
        coreAddress: core,
        poolKey: pool.pool_key,
        poolInitialized: false,
        mode: "mint_new",
        tickLower: -20_495_360,
        tickUpper: -19_787_776,
        initialTick: -20_167_000,
        maxAmount0: "100000000000000",
        maxAmount1: "185278",
        slippageBps: 50,
      },
      (async (input: RequestInfo | URL) => {
        if (input.toString().includes("/tokens/batch?")) {
          return Response.json([
            { chain_id: "4663", address: native, symbol: "ETH", decimals: 18 },
            { chain_id: "4663", address: usdg, symbol: "USDG", decimals: 6 },
          ]);
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
    );

    expect(result.pool.initialized_before_plan).toBe(false);
    expect(result.pool.initialization).toMatchObject({
      initial_tick: -20_167_000,
    });
    expect(result.decoded_calls.map((call) => call.function)).toEqual([
      "maybeInitializePool",
      "mintAndDeposit",
      "refundNativeToken",
    ]);
    expect(result.transaction.data.slice(0, 10)).toBe("0xac9650d8");
  });

  it("prepares standard fee collection without removing liquidity", async () => {
    const result = await prepareLpPositionEarningsClaim(
      env,
      {
        chainId: "4663",
        sender,
        positionsAddress: positionsV3,
        tokenId: "42",
      },
      ownedPositionFetcher({
        positionsAddress: positionsV3,
        extension: native,
      }),
    );

    expect(result.action).toBe("ekubo_collect_lp_position_fees");
    expect(result.claim).toMatchObject({
      kind: "collect_fees",
      implementation_function: "collectFees",
      removes_liquidity: false,
      burns_or_transfers_nft: false,
    });
    expect(result.decoded_calls[0]?.arguments).not.toHaveProperty("liquidity");
    expect(result.onchain_validation.claimable_result_fields).toEqual([
      "fees0",
      "fees1",
    ]);
    expect(result.execution_plan.ordered_steps).toHaveLength(1);
    expect(result.execution_plan.ordered_steps[0]?.kind).toBe("execution");
    expect(result.wallet_handoff.calldata_complete).toContain("wallet tooling");
  });

  it("prepares Ve33 reward claiming without removing liquidity", async () => {
    const result = await prepareLpPositionEarningsClaim(
      env,
      {
        chainId: "4663",
        sender,
        positionsAddress: ve33Positions,
        tokenId: "43",
      },
      ownedPositionFetcher({
        positionsAddress: ve33Positions,
        extension: ve33,
        tokenId: "43",
      }),
    );

    expect(result.action).toBe("ekubo_claim_lp_position_rewards");
    expect(result.claim).toMatchObject({
      kind: "claim_rewards",
      implementation_function: "claimRewards",
      removes_liquidity: false,
      burns_or_transfers_nft: false,
    });
    expect(result.onchain_validation.claimable_result_fields).toEqual([
      "rewardAmount",
    ]);
    expect(
      result.onchain_validation.current_state_query.inner_calls.map(
        (call) => call.function,
      ),
    ).toEqual([
      "maybeAccumulateRewards",
      "getPositionRewardsAndLiquidity",
      "ownerOf",
    ]);
    expect(result.reward_token?.known_address).toBe(
      "0x570C5aa79c798E7A418412cC8399ae5bcCe570C5",
    );
    expect(result.wallet_policy_requirements.allowed_targets).toEqual([
      ve33Positions,
    ]);
  });

  it("uses the explicit zero-liquidity fee path for legacy v2", async () => {
    const result = await prepareLpPositionEarningsClaim(
      env,
      {
        chainId: "4663",
        sender,
        positionsAddress: positionsV2,
        tokenId: "44",
      },
      ownedPositionFetcher({
        positionsAddress: positionsV2,
        extension: native,
        tokenId: "44",
      }),
    );

    expect(result.claim.implementation_function).toBe("withdraw");
    expect(result.decoded_calls[0]?.arguments).toMatchObject({
      liquidity: "0",
      with_fees: true,
      recipient: sender,
    });
    expect(result.claim.removes_liquidity).toBe(false);
  });

  it("prepares a partial v3 withdrawal and collects fees in one call", async () => {
    const result = await prepareLpPositionWithdraw(
      env,
      {
        chainId: "4663",
        sender,
        positionsAddress: positionsV3,
        tokenId: "42",
        liquidity: "400",
      },
      ownedPositionFetcher({
        positionsAddress: positionsV3,
        extension: native,
      }),
    );

    expect(result.action).toBe("ekubo_withdraw_lp_position");
    expect(result.withdrawal).toMatchObject({
      implementation_function: "withdraw",
      requested_liquidity: "400",
      indexed_liquidity: "1000",
      requested_share_bps_of_indexed_liquidity: "4000",
      full_withdrawal_by_indexed_snapshot: false,
      collects_fees: true,
      claims_ve33_rewards: false,
      burns_or_transfers_nft: false,
    });
    expect(result.decoded_calls[0]?.arguments).toMatchObject({
      liquidity: "400",
      recipient: sender,
      with_fees: true,
    });
    expect(result.execution_plan.ordered_steps).toHaveLength(1);
    expect(result.execution_plan.ordered_steps[0]?.kind).toBe("execution");
    expect(result.output_protection.contract_minimum_amounts_supported).toBe(
      false,
    );
    expect(result.wallet_handoff.calldata_complete).toContain(
      "complete transaction list",
    );
  });

  it("prepares a full Ve33 withdrawal with its reward claim", async () => {
    const result = await prepareLpPositionWithdraw(
      env,
      {
        chainId: "4663",
        sender,
        positionsAddress: ve33Positions,
        tokenId: "43",
        liquidity: "1000",
      },
      ownedPositionFetcher({
        positionsAddress: ve33Positions,
        extension: ve33,
        tokenId: "43",
      }),
    );

    expect(result.withdrawal).toMatchObject({
      implementation_function: "withdrawAndClaimRewards",
      full_withdrawal_by_indexed_snapshot: true,
      collects_fees: false,
      claims_ve33_rewards: true,
    });
    expect(
      result.decoded_calls[0]?.result_fields.map((field) => field.name),
    ).toEqual(["amount0", "amount1", "rewardAmount"]);
    expect(result.onchain_validation.required_current_liquidity_at_least).toBe(
      "1000",
    );
  });

  it("prepares unrelated position withdrawals as one atomic wallet batch", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/positions/")) {
        return Response.json({
          data: [
            {
              chain_id: "4663",
              id: "42",
              positions_address: positionsV3,
              pool_key: {
                token0: native,
                token1: usdg,
                fee: "1844674407370955",
                tick_spacing: "1024",
                extension: native,
                stableswap_params: null,
              },
              bounds: { lower: -20_495_360, upper: -19_787_776 },
              liquidity: "1000",
            },
            {
              chain_id: "4663",
              id: "44",
              positions_address: positionsV2,
              pool_key: {
                token0: native,
                token1: usdg,
                fee: "1844674407370955",
                tick_spacing: "1024",
                extension: native,
                stableswap_params: null,
              },
              bounds: { lower: -20_495_360, upper: -19_787_776 },
              liquidity: "1000",
            },
          ],
          pagination: { totalPages: 1 },
        });
      }
      if (url.includes("/tokens/batch?")) {
        return Response.json([
          { chain_id: "4663", address: native, symbol: "ETH", decimals: 18 },
          { chain_id: "4663", address: usdg, symbol: "USDG", decimals: 6 },
        ]);
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = (await prepareLpPositionWithdraw(
      env,
      {
        chainId: "4663",
        sender,
        withdrawals: [
          { positionsAddress: positionsV3, tokenId: "42", liquidity: "400" },
          { positionsAddress: positionsV2, tokenId: "44", liquidity: "250" },
        ],
      },
      fetcher,
    )) as any;

    expect(result.action).toBe("ekubo_withdraw_lp_positions");
    expect(result.withdrawals).toHaveLength(2);
    expect(result.execution_plan.ordered_steps).toHaveLength(2);
    expect(result.execution_plan.execution_policy.atomic_batch_required).toBe(true);
    expect(result.execution_plan.simulation_failure_policy.execution_reverted).toMatchObject({
      action: "reprepare_plan",
      instruction: expect.stringContaining("fresh withdrawal"),
    });
    expect(result.wallet_handoff.instruction).toContain("unrelated");
  });

  it("prepares the explicit v2 withdrawal overload with fees", async () => {
    const result = await prepareLpPositionWithdraw(
      env,
      {
        chainId: "4663",
        sender,
        positionsAddress: positionsV2,
        tokenId: "44",
        liquidity: "250",
      },
      ownedPositionFetcher({
        positionsAddress: positionsV2,
        extension: native,
        tokenId: "44",
      }),
    );

    expect(result.position.manager_version).toBe("positions_v2");
    expect(result.decoded_calls[0]?.arguments).toMatchObject({
      bounds: { lower: -20_495_360, upper: -19_787_776 },
      liquidity: "250",
      with_fees: true,
    });
    expect(result.withdrawal.collects_fees).toBe(true);
  });

  it("rejects zero-liquidity withdrawal plans", async () => {
    await expect(
      prepareLpPositionWithdraw(env, {
        chainId: "4663",
        sender,
        positionsAddress: positionsV3,
        tokenId: "42",
        liquidity: "0",
      }),
    ).rejects.toThrow("Withdrawal liquidity must be positive");
  });
});

function ownedPositionFetcher({
  positionsAddress,
  extension,
  tokenId = "42",
}: {
  positionsAddress: string;
  extension: string;
  tokenId?: string;
}) {
  return (async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/positions/")) {
      return Response.json({
        data: [
          {
            chain_id: "4663",
            id: tokenId,
            positions_address: positionsAddress,
            pool_key: {
              token0: native,
              token1: usdg,
              fee: extension === ve33 ? "0" : "1844674407370955",
              tick_spacing: "1024",
              extension,
              stableswap_params: null,
            },
            bounds: { lower: -20_495_360, upper: -19_787_776 },
            liquidity: "1000",
          },
        ],
        pagination: { totalPages: 1 },
      });
    }
    if (url.includes("/tokens/batch?")) {
      return Response.json([
        { chain_id: "4663", address: native, symbol: "ETH", decimals: 18 },
        { chain_id: "4663", address: usdg, symbol: "USDG", decimals: 6 },
        {
          chain_id: "4663",
          address: "0x570C5aa79c798E7A418412cC8399ae5bcCe570C5",
          symbol: "STONX",
          decimals: 18,
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}
