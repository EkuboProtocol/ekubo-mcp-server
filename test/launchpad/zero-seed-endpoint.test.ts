import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import worker from "../../src/index.js";
import { DISCLOSURE_CODES } from "../../src/launchpad/zero-seed/disclosures.js";
import { LOCAL_INSTANCE_PINS } from "../../src/launchpad/zero-seed/policy.js";
import { fakeArtifactStore } from "../fake-r2.js";

type Json = any;

const TOOLS = [
  "launchpad_get_claims",
  "launchpad_get_launch",
  "launchpad_get_swaps",
  "launchpad_list_launches",
  "launchpad_prepare_claim_fees",
  "launchpad_prepare_create",
  "launchpad_prepare_trade",
];
const OBSOLETE = ["launchpad_get_stats", "launchpad_prepare_advance"];

const context = {} as unknown as ExecutionContext;
const headers = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
  host: "mcp.ekubo.org",
  origin: "https://mcp.ekubo.org",
  "mcp-protocol-version": "2025-11-25",
};
const pin = LOCAL_INSTANCE_PINS[0];
const sender = "0x0000000000000000000000000000000000000123";
const poolId = `0x${"11".repeat(32)}`;
const parameters = {
  quoteToken: pin.quote, name: "Local", symbol: "LOC", decimals: 18, supply: "1000", liquidity: "0",
  askTick: -100, upperTick: 100, tickSpacing: 100, tradingStart: "1300", feeDuration: 3600,
  initialFee: "1", finalFee: "0", salt: `0x${"00".repeat(32)}`,
};

function workerEnv() {
  return {
    ARTIFACT_STORE: fakeArtifactStore(), ALLOWED_ORIGINS: "https://mcp.ekubo.org",
    EKUBO_API_URL: "https://synthetic.invalid", LAUNCHPAD_API_URL: "https://synthetic.invalid",
  };
}

async function mcp(environment: Json, path: string, method: string, params: Record<string, unknown> = {}): Promise<Json> {
  const response = await worker.fetch(
    new Request(`https://mcp.ekubo.org${path}`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }),
    environment,
    context,
  );
  const body = await response.text();
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? body.split("\n").find((line) => line.startsWith("data:"))!.slice(5)
    : body;
  return JSON.parse(data);
}

const call = (environment: Json, name: string, args: Record<string, unknown>) =>
  mcp(environment, "/mcp/launchpad", "tools/call", { name, arguments: args });

let requests: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  requests = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    throw new Error("the hosted launchpad must not make requests");
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("hosted zero-seed launchpad endpoint (support disabled)", () => {
  it("serves only the zero-seed tools and disclosures, only on /mcp/launchpad", async () => {
    const e = workerEnv();
    const scoped = (await mcp(e, "/mcp/launchpad", "tools/list")).result.tools.map((t: Json) => t.name);
    expect(scoped.sort()).toEqual(TOOLS);
    for (const name of OBSOLETE) expect(scoped).not.toContain(name);
    const bundled = (await mcp(e, "/mcp", "tools/list")).result.tools.map((t: Json) => t.name);
    expect(bundled.filter((name: string) => name.startsWith("launchpad_"))).toEqual([]);
    const resources = (await mcp(e, "/mcp/launchpad", "resources/list")).result.resources.map((r: Json) => r.uri);
    expect(resources).toContain("launchpad://disclosures");
    expect(resources).not.toContain("launchpad://onboarding");
  });

  it("lists nothing on the local harness chain or any other, without a request", async () => {
    for (const chain of ["31337", "1", "8453"]) {
      const reply = await call(workerEnv(), "launchpad_list_launches", { chain_id: chain });
      expect(reply.result.structuredContent).toEqual({ data: [], next_cursor: null, launch_support: "disabled" });
    }
    expect(requests).toEqual([]);
  });

  const refusals: [string, Record<string, unknown>, string][] = [
    ["launchpad_get_launch", { chain_id: pin.chainId, pool_id: poolId }, "launch_support_disabled"],
    ["launchpad_get_swaps", { chain_id: pin.chainId, pool_id: poolId }, "launch_support_disabled"],
    ["launchpad_get_claims", { chain_id: pin.chainId, pool_id: poolId }, "launch_support_disabled"],
    ["launchpad_prepare_create", { chain_id: pin.chainId, sender, parameters }, "launch_support_disabled"],
    ["launchpad_prepare_claim_fees", { chain_id: pin.chainId, sender, pool_id: poolId, recipient: `0x${"55".repeat(20)}` }, "launch_support_disabled"],
    ["launchpad_prepare_trade", { chain_id: pin.chainId, sender, pool_id: poolId, side: "buy", amount: "1", slippage_bps: 100 }, "executable_budget_not_proven"],
  ];
  for (const [name, args, code] of refusals) {
    it(`${name} fails closed with ${code}, storing no reference`, async () => {
      const e = workerEnv();
      const reply = await call(e, name, args);
      expect(reply.result.isError).toBe(true);
      expect(reply.result.structuredContent.error.code).toBe(code);
      expect(JSON.stringify(reply)).not.toContain("execution_plan_reference");
      expect(e.ARTIFACT_STORE.entries.size).toBe(0);
      expect(requests).toEqual([]);
    });
  }

  it("refuses disabled chains before configuration is consulted", async () => {
    const reply = await call({ ARTIFACT_STORE: fakeArtifactStore(), ALLOWED_ORIGINS: "https://mcp.ekubo.org" },
      "launchpad_get_launch", { chain_id: "1", pool_id: poolId });
    expect(reply.result.structuredContent.error.code).toBe("launch_support_disabled");
  });

  it("serves the five versioned mechanism disclosures", async () => {
    const reply = await mcp(workerEnv(), "/mcp/launchpad", "resources/read", { uri: "launchpad://disclosures" });
    const document = JSON.parse(reply.result.contents[0].text);
    expect(document).toMatchObject({ version: 2, status: "draft_not_approved" });
    expect(document.disclosures.map((entry: Json) => entry.code)).toEqual([
      "zero_initial_bid", "buyer_funded_quote_reserve", "permanent_principal_lock",
      "creator_fee_recipient_and_rate", "no_exit_guarantee",
    ]);
    expect(DISCLOSURE_CODES).toHaveLength(5);
  });
});
