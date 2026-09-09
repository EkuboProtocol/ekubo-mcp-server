import { describe, expect, it, spyOn } from "bun:test";
import worker from "../src/index.js";
import { publicToolCatalog } from "../src/server.js";
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

async function rpc(method: string, params: Record<string, unknown> = {}, path = "/mcp", modern = true) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": modern ? "2026-07-28" : "2025-11-25",
    "mcp-method": method,
    origin: "https://client.test",
  };
  const name = params.name ?? params.uri;
  if (typeof name === "string") headers["mcp-name"] = name;
  const response = await worker.fetch(new Request(`https://mcp.ekubo.org${path}`, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params: {
      ...params,
      ...(modern ? { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      } } : {}),
    } }),
  }), env, context);
  const text = await response.text();
  const data = text.startsWith("{") ? text : text.split("\n").find(line => line.startsWith("data:"))!.slice(5);
  return { response, body: JSON.parse(data) };
}

describe("MCP 2026-07-28", () => {
  it("allows modern routing headers from an allowed browser origin on every endpoint", async () => {
    for (const path of ["/mcp", "/mcp/ekubo", "/mcp/lido"]) {
      const response = await worker.fetch(new Request(`https://mcp.ekubo.org${path}`, {
        method: "OPTIONS", headers: {
          origin: "https://client.test",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,mcp-protocol-version,mcp-method,mcp-name",
        },
      }), env, context);
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("https://client.test");
      const allowed = response.headers.get("access-control-allow-headers")!.split(/,\s*/);
      for (const header of ["content-type", "mcp-protocol-version", "mcp-method", "mcp-name"]) {
        expect(allowed).toContain(header);
      }
    }
  });

  it("serves bounded cacheable catalogs without initialization and retains endpoint scope", async () => {
    for (const method of ["server/discover", "tools/list", "resources/list", "resources/templates/list"]) {
      const { response, body } = await rpc(method);
      expect(response.status).toBe(200);
      expect(body.id).toBe(7);
      expect(body.result).toMatchObject({ resultType: "complete", ttlMs: 300_000, cacheScope: "public" });
      // Only result payloads are reusable, not request-specific RPC envelopes.
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const full = (await rpc("tools/list")).body.result.tools;
    expect(full.map((t: { name: string }) => t.name)).toEqual(
      (await rpc("tools/list")).body.result.tools.map((t: { name: string }) => t.name),
    );
    expect(full).toHaveLength(publicToolCatalog.length);
    for (const tool of full) expect(tool.outputSchema?.type).toBe("object");
    const lido = (await rpc("tools/list", {}, "/mcp/lido")).body.result.tools;
    expect(lido.length).toBeLessThan(full.length);
    expect(lido.every((t: { name: string }) => t.name.includes("lido"))).toBe(true);
  });

  it("caches bundled docs but keeps fetched documentation fresh and errors uncached", async () => {
    const docs = await rpc("resources/read", { uri: "ekubo://docs/agent-workflow" });
    expect(docs.body.result).toMatchObject({ ttlMs: 3_600_000, cacheScope: "public" });
    const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ openapi: "3.1.0" }));
    try {
      const external = await rpc("resources/read", { uri: "https://prod-api.ekubo.org/openapi.json" });
      expect(external.body.result).toMatchObject({ ttlMs: 0, cacheScope: "private" });
    } finally { fetcher.mockRestore(); }
    const missing = await rpc("resources/read", { uri: "ekubo://missing" });
    expect(missing.body.error.code).toBe(-32602);
    expect(missing.body.result).toBeUndefined();
  });

  it("preserves legacy result shapes", async () => {
    const { body } = await rpc("tools/list", {}, "/mcp", false);
    expect(body.result.tools).toHaveLength(publicToolCatalog.length);
    expect(body.result.ttlMs).toBeUndefined();
    expect(body.result.cacheScope).toBeUndefined();
    expect(body.result.resultType).toBeUndefined();
  });

  it("validates locally computed outputs without stripping fields", async () => {
    for (const name of ["get_aave_v3_markets", "get_morpho_vaults", "get_sky_savings_deployment",
      "get_merkl_deployment", "get_aerodrome_deployment", "get_lido_deployment", "get_uniswap_deployments",
      "decode_uniswap_v4_position_info"]) {
      const args = name === "decode_uniswap_v4_position_info" ? { info: "0" } : {};
      const { body } = await rpc("tools/call", { name, arguments: args });
      expect(body.error).toBeUndefined();
      expect(body.result.isError).not.toBe(true);
      expect(body.result.structuredContent).toBeDefined();
      expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent);
    }
  });
});
