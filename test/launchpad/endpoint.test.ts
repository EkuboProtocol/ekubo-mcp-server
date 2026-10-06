import { afterEach, describe, expect, it } from "bun:test";
import { type Hex, keccak256, stringToHex } from "viem";
import worker from "../../src/index.js";
import { fakeArtifactStore } from "../fake-r2.js";
import { BLOCK, E18, env, FakeChain, FakeServices, type Json, launchQuote, RPC_URL, SENDER, TOKEN } from "./fake.js";

const TOOLS = [
  "launchpad_list_launches",
  "launchpad_get_launch",
  "launchpad_get_stats",
  "launchpad_get_swaps",
  "launchpad_prepare_create",
  "launchpad_prepare_trade",
  "launchpad_prepare_advance",
  "launchpad_prepare_claim_fees",
];

const context = {} as unknown as ExecutionContext;
const headers = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
  host: "mcp.ekubo.org",
  origin: "https://mcp.ekubo.org",
  "mcp-protocol-version": "2025-11-25",
};

function workerEnv(launchpad: Record<string, string> = env()) {
  return { ARTIFACT_STORE: fakeArtifactStore(), ALLOWED_ORIGINS: "https://mcp.ekubo.org", ...launchpad };
}

async function mcp(workerEnvironment: Json, path: string, method: string, params: Record<string, unknown> = {}): Promise<Json> {
  const response = await worker.fetch(
    new Request(`https://mcp.ekubo.org${path}`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }),
    workerEnvironment,
    context,
  );
  const body = await response.text();
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? body.split("\n").find((line) => line.startsWith("data:"))!.slice(5)
    : body;
  return JSON.parse(data);
}

/** Serve the node's JSON-RPC from a FakeChain and the api and quoter from FakeServices. */
function serve(chain: FakeChain, services: FakeServices) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== RPC_URL) return services.fetch(input, init);
    const { method, params } = JSON.parse(String(init?.body));
    return Response.json({ jsonrpc: "2.0", id: 1, ...(await answer(chain, method, params)) });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

async function answer(chain: FakeChain, method: string, params: Json[]) {
  if (method === "eth_getBlockByNumber") {
    await chain.latest();
    return { result: { number: `0x${BLOCK.number.toString(16)}`, hash: BLOCK.hash, timestamp: `0x${BLOCK.timestamp.toString(16)}` } };
  }
  if (method === "eth_getCode") return { result: await chain.code(params[0]) };
  if (method === "eth_getStorageAt") return { result: await chain.storage(params[0], params[1]) };
  if (method === "eth_call") {
    const outcome = await chain.call({ ...params[0], block: BLOCK });
    return outcome.ok ? { result: outcome.data } : { error: { code: 3, message: "execution reverted", data: outcome.revert } };
  }
  throw new Error(`unexpected RPC method ${method}`);
}

let restore = () => {};
afterEach(() => restore());

describe("launchpad MCP endpoint", () => {
  it("serves the four read and four preparation tools and the resources only on /mcp/launchpad", async () => {
    const e = workerEnv();
    const scoped = (await mcp(e, "/mcp/launchpad", "tools/list")).result.tools.map((t: Json) => t.name);
    expect(scoped.sort()).toEqual([...TOOLS].sort());
    const bundled = (await mcp(e, "/mcp", "tools/list")).result.tools.map((t: Json) => t.name);
    expect(bundled.filter((name: string) => name.startsWith("launchpad_"))).toEqual([]);
    const resources = (await mcp(e, "/mcp/launchpad", "resources/list")).result.resources.map((r: Json) => r.uri);
    expect(resources).toEqual(expect.arrayContaining(["launchpad://onboarding", "launchpad://disclosures"]));
  });

  it("returns a trade plan as an execution_plan_reference whose stored bytes match its integrity digest", async () => {
    const e = workerEnv();
    const chain = new FakeChain();
    const services = new FakeServices();
    services.quote = { status: 200, body: launchQuote({ specified: E18, calculated: 1000n * E18 }) };
    restore = serve(chain, services);
    const called = await mcp(e, "/mcp/launchpad", "tools/call", {
      name: "launchpad_prepare_trade",
      arguments: { chain_id: 1, sender: SENDER, slippage_bps: 100, token: TOKEN, side: "buy", amount_kind: "exact_input", amount: E18.toString() },
    });
    const result = called.result.structuredContent;
    expect(result).not.toHaveProperty("execution_plan");
    const reference = result.execution_plan_reference;
    expect(reference).toMatchObject({ kind: "artifact_reference", artifact_type: "execution_plan" });
    const id = reference.url.split("/").at(-1);
    const stored = e.ARTIFACT_STORE.entries.get(`artifact/${id}`)!.value;
    expect(keccak256(stringToHex(stored)) as Hex).toBe(reference.integrity.value);
    expect(JSON.parse(stored)).toMatchObject({ sender: SENDER, chain_id: "1" });
    expect(chain.methods).toEqual({ eth_getBlockByNumber: 1, eth_getCode: 6, eth_call: 7 });
  });

  it("returns a structured error when the launchpad is not configured", async () => {
    const reply = await mcp(workerEnv({}), "/mcp/launchpad", "tools/call", { name: "launchpad_list_launches", arguments: { chain_id: 1 } });
    expect(reply.result.isError).toBe(true);
    expect(reply.result.structuredContent.error.code).toBe("launchpad_not_configured");
  });

  it("reads the onboarding and disclosure resources", async () => {
    const e = workerEnv();
    const onboarding = await mcp(e, "/mcp/launchpad", "resources/read", { uri: "launchpad://onboarding" });
    expect(onboarding.result.contents[0].text).toContain("launchpad_prepare_create");
    const disclosures = await mcp(e, "/mcp/launchpad", "resources/read", { uri: "launchpad://disclosures" });
    expect(JSON.parse(disclosures.result.contents[0].text)).toMatchObject({ version: 1, status: "draft_not_approved" });
  });
});
