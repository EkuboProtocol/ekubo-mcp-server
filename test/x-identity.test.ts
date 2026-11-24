import { afterEach, describe, expect, it, spyOn } from "bun:test";
import worker from "../src/index.js";
import { fakeArtifactStore } from "./fake-r2.js";

const baseEnv = {
  ARTIFACT_STORE: fakeArtifactStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused",
  ACROSS_API_KEY: "unused",
  ACROSS_INTEGRATOR_ID: "unused",
  LAYER_ZERO_API_KEY: "unused",
  LI_FI_API_KEY: "unused",
};
const enabled = { ...baseEnv, EKUBO_IDENTITY_API_URL: "https://identity.test/" };
const context = {} as ExecutionContext;

type Json = Record<string, any>;

async function rpc(env: Json, path: string, method: string, params: Json = {}) {
  const response = await worker.fetch(
    new Request(`https://mcp.ekubo.org${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env as never,
    context,
  );
  const text = await response.text();
  const data = text.startsWith("{")
    ? text
    : text.split("\n").find((line) => line.startsWith("data:"))!.slice(5);
  return JSON.parse(data) as Json;
}

async function toolNames(env: Json, path: string) {
  const body = await rpc(env, path, "tools/list");
  return (body.result.tools as { name: string }[]).map((tool) => tool.name);
}

async function call(name: string, args: Json, env: Json = enabled) {
  const body = await rpc(env, "/mcp/ekubo", "tools/call", { name, arguments: args });
  expect(body.error).toBeUndefined();
  return body.result as { isError?: boolean; structuredContent: Json };
}

const X_TOOLS = ["start_x_link", "get_x_link", "complete_x_link", "lookup_x_identities"];
const LINK_ID = "a".repeat(43);
const ADDRESS = "0x7a16ff8270133f063aab6c9977183d9e72835428";
const TYPED_DATA = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
    ],
    LinkXAccount: [{ name: "statement", type: "string" }],
  },
  primaryType: "LinkXAccount",
  domain: { name: "ekubo.org", version: "1", chainId: 8453 },
  message: { statement: "Link this wallet to the X account @alice on ekubo.org." },
};

let requests: { url: string; method: string; body: string | null }[] = [];

function mockApi(routes: Record<string, () => Response>) {
  requests = [];
  spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    });
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!route) throw new Error(`Unexpected fetch ${url}`);
    return route[1]();
  }) as typeof fetch);
}

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("X link tools: catalog", () => {
  it("are not listed while EKUBO_IDENTITY_API_URL is unset", async () => {
    const names = await toolNames(baseEnv, "/mcp");
    for (const name of X_TOOLS) expect(names).not.toContain(name);
  });

  it("are listed on endpoints that serve ekubo once enabled, and nowhere else", async () => {
    for (const path of ["/mcp", "/mcp/ekubo", "/mcp?protocols=ekubo+uniswap"]) {
      const names = await toolNames(enabled, path);
      for (const name of X_TOOLS) expect(names).toContain(name);
    }
    const aave = await toolNames(enabled, "/mcp/aave");
    for (const name of X_TOOLS) expect(aave).not.toContain(name);
  });

  it("describe the person's part and mark the writes", async () => {
    const body = await rpc(enabled, "/mcp/ekubo", "tools/list");
    const tools = new Map(
      (body.result.tools as Json[]).map((tool) => [tool.name as string, tool]),
    );
    expect(tools.get("start_x_link")!.description).toContain("public");
    expect(tools.get("get_x_link")!.description).toContain("wallet_sign_typed_data");
    // Compact annotations omit defaults: absent readOnlyHint means not read-only.
    expect(tools.get("start_x_link")!.annotations?.readOnlyHint).not.toBe(true);
    expect(tools.get("complete_x_link")!.annotations?.readOnlyHint).not.toBe(true);
    expect(tools.get("lookup_x_identities")!.annotations?.readOnlyHint).toBe(true);
  });
});

describe("X link tools: calls", () => {
  it("start_x_link starts a link without a return page", async () => {
    mockApi({
      "https://identity.test/v1/identity/x/link/start": () =>
        Response.json({
          link_id: LINK_ID,
          authorization_url: "https://x.com/i/oauth2/authorize?state=s",
          expires_at: "2026-11-24T12:10:00.000Z",
        }),
    });
    const result = await call("start_x_link", { chain_id: "8453", address: ADDRESS });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.authorization_url).toStartWith("https://x.com/");
    expect(result.structuredContent.next).toContain("code");
    expect(requests[0]!.method).toBe("POST");
    expect(JSON.parse(requests[0]!.body!)).toEqual({ chain_id: "8453", address: ADDRESS });
  });

  it("get_x_link returns a Cloud Wallet signature request over the typed data, unchanged", async () => {
    mockApi({
      [`https://identity.test/v1/identity/x/link/${LINK_ID}?code=ABCDEFGHJK`]: () =>
        Response.json({
          link_id: LINK_ID,
          status: "awaiting_signature",
          chain_id: "8453",
          address: ADDRESS,
          expires_at: "2026-11-24T12:10:00.000Z",
          x_user_id: "1",
          x_handle: "alice",
          typed_data: TYPED_DATA,
        }),
    });
    const result = await call("get_x_link", { link_id: LINK_ID, code: "ABCDEFGHJK" });
    const request = result.structuredContent.signature_request;
    expect(request).toEqual({
      schema_version: "1",
      kind: "typed_data_signature_request",
      signer: "0x7a16fF8270133F063aAb6C9977183D9e72835428",
      typed_data: TYPED_DATA,
      verification_chain_id: 8453,
      valid_until: String(Date.parse("2026-11-24T12:10:00.000Z") / 1000),
    });
    expect(result.structuredContent.next).toContain("wallet_sign_typed_data");
  });

  it("get_x_link before X approval says to wait for the code", async () => {
    mockApi({
      [`https://identity.test/v1/identity/x/link/${LINK_ID}`]: () =>
        Response.json({
          link_id: LINK_ID,
          status: "awaiting_x",
          chain_id: "8453",
          address: ADDRESS,
          expires_at: "2026-11-24T12:10:00.000Z",
          x_user_id: null,
          x_handle: null,
          typed_data: null,
        }),
    });
    const result = await call("get_x_link", { link_id: LINK_ID });
    expect(result.structuredContent.signature_request).toBeNull();
    expect(result.structuredContent.next).toContain("not approved");
  });

  it("get_x_link on Starknet returns the SNIP-12 typed data and no EVM request", async () => {
    mockApi({
      [`https://identity.test/v1/identity/x/link/${LINK_ID}`]: () =>
        Response.json({
          link_id: LINK_ID,
          status: "awaiting_signature",
          chain_id: String(0x534e5f4d41494en),
          address: `0x${"1".repeat(64)}`,
          expires_at: "2026-11-24T12:10:00.000Z",
          x_user_id: "1",
          x_handle: "alice",
          typed_data: { ...TYPED_DATA, domain: { name: "ekubo.org", chainId: "SN_MAIN" } },
        }),
    });
    const result = await call("get_x_link", { link_id: LINK_ID, code: "ABCDEFGHJK" });
    expect(result.structuredContent.signature_request).toBeNull();
    expect(result.structuredContent.typed_data.domain.chainId).toBe("SN_MAIN");
    expect(result.structuredContent.next).toContain("Starknet");
  });

  it("complete_x_link posts the code and signature", async () => {
    mockApi({
      [`https://identity.test/v1/identity/x/link/${LINK_ID}/complete`]: () =>
        Response.json({
          chain_id: "8453",
          address: ADDRESS,
          identity: { x_handle: "alice", scope: "chain" },
        }),
    });
    const result = await call("complete_x_link", {
      link_id: LINK_ID,
      code: "ABCDEFGHJK",
      signature: "0x1234",
    });
    expect(result.structuredContent.identity.x_handle).toBe("alice");
    expect(JSON.parse(requests[0]!.body!)).toEqual({ code: "ABCDEFGHJK", signature: "0x1234" });
  });

  it("lookup_x_identities repeats address in the query", async () => {
    mockApi({
      "https://identity.test/v1/identity/addresses": () =>
        Response.json({ chain_id: "1", identities: { [ADDRESS]: null } }),
    });
    const result = await call("lookup_x_identities", {
      chain_id: "1",
      addresses: [ADDRESS, "0x0000000000000000000000000000000000000001"],
    });
    expect(result.structuredContent.identities[ADDRESS]).toBeNull();
    const url = new URL(requests[0]!.url);
    expect(url.searchParams.get("chainId")).toBe("1");
    expect(url.searchParams.getAll("address")).toHaveLength(2);
  });
});

