import { fakeArtifactStore } from "./fake-r2.js";
import { describe, expect, it } from "bun:test";
import { loadArtifact, referenceWalletArtifacts } from "../src/artifact-store.js";
import { ServiceError, type Env } from "../src/core.js";
import { publicToolCatalog, toolOutputSchema } from "../src/server.js";
import {
  JURISDICTION_POLICY_VERSION,
  QUOTE_JURISDICTION_NOTICE,
  type RequestCountry,
} from "../src/token-restrictions.js";
import { prepareVe33Reinvest } from "../src/ve33.js";
import { walletExecutionPlanSchema } from "../src/wallet-compatibility.js";

const ORIGIN = "https://mcp.ekubo.org";
const CHAIN = "4663";
const veToken = "0x9d7008E169D040B6c0140eb92E7cA82B12643497" as const;
const sender = "0x1111111111111111111111111111111111111111" as const;
/** Unrestricted stand-in for the STONX stake token. */
const STAKE = "0x2222222222222222222222222222222222222222" as const;
/** NVDA, one of RHC_STOCK_TOKEN_ADDRESSES. */
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec" as const;
/** USDG: not a restricted asset. */
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as const;
const SELL_SIDE_RESTRICTED = ["CU", "IR", "KP", "SY", "UA"];

function env(): Env {
  return {
    ARTIFACT_STORE: fakeArtifactStore(),
    EKUBO_API_URL: "https://api.test",
    EKUBO_QUOTER_URL: "https://quoter.test",
    ZERO_X_API_KEY: "",
  } as unknown as Env;
}

/** Answers every Ekubo quoter request with a one-hop route for its own pair. */
const quoter = (async (input: RequestInfo | URL) => {
  const url = String(input);
  const tokens = [...url.matchAll(/0x[0-9a-fA-F]{40}/g)].map((match) =>
    match[0].toLowerCase(),
  );
  const [token0, token1] = [...new Set(tokens)].sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : 1,
  );
  return Response.json({
    block_number: 123,
    block_hash: "0x01",
    total_calculated: "900",
    estimated_gas_cost: 25000,
    price_impact: 0.001,
    splits: [
      {
        amount_specified: "1000",
        amount_calculated: "900",
        route: [
          {
            swap: {
              type: "core",
              pool_key: { token0, token1, config: `0x${"00".repeat(32)}` },
              sqrt_ratio_limit: "0x000000000000000000000000",
              skip_ahead: 0,
            },
          },
        ],
      },
    ],
  });
}) as typeof fetch;

async function swapPhase(
  testEnv: Env,
  tokens: readonly string[],
  country: RequestCountry,
) {
  return prepareVe33Reinvest(
    testEnv,
    {
      phase: "swap",
      chainId: CHAIN,
      veToken,
      sender,
      stakeToken: STAKE,
      feeBalances: tokens.map((token) => ({
        token: token as `0x${string}`,
        amount: "1000",
      })),
      slippageBps: 10,
      source: "ekubo",
      country,
    },
    quoter,
  );
}

interface ReferencedChild {
  jurisdiction: Record<string, unknown>;
  execution_plan_reference?: { url: string };
  execution_plan?: unknown;
}
interface ReferencedSwapPhase {
  phase: string;
  jurisdiction: {
    policy_version: string;
    restricted_jurisdictions: string[];
    assets: unknown[];
    execution_notice: string | null;
  };
  producer_country_gate: Record<string, unknown>;
  exact_input_full_balance_swaps: ReferencedChild[];
}

/** The shape an agent actually receives: plan bodies replaced by references. */
async function referenced(
  testEnv: Env,
  tokens: readonly string[],
  country: RequestCountry,
) {
  const raw = await swapPhase(testEnv, tokens, country);
  const { value, replaced } = await referenceWalletArtifacts(
    testEnv,
    ORIGIN,
    raw,
  );
  expect(replaced).toBe(tokens.length);
  expect(toolOutputSchema("prepare_ve33_reinvest")!.safeParse(value).success)
    .toBe(true);
  return value as ReferencedSwapPhase;
}

async function storedPlan(testEnv: Env, child: ReferencedChild) {
  expect(child.execution_plan).toBeUndefined();
  const id = child.execution_plan_reference!.url.split("/artifact/")[1]!;
  return JSON.parse((await loadArtifact(testEnv, id)) ?? "null") as {
    extensions: Record<string, unknown>;
  };
}

