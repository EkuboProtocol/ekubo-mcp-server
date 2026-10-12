// Acceptance checks for user-facing tool behaviour, driven through the real
// MCP boundary (worker.fetch -> tools/list, tools/call, /artifact/<id>) with
// every upstream mocked. They hold the contract an agent relies on: a tool can
// be chosen and filled from its published entry alone, results keep exact
// values and opaque references, and every failure says what to do next.
// AGENTS.md lists when a change must extend this file.
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { keccak256, stringToHex } from "viem";
import worker from "../src/index.js";
import { ARTIFACT_TTL_SECONDS } from "../src/artifact-store.js";
import { fakeArtifactStore } from "./fake-r2.js";

const store = fakeArtifactStore();
const env = {
  ARTIFACT_STORE: store,
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "zero-x-secret-for-redaction-test",
  ACROSS_API_KEY: "across-secret-for-redaction-test",
  ACROSS_INTEGRATOR_ID: "unused",
  LAYER_ZERO_API_KEY: "unused",
  LI_FI_API_KEY: "unused",
  DUNE_API_KEY: "unused",
  ALLOWED_ORIGINS: "https://client.test",
};
const context = {} as ExecutionContext;

const OWNER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NATIVE = "0x0000000000000000000000000000000000000000";
const UINT256_MAX =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";

type Json = Record<string, any>;
type Tool = {
  name: string;
  description: string;
  inputSchema: Json;
  outputSchema?: Json;
  annotations?: Json;
};

async function rpc(path: string, method: string, params: Json = {}) {
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
    env,
    context,
  );
  const text = await response.text();
  const data = text.startsWith("{")
    ? text
    : text.split("\n").find((line) => line.startsWith("data:"))!.slice(5);
  return { status: response.status, body: JSON.parse(data) as Json };
}

async function listTools(path: string): Promise<Tool[]> {
  return (await rpc(path, "tools/list")).body.result.tools;
}

async function callTool(path: string, name: string, args: Json) {
  const { body } = await rpc(path, "tools/call", { name, arguments: args });
  expect(body.error).toBeUndefined();
  return body.result as {
    isError?: boolean;
    content: { type: string; text: string }[];
    structuredContent?: Json;
  };
}

async function fetchArtifact(url: string) {
  return worker.fetch(new Request(url), env, context);
}

function mockUpstream(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => handler(input.toString(), init)) as typeof fetch);
}

function walkProperties(
  schema: Json | undefined,
  visit: (name: string, property: Json) => void,
) {
  if (schema === undefined || typeof schema !== "object") return;
  for (const [name, property] of Object.entries<Json>(schema.properties ?? {})) {
    visit(name, property);
    walkProperties(property, visit);
    walkProperties(property.items, visit);
    for (const branch of property.items?.oneOf ?? property.items?.anyOf ?? []) {
      walkProperties(branch, visit);
    }
  }
}

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("tool discoverability", () => {
  it("lets an agent choose and fill every tool from its published entry", async () => {
    const tools = await listTools("/mcp");
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z0-9_]+$/);
      expect(tool.description.length).toBeGreaterThan(30);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
      // Every required argument is published, so a call built from the
      // schema alone is never rejected for a field the agent cannot see.
      for (const required of tool.inputSchema.required ?? []) {
        expect(tool.inputSchema.properties).toHaveProperty(required);
      }
      if (/^(get|list|derive|decode)_/.test(tool.name)) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
      }
    }
  });

  it("states the chain and the unit of every amount an agent supplies", async () => {
    const unstated: string[] = [];
    for (const tool of await listTools("/mcp")) {
      walkProperties(tool.inputSchema, (name, property) => {
        if (name === "chain_id" && property.description === undefined && property.enum === undefined) {
          unstated.push(`${tool.name}.${name}`);
        }
        if (!/amount/.test(name) || property.type === "object" || property.type === "array") return;
        // Units may be stated on the argument or once for the whole tool.
        const text = `${property.description ?? ""} ${tool.description}`;
        if (!/base units|wei|raw|cumulative amount|signed decimal integer/i.test(text)) {
          unstated.push(`${tool.name}.${name}`);
        }
      });
    }
    expect(unstated).toEqual([]);
  });
});

