import { describe, expect, it } from "bun:test";
import { fakeArtifactStore } from "./fake-r2.js";
import worker from "../src/index.js";
import type { Env } from "../src/core.js";
import { publicToolCatalog } from "../src/server.js";
import {
  chargeForMcpBody,
  MAX_BATCH_LENGTH,
  MAX_MCP_BODY_BYTES,
  MAX_UNITS_PER_REQUEST,
  rateLimitActor,
  toolCost,
} from "../src/rate-limit.js";

const context = {} as unknown as ExecutionContext;

const baseEnv = {
  ARTIFACT_STORE: fakeArtifactStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "zero-x-test-key",
  ACROSS_API_KEY: "across-test-key",
  ACROSS_INTEGRATOR_ID: "test-integrator",
  LAYER_ZERO_API_KEY: "unused",
  DUNE_API_KEY: "recommendation-test-key",
} satisfies Env;

/**
 * A counting stand-in for the Cloudflare binding. It records every draw per
 * key, which is how the weighted tests assert that an expensive tool spent
 * more of the budget than a cheap one rather than merely that it was allowed.
 */
function fakeLimiter(limit: number) {
  const draws = new Map<string, number>();
  return {
    drawsFor: (key: string) => draws.get(key) ?? 0,
    binding: {
      async limit({ key }: { key: string }) {
        const next = (draws.get(key) ?? 0) + 1;
        draws.set(key, next);
        return { success: next <= limit };
      },
    } satisfies RateLimit,
  };
}

const failingLimiter: RateLimit = {
  async limit() {
    throw new Error("rate limiter namespace unavailable");
  },
};

function post(body: unknown, ip = "203.0.113.7") {
  return new Request("https://mcp.ekubo.org/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "cf-connecting-ip": ip,
    },
    body: JSON.stringify(body),
  });
}

function toolCall(name: string, id: string | number = 1) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } };
}

describe("rate limit actor", () => {
  it("keys IPv4 callers by address", () => {
    expect(
      rateLimitActor(
        new Request("https://mcp.ekubo.org/", {
          headers: { "cf-connecting-ip": "203.0.113.7" },
        }),
      ),
    ).toBe("203.0.113.7");
  });

  it("keys IPv6 callers by /64 so one allocation is one caller", () => {
    const prefix = "2001:db8:abcd:1::/64";
    for (const address of [
      "2001:db8:abcd:0001:0000:0000:0000:0001",
      "2001:0db8:abcd:1::9999",
      "2001:db8:abcd:1:ffff:ffff:ffff:ffff",
    ]) {
      expect(
        rateLimitActor(
          new Request("https://mcp.ekubo.org/", {
            headers: { "cf-connecting-ip": address },
          }),
        ),
      ).toBe(prefix);
    }
  });

  it("separates distinct IPv6 /64s", () => {
    const key = (address: string) =>
      rateLimitActor(
        new Request("https://mcp.ekubo.org/", {
          headers: { "cf-connecting-ip": address },
        }),
      );
    expect(key("2001:db8:abcd:1::1")).not.toBe(key("2001:db8:abcd:2::1"));
  });

  it("ignores a client-supplied forwarding header", () => {
    expect(
      rateLimitActor(
        new Request("https://mcp.ekubo.org/", {
          headers: {
            "cf-connecting-ip": "203.0.113.7",
            "x-forwarded-for": "198.51.100.1",
          },
        }),
      ),
    ).toBe("203.0.113.7");
  });

  it("buckets a request with no connecting IP into one shared key", () => {
    expect(rateLimitActor(new Request("https://mcp.ekubo.org/"))).toBe(
      "anonymous",
    );
  });
});