describe("prepare_ve33_reinvest phase=swap jurisdiction metadata", () => {
  it("carries empty metadata inline for an unrestricted sell", async () => {
    const testEnv = env();
    const result = await referenced(testEnv, [USDG], "US");
    const empty = {
      policy_version: JURISDICTION_POLICY_VERSION,
      restricted_jurisdictions: [],
      assets: [],
      execution_notice: null,
    };
    expect(result.jurisdiction).toEqual(empty);
    expect(result.exact_input_full_balance_swaps).toHaveLength(1);
    const child = result.exact_input_full_balance_swaps[0]!;
    expect(child.jurisdiction).toEqual(empty);
    const plan = await storedPlan(testEnv, child);
    expect(plan.extensions["ekubo.jurisdiction"]).toEqual(child.jurisdiction);
    expect(walletExecutionPlanSchema.safeParse(plan).success).toBe(true);
    expect(result.producer_country_gate).toEqual({
      applied: true,
      policy_version: JURISDICTION_POLICY_VERSION,
      country_resolved: true,
      outcome: "permitted",
    });
    expect(result.producer_country_gate).not.toHaveProperty("country");
  });

  it("carries sell-side restrictions inline for a restricted equity sold for the stake token", async () => {
    const testEnv = env();
    const result = await referenced(testEnv, [NVDA], "US");
    const child = result.exact_input_full_balance_swaps[0]!;
    expect(child.jurisdiction).toEqual({
      policy_version: JURISDICTION_POLICY_VERSION,
      restricted_jurisdictions: SELL_SIDE_RESTRICTED,
      assets: [
        {
          chain_id: CHAIN,
          token: NVDA,
          side: "sell",
          restricted_jurisdictions: SELL_SIDE_RESTRICTED,
        },
      ],
      execution_notice: QUOTE_JURISDICTION_NOTICE,
    });
    expect(result.jurisdiction).toEqual(child.jurisdiction as never);
    expect(result.jurisdiction.execution_notice).toContain(
      "not permission to trade",
    );
    const plan = await storedPlan(testEnv, child);
    expect(plan.extensions["ekubo.jurisdiction"]).toEqual(child.jurisdiction);
    expect(walletExecutionPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("unions a restricted and an unrestricted child at the top level", async () => {
    const testEnv = env();
    const result = await referenced(testEnv, [USDG, NVDA], "US");
    const children = result.exact_input_full_balance_swaps;
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.jurisdiction).toBeDefined();
      expect(child.execution_plan_reference).toBeDefined();
      const plan = await storedPlan(testEnv, child);
      expect(plan.extensions["ekubo.jurisdiction"]).toEqual(child.jurisdiction);
    }
    const restrictedChildren = children.filter(
      (child) =>
        (child.jurisdiction.restricted_jurisdictions as string[]).length > 0,
    );
    expect(restrictedChildren).toHaveLength(1);
    expect(result.jurisdiction.restricted_jurisdictions).toEqual(
      SELL_SIDE_RESTRICTED,
    );
    expect(result.jurisdiction.assets).toEqual(
      children.flatMap((child) => child.jurisdiction.assets as unknown[]),
    );
    expect(result.jurisdiction.assets).toHaveLength(1);
    expect(result.jurisdiction.execution_notice).toBe(
      QUOTE_JURISDICTION_NOTICE,
    );
  });

  it("still fails closed on a restricted sell from an unresolved connection", async () => {
    let error: unknown;
    try {
      await swapPhase(env(), [NVDA], null);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("restricted_jurisdiction");
    expect((error as ServiceError).details).toMatchObject({ country: null });
  });

  it("records an unresolved connection when only unrestricted assets are sold", async () => {
    const result = await referenced(env(), [USDG], null);
    expect(result.producer_country_gate).toEqual({
      applied: true,
      policy_version: JURISDICTION_POLICY_VERSION,
      country_resolved: false,
      outcome: "permitted",
    });
    expect(result.exact_input_full_balance_swaps[0]!.jurisdiction).toBeDefined();
  });

  it("rejects a swap phase result that lacks inline metadata", () => {
    const schema = toolOutputSchema("prepare_ve33_reinvest")!;
    expect(
      schema.safeParse({ phase: "swap", exact_input_full_balance_swaps: [] })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        phase: "swap",
        exact_input_full_balance_swaps: [{}],
        jurisdiction: {
          policy_version: JURISDICTION_POLICY_VERSION,
          restricted_jurisdictions: [],
          assets: [],
          execution_notice: null,
        },
        producer_country_gate: {
          applied: true,
          policy_version: JURISDICTION_POLICY_VERSION,
          country_resolved: true,
          outcome: "permitted",
        },
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ phase: "claim", plan: {} }).success).toBe(true);
  });

  it("tells agents in the tool description that the metadata is not authorization", () => {
    const entry = publicToolCatalog.find(
      (tool) => tool.name === "prepare_ve33_reinvest",
    )!;
    expect(entry.description).toContain("jurisdiction metadata inline");
    expect(entry.description).toContain("neither is permission to trade");
  });
});
