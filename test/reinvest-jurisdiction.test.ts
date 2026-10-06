import { fakeArtifactStore } from "./fake-r2.js";
import { describe, expect, it } from "bun:test";
import { loadArtifact, referenceWalletArtifacts } from "../src/artifact-store.js";
import { ServiceError, type Env } from "../src/core.js";
import { publicToolCatalog, toolOutputSchema } from "../src/server.js";
import {
  JURISDICTION_POLICY_VERSION,
  JURISDICTION_POLICY_DIGEST,
  QUOTE_JURISDICTION_NOTICE_V2,
  quoteJurisdiction,
  type RequestCountry,
} from "../src/token-restrictions.js";
import { prepareVe33Reinvest } from "../src/ve33.js";
import { walletExecutionPlanSchema } from "../src/wallet-compatibility.js";

const ORIGIN = "https://mcp.ekubo.org";
const CHAIN = "4663";
const veToken = "0x9d7008E169D040B6c0140eb92E7cA82B12643497" as const;
const sender = "0x1111111111111111111111111111111111111111" as const;
/** STONX, the stake token: verified outside the Stock Token class. */
const STAKE = "0x570c5aa79c798e7a418412cc8399ae5bcce570c5" as const;
/** NVDA, a Robinhood Stock Token. */
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec" as const;
/** USDG: verified outside the Stock Token class. */
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as const;
/** Not classified by the policy: held. */
const UNKNOWN = "0x3333333333333333333333333333333333333333" as const;
const V2_COUNTRIES = [
  "AE", "BY", "CA", "CH", "CU", "GB", "IR", "KP", "MM",
  "RU", "SD", "SG", "SS", "SY", "UA", "US", "VE",
];
const NO_LISTS = { restricted_jurisdictions: [], offering_exclusions: [], issuer_prohibited_investor: [] };
const STAKE_BUY = {
  chain_id: CHAIN, token: STAKE, side: "buy", classification: "non_class",
  provenance: [{ source: "ekubo-issued", ref: "EKU-853 CLO decision 4f77cad3", observed_at: "2026-10-06" }],
  ...NO_LISTS, execution_hold: false,
};
const USDG_SELL = {
  chain_id: CHAIN, token: USDG, side: "sell", classification: "non_class",
  provenance: [{ source: "issuer-token-contracts-page", ref: "https://docs.robinhood.com/chain/contracts", observed_at: "2026-10-06" }],
  ...NO_LISTS, execution_hold: false,
};
const NVDA_SELL = {
  chain_id: CHAIN, token: NVDA, side: "sell", classification: "rhj_stock_token",
  provenance: expect.arrayContaining([expect.objectContaining({ source: "issuer-registry" })]),
  restricted_jurisdictions: V2_COUNTRIES,
  offering_exclusions: ["AE", "CA", "CH", "GB", "SG", "US"],
  issuer_prohibited_investor: ["BY", "CU", "IR", "KP", "MM", "RU", "SD", "SS", "SY", "UA", "VE"],
  execution_hold: false,
};

