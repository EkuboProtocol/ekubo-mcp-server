import { decodeV4PositionInfo } from "../src/uniswap/pool-key.js";
import { describe, expect, it } from "bun:test";
import {
  decodeAbiParameters,
  decodeFunctionData,
  parseAbiParameters,
  zeroAddress,
} from "viem";
import { getUniswapDeployments, deployment } from "../src/uniswap/common.js";
import {
  prepareV2Add,
  prepareV2Remove,
  V2_ABI,
  v2PairAddress,
} from "../src/uniswap/v2.js";
import {
  prepareV3Add,
  prepareV3Remove,
  prepareV3Collect,
  V3_ABI,
} from "../src/uniswap/v3.js";
import {
  prepareV4Add,
  prepareV4Collect,
  prepareV4Remove,
  V4_ABI,
  PERMIT2_ABI,
} from "../src/uniswap/v4.js";
import { prepareUniswapReads, v4PoolId } from "../src/uniswap/reads.js";
import { quoteUniswapLiquidity } from "../src/uniswap/quote.js";
import { discoverUniswapPools, getUniswapCharts } from "../src/uniswap/data.js";
import { planTransactions, planStepKinds } from "./plan-helpers.js";
const sender = "0x1111111111111111111111111111111111111111";
const deadline = () => String(Math.floor(Date.now() / 1000) + 1800);
const base = () => ({
  chain_id: "8453" as const,
  sender,
  deadline: deadline(),
  token0: "0x4200000000000000000000000000000000000006",
  token1: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
});
const deposit = () => ({
  ...base(),
  amount0: "1000000",
  amount1: "2000000",
  amount0_min: "900000",
  amount1_min: "1900000",
  tick_lower: -120,
  tick_upper: 120,
  tick_spacing: 60,
  fee: 3000,
});
const pool_id = () =>
  v4PoolId({
    token0: zeroAddress,
    token1: base().token1 as `0x${string}`,
    fee: 3000,
    tick_spacing: 60,
    hooks: zeroAddress,
  });
