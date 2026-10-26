import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import worker from "../src/index.js";
import { z } from "zod";
import { catalogSummary, compactSchema, labelPatterns } from "../src/mcp-catalog.js";
import { PROTOCOLS, protocolMcpPath } from "../src/protocols.js";
import { fakeArtifactStore } from "./fake-r2.js";


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
  instructions: number;
  tools: number;
  tool: number;
  resources: number;
};

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
  "/mcp/launchpad": { instructions: 1_100, tools: 12_200, tool: 2_300, resources: 300 },
};

const FACETS: Record<string, Budget> = {
  "/mcp?protocols=ekubo+ekubo-advanced": { instructions: 5_500, tools: 74_000, tool: 5_200, resources: 1_900 },
  "/mcp?protocols=ekubo+uniswap": { instructions: 5_500, tools: 74_000, tool: 5_200, resources: 1_900 },
  "/mcp?protocols=ekubo+aave+aerodrome+lido+merkl+morpho+sky+uniswap": {
    instructions: 8_700,
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