async function refusal(call: Promise<unknown>): Promise<ServiceError> {
  let error: unknown;
  try {
    await call;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ServiceError);
  return error as ServiceError;
}

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
    coverage: string;
    execution_hold: boolean;
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
  it("carries explicit empty metadata inline for an unrestricted sell", async () => {
    const testEnv = env();
    const result = await referenced(testEnv, [USDG], "US");
    const empty = {
      policy_version: "ekubo-token-jurisdictions-v2",
      policy_digest: JURISDICTION_POLICY_DIGEST,
      scope: "trade",
      coverage: "complete",
      execution_hold: false,
      restricted_jurisdictions: [],
      jurisdiction_names: {},
      assets: [USDG_SELL, STAKE_BUY],
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
    });
    expect(result.producer_country_gate).not.toHaveProperty("country");
    expect(result.producer_country_gate).not.toHaveProperty("outcome");
  });

  it("refuses to sell a Stock Token from any v2 country: no disposal exemption", async () => {
    for (const country of V2_COUNTRIES) {
      const error = await refusal(swapPhase(env(), [NVDA], country));
      expect(error.code).toBe("restricted_jurisdiction");
      expect(error.details).toMatchObject({
        country,
        restricted_assets: [{ token: NVDA, side: "sell", classification: "rhj_stock_token" }],
      });
    }
  });

  it("carries the full country floor inline when a Stock Token sale is prepared elsewhere", async () => {
    const testEnv = env();
    const result = await referenced(testEnv, [NVDA], "FR");
    const child = result.exact_input_full_balance_swaps[0]!;
    expect(child.jurisdiction).toEqual({
      policy_version: JURISDICTION_POLICY_VERSION,
      policy_digest: JURISDICTION_POLICY_DIGEST,
      scope: "trade",
      coverage: "complete",
      execution_hold: false,
      restricted_jurisdictions: V2_COUNTRIES,
      jurisdiction_names: expect.objectContaining({ US: "United States of America", AE: "United Arab Emirates" }),
      assets: [NVDA_SELL, STAKE_BUY],
      execution_notice: QUOTE_JURISDICTION_NOTICE_V2,
    });
    expect(result.jurisdiction).toEqual(child.jurisdiction as never);
    expect(result.jurisdiction.execution_notice).toContain("not permission to trade");
    expect(result.jurisdiction.execution_notice).toContain("No blanket disposal exemption applies.");
    const plan = await storedPlan(testEnv, child);
    expect(plan.extensions["ekubo.jurisdiction"]).toEqual(child.jurisdiction);
    expect(walletExecutionPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("unions a restricted and an unrestricted child at the top level", async () => {
    const testEnv = env();
    const result = await referenced(testEnv, [USDG, NVDA], "FR");
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
    expect(result.jurisdiction.restricted_jurisdictions).toEqual(V2_COUNTRIES);
    expect(result.jurisdiction.assets).toEqual(
      children.flatMap((child) => child.jurisdiction.assets as unknown[]),
    );
    expect(result.jurisdiction.assets).toHaveLength(4);
    expect(result.jurisdiction.coverage).toBe("complete");
    expect(result.jurisdiction.execution_notice).toBe(
      QUOTE_JURISDICTION_NOTICE_V2,
    );
  });

  it("still fails closed on a restricted sell from an unresolved connection", async () => {
    const error = await refusal(swapPhase(env(), [NVDA], null));
    expect(error.code).toBe("restricted_jurisdiction");
    expect(error.details).toMatchObject({ country: null });
  });

  it("holds the whole phase when any fee token is unknown, from any country", async () => {
    for (const country of ["FR", "US", "XX", null]) {
      const error = await refusal(swapPhase(env(), [USDG, UNKNOWN], country));
      expect(error.code).toBe("unclassified_asset");
      expect(error.details).toMatchObject({
        assets: [{ token: UNKNOWN, side: "sell", classification: "unknown" }],
      });
    }
  });

  it("records an unresolved connection when only unrestricted assets are sold", async () => {
    const result = await referenced(env(), [USDG], null);
    expect(result.producer_country_gate).toEqual({
      applied: true,
      policy_version: JURISDICTION_POLICY_VERSION,
      country_resolved: false,
    });
    expect(result.exact_input_full_balance_swaps[0]!.jurisdiction).toBeDefined();
  });

  it("rejects a swap phase result that lacks inline metadata, child or top level", () => {
    const schema = toolOutputSchema("prepare_ve33_reinvest")!;
    const explicitEmpty = quoteJurisdiction([
      { chainId: CHAIN, token: USDG, side: "sell" },
      { chainId: CHAIN, token: STAKE, side: "buy" },
    ]);
    expect(explicitEmpty.restricted_jurisdictions).toEqual([]);
    const gate = { applied: true, policy_version: JURISDICTION_POLICY_VERSION, country_resolved: true };
    const child = { jurisdiction: explicitEmpty };
    const complete = {
      phase: "swap", exact_input_full_balance_swaps: [child],
      jurisdiction: explicitEmpty, producer_country_gate: gate,
    };
    expect(schema.safeParse(complete).success).toBe(true);
    // Missing is not empty: dropping the metadata anywhere fails validation.
    expect(schema.safeParse({ ...complete, jurisdiction: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...complete, exact_input_full_balance_swaps: [{}] }).success).toBe(false);
    expect(schema.safeParse({ ...complete, exact_input_full_balance_swaps: [], jurisdiction: undefined }).success).toBe(false);
    // An unknown asset is reported as null lists, never as an empty list.
    const unknown = quoteJurisdiction([{ chainId: CHAIN, token: UNKNOWN, side: "sell" }]);
    expect(unknown).toMatchObject({ coverage: "unknown", restricted_jurisdictions: null });
    expect(schema.safeParse({ ...complete, jurisdiction: unknown }).success).toBe(true);
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
