import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import worker from "../src/index.js";
import { compactSchema, labelPatterns } from "../src/mcp-catalog.js";
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
// resources/list): /mcp 72,327 -> 40,505; /mcp/ekubo 44,788 -> 23,963 with
// instructions 4,183 -> 896. Every Ekubo-scoped endpoint's instructions carry
// the CLO jurisdiction notice verbatim, about 480 of those tokens. The
// /mcp/ekubo tools budget was raised from 104,000 for the STONX
// emissions-efficiency KPI (EKU-950), which landed after it was set. Every
// non-Safe instructions budget was raised by 550 characters for the scope
// sentence (EKU-988): without it, agents read the handoff rules as a ban on
// the user's own cast/sncast work outside this server.
const ENDPOINTS: Record<string, Budget> = {
  "/mcp": { instructions: 7_950, tools: 170_000, tool: 11_200, resources: 4_200 },
  "/mcp/ekubo": { instructions: 4_950, tools: 105_000, tool: 11_200, resources: 1_900 },
  "/mcp/aave": { instructions: 4_750, tools: 9_100, tool: 1_600, resources: 300 },
  "/mcp/aerodrome": { instructions: 5_450, tools: 18_400, tool: 2_600, resources: 850 },
  "/mcp/lido": { instructions: 4_750, tools: 5_700, tool: 1_300, resources: 750 },
  "/mcp/merkl": { instructions: 5_250, tools: 3_400, tool: 2_200, resources: 750 },
  "/mcp/morpho": { instructions: 4_750, tools: 5_600, tool: 1_900, resources: 750 },
  "/mcp/sky": { instructions: 4_750, tools: 4_100, tool: 1_100, resources: 750 },
  "/mcp/uniswap": { instructions: 4_250, tools: 21_500, tool: 2_100, resources: 300 },
  "/mcp/safe": { instructions: 1_400, tools: 12_100, tool: 2_600, resources: 300 },
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

  for (const [path, budget] of Object.entries(ENDPOINTS)) {
    it(`${path} stays within its budget`, async () => {
      const result = await measure(path);
      const dir = process.env.MCP_CONTEXT_DUMP;
      if (dir) {
        const slug = path.replaceAll("/", "_");
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