describe("tool cost", () => {
  it("charges nothing for tools that only compute locally", () => {
    expect(toolCost("derive_pool_id")).toBe(0);
    expect(toolCost("decode_pool_config")).toBe(0);
  });

  it("charges a metered provider call far above an ordinary read", () => {
    expect(toolCost("get_quotes_with_plans")).toBeGreaterThan(
      toolCost("get_token") * 5,
    );
    expect(
      toolCost("get_stonx_allocation_recommendation"),
    ).toBeGreaterThan(toolCost("get_quotes_with_plans"));
  });

  it("charges a bulk read above a single read", () => {
    expect(toolCost("get_tokens")).toBeGreaterThan(
      toolCost("get_token"),
    );
    expect(toolCost("export_tokens")).toBeGreaterThan(
      toolCost("list_tokens"),
    );
  });

  it("never prices an unlisted tool at zero", () => {
    expect(toolCost("prepare_something_added_later")).toBeGreaterThan(0);
    expect(toolCost("get_something_added_later")).toBeGreaterThan(0);
    expect(toolCost("")).toBeGreaterThan(0);
  });

  it("prices every catalog tool below the per-request ceiling", () => {
    // The ceiling refuses rather than clamps, so a tool priced at or above it
    // would be a tool nobody can call. This is the guard on that.
    const overCeiling = publicToolCatalog
      .map((tool) => ({ name: tool.name, cost: toolCost(tool.name) }))
      .filter((tool) => tool.cost > MAX_UNITS_PER_REQUEST);
    expect(overCeiling).toEqual([]);
  });
});

describe("pricing an MCP body", () => {
  it("charges nothing for session and discovery traffic", () => {
    for (const method of ["initialize", "tools/list", "resources/list"]) {
      const priced = chargeForMcpBody(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
      );
      expect(priced).toEqual({
        ok: true,
        charge: { units: 0, meteredCalls: 0 },
        id: 1,
      });
    }
  });

  it("counts a metered tool against both budgets", () => {
    const priced = chargeForMcpBody(
      JSON.stringify(toolCall("get_quotes_with_plans")),
    );
    expect(priced).toEqual({
      ok: true,
      charge: {
        units: toolCost("get_quotes_with_plans"),
        meteredCalls: 1,
      },
      id: 1,
    });
  });

  it("sums a batch rather than pricing it as one call", () => {
    const priced = chargeForMcpBody(
      JSON.stringify([
        toolCall("get_token", 1),
        toolCall("get_token", 2),
        toolCall("get_quotes_with_plans", 3),
      ]),
    );
    expect(priced).toEqual({
      ok: true,
      charge: {
        units: toolCost("get_token") * 2 + toolCost("get_quotes_with_plans"),
        meteredCalls: 1,
      },
      // No single id owns the answer to a batch.
      id: null,
    });
  });

  it("refuses a batch longer than the cap", () => {
    const batch = Array.from({ length: MAX_BATCH_LENGTH + 1 }, (_, index) =>
      toolCall("get_token", index),
    );
    expect(chargeForMcpBody(JSON.stringify(batch))).toEqual({
      ok: false,
      reason: "too_many_calls",
    });
  });

  it("refuses a short batch that is expensive rather than under-charging it", () => {
    const expensive = "get_stonx_allocation_recommendation";
    const perCall = toolCost(expensive);
    const count = Math.floor(MAX_UNITS_PER_REQUEST / perCall) + 1;
    expect(count).toBeLessThanOrEqual(MAX_BATCH_LENGTH);

    const batch = Array.from({ length: count }, (_, index) =>
      toolCall(expensive, index),
    );
    expect(chargeForMcpBody(JSON.stringify(batch))).toEqual({
      ok: false,
      reason: "too_expensive",
    });

    // One under the ceiling still prices, and prices at full cost.
    const affordable = Array.from({ length: count - 1 }, (_, index) =>
      toolCall(expensive, index),
    );
    expect(chargeForMcpBody(JSON.stringify(affordable))).toMatchObject({
      ok: true,
      charge: { units: perCall * (count - 1), meteredCalls: count - 1 },
    });
  });

  it("reports an unparseable body instead of guessing a price", () => {
    expect(chargeForMcpBody("{not json")).toEqual({
      ok: false,
      reason: "unparseable",
    });
  });
});