describe("read journey: owner positions", () => {
  const position = (id: string) => ({
    id,
    chain_id: "0x1237",
    positions_address: "0x02D9876A21AF7545f8632C3af76eC90b5ad4b66D",
    owner: OWNER,
    pool_key: {
      token0: NATIVE,
      token1: OWNER,
      fee: "0x0",
      tick_spacing: "0x400",
      extension: NATIVE,
      stableswap_params: null,
    },
    bounds: { lower: -1024, upper: 1024 },
    // Larger than 2^53: a number-typed round trip would change it.
    liquidity: "340282366920938463463374607431768211455",
    pool_state: { sqrt_ratio: "1", tick: 0, liquidity: "100" },
  });

  it("is discovered with its paging defaults and preserves exact values, pagination and the read reference", async () => {
    const tool = (await listTools("/mcp/ekubo")).find(
      (entry) => entry.name === "get_positions_by_owner",
    )!;
    expect(tool.inputSchema.required).toEqual(["owner"]);
    expect(tool.inputSchema.properties.page.default).toBe(1);
    expect(tool.inputSchema.properties.page_size.default).toBe(50);
    expect(tool.description).toContain("wallet_batch_eth_call");

    const requested: string[] = [];
    mockUpstream((url) => {
      requested.push(url);
      if (url.includes("/tokens/batch?")) return Response.json([]);
      return Response.json({
        data: [position("0x2a")],
        pagination: { page: 2, pageSize: 1, totalPages: 3, totalItems: 3 },
      });
    });
    const result = await callTool("/mcp/ekubo", "get_positions_by_owner", {
      owner: OWNER.toLowerCase(),
      chain_id: "0x1237",
      page: 2,
      page_size: 1,
    });
    expect(result.isError).toBeUndefined();
    const content = result.structuredContent!;
    // The text block is the same JSON, for clients without structured output.
    expect(JSON.parse(result.content[0]!.text)).toEqual(content);
    expect(requested[0]).toBe(
      `https://api.test/positions/${OWNER}?chainId=4663&pageSize=1&page=2`,
    );
    expect(content.owner).toBe(OWNER);
    expect(content.chain_id).toBe("4663");
    expect(content.pagination).toEqual({
      page: 2,
      pageSize: 1,
      totalPages: 3,
      totalItems: 3,
    });
    expect(content.positions[0]).toMatchObject({
      id: "0x2a",
      chain_id: "4663",
      liquidity: "340282366920938463463374607431768211455",
    });

    const read = content.current_state_reads[0];
    expect(read.chain_id).toBe("4663");
    expect(read.read_calls).toBeUndefined();
    const reference = read.read_calls_reference;
    expect(reference).toMatchObject({ kind: "artifact_reference", artifact_type: "read_calls" });
    const fetched = await fetchArtifact(reference.url);
    expect(fetched.status).toBe(200);
    const body = await fetched.text();
    expect(keccak256(stringToHex(body))).toBe(reference.integrity.value);
    const bundle = JSON.parse(body);
    expect(bundle.chain_id).toBe("4663");
    expect(bundle.calls.map((call: Json) => call.id)).toContain(
      content.positions[0].current_state.state_call_id,
    );
  });

  it("returns an empty page as an empty result, not an error", async () => {
    mockUpstream(() =>
      Response.json({
        data: [],
        pagination: { page: 4, pageSize: 50, totalPages: 3, totalItems: 3 },
      }),
    );
    const result = await callTool("/mcp/ekubo", "get_positions_by_owner", {
      owner: OWNER,
      page: 4,
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      positions: [],
      current_state_reads: [],
      tokens: [],
      pagination: { page: 4, totalPages: 3 },
    });
  });
});

