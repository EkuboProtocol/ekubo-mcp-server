import { fakeArtifactStore } from "./fake-r2.js";
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { fixedSqrtRatioToFloat } from "@ekubo/sdk";
import { YUL_ROUTER_ADDRESS } from "@ekubo/yul-router-sdk";
import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  hexToBigInt,
  sliceHex,
  type Hex,
} from "viem";
import { planStepKinds, planTransactions } from "./plan-helpers.js";
import type { Env } from "../src/core.js";
import { prepareFixPoolPrice } from "../src/fix-price.js";
import { derivePoolId } from "../src/pools.js";

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

const core = "0x00000000000014aA86C5d3c41765bb24e11bd701";
const sender = "0x1111111111111111111111111111111111111111";
const native = getAddress("0x0000000000000000000000000000000000000000");
const usd = getAddress("0x2222222222222222222222222222222222222222");
const other = getAddress("0x3333333333333333333333333333333333333333");
const preparedAt = 1_800_000_000_000;
const TARGET_PRICE_SENTINEL = -(1n << 127n);

afterEach(() => {
  setSystemTime();
});

function poolFixture(
  token0: string,
  token1: string,
  decimals: [number, number],
) {
  const key = derivePoolId({
    token0,
    token1,
    fee: "1",
    tickSpacing: 1000,
    extension: native,
  });
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/poolKeys/")) {
      return Response.json({
        pool_id: key.pool_id,
        pool_key: {
          token0,
          token1,
          fee: "1",
          tick_spacing: "1000",
          extension: native,
          stableswap_params: null,
        },
        state: { sqrt_ratio: "0", tick: 0, liquidity: "0" },
      });
    }
    if (url.includes("/tokens/batch?")) {
      return Response.json([
        { chain_id: "1", address: token0, symbol: "A", decimals: decimals[0] },
        { chain_id: "1", address: token1, symbol: "B", decimals: decimals[1] },
      ]);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const common = {
    chainId: "1",
    sender,
    coreAddress: core,
    poolId: key.pool_id,
    baseToken: token0,
    targetPrice: "2000",
  };
  return {
    fetcher,
    common,
    token0: getAddress(token0),
    token1: getAddress(token1),
  };
}

const ethUsd = poolFixture(native, usd, [18, 6]);
const usdOther = poolFixture(usd, other, [6, 18]);

type Fixture = typeof ethUsd;

async function target(fixture: Fixture) {
  const read = (await prepareFixPoolPrice(
    env,
    fixture.common,
    fixture.fetcher,
  )) as {
    target: { fixed_q128_sqrt_ratio: string; compact_sqrt_ratio: string };
  };
  return {
    fixed: BigInt(read.target.fixed_q128_sqrt_ratio),
    compact: BigInt(read.target.compact_sqrt_ratio),
  };
}

/** A compact current price on the requested side of the target. */
async function currentFor(
  fixture: Fixture,
  direction: "increase" | "decrease",
) {
  const { fixed } = await target(fixture);
  return fixedSqrtRatioToFloat(
    direction === "increase" ? fixed / 2n : fixed * 2n,
  ).toString();
}

async function execute(
  fixture: Fixture,
  direction: "increase" | "decrease",
  amounts: { specified: string; calculated: string },
  tokens?: { specified: string; calculated: string },
) {
  setSystemTime(new Date(preparedAt));
  const pendingCurrentSqrtRatio = await currentFor(fixture, direction);
  const increasing = direction === "increase";
  return prepareFixPoolPrice(
    env,
    {
      ...fixture.common,
      pendingCurrentSqrtRatio,
      quoteResult: {
        specifiedToken:
          tokens?.specified ?? (increasing ? fixture.token0 : fixture.token1),
        calculatedToken:
          tokens?.calculated ?? (increasing ? fixture.token1 : fixture.token0),
        specifiedAmount: amounts.specified,
        calculatedAmount: amounts.calculated,
      },
    },
    fixture.fetcher,
  );
}

