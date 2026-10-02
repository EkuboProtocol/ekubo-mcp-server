import { describe, expect, it } from "bun:test";
import worker from "../../src/index.js";
import { fakeArtifactStore } from "../fake-r2.js";
import { E18, TOKEN, fixtureEnv, standardLaunch } from "./helpers.js";

const PREPARE_TOOLS = ["launchpad_prepare_create", "launchpad_prepare_trade", "launchpad_prepare_advance"];
const LAUNCHPAD_TOOLS = ["launchpad_search", "launchpad_get_launch", "launchpad_get_provenance", "launchpad_get_analytics"];

function env(extra: Record<string, string> = {}) {
  return {
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
    ...extra,
  } as never;
}

const context = {} as ExecutionContext;

async function rpc(path: string, method: string, params: Record<string, unknown>, workerEnv: unknown) {
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
    workerEnv as never,
    context,
  );
  const text = await response.text();
  const data = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5);
  return JSON.parse(data);
}

describe("launchpad endpoint", () => {
  it("serves the four analytics tools and three preparation tools only at /mcp/launchpad", async () => {
    const scoped = await rpc("/mcp/launchpad", "tools/list", {}, env());
    expect(scoped.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([...LAUNCHPAD_TOOLS, ...PREPARE_TOOLS].sort());
    const bundled = await rpc("/mcp", "tools/list", {}, env());
    const names = bundled.result.tools.map((t: { name: string }) => t.name);
    for (const tool of [...LAUNCHPAD_TOOLS, ...PREPARE_TOOLS]) expect(names).not.toContain(tool);
  });

  it("answers a tool call from the configured fixture", async () => {
    const { chain } = standardLaunch();
    const reply = await rpc(
      "/mcp/launchpad",
      "tools/call",
      { name: "launchpad_get_launch", arguments: { chain_id: 31337, token: TOKEN } },
      env(fixtureEnv(chain.bundle()) as Record<string, string>),
    );
    expect(reply.result.structuredContent.as_of.block_number).toBe(chain.head.number);
    expect(reply.result.structuredContent.launch.phase).toBe("active");
  });

  it("returns a structured error when the launchpad is not configured", async () => {
    const reply = await rpc("/mcp/launchpad", "tools/call", { name: "launchpad_search", arguments: { chain_id: 31337 } }, env());
    expect(reply.result.isError).toBe(true);
    expect(reply.result.structuredContent.error.code).toBe("launchpad_not_configured");
  });
});

describe("GET /launchpad/stats", () => {
  it("returns tokens created and rolling volume with scope and freshness", async () => {
    const { chain } = standardLaunch();
    const response = await worker.fetch(
      new Request("https://mcp.ekubo.org/launchpad/stats"),
      env(fixtureEnv(chain.bundle()) as Record<string, string>),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      tokens_created: { value: 1, method: "count of LaunchCreated from the manifest's extension" },
      rolling_24h_volume: [{ quote_asset: "0x0000000000000000000000000000000000000000", decimals: 18, user_volume: E18.toString() }],
      as_of: { block_number: chain.head.number, block_timestamp: chain.head.timestamp },
      source: { kind: "fixture", complete: true },
    });
    expect(typeof body.scope).toBe("string");
  });

  it("is unavailable, not zero, when unconfigured", async () => {
    const response = await worker.fetch(new Request("https://mcp.ekubo.org/launchpad/stats"), env(), context);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("launchpad_not_configured");
  });

  it("rejects writes", async () => {
    const response = await worker.fetch(new Request("https://mcp.ekubo.org/launchpad/stats", { method: "POST" }), env(), context);
    expect(response.status).toBe(405);
  });
});