describe("preparation journey: transfers handoff", () => {
  const args = {
    chain_id: "8453",
    sender: OWNER,
    transfers: [
      { kind: "erc20", token: USDC_BASE, recipient: RECIPIENT, amount: UINT256_MAX },
      { kind: "native", recipient: RECIPIENT, amount: "1" },
    ],
  };

  it("prepares an unsigned plan that travels only as a verifiable reference", async () => {
    const upstream = mockUpstream(() => {
      throw new Error("preparation must not call an upstream");
    });
    const result = await callTool("/mcp/ekubo", "prepare_transfers", args);
    expect(upstream).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    const content = result.structuredContent!;

    // Preparation only: the result asks for wallet simulation and owner
    // authorization and claims nothing was signed, sent or confirmed.
    expect(content).toMatchObject({
      action: "batch_transfers",
      execution_plan_ready: true,
      wallet_validation_required: true,
      agent_confirmation_required: false,
      request: { chain_id: "8453", sender: OWNER, transfer_count: 2 },
      details: { total_native_value: "1" },
      onchain_validation: { exact_transaction_simulation_required: true },
    });
    for (const field of ["transaction_hash", "tx_hash", "signature", "submitted", "confirmed"]) {
      expect(JSON.stringify(content)).not.toContain(`"${field}"`);
    }
    expect(content.execution_plan).toBeUndefined();
    expect(content.wallet_handoff.complete_transaction_list).toContain(
      "execution_plan_reference",
    );

    const reference = content.execution_plan_reference;
    const response = await fetchArtifact(reference.url);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(keccak256(stringToHex(body))).toBe(reference.integrity.value);
    expect(new TextEncoder().encode(body).length).toBe(reference.bytes);
    const plan = JSON.parse(body);
    expect(plan).toMatchObject({ chain_id: "8453", sender: OWNER });
    // uint256 max survives as an exact amount in the transfer calldata.
    expect(JSON.stringify(plan).toLowerCase()).toContain("f".repeat(64));
  });

  it("is safe to retry: an identical call yields an identical plan under a fresh reference", async () => {
    const first = (await callTool("/mcp/ekubo", "prepare_transfers", args)).structuredContent!;
    const second = (await callTool("/mcp/ekubo", "prepare_transfers", args)).structuredContent!;
    expect(second.plan_id).toBe(first.plan_id);
    expect(second.execution_plan_reference.integrity).toEqual(
      first.execution_plan_reference.integrity,
    );
    expect(second.execution_plan_reference.url).not.toBe(first.execution_plan_reference.url);
    expect((await fetchArtifact(first.execution_plan_reference.url)).status).toBe(200);
    expect((await fetchArtifact(second.execution_plan_reference.url)).status).toBe(200);
  });

  it("expires a reference with recovery guidance, and re-running the tool recovers", async () => {
    const stale = (await callTool("/mcp/ekubo", "prepare_transfers", args)).structuredContent!;
    expect(stale.execution_plan_reference.instruction).toContain("404");
    const id = stale.execution_plan_reference.url.split("/artifact/")[1];
    store.entries.get(`artifact/${id}`)!.uploaded = new Date(
      Date.now() - (ARTIFACT_TTL_SECONDS + 1) * 1000,
    );

    const expired = await fetchArtifact(stale.execution_plan_reference.url);
    expect(expired.status).toBe(404);
    const error = ((await expired.json()) as Json).error;
    expect(error.code).toBe("artifact_not_found_or_expired");
    expect(error.message).toContain("Re-run the Ekubo tool");

    const fresh = (await callTool("/mcp/ekubo", "prepare_transfers", args)).structuredContent!;
    expect(fresh.execution_plan_reference.integrity).toEqual(
      stale.execution_plan_reference.integrity,
    );
    expect((await fetchArtifact(fresh.execution_plan_reference.url)).status).toBe(200);
  });
});