describe("Worker admission control", () => {
  it("serves normally when no limiter is bound", async () => {
    const response = await worker.fetch(
      new Request("https://mcp.ekubo.org/", {
        headers: { "cf-connecting-ip": "203.0.113.7" },
      }),
      baseEnv,
      context,
    );
    expect(response.status).toBe(200);
  });

  it("rejects a burst with the short window's Retry-After", async () => {
    const burst = fakeLimiter(2);
    const env = { ...baseEnv, RATE_LIMITER_BURST: burst.binding } satisfies Env;
    const request = () =>
      worker.fetch(
        new Request("https://mcp.ekubo.org/tools", {
          headers: { "cf-connecting-ip": "203.0.113.7" },
        }),
        env,
        context,
      );

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);

    const limited = await request();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("10");
    expect(limited.headers.get("cache-control")).toBe("no-store");
    const body = (await limited.json()) as {
      error: { code: string; scope: string; retry_after_seconds: number };
    };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.scope).toBe("burst");
    expect(body.error.retry_after_seconds).toBe(10);
  });

  it("limits every route, not only /mcp", async () => {
    const sustained = fakeLimiter(1);
    const env = { ...baseEnv, RATE_LIMITER: sustained.binding } satisfies Env;
    const paths = ["/", "/artifact/00000000-0000-4000-8000-000000000000"];

    const first = await worker.fetch(
      new Request(`https://mcp.ekubo.org${paths[0]}`, {
        headers: { "cf-connecting-ip": "203.0.113.7" },
      }),
      env,
      context,
    );
    expect(first.status).toBe(200);

    // A stored-artifact fetch costs an R2 read, so it draws from the same
    // per-caller budget the discovery route just spent.
    const second = await worker.fetch(
      new Request(`https://mcp.ekubo.org${paths[1]}`, {
        headers: { "cf-connecting-ip": "203.0.113.7" },
      }),
      env,
      context,
    );
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("60");
  });

  it("keeps separate callers on separate budgets", async () => {
    const sustained = fakeLimiter(1);
    const env = { ...baseEnv, RATE_LIMITER: sustained.binding } satisfies Env;
    const get = (ip: string) =>
      worker.fetch(
        new Request("https://mcp.ekubo.org/", {
          headers: { "cf-connecting-ip": ip },
        }),
        env,
        context,
      );

    expect((await get("203.0.113.7")).status).toBe(200);
    expect((await get("203.0.113.7")).status).toBe(429);
    expect((await get("198.51.100.4")).status).toBe(200);
  });

  it("does not limit CORS preflights", async () => {
    const burst = fakeLimiter(0);
    const env = { ...baseEnv, RATE_LIMITER_BURST: burst.binding } satisfies Env;
    const response = await worker.fetch(
      new Request("https://mcp.ekubo.org/.well-known/mcp.json", {
        method: "OPTIONS",
        headers: { "cf-connecting-ip": "203.0.113.7" },
      }),
      env,
      context,
    );
    expect(response.status).toBe(200);
    expect(burst.drawsFor("burst:203.0.113.7")).toBe(0);
  });

  it("spends units in proportion to what a tool costs", async () => {
    const tools = fakeLimiter(1_000);
    const env = { ...baseEnv, RATE_LIMITER_TOOLS: tools.binding } satisfies Env;

    await worker.fetch(post(toolCall("get_token")), env, context);
    const afterCheapCall = tools.drawsFor("tools:203.0.113.7");
    expect(afterCheapCall).toBe(toolCost("get_token"));

    await worker.fetch(
      post(toolCall("get_quotes_with_plans")),
      env,
      context,
    );
    expect(tools.drawsFor("tools:203.0.113.7")).toBe(
      afterCheapCall + toolCost("get_quotes_with_plans"),
    );
  });

  it("spends nothing from the tool budget on session traffic", async () => {
    const tools = fakeLimiter(1_000);
    const metered = fakeLimiter(1_000);
    const env = {
      ...baseEnv,
      RATE_LIMITER_TOOLS: tools.binding,
      RATE_LIMITER_METERED: metered.binding,
    } satisfies Env;

    await worker.fetch(
      post({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      env,
      context,
    );
    expect(tools.drawsFor("tools:203.0.113.7")).toBe(0);
    expect(metered.drawsFor("metered:203.0.113.7")).toBe(0);
  });

  it("answers an exhausted tool budget as a JSON-RPC error on that call", async () => {
    const tools = fakeLimiter(1);
    const env = { ...baseEnv, RATE_LIMITER_TOOLS: tools.binding } satisfies Env;

    const response = await worker.fetch(
      post(toolCall("get_tokens", "call-7")),
      env,
      context,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    const body = (await response.json()) as {
      jsonrpc: string;
      id: string;
      error: {
        code: number;
        data: { reason: string; scope: string; retry_after_seconds: number };
      };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe("call-7");
    expect(body.error.code).toBe(-32029);
    expect(body.error.data).toEqual({
      reason: "rate_limited",
      scope: "tool_units",
      retry_after_seconds: 60,
    });
  });

  it("guards paid providers with a budget cheap traffic cannot relax", async () => {
    const metered = fakeLimiter(1);
    const env = {
      ...baseEnv,
      // Deliberately generous, so only the metered budget can reject.
      RATE_LIMITER_TOOLS: fakeLimiter(10_000).binding,
      RATE_LIMITER_METERED: metered.binding,
    } satisfies Env;
    const quote = () =>
      worker.fetch(post(toolCall("get_quotes_with_plans")), env, context);

    const first = await quote();
    expect(first.status).not.toBe(429);

    const second = await quote();
    expect(second.status).toBe(429);
    const body = (await second.json()) as {
      error: { data: { scope: string } };
    };
    expect(body.error.data.scope).toBe("metered_providers");

    // Unlimited cheap calls must not restore the paid-provider headroom.
    for (let index = 0; index < 5; index += 1) {
      await worker.fetch(post(toolCall("derive_pool_id")), env, context);
    }
    expect((await quote()).status).toBe(429);
  });

  it("admits the request when a limiter is broken", async () => {
    const env = {
      ...baseEnv,
      RATE_LIMITER: failingLimiter,
      RATE_LIMITER_BURST: failingLimiter,
      RATE_LIMITER_TOOLS: failingLimiter,
      RATE_LIMITER_METERED: failingLimiter,
    } satisfies Env;

    const discovery = await worker.fetch(
      new Request("https://mcp.ekubo.org/", {
        headers: { "cf-connecting-ip": "203.0.113.7" },
      }),
      env,
      context,
    );
    expect(discovery.status).toBe(200);

    const call = await worker.fetch(
      post(toolCall("get_quotes_with_plans")),
      env,
      context,
    );
    expect(call.status).not.toBe(429);
  });

  it("refuses an oversized body before pricing it", async () => {
    const env = { ...baseEnv, RATE_LIMITER_TOOLS: fakeLimiter(0).binding };
    const padding = "x".repeat(MAX_MCP_BODY_BYTES + 1);
    const response = await worker.fetch(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_tokens", arguments: { padding } },
      }),
      env,
      context,
    );
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("request_too_large");
  });

  it("refuses a batch longer than the cap", async () => {
    const response = await worker.fetch(
      post(
        Array.from({ length: MAX_BATCH_LENGTH + 1 }, (_, index) =>
          toolCall("get_token", index),
        ),
      ),
      baseEnv,
      context,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("batch_too_large");
  });

  it("refuses an over-ceiling batch instead of serving it under-charged", async () => {
    const tools = fakeLimiter(1_000);
    const env = { ...baseEnv, RATE_LIMITER_TOOLS: tools.binding } satisfies Env;
    const expensive = "get_stonx_allocation_recommendation";
    const count =
      Math.floor(MAX_UNITS_PER_REQUEST / toolCost(expensive)) + 1;

    const response = await worker.fetch(
      post(Array.from({ length: count }, (_, index) => toolCall(expensive, index))),
      env,
      context,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("batch_too_expensive");
    // Refused before pricing touched the budget, and never dispatched.
    expect(tools.drawsFor("tools:203.0.113.7")).toBe(0);
  });

  it("hands the priced bytes to the MCP handler unchanged", async () => {
    const response = await worker.fetch(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      }),
      baseEnv,
      context,
    );
    expect(response.status).toBe(200);
    const payload = await response.text();
    // Whether the handler answers as JSON or as an SSE frame, the initialize
    // result is in there — which it could not be if the replayed request had
    // arrived with an empty or truncated body.
    expect(payload).toContain("serverInfo");
    expect(payload).toContain("ekubo");
  });
});
