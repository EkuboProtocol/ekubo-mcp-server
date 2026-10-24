import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import worker from "../../src/index.js";
import { DISCLOSURE_CODES } from "../../src/launchpad/zero-seed/disclosures.js";
import { LIVE_INSTANCE_PINS, LOCAL_INSTANCE_PINS } from "../../src/launchpad/zero-seed/policy.js";
import { fakeArtifactStore } from "../fake-r2.js";
import { PROTOCOLS, protocolMcpPath } from "../../src/protocols.js";
import { MCP_SERVER_VERSION, MCP_TOOL_CATALOG_REVISION } from "../../src/version.js";

type Json = any;

const TOOLS = [
  "launchpad_get_claims",
  "launchpad_get_launch",
  "launchpad_get_owners",
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
const pin = LOCAL_INSTANCE_PINS.find((entry) => entry.feeModel === "tick_rate_v2")!;
const sender = "0x0000000000000000000000000000000000000123";
const poolId = `0x${"11".repeat(32)}`;
const parameters = {
  name: "Local", symbol: "LOC", decimals: 18, supply: "1000000000000000000000000000",
  askTick: -100, upperTick: 100, tickSpacing: 100, tradingStart: "1300", decayRateX32: "68913100933",
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

const TESTING = "/mcp/launchpad-testing";
const DEFAULT = [
  "/mcp",
  ...PROTOCOLS.filter((protocol) => protocol.slug !== "launchpad-testing").map((protocol) => protocolMcpPath(protocol.slug)),
  "/mcp?protocols=ekubo+ekubo-advanced",
  "/mcp?protocols=ekubo+aave+aerodrome+lido+merkl+morpho+sky+uniswap",
];

const call = (environment: Json, name: string, args: Record<string, unknown>, path = TESTING) =>
  mcp(environment, path, "tools/call", { name, arguments: args });

async function get(path: string): Promise<Response> {
  return worker.fetch(new Request(`https://mcp.ekubo.org${path}`, { headers: { host: "mcp.ekubo.org" } }), workerEnv() as Json, context);
}

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

describe("hosted zero-seed launchpad tools (support disabled)", () => {
  it(`${TESTING} lists exactly the zero-seed tools and disclosures`, async () => {
    const e = workerEnv();
    const tools = (await mcp(e, TESTING, "tools/list")).result.tools as Json[];
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    for (const tool of tools) {
      expect(tool.description).toStartWith("Zero-seed launchpad, support disabled:");
      expect(JSON.stringify(tool.outputSchema ?? {})).not.toContain("_reference");
    }
    const resources = (await mcp(e, TESTING, "resources/list")).result.resources.map((r: Json) => r.uri);
    expect(resources).toContain("launchpad://disclosures");
    expect(resources).not.toContain("launchpad://onboarding");
    const init = (await mcp(e, TESTING, "initialize", {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
    })).result;
    expect(init.serverInfo).toMatchObject({ name: "ekubo-launchpad-testing", version: MCP_SERVER_VERSION });
    expect(init.instructions).toStartWith(`Tool catalog revision: ${MCP_TOOL_CATALOG_REVISION}`);
    expect(init.instructions).toContain("launch_support_disabled");
    expect(requests).toEqual([]);
  });

  for (const path of DEFAULT) {
    it(`${path} serves no zero-seed tool, resource or instructions`, async () => {
      const e = workerEnv();
      const names = (await mcp(e, path, "tools/list")).result.tools.map((t: Json) => t.name as string);
      expect(names.filter((name: string) => name.startsWith("launchpad_"))).toEqual([]);
      const resources = (await mcp(e, path, "resources/list")).result.resources.map((r: Json) => r.uri as string);
      expect(resources.filter((uri: string) => uri.startsWith("launchpad://"))).toEqual([]);
      const read = await mcp(e, path, "resources/read", { uri: "launchpad://disclosures" });
      expect(read.result).toBeUndefined();
      const init = (await mcp(e, path, "initialize", {
        protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
      })).result;
      expect(init.instructions.replaceAll(MCP_TOOL_CATALOG_REVISION, "")).not.toContain("launchpad");
      for (const name of TOOLS) {
        const reply = await call(e, name, {}, path);
        expect(reply.result?.structuredContent).toBeUndefined();
        expect(JSON.stringify(reply)).toContain(`Tool ${name} not found`);
      }
      expect(requests).toEqual([]);
    });
  }

  it("keeps /mcp and /mcp/ekubo at their pre-launchpad tool counts", async () => {
    const e = workerEnv();
    const count = async (path: string) => (await mcp(e, path, "tools/list")).result.tools.length;
    expect(await count("/mcp")).toBe(99);
    expect(await count("/mcp/ekubo")).toBe(34);
  });

  it("advertises the testing endpoint only as a standalone protocol", async () => {
    const root = await (await get("/")).json() as Json;
    expect(root.tool_count).toBe(99);
    expect(root.mcp_endpoints.all.protocols).not.toContain("launchpad-testing");
    const entry = root.mcp_endpoints.by_protocol.find((p: Json) => p.protocol === "launchpad-testing");
    expect(entry).toMatchObject({ url: `https://mcp.ekubo.org${TESTING}`, tool_count: 8 });
    expect([...entry.tools].sort()).toEqual(TOOLS);
    const ekubo = root.mcp_endpoints.by_protocol.find((p: Json) => p.protocol === "ekubo");
    expect(ekubo.tools.filter((name: string) => name.startsWith("launchpad_"))).toEqual([]);
    expect(ekubo.description).not.toContain("launchpad");

    const all = await (await get("/tools")).json() as Json;
    expect(all.tools.filter((t: Json) => t.name.startsWith("launchpad_"))).toEqual([]);
    const ekuboTools = await (await get("/tools?protocol=ekubo")).json() as Json;
    expect(ekuboTools.tools.filter((t: Json) => t.name.startsWith("launchpad_"))).toEqual([]);
    const testing = await (await get("/tools?protocol=launchpad-testing")).json() as Json;
    expect(testing.mcp_endpoint).toBe(`https://mcp.ekubo.org${TESTING}`);
    expect(testing.tools.map((t: Json) => t.name).sort()).toEqual(TOOLS);
    expect(testing.tools.every((t: Json) => t.protocol === "launchpad-testing")).toBe(true);
  });

  for (const query of ["ekubo+launchpad-testing", "launchpad-testing"]) {
    it(`refuses ?protocols=${query}: the testing tools cannot be combined`, async () => {
      for (const path of [`/mcp?protocols=${query}`, `/tools?protocols=${query}`]) {
        const response = path.startsWith("/mcp")
          ? await worker.fetch(new Request(`https://mcp.ekubo.org${path}`, {
            method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
          }), workerEnv() as Json, context)
          : await get(path);
        expect(response.status).toBeGreaterThanOrEqual(400);
        const body = await response.json() as Json;
        expect(body.error.code).toBe("unknown_protocol");
        expect(JSON.stringify(body)).toContain("/mcp/launchpad-testing");
      }
    });
  }

  it("keeps the live instance pin list empty", () => {
    expect(LIVE_INSTANCE_PINS).toEqual([]);
    expect(Object.isFrozen(LIVE_INSTANCE_PINS)).toBe(true);
  });

  it("serves nothing at the retired /mcp/launchpad path", async () => {
    const response = await worker.fetch(
      new Request("https://mcp.ekubo.org/mcp/launchpad", {
        method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      workerEnv() as Json,
      context,
    );
    expect(response.status).toBe(404);
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
    ["launchpad_get_owners", { chain_id: pin.chainId, pool_id: poolId }, "launch_support_disabled"],
    ["launchpad_prepare_create", { chain_id: pin.chainId, sender, parameters }, "launch_support_disabled"],
    ["launchpad_prepare_claim_fees", { chain_id: pin.chainId, sender, pool_id: poolId, recipient: `0x${"55".repeat(20)}` }, "launch_support_disabled"],
    ["launchpad_prepare_trade", { chain_id: pin.chainId, sender, pool_id: poolId, side: "buy", amount: "1", slippage_bps: 100 }, "executable_budget_not_proven"],
  ];
  for (const [name, args, code] of refusals) {
    it(`${name} fails closed with ${code} on ${TESTING}, storing no reference`, async () => {
      const e = workerEnv();
      const reply = await call(e, name, args);
      expect(reply.result.isError).toBe(true);
      expect(reply.result.structuredContent.error.code).toBe(code);
      expect(JSON.stringify(reply)).not.toContain("execution_plan_reference");
      expect(e.ARTIFACT_STORE.entries.size).toBe(0);
      expect(requests).toEqual([]);
    });
  }

  it("prepare_create takes the launch's quote (native by default) and the requested supply, with no liquidity input", async () => {
    const e = workerEnv();
    const tools = (await mcp(e, TESTING, "tools/list")).result.tools as Json[];
    const create = tools.find((t) => t.name === "launchpad_prepare_create");
    const schema = create.inputSchema.properties.parameters;
    const properties = Object.keys(schema.properties);
    expect(properties).toEqual(["name", "symbol", "decimals", "supply", "quoteToken", "askTick", "upperTick", "tickSpacing",
      "tradingStart", "decayRateX32", "halfLifeSeconds", "initialFee", "finalFee", "salt"]);
    expect(properties).not.toContain("liquidity");
    expect(properties).not.toContain("decayFactor");
    expect(properties).not.toContain("feeDuration");
    expect(schema.required).toEqual(properties.filter((key) => !["quoteToken", "decayRateX32", "halfLifeSeconds"].includes(key)));
    expect(schema.properties.quoteToken).toMatchObject({ default: "0x0000000000000000000000000000000000000000",
      pattern: "^0x[0-9a-f]{40}$" });
    expect(schema.properties.quoteToken.description).toContain("native ETH");
    expect(schema.properties.supply.description).toContain("Requested raw supply");
    for (const stale of [{ ...parameters, liquidity: "0" }, { ...parameters, decayFactor: "1" }, { ...parameters, feeDuration: 3600 }]) {
      const reply = await call(e, "launchpad_prepare_create", { chain_id: pin.chainId, sender, parameters: stale });
      expect(reply.result.isError).toBe(true);
      expect(reply.result.content[0].text).toMatch(/liquidity|decayFactor|feeDuration/);
    }
    // Native default, an explicit ERC-20 and an unreviewed ERC-20 all fail closed: support is disabled.
    for (const quoteToken of [undefined, "0xffffffffffffffffffffffffffffffffffffffff", "0x4200000000000000000000000000000000000006"]) {
      const reply = await call(e, "launchpad_prepare_create", { chain_id: pin.chainId, sender,
        parameters: quoteToken === undefined ? parameters : { ...parameters, quoteToken } });
      expect(reply.result.structuredContent.error.code).toBe("launch_support_disabled");
    }
    expect(JSON.stringify(tools)).not.toContain("execution_plan_reference");
    expect(e.ARTIFACT_STORE.entries.size).toBe(0);
    expect(requests).toEqual([]);
  });

  describe("creator fee range at the tool boundary (uint64 Q0.64 decimal strings)", () => {
    const MAX = "18446744073709551615";
    const FEE_50 = "9223372036854775808";
    const FEE_03 = "55340232221128654";
    const create = (fees: Record<string, unknown>, e = workerEnv()) =>
      call(e, "launchpad_prepare_create", { chain_id: pin.chainId, sender, parameters: { ...parameters, ...fees } });

    it("publishes the full range, just under 100%, with no 99% ceiling and no fee_too_high", async () => {
      const tools = (await mcp(workerEnv(), TESTING, "tools/list")).result.tools as Json[];
      const schema = tools.find((t) => t.name === "launchpad_prepare_create").inputSchema.properties.parameters;
      expect(schema.properties.initialFee).toMatchObject({ type: "string" });
      expect(schema.properties.initialFee.description).toContain(`0 to ${MAX}, just under 100%`);
      expect(schema.properties.initialFee.description).toContain("uint64 Q0.64");
      expect(schema.properties.finalFee.description).toContain("<= initialFee");
      expect(schema.properties.finalFee.description).toContain("Long-run floor");
      expect(schema.properties).not.toHaveProperty("feeDuration");
      const text = JSON.stringify(tools);
      for (const stale of ["99%", "18262276632972456099", "fee_too_high", "FeeTooHigh"]) expect(text).not.toContain(stale);
      expect(text.replaceAll("just under 100%", "")).not.toContain("100%");
    });

    const accepted: [string, Record<string, unknown>][] = [
      ["the default 50% -> 0.3% at the one-day half-life", { initialFee: FEE_50, finalFee: FEE_03 }],
      ["the maximum -> 0.3%", { initialFee: MAX, finalFee: FEE_03 }],
      ["flat at the maximum", { initialFee: MAX, finalFee: MAX }],
      ["a final fee one below the maximum", { initialFee: MAX, finalFee: "18446744073709551614" }],
      ["zero", { initialFee: "0", finalFee: "0" }],
    ];
    for (const [label, fees] of accepted) {
      it(`accepts ${label}; support stays disabled, so no plan`, async () => {
        const e = workerEnv();
        const reply = await create(fees, e);
        expect(reply.result.isError).toBe(true);
        expect(reply.result.structuredContent).toEqual({ error: { code: "launch_support_disabled", message: "launch_support_disabled" } });
        expect(e.ARTIFACT_STORE.entries.size).toBe(0);
        expect(requests).toEqual([]);
      });
    }

    const NOT_CANONICAL = "must be a canonical decimal string";
    const ABOVE = `must be at most ${MAX} (uint64 max, just under 100%)`;
    const refused: [string, Record<string, unknown>, string, string][] = [
      ["2^64 as the initial fee", { initialFee: "18446744073709551616" }, "initialFee", ABOVE],
      ["2^64 as the final fee", { initialFee: MAX, finalFee: "18446744073709551616" }, "finalFee", ABOVE],
      ["2^65 - 1", { initialFee: "36893488147419103231" }, "initialFee", ABOVE],
      ["a leading zero", { initialFee: `0${MAX}` }, "initialFee", NOT_CANONICAL],
      ["a sign", { initialFee: "+1" }, "initialFee", NOT_CANONICAL],
      ["a negative", { finalFee: "-1" }, "finalFee", NOT_CANONICAL],
      ["whitespace", { initialFee: ` ${MAX}` }, "initialFee", NOT_CANONICAL],
      ["hex", { initialFee: "0xffffffffffffffff" }, "initialFee", NOT_CANONICAL],
      ["an exponent", { initialFee: "1e18" }, "initialFee", NOT_CANONICAL],
      ["a fraction", { initialFee: "0.5" }, "initialFee", NOT_CANONICAL],
      ["an empty string", { finalFee: "" }, "finalFee", NOT_CANONICAL],
      ["a JSON number", { initialFee: 1 }, "initialFee", "must be a decimal string; a JSON number cannot carry every uint64"],
      ["final above initial", { initialFee: "18446744073709551614", finalFee: MAX }, "finalFee",
        "invalid_fee_schedule: finalFee must be at most initialFee"],
    ];
    for (const [label, fees, field, message] of refused) {
      it(`refuses ${label} as invalid input naming parameters.${field}`, async () => {
        const e = workerEnv();
        const reply = await create(fees, e);
        expect(reply.result.isError).toBe(true);
        expect(reply.result.structuredContent).toBeUndefined();
        const text = reply.result.content[0].text as string;
        expect(text).toContain(`parameters.${field}: ${message}`);
        expect(text).not.toContain("launch_support_disabled");
        expect(e.ARTIFACT_STORE.entries.size).toBe(0);
        expect(requests).toEqual([]);
      });
    }
  });

  describe("fee decay at the tool boundary: decayRateX32 or halfLifeSeconds, one-day default", () => {
    const { decayRateX32: _rate, ...base } = parameters;
    const MAX = "18446744073709551615";
    const create = (decay: Record<string, unknown>, e = workerEnv()) =>
      call(e, "launchpad_prepare_create", { chain_id: pin.chainId, sender, parameters: { ...base, ...decay } });

    it("publishes both inputs with the half-life wording and no duration or end promise", async () => {
      const tools = (await mcp(workerEnv(), TESTING, "tools/list")).result.tools as Json[];
      const tool = tools.find((t) => t.name === "launchpad_prepare_create");
      const schema = tool.inputSchema.properties.parameters;
      expect(schema.properties.decayRateX32).toMatchObject({ type: "string" });
      expect(schema.properties.decayRateX32.description).toContain("68913100933 = one-day half-life (default)");
      expect(schema.properties.decayRateX32.description).toContain("0 = flat at initialFee");
      expect(schema.properties.halfLifeSeconds).toMatchObject({ type: "string" });
      expect(schema.properties.halfLifeSeconds.description).toContain("half-life of the excess over finalFee");
      expect(schema.description).toContain("approaching finalFee, a floor with no end date");
      const text = JSON.stringify(tool);
      for (const stale of ["feeDuration", "fee duration", "600 s half-life rescaled", "fee_end", "ends at"]) expect(text).not.toContain(stale);
    });

    const accepted: [string, Record<string, unknown>][] = [
      ["neither (the one-day default)", {}],
      ["decayRateX32 0 (a flat fee)", { decayRateX32: "0" }],
      ["decayRateX32 1", { decayRateX32: "1" }],
      ["decayRateX32 2^64 - 1", { decayRateX32: MAX }],
      ["halfLifeSeconds 86400", { halfLifeSeconds: "86400" }],
      ["a fractional halfLifeSeconds", { halfLifeSeconds: "86400.5" }],
      ["halfLifeSeconds at microsecond precision", { halfLifeSeconds: "0.000323" }],
    ];
    for (const [label, decay] of accepted) {
      it(`accepts ${label}; support stays disabled, so no plan`, async () => {
        const e = workerEnv();
        const reply = await create(decay, e);
        expect(reply.result.structuredContent).toEqual({ error: { code: "launch_support_disabled", message: "launch_support_disabled" } });
        expect(e.ARTIFACT_STORE.entries.size).toBe(0);
        expect(requests).toEqual([]);
      });
    }

    const invalid: [string, Record<string, unknown>, string][] = [
      ["decayRateX32 2^64", { decayRateX32: "18446744073709551616" }, "parameters.decayRateX32: must be at most 18446744073709551615"],
      ["decayRateX32 as a JSON number", { decayRateX32: 68913100933 }, "parameters.decayRateX32: must be a decimal string"],
      ["decayRateX32 with a leading zero", { decayRateX32: "068913100933" }, "parameters.decayRateX32: must be a canonical decimal string"],
      ["a negative decayRateX32", { decayRateX32: "-1" }, "parameters.decayRateX32: must be a canonical decimal string"],
      ["both inputs", { decayRateX32: "1", halfLifeSeconds: "86400" }, "parameters.halfLifeSeconds: give decayRateX32 or halfLifeSeconds, not both"],
      ["seven decimals", { halfLifeSeconds: "1.0000001" }, "parameters.halfLifeSeconds: must be a decimal string of seconds with at most 6 decimals"],
      ["an exponent", { halfLifeSeconds: "8.64e4" }, "parameters.halfLifeSeconds: must be a decimal string of seconds with at most 6 decimals"],
      ["the old feeDuration", { feeDuration: 3600 }, "feeDuration"],
    ];
    for (const [label, decay, message] of invalid) {
      it(`refuses ${label} as invalid input before any request`, async () => {
        const e = workerEnv();
        const reply = await create(decay, e);
        expect(reply.result.isError).toBe(true);
        expect(reply.result.structuredContent).toBeUndefined();
        expect(reply.result.content[0].text).toContain(message);
        expect(e.ARTIFACT_STORE.entries.size).toBe(0);
        expect(requests).toEqual([]);
      });
    }

    // A half-life whose exact rate is 0 or above uint64: the conversion refuses instead of clamping.
    for (const [label, halfLifeSeconds] of [["zero", "0"], ["one too long for a rate of 1", "5954091920683120"],
      ["too short for uint64", "0.000322"]] as const) {
      it(`refuses a half-life ${label} with invalid_half_life`, async () => {
        const e = workerEnv();
        const reply = await create({ halfLifeSeconds }, e);
        expect(reply.result.isError).toBe(true);
        expect(reply.result.structuredContent.error.code).toBe("invalid_half_life");
        expect(e.ARTIFACT_STORE.entries.size).toBe(0);
        expect(requests).toEqual([]);
      });
    }
  });

  it("refuses disabled chains before configuration is consulted", async () => {
    const reply = await call({ ARTIFACT_STORE: fakeArtifactStore(), ALLOWED_ORIGINS: "https://mcp.ekubo.org" },
      "launchpad_get_launch", { chain_id: "1", pool_id: poolId });
    expect(reply.result.structuredContent.error.code).toBe("launch_support_disabled");
  });

  it("serves the ten versioned draft mechanism disclosures", async () => {
    const reply = await mcp(workerEnv(), TESTING, "resources/read", { uri: "launchpad://disclosures" });
    const document = JSON.parse(reply.result.contents[0].text);
    expect(document).toMatchObject({ version: 7, status: "draft_not_approved" });
    expect(document.disclosures.map((entry: Json) => entry.code)).toEqual([
      "zero_initial_bid", "buyer_funded_quote_reserve", "permanent_principal_lock", "creator_fee_recipient_and_rate",
      "transferable_launch_ownership", "creator_fee_recapture", "high_initial_fee", "exact_output_gross_up", "no_exit_guarantee",
      "quote_token_trust",
    ]);
    expect(DISCLOSURE_CODES).toHaveLength(10);
    const text = reply.result.contents[0].text;
    expect(text).not.toContain("linearly");
    expect(text).not.toContain("cannot transfer");
    expect(text).not.toContain("rounding remainder");
    expect(text).not.toContain("600 s half-life");
    expect(text).not.toContain("<fee duration>");
    const fee = document.disclosures.find((entry: Json) => entry.code === "creator_fee_recipient_and_rate");
    expect(fee.template).toContain("halves about every <half-life> s, so the fee approaches <final fee>, a long-run floor and not an end date");
    expect(fee.template).toContain("once more than <saturation seconds> s have passed since trading start");
    expect(fee.constant_template).toContain("constant: the decay rate is 0, so it never decays toward <final fee>");
    expect(text).toContain("the remainder of <sink supply>, too small to pay for one more unit of liquidity, is minted to address(0)");
    const trust = document.disclosures.find((entry: Json) => entry.code === "quote_token_trust");
    expect(trust.template).toContain("<quote> is trusted across all of Core, not just this pool");
    expect(trust.template).toContain("an honest token paired with it can lose that pool's own reserve");
    expect(trust.template).toContain("are not reachable through it");
    expect(trust.native_template).toBe("Quote trust: the quote is native ETH, which Core accounts for itself. No quote token contract is trusted.");
  });
});
