import { afterEach, describe, expect, it } from "bun:test";
import { type Hex, keccak256, stringToHex } from "viem";
import worker from "../../../src/index.js";
import { fakeArtifactStore } from "../../fake-r2.js";
import { BLOCK, FakeChain, MANIFEST, SENDER, TOKEN } from "./fake-chain.js";

const RPC_URL = "http://launchpad-node.test/";
const context = {} as unknown as ExecutionContext;
const headers = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
  host: "mcp.ekubo.org",
  origin: "https://mcp.ekubo.org",
  "mcp-protocol-version": "2025-11-25",
};

// MCP responses are plain JSON.
type Json = any;

function workerEnv() {
  return {
    ARTIFACT_STORE: fakeArtifactStore(),
    ALLOWED_ORIGINS: "https://mcp.ekubo.org",
    LAUNCHPAD_MANIFEST: JSON.stringify(MANIFEST),
    LAUNCHPAD_RPC_URL: RPC_URL,
  };
}

async function mcp(env: Json, path: string, method: string, params: Record<string, unknown> = {}): Promise<Json> {
  const response = await worker.fetch(
    new Request(`https://mcp.ekubo.org${path}`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }),
    env,
    context,
  );
  const body = await response.text();
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? body.split("\n").find((line) => line.startsWith("data:"))!.slice(5)
    : body;
  return JSON.parse(data);
}

/** Serve the launchpad node's JSON-RPC from a FakeChain; every other URL fails the test. */
function serveChain(chain: FakeChain) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== RPC_URL) throw new Error(`unexpected fetch ${String(input)}`);
    const { method, params } = JSON.parse(String(init?.body));
    const result = await answer(chain, method, params);
    return Response.json({ jsonrpc: "2.0", id: 1, ...result });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

async function answer(chain: FakeChain, method: string, params: Json[]) {
  if (method === "eth_getBlockByNumber") {
    return { result: { number: `0x${BLOCK.number.toString(16)}`, hash: BLOCK.hash, timestamp: `0x${BLOCK.timestamp.toString(16)}` } };
  }
  if (method === "eth_getLogs") {
    const logs = await chain.logs(params[0]);
    return { result: logs.map((log) => ({ ...log, blockNumber: `0x${log.blockNumber.toString(16)}`, logIndex: `0x${log.logIndex.toString(16)}` })) };
  }
  const outcome = await chain.call({ ...params[0], block: BLOCK });
  return outcome.ok ? { result: outcome.data } : { error: { code: 3, message: "execution reverted", data: outcome.revert } };
}

let restore = () => {};
afterEach(() => restore());

describe("launchpad preparation on the MCP endpoint", () => {
  it("lists the prepare tools and launchpad resources only on /mcp/launchpad", async () => {
    const env = workerEnv();
    const launchpadTools = (await mcp(env, "/mcp/launchpad", "tools/list")).result.tools.map((t: Json) => t.name);
    expect(launchpadTools).toEqual(expect.arrayContaining(["launchpad_prepare_create", "launchpad_prepare_trade", "launchpad_prepare_advance"]));
    const bundledTools = (await mcp(env, "/mcp", "tools/list")).result.tools.map((t: Json) => t.name);
    expect(bundledTools.filter((name: string) => name.startsWith("launchpad_"))).toEqual([]);
    const resources = (await mcp(env, "/mcp/launchpad", "resources/list")).result.resources.map((r: Json) => r.uri);
    expect(resources).toEqual(expect.arrayContaining(["launchpad://onboarding", "launchpad://disclosures"]));
    const bundledResources = (await mcp(env, "/mcp", "resources/list")).result.resources.map((r: Json) => r.uri);
    expect(bundledResources.filter((uri: string) => uri.startsWith("launchpad://"))).toEqual([]);
  });

  it("returns the plan as an execution_plan_reference envelope whose stored bytes match its integrity digest", async () => {
    const env = workerEnv();
    const chain = new FakeChain();
    chain.launchQuote = { update: { delta0: 10n ** 15n, delta1: -(10n ** 21n) }, fee: 0n };
    restore = serveChain(chain);
    const called = await mcp(env, "/mcp/launchpad", "tools/call", {
      name: "launchpad_prepare_trade",
      arguments: { chain_id: 1, sender: SENDER, slippage_bps: 100, token: TOKEN, side: "buy", amount_kind: "exact_input", amount: "1000000000000000" },
    });
    const result = called.result.structuredContent;
    expect(result).not.toHaveProperty("execution_plan");
    const reference = result.execution_plan_reference;
    expect(reference).toMatchObject({ kind: "artifact_reference", artifact_type: "execution_plan" });
    const id = reference.url.split("/").at(-1);
    const stored = env.ARTIFACT_STORE.entries.get(`artifact/${id}`)!.value;
    expect(keccak256(stringToHex(stored)) as Hex).toBe(reference.integrity.value);
    const plan = JSON.parse(stored);
    expect(plan.sender).toBe(SENDER);
    expect(plan.chain_id).toBe("1");
  });

  it("reads the onboarding and disclosure resources", async () => {
    const env = workerEnv();
    const onboarding = await mcp(env, "/mcp/launchpad", "resources/read", { uri: "launchpad://onboarding" });
    expect(onboarding.result.contents[0].text).toContain("launchpad_prepare_create");
    const disclosures = await mcp(env, "/mcp/launchpad", "resources/read", { uri: "launchpad://disclosures" });
    expect(JSON.parse(disclosures.result.contents[0].text)).toMatchObject({ version: 1, status: "draft_not_approved" });
  });
});