function signedInt128(value: Hex) {
  const raw = hexToBigInt(value);
  return raw >= 1n << 127n ? raw - (1n << 128n) : raw;
}

/**
 * Decodes the router's packed calldata for a single-path, single core-hop
 * route with a deadline and no recipient, as YulRouter.yul reads it.
 */
function decodeFixPriceRoute(data: Hex) {
  const flags = Number(hexToBigInt(sliceHex(data, 0, 1)));
  expect(flags).toBe(2);
  expect(Number(hexToBigInt(sliceHex(data, 1, 2)))).toBe(0);
  const hopType = Number(hexToBigInt(sliceHex(data, 79, 80)));
  expect(hopType).toBe(0);
  const options = hexToBigInt(sliceHex(data, 152, 168));
  expect((data.length - 2) / 2).toBe(168);
  return {
    specifiedToken: getAddress(sliceHex(data, 2, 22)),
    calculatedToken: getAddress(sliceHex(data, 22, 42)),
    threshold: signedInt128(sliceHex(data, 42, 58)),
    deadline: Number(hexToBigInt(sliceHex(data, 58, 62))),
    specifiedAmount: signedInt128(sliceHex(data, 62, 78)),
    hopCount: Number(hexToBigInt(sliceHex(data, 78, 79))) + 1,
    token0: getAddress(sliceHex(data, 80, 100)),
    token1: getAddress(sliceHex(data, 100, 120)),
    config: sliceHex(data, 120, 152),
    sqrtRatioLimit: options >> 32n,
    allowPartial: (options & 0x80000000n) !== 0n,
    skipAhead: options & 0x7fffffffn,
  };
}

