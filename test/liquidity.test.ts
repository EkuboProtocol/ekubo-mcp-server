import { describe, expect, it } from "bun:test";
import type { Env } from "../src/core.js";
import { prepareLpPositionDeposit } from "../src/liquidity.js";
import { derivePoolId } from "../src/pools.js";

const env = {
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused",
  ACROSS_API_KEY: "unused",
  ACROSS_INTEGRATOR_ID: "unused",
  DUNE_API_KEY: "unused",
} satisfies Env;

const native = "0x0000000000000000000000000000000000000000";
const usdg = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const core = "0x00000000000014aA86C5d3c41765bb24e11bd701";
const ve33 = "0xD18685a514E59b06d59824e16Db07e73345d9953";
const ve33Positions = "0xdA38ac72CE7220c4dd7719d114ef94eDadb8f068";
const sender = "0xaf42bF32648740e62A754413EFFDEB1782ce5443";

describe("LP deposit preparation", () => {
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
    expect(BigInt(result.liquidity_protection.minimum_liquidity)).toBeGreaterThan(
      0n,
    );
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
      allowed_approval_spender: ve33Positions,
      native_value_in_plan: "100000000000000",
      required_max_native_value_per_batch_at_least: "100000000000000",
    });
    expect(
      result.wallet_policy_requirements.calldata_selectors.map(
        (selector) => selector.function,
      ),
    ).toEqual([
      "approve",
      "multicall",
      "mintAndDeposit",
      "refundNativeToken",
    ]);
    expect(result.execution_plan.ordered_steps.map((step) => step.kind)).toEqual([
      "approval",
      "execution",
      "allowance_cleanup",
    ]);
    expect(result.confirmation.no_cast_required).toContain("wallet MCP");
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
});
