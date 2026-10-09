import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import worker from "../src/index.js";
import { z } from "zod";
import { catalogSummary, compactSchema, labelPatterns } from "../src/mcp-catalog.js";
import { PROTOCOLS, protocolMcpPath } from "../src/protocols.js";
import { fakeArtifactStore } from "./fake-r2.js";

// Everything a client loads at session start — the initialize instructions,
// tools/list and resources/list — is paid for on every turn of every agent
// session. These budgets are in JSON characters (roughly 3.5–4 per token on
// current tokenizers). Raise one only with a reason the extra tokens buy.
// MCP_CONTEXT_DUMP=<dir> writes each endpoint's payloads for token counting.

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
  ALLOWED_ORIGINS: "https://client.test",
};
const context = {} as ExecutionContext;

async function rpc(path: string, method: string, params: Record<string, unknown> = {}) {
  const response = await worker.fetch(
    new Request(`https://mcp.ekubo.org${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        origin: "https://client.test",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    context,
  );
  const text = await response.text();
  const data = text.startsWith("{")
    ? text
    : text.split("\n").find((line) => line.startsWith("data:"))!.slice(5);
  return JSON.parse(data).result;
}

type Budget = {
  /** initialize instructions */
  instructions: number;
  /** the whole tools/list array */
  tools: number;
  /** the largest single tool entry */
  tool: number;
  /** the resources/list result */
  resources: number;
};

// Oct 2026 measurements, o200k tokens (instructions + tools/list +
// resources/list): /mcp 72,327 -> 40,505 (EKU-971) -> 31,494 (EKU-991)
// -> 31,741 (EKU-999); /mcp/ekubo 44,788 -> 23,963 -> 17,440 -> 17,702, of
// which tools/list 16,388 and the largest tool, get_quotes_with_plans, 1,127.
// EKU-999 spends ~270 tokens on small-model failures from EKU-993: the
// slippage_bps unit, the ve33 chain_id source and no-restating references in
// chat. Every Ekubo-scoped endpoint's
// instructions carry the CLO jurisdiction notice verbatim, about 480 of
// those tokens, and get_quotes_with_plans carries it again in its
// description. Every non-Safe instructions budget was raised by 550 characters
// for the scope sentence (EKU-988): without it, agents read the handoff rules
// as a ban on the user's own cast/sncast work outside this server. EKU-994
// split /mcp/ekubo into core (34 tools) and /mcp/ekubo-advanced (17 operator
// tools); /mcp is unchanged.
const ENDPOINTS: Record<string, Budget> = {
  "/mcp": { instructions: 7_950, tools: 133_000, tool: 5_200, resources: 4_200 },
  "/mcp/ekubo": { instructions: 5_250, tools: 54_000, tool: 5_200, resources: 1_900 },
  "/mcp/ekubo-advanced": { instructions: 4_650, tools: 20_000, tool: 2_000, resources: 900 },
  "/mcp/aave": { instructions: 4_750, tools: 8_500, tool: 1_500, resources: 300 },
  "/mcp/aerodrome": { instructions: 5_450, tools: 15_000, tool: 2_200, resources: 850 },
  "/mcp/lido": { instructions: 4_750, tools: 5_100, tool: 1_200, resources: 750 },
  "/mcp/merkl": { instructions: 5_250, tools: 2_400, tool: 1_600, resources: 750 },
  "/mcp/morpho": { instructions: 4_750, tools: 5_300, tool: 1_800, resources: 750 },
  "/mcp/sky": { instructions: 4_750, tools: 3_800, tool: 1_100, resources: 750 },
  "/mcp/uniswap": { instructions: 4_250, tools: 19_500, tool: 1_900, resources: 300 },
  "/mcp/safe": { instructions: 1_400, tools: 11_000, tool: 2_450, resources: 300 },
};

// Facets of /mcp (EKU-1123) state the shared paragraphs once instead of once
// per connection. o200k on 0.50.0: ekubo+ekubo-advanced 17,818 vs 19,026 as two
// connections; ekubo+uniswap 17,941 vs 18,914; the Cloud Wallet default (every
// bundled protocol but ekubo-advanced) 27,624 vs 34,249 as eight.
const FACETS: Record<string, Budget> = {
  "/mcp?protocols=ekubo+ekubo-advanced": { instructions: 5_250, tools: 74_000, tool: 5_200, resources: 1_900 },
  "/mcp?protocols=ekubo+uniswap": { instructions: 5_250, tools: 74_000, tool: 5_200, resources: 1_900 },
  "/mcp?protocols=ekubo+aave+aerodrome+lido+merkl+morpho+sky+uniswap": {
    instructions: 8_400,
    tools: 113_000,
    tool: 5_200,
    resources: 4_200,
  },
};

async function measure(path: string) {
  const init = await rpc(path, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "budget", version: "1" },
  });
  const tools = (await rpc(path, "tools/list")).tools as { name: string }[];
  const resources = await rpc(path, "resources/list");
  const perTool = tools.map((tool) => ({
    name: tool.name,
    chars: JSON.stringify(tool).length,
  }));
  return {
    instructions: init.instructions as string,
    tools,
    resources,
    size: {
      instructions: (init.instructions as string).length,
      tools: JSON.stringify(tools).length,
      tool: Math.max(...perTool.map((tool) => tool.chars)),
      resources: JSON.stringify(resources).length,
    },
    perTool,
  };
}

describe("MCP context budget", () => {
  it("covers every endpoint", () => {
    expect(Object.keys(ENDPOINTS).sort()).toEqual(
      ["/mcp", ...PROTOCOLS.map((protocol) => protocolMcpPath(protocol.slug))].sort(),
    );
  });

  it("merges only type-specific anyOf branches, which is lossless", () => {
    expect(
      compactSchema({
        anyOf: [{ anyOf: [{ type: "integer", minimum: 0 }, { type: "string", pattern: "^1$" }] }, { type: "null" }],
        description: "d",
      }),
    ).toEqual({ type: ["integer", "string", "null"], minimum: 0, pattern: "^1$", description: "d" });
    // `const` is not type-specific, so these branches stay separate.
    const literal = { anyOf: [{ type: "string", const: "a" }, { type: "number" }] };
    expect(compactSchema(literal)).toEqual(literal);
    expect(labelPatterns({ type: "string", pattern: "^0x[0-9a-fA-F]{40}$" })).toEqual({
      type: "string",
      description: "address",
    });
  });

  it("names repeated objects and keeps output schemas to what an agent reads", () => {
    const key = catalogSummary(z.object({ token0: z.string() }), "PoolKey {token0}");
    expect(
      compactSchema(
        z.toJSONSchema(z.object({ a: key.optional(), b: key.nullable().describe("Vote") }), { io: "input" }),
      ),
    ).toEqual({
      type: "object",
      properties: {
        a: { type: "object", description: "PoolKey {token0}" },
        b: { type: ["object", "null"], description: "Vote. PoolKey {token0}" },
      },
      required: ["b"],
    });
    expect(
      compactSchema(z.toJSONSchema(z.object({ id: z.string().regex(/^0x/) }), { io: "output" }), true),
    ).toEqual({ type: "object", properties: { id: { type: "string" } } });
    expect(labelPatterns({ type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "Token address" })).toEqual({
      type: "string",
      description: "Token address",
    });
    expect(compactSchema({ type: "integer", minimum: -887272, maximum: 30 })).toEqual({ type: "integer", maximum: 30 });
  });

  it("publishes compact schemas", async () => {
    const tools = (await rpc("/mcp", "tools/list")).tools as Record<string, unknown>[];
    const text = JSON.stringify(tools);
    expect(text).not.toContain("$schema");
    expect(text).not.toContain("$ref");
    expect(text).not.toContain(String(Number.MAX_SAFE_INTEGER));
    expect(text).not.toContain('"additionalProperties":{}');
    expect(text).not.toContain('"additionalProperties":true');
    for (const tool of tools) {
      const annotations = tool.annotations as Record<string, unknown> | undefined;
      if (annotations?.readOnlyHint === true) {
        expect(annotations.destructiveHint).toBeUndefined();
        expect(annotations.idempotentHint).toBeUndefined();
      }
    }
  });

  for (const [path, budget] of [...Object.entries(ENDPOINTS), ...Object.entries(FACETS)]) {
    it(`${path} stays within its budget`, async () => {
      const result = await measure(path);
      const dir = process.env.MCP_CONTEXT_DUMP;
      if (dir) {
        const slug = path.replaceAll(/[/?=+]/g, "_");
        writeFileSync(`${dir}/${slug}.json`, JSON.stringify(result));
      }
      console.log(path, JSON.stringify(result.size), result.tools.length, "tools");
      expect(result.size.instructions).toBeLessThanOrEqual(budget.instructions);
      expect(result.size.tools).toBeLessThanOrEqual(budget.tools);
      expect(result.size.tool).toBeLessThanOrEqual(budget.tool);
      expect(result.size.resources).toBeLessThanOrEqual(budget.resources);
    });
  }
});