describe("X link tools: errors", () => {
  it("maps API refusals to codes with recovery guidance", async () => {
    const cases: [number, string][] = [
      [401, "invalid_signature"],
      [403, "wrong_code"],
      [404, "link_not_found"],
      [409, "link_not_ready"],
      [429, "rate_limited"],
      [503, "unavailable"],
    ];
    for (const [status, code] of cases) {
      mockApi({
        "https://identity.test/": () =>
          Response.json({ status, error: `refused ${status}` }, { status }),
      });
      const result = await call("complete_x_link", {
        link_id: LINK_ID,
        code: "ABCDEFGHJK",
        signature: "0x1234",
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe(code);
      expect(result.structuredContent.error.message).toBe(`refused ${status}`);
      expect(result.structuredContent.error.details.retry).toBeString();
      (globalThis.fetch as unknown as { mockRestore: () => void }).mockRestore();
    }
  });

  it("rejects malformed input before any upstream call", async () => {
    mockApi({});
    for (const [name, args] of [
      ["get_x_link", { link_id: "short" }],
      ["start_x_link", { chain_id: "base", address: ADDRESS }],
      ["lookup_x_identities", { chain_id: "1", addresses: [] }],
      ["complete_x_link", { link_id: LINK_ID, code: "ABCDEFGHJK", signature: "nothex" }],
    ] as const) {
      const body = await rpc(enabled, "/mcp/ekubo", "tools/call", { name, arguments: args });
      const failed = body.error !== undefined || body.result?.isError === true;
      expect(failed).toBe(true);
    }
    expect(requests).toHaveLength(0);
  });

  it("reports an unreachable API as retryable without linking", async () => {
    spyOn(globalThis, "fetch").mockImplementation((async () => {
      const error = new Error("The operation timed out");
      error.name = "TimeoutError";
      throw error;
    }) as unknown as typeof fetch);
    const result = await call("lookup_x_identities", { chain_id: "1", addresses: [ADDRESS] });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe("upstream_timeout");
  });
});
