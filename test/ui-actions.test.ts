import { fakeArtifactStore } from "./fake-r2.js";
import { describe, expect, it } from "bun:test";
import { numberToHex } from "viem";
import {
  planStepKinds,
  planTargets,
  planTotalValue,
  planTransactions,
  planValues,
  planFunctions,
  planArgs,
  ALL_ABI,
} from "./plan-helpers.js";
import {
  prepareAuctionComplete,
  prepareAuctionCreate,
  prepareAuctionCreatorProceeds,
} from "../src/auctions.js";
import {
  getRewardsClaimsByOwner,
  prepareRevenueBuybacks,
  prepareRewardsClaim,
} from "../src/claims.js";
import type { Env } from "../src/core.js";
import { prepareFixPoolPrice } from "../src/fix-price.js";
import { prepareTwammOrder, prepareTwammOrderStop } from "../src/orders.js";
import { derivePoolId } from "../src/pools.js";
import {
  prepareApprovalRevocations,
  prepareExecuteTwammVirtualOrders,
  prepareLpPositionTransfer,
  prepareManualPoolBoost,
  prepareOldGekuboUnwrap,
  prepareOracleCapacityExpansion,
  prepareWrapUnwrap,
} from "../src/ui-actions.js";

const env = {
  ARTIFACT_STORE: fakeArtifactStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused",
  ACROSS_API_KEY: "unused",
  ACROSS_INTEGRATOR_ID: "unused",
  LAYER_ZERO_API_KEY: "unused",
  LI_FI_API_KEY: "unused",
  DUNE_API_KEY: "unused",
} satisfies Env;

const sender = "0x1111111111111111111111111111111111111111";
const native = "0x0000000000000000000000000000000000000000";
const token1 = "0x2222222222222222222222222222222222222222";
const token2 = "0x3333333333333333333333333333333333333333";
const twamm = "0xd47f1b1edcfeabb08f6ebd8fc337c27e636c75ba";
const poolKey = {
  token0: native,
  token1,
  config: numberToHex((BigInt(twamm) << 96n) | (1n << 31n) | 4n, {
    size: 32,
  }),
} as const;

