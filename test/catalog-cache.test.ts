import { describe, expect, it } from "bun:test";
import worker from "../src/index.js";
import { compactTool } from "../src/mcp-catalog.js";
import { PROTOCOLS, protocolMcpPath } from "../src/protocols.js";
import {
  getPoolSchema,
  listTokensSchema,
  prepareSwapSchema,
  toolOutputSchema,
} from "../src/server.js";
import { fakeArtifactStore } from "./fake-r2.js";

// tools/list converts each zod schema once per isolate (EKU-1160). The cache
// must be invisible: every endpoint, origin and interleaving publishes what a
// fresh conversion would, and request handling stays per request.

const unused = {
  ZERO_X_API_KEY: "unused",
  ACROSS_API_KEY: "unused",
  ACROSS_INTEGRATOR_ID: "unused",
  LAYER_ZERO_API_KEY: "unused",
  LI_FI_API_KEY: "unused",
  DUNE_API_KEY: "unused",
};
const deployments = [
  {
    host: "https://mcp.ekubo.org",
    origin: "https://client-a.test",
    env: {
      ...unused,
      ARTIFACT_STORE: fakeArtifactStore(),
      EKUBO_API_URL: "https://api-a.test",
      EKUBO_QUOTER_URL: "https://quoter-a.test",
      ALLOWED_ORIGINS: "https://client-a.test",
    },
  },
  {
    host: "https://mcp-staging.test",
    origin: "https://client-b.test",
    env: {
      ...unused,
      ARTIFACT_STORE: fakeArtifactStore(),
      EKUBO_API_URL: "https://api-b.test",
      EKUBO_QUOTER_URL: "https://quoter-b.test",
      ALLOWED_ORIGINS: "https://client-b.test",
      ALLOWED_HOSTNAMES: "mcp-staging.test",
    },
  },
];
type Deployment = (typeof deployments)[number];
const context = {} as ExecutionContext;
const ENDPOINTS = [
  "/mcp",
  ...PROTOCOLS.map((protocol) => protocolMcpPath(protocol.slug)),
  "/mcp?protocols=ekubo+ekubo-advanced",
  "/mcp?protocols=ekubo+aave+aerodrome+lido+merkl+morpho+sky+uniswap",
];

async function post(deployment: Deployment, path: string, body: unknown) {
  const response = await worker.fetch(
    new Request(`${deployment.host}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        origin: deployment.origin,
        host: new URL(deployment.host).host,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    deployment.env,
    context,
  );
  return { status: response.status, text: await response.text() };
}

function messages(text: string): { id?: unknown; result?: { tools?: { name: string }[] }; error?: unknown }[] {
  const data = text.startsWith("{") || text.startsWith("[")
    ? text
    : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).join(",");
  const parsed = JSON.parse(text.startsWith("[") || text.startsWith("{") ? data : `[${data}]`);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function toolsList(deployment: Deployment, path: string, id: number | string = 1) {
  const { status, text } = await post(deployment, path, { jsonrpc: "2.0", id, method: "tools/list" });
  expect(status).toBe(200);
  return messages(text)[0]!;
}

describe("tools/list schema cache", () => {
  it("reuses one frozen conversion per schema, equal to a fresh conversion", () => {
    for (const [name, inputSchema, outputSchema] of [
      ["list_tokens", listTokensSchema, undefined],
      ["get_pool", getPoolSchema, toolOutputSchema("get_pool")],
      ["prepare_swap", prepareSwapSchema, toolOutputSchema("prepare_swap")],
    ] as const) {
      const first = compactTool(name, { inputSchema, outputSchema });
      const again = compactTool(name, { inputSchema, outputSchema });
      expect(again.inputSchema).toBe(first.inputSchema);
      expect(Object.isFrozen(first.inputSchema)).toBe(true);
      // A clone is a distinct object, so it is converted afresh.
      const fresh = compactTool(name, {
        inputSchema: inputSchema.clone(),
        outputSchema: outputSchema?.clone(),
      });
      expect(fresh.inputSchema).not.toBe(first.inputSchema);
      expect(JSON.stringify(fresh)).toBe(JSON.stringify(first));
    }
  });

  it("publishes the same catalog for every endpoint across deployments and repeats", async () => {
    const full = (await toolsList(deployments[0]!, "/mcp")).result!.tools!;
    expect(full.some((tool) => tool.name.startsWith("prepare_safe_"))).toBe(false);
    for (const path of ENDPOINTS) {
      const seen = new Set<string>();
      for (const deployment of [...deployments, ...deployments]) {
        seen.add(JSON.stringify((await toolsList(deployment, path)).result));
      }
      expect(seen.size).toBe(1);
      if (path === "/mcp/safe") continue;
      for (const tool of JSON.parse([...seen][0]!).tools as { name: string }[]) {
        expect(tool).toEqual(full.find((entry) => entry.name === tool.name)!);
      }
    }
  });

  it("answers interleaved concurrent requests per request", async () => {
    const jobs = deployments.flatMap((deployment, d) =>
      ENDPOINTS.flatMap((path, p) => [
        { deployment, path, id: `list-${d}-${p}`, body: { jsonrpc: "2.0", id: `list-${d}-${p}`, method: "tools/list" } },
        { deployment, path, id: null, body: { jsonrpc: "2.0", method: "notifications/initialized" } },
        { deployment, path, id: d * 100 + p, body: { jsonrpc: "2.0", id: d * 100 + p, method: "ping" } },
      ]),
    );
    const sequential: string[] = [];
    for (const job of jobs) sequential.push(JSON.stringify(await post(job.deployment, job.path, job.body)));
    const results = await Promise.all(jobs.map((job) => post(job.deployment, job.path, job.body)));
    results.forEach((result, index) => {
      const job = jobs[index]!;
      expect(JSON.stringify(result)).toBe(sequential[index]!);
      if (job.id === null) {
        expect(result.status).toBe(202);
        expect(result.text).toBe("");
      } else {
        expect(messages(result.text)[0]!.id).toBe(job.id);
      }
    });
  });

  it("keeps notification, malformed-message and batch semantics", async () => {
    const deployment = deployments[1]!;
    const notification = await post(deployment, "/mcp/lido", { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notification.status).toBe(202);
    expect((await post(deployment, "/mcp/lido", { method: "notifications/initialized" })).status).toBe(400);
    expect((await post(deployment, "/mcp/lido", { jsonrpc: "2.0", method: 7 })).status).toBe(400);
    expect((await post(deployment, "/mcp/lido", "{\"jsonrpc\":\"2.0\",")).status).toBe(400);
    const batch = await post(deployment, "/mcp/lido", [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 41, method: "tools/list" },
    ]);
    expect(batch.status).toBe(200);
    const replies = messages(batch.text);
    expect(replies.map((reply) => reply.id)).toEqual([41]);
    expect(replies[0]!.result!.tools!.map((tool) => tool.name)).toEqual(
      (await toolsList(deployment, "/mcp/lido")).result!.tools!.map((tool) => tool.name),
    );
  });
});
