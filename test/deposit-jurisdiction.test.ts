import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { numberToHex, zeroAddress } from "viem";
import worker from "../src/index.js";
import { v4PoolId } from "../src/uniswap/reads.js";
import { fakeArtifactStore } from "./fake-r2.js";

/**
 * EKU-864 (CSO EKU-863 F-1): the Uniswap add-liquidity tools, the manual pool
 * boost and every ve33 stake path build a plan around caller-chosen tokens, so
 * on a covered chain they refuse an unclassified token from every country and
 * a Robinhood Stock Token from a restricted or unresolved connection, before
 * any plan is stored.
 */

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
  ALLOWED_ORIGINS: "https://mcp.ekubo.org",
};
const context = {} as unknown as ExecutionContext;
const headers = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
  host: "mcp.ekubo.org",
  origin: "https://mcp.ekubo.org",
  "mcp-protocol-version": "2025-11-25",
};

const SENDER = "0x1111111111111111111111111111111111111111";
const VE_TOKEN = "0x9d7008E169D040B6c0140eb92E7cA82B12643497";
/** Robinhood chain WETH and USDG: verified outside the Stock Token class. */
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
/** NVDA, a Robinhood Stock Token. Sorts above USDG. */
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
/** Not classified by the policy. Sorts below USDG. */
const UNKNOWN = "0x3333333333333333333333333333333333333333";
const BOOSTED_FEES = "0x948b9C2C99718034954110cB61a6e08e107745f9";

type Pair = { token0: string; token1: string };
type Case = {
  tool: string;
  /** Arguments that put `pair` (or its non-native side) into the plan on `chain`. */
  args: (chain: "4663" | "1", pair: Pair) => Record<string, unknown>;
  /** The subject token is paired with this side, or replaces the stake token. */
  pairs: { unknown: Pair; stock: Pair; permitted: Pair };
};

const deadline = String(Math.floor(Date.now() / 1000) + 3600);
const v3Range = { tick_lower: -120, tick_upper: 120, tick_spacing: 60, fee: 3000 };
const pairs = {
  unknown: { token0: UNKNOWN, token1: USDG },
  stock: { token0: USDG, token1: NVDA },
  permitted: { token0: WETH, token1: USDG },
};
/** V4 pairs native ETH, which the policy lists outside the class, as currency0. */
const nativePairs = {
  unknown: { token0: zeroAddress, token1: UNKNOWN },
  stock: { token0: zeroAddress, token1: NVDA },
  permitted: { token0: zeroAddress, token1: USDG },
};
/** Stake paths move a single token: token1 is the stake token. */
const stakeTokens = {
  unknown: { token0: "", token1: UNKNOWN },
  stock: { token0: "", token1: NVDA },
  permitted: { token0: "", token1: USDG },
};

const CASES: Case[] = [
  {
    tool: "prepare_uniswap_v2_add_liquidity",
    pairs,
    args: (chain, pair) => ({
      chain_id: chain, sender: SENDER, deadline, ...pair,
      amount0: "1000", amount1: "2000", amount0_min: "900", amount1_min: "1900",
    }),
  },
  {
    tool: "prepare_uniswap_v3_add_liquidity",
    pairs,
    args: (chain, pair) => ({
      chain_id: chain, sender: SENDER, deadline, ...pair, ...v3Range,
      amount0: "1000", amount1: "2000", amount0_min: "900", amount1_min: "1900",
    }),
  },
  {
    tool: "prepare_uniswap_v4_add_liquidity",
    pairs: nativePairs,
    args: (chain, pair) => ({
      chain_id: chain, sender: SENDER, deadline, ...pair, ...v3Range,
      pool_id: v4PoolId({
        token0: pair.token0 as `0x${string}`,
        token1: pair.token1 as `0x${string}`,
        fee: 3000,
        tick_spacing: 60,
        hooks: zeroAddress,
      }),
      liquidity: "1234", amount0_max: "1000", amount1_max: "2000",
    }),
  },
  {
    tool: "prepare_manual_pool_boost",
    pairs,
    args: (chain, pair) => ({
      chain_id: Number(chain), sender: SENDER,
      pool_key: {
        ...pair,
        config: numberToHex((BigInt(BOOSTED_FEES) << 96n) | (1n << 31n) | 4n, { size: 32 }),
      },
      start_time: "1000", end_time: "1100", amount0: "100", amount1: "200",
    }),
  },
  {
    tool: "prepare_ve33_stake",
    pairs: stakeTokens,
    args: (chain, { token1 }) => ({
      chain_id: Number(chain), ve_token: VE_TOKEN, sender: SENDER, stake_token: token1,
      amount: "100", salt: `0x${"12".repeat(32)}`,
    }),
  },
  {
    tool: "prepare_ve33_increase_stake",
    pairs: stakeTokens,
    args: (chain, { token1 }) => ({
      chain_id: Number(chain), ve_token: VE_TOKEN, sender: SENDER, stake_token: token1,
      ve_id: "10", amount: "100",
    }),
  },
  {
    tool: "prepare_ve33_reinvest",
    pairs: stakeTokens,
    args: (chain, { token1 }) => ({
      phase: "stake", chain_id: Number(chain), ve_token: VE_TOKEN, sender: SENDER,
      stake_token: token1, ve_id: "10", amount: "100",
    }),
  },
];