const v4 = () => ({
  ...base(),
  pool_id: pool_id(),
  token0: zeroAddress,
  tick_lower: -120,
  tick_upper: 120,
  tick_spacing: 60,
  fee: 3000,
  liquidity: "1234",
  amount0_max: "1000000",
  amount1_max: "2000000",
});
function v4Actions(data: `0x${string}`, wrapped = false) {
  if (wrapped) {
    const decoded = decodeFunctionData({ abi: V4_ABI, data });
    if (decoded.functionName !== "multicall")
      throw new Error("Expected multicall");
    data = decoded.args[0].at(-1)!;
  }
  const decoded = decodeFunctionData({ abi: V4_ABI, data });
  if (decoded.functionName !== "modifyLiquidities")
    throw new Error("Expected modifyLiquidities");
  return decodeAbiParameters(
    parseAbiParameters("bytes,bytes[]"),
    decoded.args[0],
  );
}
describe("Uniswap liquidity plans", () => {
  it("pins separate deployments on five chains", () => {
    expect(getUniswapDeployments().deployments).toHaveLength(5);
    expect(
      new Set(
        getUniswapDeployments().deployments.map((d) => d.v4_position_manager),
      ).size,
    ).toBe(5);
    expect(() => deployment("56")).toThrow();
  });
  it("derives the canonical Ethereum V2 USDC/WETH pair", () => {
    expect(
      v2PairAddress(
        "1",
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      ).toLowerCase(),
    ).toBe("0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc");
  });
  it("funds V2 native deposits and cleans up only the ERC20 approval", () => {
    const result = prepareV2Add({ ...deposit(), use_native: true });
    expect(planStepKinds(result)).toEqual([
      "approval",
      "execution",
      "allowance_cleanup",
    ]);
    const tx = planTransactions(result)[1];
    expect(tx.value).toBe("1000000");
    const call = decodeFunctionData({ abi: V2_ABI, data: tx.data });
    expect(call.functionName).toBe("addLiquidityETH");
    expect(call.args).toEqual([
      base().token1 as `0x${string}`,
      2000000n,
      1900000n,
      900000n,
      sender,
      BigInt(result.request.deadline as string),
    ]);
  });
  it("approves only the derived LP token for a V2 withdrawal", () => {
    const result = prepareV2Remove({
      ...base(),
      liquidity: "10",
      amount0_min: "1",
      amount1_min: "2",
    });
    expect(planTransactions(result)[0].to).toBe(
      v2PairAddress(
        "8453",
        base().token0 as `0x${string}`,
        base().token1 as `0x${string}`,
      ),
    );
  });
  it("mints V3 with an ETH refund and exact token approval", () => {
    const result = prepareV3Add({ ...deposit(), use_native: true });
    const tx = planTransactions(result)[1];
    const call = decodeFunctionData({ abi: V3_ABI, data: tx.data });
    expect(call.functionName).toBe("multicall");
    if (call.functionName !== "multicall") throw new Error();
    expect(
      call.args[0].map(
        (data) => decodeFunctionData({ abi: V3_ABI, data }).functionName,
      ),
    ).toEqual(["mint", "refundETH"]);
  });
  it("removes, collects and burns V3 in that order", () => {
    const result = prepareV3Remove({
      ...base(),
      token_id: "42",
      liquidity: "100",
      amount0_min: "1",
      amount1_min: "2",
      burn: true,
    });
    const call = decodeFunctionData({
      abi: V3_ABI,
      data: planTransactions(result)[0].data,
    });
    if (call.functionName !== "multicall") throw new Error();
    expect(
      call.args[0].map(
        (data) => decodeFunctionData({ abi: V3_ABI, data }).functionName,
      ),
    ).toEqual(["decreaseLiquidity", "collect", "burn"]);
  });
  it("collects V3 fees without decreasing liquidity", () => {
    const result = prepareV3Collect({ ...base(), token_id: "42" });
    const call = decodeFunctionData({
      abi: V3_ABI,
      data: planTransactions(result)[0].data,
    });
    if (call.functionName !== "multicall") throw new Error();
    expect(call.args[0]).toHaveLength(1);
    expect(
      decodeFunctionData({ abi: V3_ABI, data: call.args[0][0] }).functionName,
    ).toBe("collect");
  });
  it("settles V4 mints, refunds native and revokes both approval layers", () => {
    const result = prepareV4Add(v4()),
      txs = planTransactions(result);
    expect(planStepKinds(result)).toEqual([
      "approval",
      "approval",
      "execution",
      "allowance_cleanup",
      "allowance_cleanup",
    ]);
    expect(v4Actions(txs[2].data, true)[0]).toBe("0x020d14");
    expect(txs[2].value).toBe("1000000");
    const approval = decodeFunctionData({
      abi: PERMIT2_ABI,
      data: txs[1].data,
    });
    const cleanup = decodeFunctionData({ abi: PERMIT2_ABI, data: txs[3].data });
    expect(approval.args[2]).toBe(2000000n);
    expect(cleanup.args[2]).toBe(0n);
  });
  it("closes both signs of accrued fee deltas when increasing V4", () => {
    const result = prepareV4Add({ ...v4(), token_id: "42" });
    expect(v4Actions(planTransactions(result)[2].data, true)[0]).toBe(
      "0x00121214",
    );
  });
  it("claims V4 with a zero decrease and TAKE_PAIR", () => {
    const result = prepareV4Collect({
      ...base(),
      pool_id: pool_id(),
      token0: zeroAddress,
      token_id: "42",
      fee: 3000,
      tick_spacing: 60,
    });
    const [actions, params] = v4Actions(planTransactions(result)[0].data);
    expect(actions).toBe("0x0111");
    expect(
      decodeAbiParameters(
        parseAbiParameters("uint256,uint256,uint128,uint128,bytes"),
        params[0],
      ),
    ).toEqual([42n, 0n, 0n, 0n, "0x"]);
  });
  it("preserves exact liquidity and minimum amounts on V4 withdrawal", () => {
    const result = prepareV4Remove({
      ...base(),
      pool_id: pool_id(),
      token0: zeroAddress,
      token_id: "42",
      fee: 3000,
      tick_spacing: 60,
      liquidity: "123",
      amount0_min: "10",
      amount1_min: "20",
    });
    const [actions, params] = v4Actions(planTransactions(result)[0].data);
    expect(actions).toBe("0x0111");
    expect(
      decodeAbiParameters(
        parseAbiParameters("uint256,uint256,uint128,uint128,bytes"),
        params[0],
      ),
    ).toEqual([42n, 123n, 10n, 20n, "0x"]);
  });
  it("rejects stale plans, unordered currencies, invalid ticks and overflow", () => {
    expect(() => prepareV3Add({ ...deposit(), deadline: "1" })).toThrow(
      "Deadline",
    );
    expect(() =>
      prepareV3Add({
        ...deposit(),
        token0: base().token1,
        token1: base().token0,
      }),
    ).toThrow("token0");
    expect(() => prepareV3Add({ ...deposit(), tick_lower: -119 })).toThrow(
      "Ticks",
    );
    expect(() =>
      prepareV3Add({ ...deposit(), amount0_min: "999999999" }),
    ).toThrow("minima");
    expect(() =>
      prepareV4Add({ ...v4(), amount0_max: String(1n << 128n) }),
    ).toThrow("uint128");
    expect(() => prepareV4Add({ ...v4(), fee: 8388608 })).toThrow("pool_id");
  });
  it("builds decoded wallet reads with ownership and canonical factory checks", () => {
    const result = prepareUniswapReads({
      ...base(),
      version: "v3",
      owner: sender,
      token_ids: ["42"],
      owner_indices: ["0"],
    });
    expect(result.read_calls.calls.slice(0, 6).map((c) => c.id)).toEqual([
      "owner:42",
      "position:42",
      "canonical_pool",
      "fee_tick_spacing",
      "nft_balance",
      "token_at:0",
    ]);
  });
  it("calculates a one-sided position without floating point amounts", () => {
    const result = quoteUniswapLiquidity({
      sqrt_price_x96: "79228162514264337593543950336",
      tick_lower: 60,
      tick_upper: 120,
      tick_spacing: 60,
      amount0: "1000000000000000000",
      amount1: "0",
    });
    expect(BigInt(result.liquidity)).toBeGreaterThan(0n);
    expect(result.mint_amount1).toBe("0");
    expect(BigInt(result.mint_amount0)).toBeLessThanOrEqual(
      1000000000000000000n,
    );
    expect(BigInt(result.amount0_max)).toBeGreaterThan(
      BigInt(result.mint_amount0),
    );
  });
});
describe("Uniswap indexed data", () => {
  it("sends variables for bounded discovery and exposes partial upstream failures", async () => {
    const fetcher = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.variables).toEqual({ chain: "BASE", first: 5, cursor: 100 });
      return Response.json({
        data: { topV4Pools: [] },
        errors: [{ message: "unavailable", path: ["topV4Pools"] }],
      });
    }) as typeof fetch;
    const result = await discoverUniswapPools(
      { chain_id: "8453", version: "v4", first: 5, tvl_cursor: 100 },
      fetcher,
    );
    expect(result.partial).toBe(true);
    expect(result.errors).toHaveLength(1);
  });
  it("does not fabricate data from failed HTTP or GraphQL requests", async () => {
    const input = {
      chain_id: "8453" as const,
      version: "v3" as const,
      pool: base().token0,
    };
    await expect(
      getUniswapCharts(
        input,
        (async () =>
          new Response("", { status: 503 })) as unknown as typeof fetch,
      ),
    ).rejects.toThrow("503");
    await expect(
      getUniswapCharts(input, (async () =>
        Response.json({
          errors: [{ message: "failed" }],
        })) as unknown as typeof fetch),
    ).rejects.toThrow("no data");
    expect(() => getUniswapCharts({ ...input, version: "v4" })).toThrow(
      "bytes32",
    );
  });
});