describe("input errors name the argument and the fix", () => {
  const cases: [string, string, Json, string][] = [
    ["missing chain", "get_token", { address: NATIVE }, "chain_id is required"],
    ["wrong chain type", "get_token", { chain_id: true, address: NATIVE }, "chain_id must be an integer"],
    ["non-numeric chain", "get_token", { chain_id: "base", address: NATIVE }, "positive decimal or hexadecimal integer"],
    ["zero chain", "get_token", { chain_id: 0, address: NATIVE }, "chain_id must be positive"],
    ["fractional amount", "prepare_transfers", {
      chain_id: "8453", sender: OWNER,
      transfers: [{ kind: "native", recipient: RECIPIENT, amount: "1.5" }],
    }, "positive canonical decimal integer"],
    ["zero amount", "prepare_transfers", {
      chain_id: "8453", sender: OWNER,
      transfers: [{ kind: "native", recipient: RECIPIENT, amount: "0" }],
    }, "positive canonical decimal integer"],
    ["amount above uint256", "prepare_transfers", {
      chain_id: "8453", sender: OWNER,
      transfers: [{ kind: "native", recipient: RECIPIENT, amount: `${UINT256_MAX.slice(0, -1)}6` }],
    }, "amount must fit uint256"],
    ["empty batch", "prepare_transfers", { chain_id: "8453", sender: OWNER, transfers: [] }, "transfers"],
    ["zero sender", "prepare_transfers", {
      chain_id: "8453", sender: NATIVE,
      transfers: [{ kind: "native", recipient: RECIPIENT, amount: "1" }],
    }, "nonzero address"],
  ];

  for (const [label, name, args, expected] of cases) {
    it(`rejects ${label} before any upstream call`, async () => {
      const upstream = mockUpstream(() => {
        throw new Error("invalid input must not reach an upstream");
      });
      const result = await callTool("/mcp/ekubo", name, args);
      expect(upstream).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(expected);
    });
  }

  it("rejects an unknown tool with a JSON-RPC invalid-params error", async () => {
    const { body } = await rpc("/mcp/ekubo", "tools/call", { name: "get_tokn", arguments: {} });
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain("get_tokn");
  });

  it("names the valid endpoints when a client connects to an unknown protocol path", async () => {
    const { status, body } = await rpc("/mcp/ekuboo", "tools/list");
    expect(status).toBe(404);
    expect(body.error.code).toBe("unknown_protocol");
    expect(body.error.message).toContain("/mcp/ekubo");
  });
});

describe("upstream failures are structured and recoverable", () => {
  const tokenArgs = { chain_id: "1", address: NATIVE };

  it("reports a timeout as retryable upstream_timeout, not a server defect", async () => {
    mockUpstream(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const result = await callTool("/mcp/ekubo", "get_token", tokenArgs);
    expect(result.isError).toBe(true);
    expect(result.structuredContent!.error).toMatchObject({
      code: "upstream_timeout",
      details: { retryable: true },
    });
    expect(result.structuredContent!.error.message).toContain("retry");
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it("names a timed-out quote source in the per-source failures", async () => {
    mockUpstream(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const result = await callTool("/mcp/ekubo", "get_quotes_with_plans", {
      chain_id: "8453",
      token_in: NATIVE,
      token_out: USDC_BASE,
      quote_type: "exact_input",
      amount: "100000000000000000",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent!.error.code).toBe("quote_unavailable");
    const failures = result.structuredContent!.error.details as Json[];
    expect(failures.map((failure) => failure.source).sort()).toEqual(["0x", "ekubo"]);
    for (const failure of failures) {
      expect(failure).toMatchObject({ code: "upstream_timeout", retry_recommended: true });
    }
  });

  it("explains a non-JSON gateway page with its status", async () => {
    mockUpstream(() =>
      new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );
    const result = await callTool("/mcp/ekubo", "get_token", tokenArgs);
    expect(result.structuredContent!.error).toMatchObject({
      code: "invalid_upstream_response",
      details: { status: 502, content_type: "text/html" },
    });
  });

  it("passes an upstream not-found message through unchanged", async () => {
    mockUpstream(() => Response.json({ error: "Token not found" }, { status: 404 }));
    const result = await callTool("/mcp/ekubo", "get_token", tokenArgs);
    expect(result.structuredContent!.error).toMatchObject({
      code: "upstream_error",
      message: "Token not found",
    });
  });

  it("never returns provider credentials, even when a provider echoes them", async () => {
    mockUpstream((url, init) => {
      const headers = new Headers(init?.headers);
      return Response.json(
        {
          reason: "Invalid API key",
          echoed: headers.get("0x-api-key") ?? headers.get("authorization"),
        },
        { status: 401 },
      );
    });
    const result = await callTool("/mcp/ekubo", "get_quotes_with_plans", {
      chain_id: "8453",
      token_in: NATIVE,
      token_out: USDC_BASE,
      quote_type: "exact_input",
      amount: "100000000000000000",
    });
    expect(result.isError).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(env.ZERO_X_API_KEY);
    expect(serialized).not.toContain(env.ACROSS_API_KEY);
  });
});