describe("EVM interface action preparation", () => {
  it("prepares direct wrap and unwrap without wallet-side encoding", () => {
    const wrap = prepareWrapUnwrap({
      chainId: "1",
      sender,
      direction: "wrap",
      amount: "100",
    });
    const unwrap = prepareWrapUnwrap({
      chainId: "1",
      sender,
      direction: "unwrap",
      amount: "100",
    });

    expect(planTransactions(wrap)).toHaveLength(1);
    expect(planTransactions(wrap)[0]?.value).toBe("100");
    expect(planTransactions(wrap)[0]?.data).toBe("0xd0e30db0");
    expect(planTransactions(unwrap)[0]?.value).toBe("0");
    expect(planTransactions(unwrap)[0]?.data.slice(0, 10)).toBe(
      "0x2e1a7d4d",
    );
  });

  it("returns every approval revocation as an ordered top-level transaction", () => {
    const result = prepareApprovalRevocations({
      chainId: "1",
      sender,
      approvals: [
        { token: token1, spender: token2 },
        { token: token2, spender: token1 },
      ],
    });

    expect(planTransactions(result)).toHaveLength(2);
    expect(
      result.execution_plan.ordered_steps.map((step) => step.step),
    ).toEqual([1, 2]);
    expect(planArgs(result, ALL_ABI).map((args) => String(args[1]))).toEqual([
      "0",
      "0",
    ]);
  });

  it("prepares LP NFT transfer with pending ownership validation", async () => {
    const positions = "0x02D9876A21AF7545f8632C3af76eC90b5ad4b66D";
    const recipient = "0x4444444444444444444444444444444444444444";
    const result = await prepareLpPositionTransfer(
      env,
      {
        chainId: "4663",
        sender,
        positionsAddress: positions,
        tokenId: "42",
        recipient,
      },
      (async (input: RequestInfo | URL) => {
        if (input.toString().includes("/positions/")) {
          return Response.json({
            data: [
              {
                chain_id: "4663",
                id: "42",
                positions_address: positions,
                pool_key: {
                  token0: native,
                  token1,
                  fee: "1",
                  tick_spacing: "4",
                  extension: native,
                  stableswap_params: null,
                },
                bounds: { lower: -4, upper: 4 },
                liquidity: "100",
              },
            ],
            pagination: { totalPages: 1 },
          });
        }
        if (input.toString().includes("/tokens/batch?")) {
          return Response.json([
            { chain_id: "4663", address: native, symbol: "ETH", decimals: 18 },
            { chain_id: "4663", address: token1, symbol: "TKN", decimals: 18 },
          ]);
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
    );

    expect(planFunctions(result, ALL_ABI)).toEqual(["safeTransferFrom"]);
    expect(planArgs(result, ALL_ABI)[0]).toEqual([sender, recipient, 42n]);
    expect(result.details).toMatchObject({
      irreversible_ownership_change: true,
      transfers_liquidity_and_unclaimed_earnings_with_nft: true,
    });
  });

  it("prepares boost, oracle, and TWAMM maintenance calls completely", () => {
    const boost = prepareManualPoolBoost({
      chainId: "1",
      sender,
      poolKey,
      startTime: "1000",
      endTime: "1100",
      amount0: "100",
      amount1: "200",
    });
    const oracle = prepareOracleCapacityExpansion({
      chainId: "1",
      sender,
      token: token1,
      minCapacity: 64,
    });
    const execute = prepareExecuteTwammVirtualOrders({
      chainId: "1",
      sender,
      poolKey,
    });

    expect(planFunctions(boost, ALL_ABI)).toEqual([
      "approve",
      "boost",
    ]);
    expect(boost.details).toMatchObject({
      rate_scale: "Q32 token base units per second",
    });
    expect(planTransactions(oracle)[0]?.data.slice(0, 10)).not.toBe("0x");
    expect(planFunctions(execute, ALL_ABI)[0]).toBe(
      "lockAndExecuteVirtualOrders",
    );
  });

  it("prepares TWAMM creation and stop multicalls in interface order", () => {
    const create = prepareTwammOrder({
      chainId: "1",
      sender,
      sellToken: token1,
      buyToken: token2,
      pendingTimestamp: "1000",
      orders: [
        { fee: "1", startTime: "1010", endTime: "2000", amount: "10000" },
      ],
    });
    const stop = prepareTwammOrderStop({
      chainId: "1",
      sender,
      ordersAddress: "0x3325428adB409c239E88ca472F50b0efe00E98B4",
      tokenId: "5",
      pendingTimestamp: "1100",
      orders: [
        {
          orderKey: poolKey,
          endTime: "2000",
          saleRate: "30",
        },
      ],
    });

    expect(planFunctions(create, ALL_ABI)).toEqual([
      "approve",
      "mintAndIncreaseSellAmount",
    ]);
    expect(planFunctions(stop, ALL_ABI)).toEqual([
      "collectProceeds",
      "decreaseSaleRate",
    ]);
    // collectProceeds and decreaseSaleRate are two decodable steps now.
    expect(planTransactions(stop)).toHaveLength(2);
  });

  it("funds each split order from its own step and preserves the total", () => {
    // Splitting the multicall moved native value from one wrapper onto the
    // individual payable calls. The sum must still be exactly what the user
    // is selling, and `mint` must carry none of it.
    const native = "0x0000000000000000000000000000000000000000";
    const create = prepareTwammOrder({
      chainId: "1",
      sender,
      sellToken: native,
      buyToken: token2,
      pendingTimestamp: "1000",
      salt: `0x${"34".repeat(32)}`,
      orders: [
        { fee: "1", startTime: "1010", endTime: "2000", amount: "10000" },
        { fee: "1", startTime: "1010", endTime: "3000", amount: "25000" },
      ],
    });
    expect(planValues(create)).toEqual([
      "0",
      "10000",
      "25000",
    ]);
    expect(planTotalValue(create)).toBe(35000n);
    expect(create.execution_plan.required_capabilities).toEqual([
      "atomic_batch",
    ]);
  });

  it("puts the auction sell amount on the payable call, not on mint", () => {
    const native = "0x0000000000000000000000000000000000000000";
    const create = prepareAuctionCreate({
      chainId: "1",
      sender,
      sellToken: native,
      buyToken: token2,
      sellAmount: "1000",
      creatorFeeQ32: "100",
      minBoostDuration: 3600,
      graduationPoolFeeQ64: "1000",
      graduationPoolTickSpacing: 4,
      startTime: "1000",
      auctionDuration: 7200,
      salt: `0x${"56".repeat(32)}`,
    });
    expect(planValues(create)).toEqual(["0", "1000"]);
  });

  it("prepares auction creation and optional graduation initialization", () => {
    const salt = `0x${"12".repeat(32)}` as const;
    const create = prepareAuctionCreate({
      chainId: "1",
      sender,
      sellToken: token1,
      buyToken: token2,
      sellAmount: "1000",
      creatorFeeQ32: "100",
      minBoostDuration: 3600,
      graduationPoolFeeQ64: "1000",
      graduationPoolTickSpacing: 4,
      startTime: "1000",
      auctionDuration: 7200,
      salt,
    });
    const complete = prepareAuctionComplete({
      chainId: "1",
      sender,
      tokenId: (create.details as { expected_token_id: string })
        .expected_token_id,
      auctionKey: (
        create.request as {
          auction_key: {
            token0: string;
            token1: string;
            config: `0x${string}`;
          };
        }
      ).auction_key,
      graduationPoolInitialized: false,
      launchPoolTick: 42,
    });

    expect(planFunctions(create, ALL_ABI)).toEqual([
      "approve",
      "mint",
      "sellAmountByAuction",
    ]);
    expect(planFunctions(complete, ALL_ABI)).toEqual([
      "maybeInitializeGraduationPool",
      "completeAuctionAndStartBoost",
    ]);
    const creatorProceeds = prepareAuctionCreatorProceeds({
      chainId: "1",
      sender,
      tokenId: (create.details as { expected_token_id: string })
        .expected_token_id,
      auctionKey: (
        create.request as {
          auction_key: {
            token0: string;
            token1: string;
            config: `0x${string}`;
          };
        }
      ).auction_key,
    });
    expect(planFunctions(creatorProceeds, ALL_ABI)[0]).toBe("collectCreatorProceeds");
  });

  it("matches the old gEKUBO byte route and revenue maintenance ordering", () => {
    const unwrap = prepareOldGekuboUnwrap({
      chainId: "1",
      sender,
      amount: "1",
    });
    const buybacks = prepareRevenueBuybacks({
      chainId: "1",
      sender,
      endedOrderCollects: [{ sellToken: token1, fee: "1", endTime: "1000" }],
      protocolFeePairs: [{ token0: token1, token1: token2 }],
      rollTokens: [token1],
    });

    // Step 0 is the approval; the raw byte route is the execution step.
    expect(planTransactions(unwrap)[1]?.data).toBe(
      "0x0001005a0300000001000501",
    );
    expect(unwrap.execution_plan.required_capabilities).toEqual([
      "atomic_batch",
    ]);
    expect(planFunctions(buybacks, ALL_ABI)).toEqual([
      "collect",
      "withdrawProtocolFees",
      "roll",
    ]);
    // Each buyback call is its own decodable step now, not one multicall.
    expect(planTransactions(buybacks)).toHaveLength(3);
  });

  it("returns a complete incentive claim plan", () => {
    const reward = prepareRewardsClaim({
      chainId: "1",
      sender,
      claims: [
        {
          dropAddress: token2,
          key: {
            owner: sender,
            token: token1,
            root: `0x${"34".repeat(32)}`,
          },
          claim: { index: "1", account: sender, amount: "10" },
          proof: [],
        },
      ],
    });

    expect(planTransactions(reward)).toHaveLength(1);
    expect(planFunctions(reward, ALL_ABI)[0]).toBe("claim");
  });

  it("supplies the complete reward availability read list before claiming", async () => {
    const root = `0x${"56".repeat(32)}`;
    const result = await getRewardsClaimsByOwner(
      env,
      { owner: sender },
      (async () =>
        Response.json({
          claims: [
            {
              campaign: "campaign",
              chainId: "0x1",
              dropAddress: token2,
              key: { owner: sender, token: token1, root },
              claim: { index: 1, account: sender, amount: "10" },
              proof: [],
            },
          ],
        })) as unknown as typeof fetch,
    );

    expect(result.claims[0]).toMatchObject({
      chain_id: "1",
      requested_owner_matches_key: true,
    });
    expect(result.onchain_validation.validation_reads).toHaveLength(1);
    const validationBundle = result.onchain_validation.validation_reads[0];
    expect(validationBundle.chain_id).toBe("1");
    expect(
      validationBundle.read_calls.calls.map((call: { id: string }) => call.id),
    ).toEqual([
      "ekubo-reward-claim-0-is-claimed",
      "ekubo-reward-claim-0-is-available",
    ]);
  });

  it("supplies every phase of fix-price reads, quote, approval, and execution", async () => {
    const core = "0x00000000000014aA86C5d3c41765bb24e11bd701";
    const key = derivePoolId({
      token0: native,
      token1,
      fee: "1",
      tickSpacing: 4,
      extension: native,
    });
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/poolKeys/")) {
        return Response.json({
          pool_id: key.pool_id,
          pool_key: {
            token0: native,
            token1,
            fee: "1",
            tick_spacing: "4",
            extension: native,
            stableswap_params: null,
          },
          state: null,
        });
      }
      if (url.includes("/tokens/batch?")) {
        return Response.json([
          { chain_id: "1", address: native, symbol: "ETH", decimals: 18 },
          { chain_id: "1", address: token1, symbol: "USD", decimals: 6 },
        ]);
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const common = {
      chainId: "1",
      sender,
      coreAddress: core,
      poolId: key.pool_id,
      baseToken: native,
      targetPrice: "1000000000000",
      country: null,
    };
    const read = await prepareFixPoolPrice(env, common, fetcher);
    const quote = await prepareFixPoolPrice(
      env,
      { ...common, pendingCurrentSqrtRatio: "1" },
      fetcher,
    );
    const execute = await prepareFixPoolPrice(
      env,
      {
        ...common,
        pendingCurrentSqrtRatio: "1",
        quoteResult: {
          specifiedToken: native,
          calculatedToken: token1,
          specifiedAmount: "-1",
          calculatedAmount: "-1000",
        },
      },
      fetcher,
    );

    expect(read).toMatchObject({
      phase: "read_current_price",
      current_price_query: {
        read_calls: {
          calls: [
            {
              decode: {
                kind: "function_result",
                function_name: "poolPrice",
                semantic_codecs: [
                  {
                    path: "sqrtRatio",
                    semantic_type: "ekubo.sqrt_ratio_float",
                    codec: {
                      id: "ekubo.sqrt_ratio_float_to_q128",
                      implementations: [{ ecosystem: "npm" }],
                    },
                  },
                ],
              },
            },
          ],
        },
        resume: {
          tool: "prepare_fix_pool_price",
          arguments: {
            pending_current_sqrt_ratio:
              "<wallet_batch_eth_call.results[0].decoded.sqrtRatio.abi_value>",
          },
        },
      },
    });
    expect(
      (read as typeof read & { target: Record<string, unknown> }).target,
    ).toEqual({
      human_price_quote_per_base: "1000000000000",
      fixed_q128_sqrt_ratio: (1n << 128n).toString(),
      compact_sqrt_ratio: ((1n << 95n) + (1n << 62n)).toString(),
    });
    expect(quote).toMatchObject({
      phase: "quote",
      quote_query: {
        read_calls: {
          calls: [
            {
              decode: {
                kind: "function_result",
                function_name: "quote",
              },
            },
          ],
        },
        resume: {
          arguments: {
            quote_result: {
              specified_token:
                "<wallet_batch_eth_call.results[0].decoded.specifiedToken>",
              calculated_token:
                "<wallet_batch_eth_call.results[0].decoded.calculatedToken>",
              specified_amount:
                "<wallet_batch_eth_call.results[0].decoded.specifiedAmount>",
              calculated_amount:
                "<wallet_batch_eth_call.results[0].decoded.calculatedAmount>",
              block_number: "<wallet_batch_eth_call.block_number>",
            },
          },
        },
      },
    });
    expect(execute).toMatchObject({
      phase: "execute",
      execution_plan_ready: true,
      agent_confirmation_required: false,
    });
    // The route call is opaque calldata from the quote provider, so only the
    // approval decodes; the plan still states both steps.
    expect(planStepKinds(execute)).toEqual(["approval", "execution"]);
    expect(planTransactions(execute)).toHaveLength(2);
  });
});