describe("prepare_fix_pool_price quote acceptance", () => {
  const zeroCases = [
    {
      name: "ETH/USD increase, ERC20 input",
      fixture: ethUsd,
      direction: "increase",
    },
    {
      name: "ETH/USD decrease, native input",
      fixture: ethUsd,
      direction: "decrease",
    },
    { name: "ERC20/ERC20 increase", fixture: usdOther, direction: "increase" },
    { name: "ERC20/ERC20 decrease", fixture: usdOther, direction: "decrease" },
  ] as const;

  for (const { name, fixture, direction } of zeroCases) {
    it(`prepares an empty-range 0/0 quote as a zero-cost price move: ${name}`, async () => {
      const result = await execute(fixture, direction, {
        specified: "0",
        calculated: "0",
      });
      const { compact } = await target(fixture);
      const increasing = direction === "increase";

      expect(result).toMatchObject({
        phase: "execute",
        execution_plan_ready: true,
        details: {
          direction,
          input_token: increasing ? fixture.token1 : fixture.token0,
          output_token: increasing ? fixture.token0 : fixture.token1,
          maximum_input_amount: "0",
          expected_output_amount: "0",
          partial_fill_stops_at_target: true,
        },
      });
      // No approval: nothing is paid, and approve(0) would erase an allowance.
      expect(planStepKinds(result)).toEqual(["execution"]);
      const [transaction] = planTransactions(result);
      expect(getAddress(transaction.to)).toBe(YUL_ROUTER_ADDRESS);
      expect(BigInt(transaction.value)).toBe(0n);

      const route = decodeFixPriceRoute(transaction.data);
      expect(route).toEqual({
        specifiedToken: increasing ? fixture.token0 : fixture.token1,
        calculatedToken: increasing ? fixture.token1 : fixture.token0,
        // Zero threshold: the router reverts unless the route takes no input.
        threshold: 0n,
        deadline: Math.floor(preparedAt / 1_000) + 1_800,
        // Still the target-price route, not a no-op: the exact-out sentinel
        // with a partial single hop limited at the target price.
        specifiedAmount: TARGET_PRICE_SENTINEL,
        hopCount: 1,
        token0: fixture.token0,
        token1: fixture.token1,
        config: route.config,
        sqrtRatioLimit: compact,
        allowPartial: true,
        skipAhead: 0n,
      });
    });
  }

  it("accepts output rounded to zero while input is nonzero", async () => {
    const result = await execute(ethUsd, "increase", {
      specified: "0",
      calculated: "-5",
    });
    expect(planStepKinds(result)).toEqual(["approval", "execution"]);
    const [approval, transaction] = planTransactions(result);
    expect(getAddress(approval.to)).toBe(usd);
    expect(
      decodeFunctionData({ abi: erc20Abi, data: approval.data }).args,
    ).toEqual([YUL_ROUTER_ADDRESS, 5n]);
    expect(decodeFixPriceRoute(transaction.data).threshold).toBe(-5n);
  });

  it("bounds a zero-input quote with a zero threshold and no approval", async () => {
    const result = await execute(ethUsd, "increase", {
      specified: "-7",
      calculated: "0",
    });
    expect(planStepKinds(result)).toEqual(["execution"]);
    expect(
      decodeFixPriceRoute(planTransactions(result)[0].data).threshold,
    ).toBe(0n);
  });

  it("keeps the exact ERC20 approval for nonzero input", async () => {
    const result = await execute(ethUsd, "increase", {
      specified: "-1",
      calculated: "-1000",
    });
    expect(planStepKinds(result)).toEqual(["approval", "execution"]);
    const [approval, transaction] = planTransactions(result);
    expect(getAddress(approval.to)).toBe(usd);
    expect(BigInt(approval.value)).toBe(0n);
    expect(
      decodeFunctionData({ abi: erc20Abi, data: approval.data }),
    ).toMatchObject({
      functionName: "approve",
      args: [YUL_ROUTER_ADDRESS, 1000n],
    });
    expect(BigInt(transaction.value)).toBe(0n);
    const route = decodeFixPriceRoute(transaction.data);
    expect(route.threshold).toBe(-1000n);
    expect(route.specifiedAmount).toBe(TARGET_PRICE_SENTINEL);
  });

  it("keeps the native value for nonzero native input", async () => {
    const result = await execute(ethUsd, "decrease", {
      specified: "-1000",
      calculated: "-1",
    });
    expect(planStepKinds(result)).toEqual(["execution"]);
    const [transaction] = planTransactions(result);
    expect(BigInt(transaction.value)).toBe(1n);
    expect(decodeFixPriceRoute(transaction.data).threshold).toBe(-1n);
  });

  const rejected = [
    {
      name: "positive specified",
      amounts: { specified: "1", calculated: "0" },
    },
    {
      name: "positive calculated",
      amounts: { specified: "0", calculated: "1" },
    },
    { name: "both positive", amounts: { specified: "1", calculated: "1" } },
    {
      name: "positive calculated with negative specified",
      amounts: { specified: "-1", calculated: "1000" },
    },
  ];
  for (const { name, amounts } of rejected) {
    it(`rejects a quote with a ${name} delta`, async () => {
      await expect(execute(ethUsd, "increase", amounts)).rejects.toMatchObject({
        code: "quote_mismatch",
      });
    });
  }

  it("rejects zero quotes for swapped or unrelated tokens", async () => {
    const zero = { specified: "0", calculated: "0" };
    await expect(
      execute(ethUsd, "increase", zero, { specified: usd, calculated: native }),
    ).rejects.toMatchObject({ code: "quote_mismatch" });
    await expect(
      execute(ethUsd, "increase", zero, {
        specified: native,
        calculated: other,
      }),
    ).rejects.toMatchObject({ code: "quote_mismatch" });
  });

  it("rejects a target the pending price already reached", async () => {
    const { compact } = await target(ethUsd);
    await expect(
      prepareFixPoolPrice(
        env,
        {
          ...ethUsd.common,
          pendingCurrentSqrtRatio: compact.toString(),
          quoteResult: {
            specifiedToken: native,
            calculatedToken: usd,
            specifiedAmount: "0",
            calculatedAmount: "0",
          },
        },
        ethUsd.fetcher,
      ),
    ).rejects.toMatchObject({ code: "target_already_reached" });
  });
});