describe("Uniswap V4 identity and packed state", () => {
  it("decodes negative ticks from deployed PositionInfo without using its truncated ID", () => {
    const state = decodeV4PositionInfo(
      "101516803225183020661984658889705904311078375743037715635662889304224364048384",
    );
    expect(state.tick_lower).toBe(-200400);
    expect(state.tick_upper).toBe(-196800);
    expect(state.has_subscriber).toBe(false);
    expect(state.pool_id_prefix).toHaveLength(52);
    expect(() => decodeV4PositionInfo(String(1n << 256n))).toThrow("uint256");
  });
  it("recovers a key only when its hash matches, despite protocol fees in the display tier", async () => {
    const row = {
      poolId:
        "0x864abca0a6202dba5b8868772308da953ff125b0f95015adbf89aaf579e903a8",
      feeTier: 625,
      tickSpacing: 10,
      token0: { address: null },
      token1: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
      hook: null,
    };
    const fetcher = (async () =>
      Response.json({
        data: { topV4Pools: [row, { ...row, tickSpacing: 11 }] },
      })) as unknown as typeof fetch;
    const result = await discoverUniswapPools(
      { chain_id: "42161", version: "v4" },
      fetcher,
    );
    const pools = (
      result.data as { topV4Pools: { pool_key: { fee: number } | null }[] }
    ).topV4Pools;
    expect(pools[0].pool_key?.fee).toBe(500);
    expect(pools[1].pool_key).toBeNull();
  });
  it("requires explicit full-withdrawal semantics for V4 burn", () => {
    const input = {
      ...v4(),
      token_id: "1",
      amount0_min: "1",
      amount1_min: "2",
      burn: true,
    };
    expect(() => prepareV4Remove(input)).toThrow("entire position");
    const result = prepareV4Remove({ ...input, liquidity: "0" });
    expect(v4Actions(planTransactions(result)[0].data)[0]).toBe("0x0311");
  });
});