function edgeRequest(body: unknown, country?: string): Request {
  const request = new Request("https://mcp.ekubo.org/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  Object.defineProperty(request, "cf", {
    value: country === undefined ? {} : { country },
  });
  return request;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  country?: string,
): Promise<{ isError?: boolean; structuredContent: Record<string, unknown> }> {
  const response = await worker.fetch(
    edgeRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      country,
    ),
    env,
    context,
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  const data = body.includes("data:")
    ? body.split("\n").find((line) => line.startsWith("data:"))!.slice(5).trim()
    : body;
  return (JSON.parse(data) as { result: { isError?: boolean; structuredContent: Record<string, unknown> } }).result;
}

/** Reinvest nests its plan under `plan`; the other tools return it at the top. */
function expectPlan(result: { structuredContent: Record<string, unknown> }) {
  expect(result.structuredContent).not.toHaveProperty("error");
  const plan = (result.structuredContent.plan ?? result.structuredContent) as Record<string, unknown>;
  expect(plan).toHaveProperty("execution_plan_reference");
}

function expectNoPlan(result: { structuredContent: Record<string, unknown> }) {
  expect(result.structuredContent).not.toHaveProperty("execution_plan_reference");
  expect(result.structuredContent).not.toHaveProperty("plan");
  expect(JSON.stringify(result.structuredContent)).not.toContain("/artifact/");
}

let fetchCalls = 0;
let mockedFetch: ReturnType<typeof spyOn>;
beforeAll(() => {
  mockedFetch = spyOn(globalThis, "fetch").mockImplementation((async () => {
    fetchCalls += 1;
    return new Response("unexpected network call", { status: 500 });
  }) as unknown as typeof fetch);
});
afterAll(() => mockedFetch.mockRestore());

describe("chain 4663 deposit, boost and stake tools under jurisdiction policy v2", () => {
  for (const { tool, args, pairs: subject } of CASES) {
    describe(tool, () => {
      it("refuses an unclassified token with unclassified_asset from every country", async () => {
        const stored = env.ARTIFACT_STORE.entries.size;
        for (const country of ["FR", "US", "IR", "XX", "T1", undefined]) {
          const result = await callTool(tool, args("4663", subject.unknown), country);
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({
            error: {
              code: "unclassified_asset",
              details: {
                policy_version: "ekubo-token-jurisdictions-v2",
                assets: [{ chain_id: "4663", token: UNKNOWN, classification: "unknown" }],
              },
            },
          });
          expectNoPlan(result);
        }
        expect(env.ARTIFACT_STORE.entries.size).toBe(stored);
      });

      it("refuses a Stock Token with restricted_jurisdiction from US and an unresolved XX", async () => {
        const stored = env.ARTIFACT_STORE.entries.size;
        for (const [country, code] of [["US", "US"], ["XX", null], [undefined, null]] as const) {
          const result = await callTool(tool, args("4663", subject.stock), country);
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({
            error: {
              code: "restricted_jurisdiction",
              details: {
                country: code,
                restricted_assets: [{ chain_id: "4663", token: NVDA, classification: "rhj_stock_token" }],
              },
            },
          });
          expectNoPlan(result);
        }
        expect(env.ARTIFACT_STORE.entries.size).toBe(stored);
      });

      it("prepares a Stock Token plan for an unrestricted country", async () => {
        const result = await callTool(tool, args("4663", subject.stock), "FR");
        expectPlan(result);
      });

      it("prepares non-class assets from a restricted country", async () => {
        const result = await callTool(tool, args("4663", subject.permitted), "US");
        expectPlan(result);
      });

      it("leaves a chain outside the policy unchanged", async () => {
        for (const country of ["US", "XX", undefined]) {
          const result = await callTool(tool, args("1", subject.unknown), country);
          expectPlan(result);
        }
      });
    });
  }

  it("gates reinvest phase=stake_all before reading the indexed portfolio", async () => {
    const before = fetchCalls;
    const base = {
      phase: "stake_all", chain_id: 4663, ve_token: VE_TOKEN, sender: SENDER,
      current_state_id: `0x${"34".repeat(32)}`, amount: "100",
    };
    const unknown = await callTool("prepare_ve33_reinvest", { ...base, stake_token: UNKNOWN }, "FR");
    expect(unknown.structuredContent).toMatchObject({ error: { code: "unclassified_asset" } });
    expectNoPlan(unknown);
    for (const country of ["US", "XX"]) {
      const stock = await callTool("prepare_ve33_reinvest", { ...base, stake_token: NVDA }, country);
      expect(stock.structuredContent).toMatchObject({ error: { code: "restricted_jurisdiction" } });
      expectNoPlan(stock);
    }
    expect(fetchCalls).toBe(before);
  });
});
