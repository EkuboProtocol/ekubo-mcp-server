import { describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import worker from "../src/index.js";
import { fakeArtifactStore } from "./fake-r2.js";

const versions = ["2025-03-26", "2025-11-25", "2026-07-28"];
const verifiedContext = Symbol.for("cloudflare.workers-oauth-provider.verified-context.v1");
const env = {
  ARTIFACT_STORE: fakeArtifactStore(), EKUBO_API_URL: "https://api.test", EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused", ACROSS_API_KEY: "unused", ACROSS_INTEGRATOR_ID: "unused",
  LAYER_ZERO_API_KEY: "unused", LI_FI_API_KEY: "unused", DUNE_API_KEY: "unused",
  ALLOWED_HOSTNAMES: "mcp.ekubo.org", ALLOWED_ORIGINS: "https://client.test",
};

function request(version: string, id: string, method: string, params: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request("https://mcp.ekubo.org/mcp", {
    method: "POST", headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": version, "mcp-method": method,
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
      host: "mcp.ekubo.org", ...headers,
    }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params: {
      ...params, ...(version === "2026-07-28" ? { _meta: {
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientCapabilities": {},
      } } : {}),
    } }),
  });
}

async function reply(response: Response) {
  const text = await response.text();
  return JSON.parse(text.startsWith("{") ? text : text.split("\n").find(line => line.startsWith("data:"))!.slice(5));
}

function context(clientId: string) {
  const props = { client: clientId };
  return { props, [verifiedContext]: {
    version: 1, token: `synthetic-${clientId}`, clientId, scopes: ["read"], props,
    resource: "https://mcp.ekubo.org/mcp",
  } } as unknown as ExecutionContext;
}

// Exercise actual async auth propagation, which a public tools/list-only check
// cannot observe. No production OAuth mode or authenticated endpoint is enabled.
function authProbe() {
  let arrivals = 0;
  let release!: () => void;
  const overlap = new Promise<void>(resolve => { release = resolve; });
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "auth-compatibility-fixture", version: "1" });
    server.registerTool("identity", { inputSchema: z.object({ marker: z.string() }) }, async ({ marker }, extra) => {
      const before = getMcpAuthContext()?.props ?? null;
      arrivals += 1;
      if (arrivals === 3) release();
      await overlap;
      const data = { marker, before, after: getMcpAuthContext()?.props ?? null, clientId: extra.http?.authInfo?.clientId ?? null };
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    });
    return server;
  }, { allowedHostnames: ["mcp.ekubo.org"] });
  return { handler, arrivals: () => arrivals };
}

describe("Agents transport and auth compatibility", () => {
  for (const version of versions) {
    it(`${version} recovers after cancelling a response and rejects session methods`, async () => {
      const response = await worker.fetch(request(version, "cancel", "tools/list", {}), env, {} as ExecutionContext);
      expect(response.status).toBe(200);
      await response.body!.cancel("synthetic disconnected client");
      for (const method of ["GET", "DELETE"]) {
        const unsupported = await worker.fetch(new Request("https://mcp.ekubo.org/mcp", {
          method, headers: { host: "mcp.ekubo.org", "mcp-protocol-version": version, "mcp-session-id": "synthetic-stale" },
        }), env, {} as ExecutionContext);
        expect(unsupported.status).toBe(405);
        expect(unsupported.headers.get("mcp-session-id")).toBeNull();
        await unsupported.text();
      }
      const recovered = await worker.fetch(request(version, "recovered", "tools/call", {
        name: "decode_pool_config", arguments: {
          config: "0x000000000000000000000000000000000000000000000000000000008000003c",
        },
      }), env, {} as ExecutionContext);
      expect(recovered.status).toBe(200);
      const body = await reply(recovered);
      expect(body.id).toBe("recovered");
      expect(body.result.structuredContent.decoded_config.tick_spacing).toBe(60);
      expect(recovered.headers.get("mcp-session-id")).toBeNull();
    });

    it(`${version} preserves host/origin rejection with an admitted positive control`, async () => {
      const invoke = (headers: Record<string, string>) => worker.fetch(request(version, "policy", "tools/list", {}, headers), env, {} as ExecutionContext);
      const admitted = await invoke({ origin: "https://client.test" });
      expect(admitted.status).toBe(200);
      expect((await reply(admitted)).result.tools.length).toBeGreaterThan(0);
      expect((await invoke({ host: "evil.test", origin: "https://client.test" })).status).toBe(403);
      expect((await invoke({ origin: "https://evil.test" })).status).toBe(403);
    });

    it(`${version} ignores forged auth/session headers and keeps stateless replies`, async () => {
      const invoke = (headers: Record<string, string>) => worker.fetch(request(version, "public", "tools/list", {}, headers), env, {} as ExecutionContext);
      const plain = await invoke({});
      const forged = await invoke({ authorization: "Bearer synthetic-untrusted", "x-auth-info": '{"clientId":"forged"}', "mcp-session-id": "forged-session" });
      expect(forged.status).toBe(200);
      expect(forged.headers.get("mcp-session-id")).toBeNull();
      expect(forged.headers.get("cache-control")).toBe("no-store");
      expect(await reply(forged)).toEqual(await reply(plain));
    });

    it(`${version} keeps verified contexts isolated across overlapping calls and stream reads`, async () => {
      const probe = authProbe();
      const responses = await Promise.all(["alice", "bob", "anonymous"].map(async (marker) => {
        const req = request(version, marker, "tools/call", { name: "identity", arguments: { marker } }, {
          authorization: "Bearer synthetic-forged", "x-auth-info": '{"clientId":"forged"}',
        });
        const ctx = marker === "anonymous" ? {} as ExecutionContext : context(marker);
        const response = await probe.handler(req, {}, ctx);
        expect(response.status).toBe(200);
        expect(response.headers.get("mcp-session-id")).toBeNull();
        const body = await reply(response);
        expect(body.id).toBe(marker);
        const props = marker === "anonymous" ? null : { client: marker };
        expect(JSON.parse(body.result.content[0].text)).toEqual({ marker, before: props, after: props, clientId: marker === "anonymous" ? null : marker });
        return response.headers.get("content-type");
      }));
      expect(probe.arrivals()).toBe(3);
      if (version !== "2026-07-28") expect(responses.every(type => type?.includes("text/event-stream"))).toBe(true);
    });

    it(`${version} rejects a malformed verified context before tool execution`, async () => {
      const probe = authProbe();
      const ctx = { [verifiedContext]: { version: 1, token: "synthetic-secret" } } as unknown as ExecutionContext;
      const response = await probe.handler(request(version, "invalid", "tools/call", { name: "identity", arguments: { marker: "bad" } }), {}, ctx);
      expect(response.status).toBe(500);
      expect((await reply(response)).error).toEqual({ code: -32603, message: "Internal server error" });
      expect(probe.arrivals()).toBe(0);
    });
  }
});
