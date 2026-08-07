import { describe, expect, it } from "bun:test";
import { keccak256, stringToHex } from "viem";
import { fakeArtifactStore } from "./fake-r2.js";
import worker from "../src/index.js";

const env = {
  ARTIFACT_STORE: fakeArtifactStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "zero-x-test-key",
  ACROSS_API_KEY: "across-test-key",
  ACROSS_INTEGRATOR_ID: "test-integrator",
  DUNE_API_KEY: "recommendation-test-key",
  ALLOWED_ORIGINS: "https://mcp.ekubo.org",
};
const context = {} as unknown as ExecutionContext;

const headers = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  origin: "https://mcp.ekubo.org",
  "mcp-protocol-version": "2025-11-25",
};

/**
 * A canonical-shaped response: the five fields a wallet acts on, buried in the
 * display metadata that makes the real list 483 KB, plus the Starknet row
 * whose chain ID does not survive a round trip through a JSON number.
 */
const upstreamTokens = [
  {
    chain_id: "0x1",
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
    address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    sort_order: 6,
    visibility_priority: 3,
    logo_url: "https://imagedelivery.net/example/logo",
    total_supply: 71781369987.4076,
    usd_price: 1.0000001373549674,
    bridgeInfos: { "10": { bridge_address: "0x0b2c639c533813f4aa9d7837" } },
  },
  {
    chain_id: "0x534e5f4d41494e",
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
    address:
      "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb",
    sort_order: 8,
    visibility_priority: 3,
    logo_url: "https://imagedelivery.net/example/logo",
    total_supply: 1,
    usd_price: 1,
    bridgeInfos: null,
  },
];

async function withStubbedUpstream<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.test/tokens")) {
      return new Response(JSON.stringify(upstreamTokens), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected upstream request: ${url}`);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function callListTokens(args: Record<string, unknown>) {
  const response = await worker.fetch(
    new Request("https://mcp.ekubo.org/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ekubo_list_tokens", arguments: args },
      }),
    }),
    env as never,
    context,
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  // The endpoint may answer as SSE; take the last data frame either way.
  const payload = text.startsWith("event:")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .at(-1)!
    : text;
  return (JSON.parse(payload) as {
    result: { structuredContent: Record<string, unknown> };
  }).result.structuredContent;
}

describe("ekubo_list_tokens as_reference", () => {
  it("returns entries inline by default", async () => {
    const content = await withStubbedUpstream(() => callListTokens({}));
    expect(Array.isArray(content.tokens)).toBe(true);
    expect(content.token_list_reference).toBeUndefined();
  });

  it("stores a verifiable list the wallet can fetch itself", async () => {
    const content = await withStubbedUpstream(() =>
      callListTokens({ as_reference: true }),
    );

    const reference = content.token_list_reference as {
      kind: string;
      artifact_type: string;
      url: string;
      integrity: { algorithm: string; value: `0x${string}` };
      bytes: number;
      instruction: string;
    };
    expect(reference.kind).toBe("artifact_reference");
    expect(reference.artifact_type).toBe("token_list");
    expect(content.tokens).toBeUndefined();
    expect(content.tokens_referenced).toBe(2);

    // The wallet's side of the handoff: fetch the URL, recompute the digest
    // and the byte count, and refuse anything that disagrees.
    const fetched = await worker.fetch(
      new Request(reference.url),
      env as never,
      context,
    );
    expect(fetched.status).toBe(200);
    const body = await fetched.text();
    expect(keccak256(stringToHex(body))).toBe(reference.integrity.value);
    expect(new TextEncoder().encode(body).length).toBe(reference.bytes);

    const list = JSON.parse(body) as {
      name: string;
      tokens: Record<string, unknown>[];
    };
    expect(list.name).toContain("Ekubo");
    expect(list.tokens[0]).toEqual({
      chain_id: "1",
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
    });
    // Display metadata is the bulk of the canonical list and none of it is
    // something a wallet acts on, so the stored body must not carry it.
    for (const dropped of [
      "logo_url",
      "usd_price",
      "total_supply",
      "bridgeInfos",
      "visibility_priority",
    ]) {
      expect(list.tokens[0][dropped]).toBeUndefined();
    }
    // The Starknet chain ID survives exactly; as a JSON number it would not.
    expect(list.tokens[1].chain_id).toBe("23448594291968334");
    expect(Number(list.tokens[1].chain_id as string)).toBeGreaterThan(
      Number.MAX_SAFE_INTEGER,
    );
  });
});
