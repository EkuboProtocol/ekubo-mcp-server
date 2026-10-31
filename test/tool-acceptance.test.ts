import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { decodeFunctionData, encodeFunctionData, erc20Abi, keccak256, parseAbi, stringToHex } from "viem";
import { encodeRoutes, YUL_ROUTER_ADDRESS } from "@ekubo/yul-router-sdk";
import worker from "../src/index.js";
import { ARTIFACT_TTL_SECONDS } from "../src/artifact-store.js";
import { PROTOCOLS, protocolMcpPath } from "../src/protocols.js";
import { fakeArtifactStore } from "./fake-r2.js";
import zeroXIndicative from "./fixtures/zero-x-indicative-price.json";
import { createHash } from "node:crypto";

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

// Google's current client ignores structuredContent. Consume only TextContent,
// while retaining a parity check for clients that use the structured channel.
function googleTextResult(result: Awaited<ReturnType<typeof callTool>>): Json {
  expect(result.content).toHaveLength(1);
  expect(result.content[0]!.type).toBe("text");
  const value = JSON.parse(result.content[0]!.text) as Json;
  expect(result.structuredContent).toEqual(value);
  return value;
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

describe("Google Connected Apps wire contract", () => {
  it("negotiates the supported protocol without authentication or browser headers", async () => {
    const response = await rpc("/mcp/ekubo", "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "google-contract-fixture", version: "1" },
    });
    expect(response.status).toBe(200);
    expect(response.body.error).toBeUndefined();
    expect(response.body.result.protocolVersion).toBe("2025-11-25");
    expect(response.body.result.instructions).toContain("Handoff: preparation tools");
  });

  it("pins registration-relevant tools and instructions for each Ekubo facet", async () => {
    const snapshots: Record<string, { count: number; sha256: string }> = {};
    for (const path of ["/mcp/ekubo", "/mcp/ekubo-advanced"]) {
      const initialized = await rpc(path, "initialize", {
        protocolVersion: "2025-11-25", capabilities: {},
        clientInfo: { name: "google-contract-fixture", version: "1" },
      });
      const tools = await listTools(path);
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.description.length).toBeGreaterThan(0);
      }
      const payload = { instructions: initialized.body.result.instructions, tools };
      snapshots[path] = { count: tools.length,
        sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
    }
    expect(snapshots).toMatchSnapshot();
  });

  it("does not require an optional GET notification stream", async () => {
    const response = await worker.fetch(new Request("https://mcp.ekubo.org/mcp/ekubo"), env, context);
    expect(response.status).toBe(405);
  });

  it("makes SDK input-error recovery available without structuredContent", async () => {
    const result = await callTool("/mcp/ekubo", "get_token", { address: NATIVE });
    expect(result.isError).toBe(true);
    // SDK schema-validation errors are plain text, which Google's recoverable
    // error guidance permits. Do not require a structured channel to read them.
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toContain("chain_id");
    expect(result.content[0]!.text).toMatch(/required|undefined/i);
  });
});

describe("absolute swap protection through MCP", () => {
  const USDG = "0xe343167631d89b6ffc58b88d6b7fb0228795491d";
  const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
  const output = 168620010171n;
  const amount = "168413941673";
  const args = { chain_id: "1", token_in: USDG, token_out: USDT,
    quote_type: "exact_input", amount, sender: OWNER };
  const poolKey = { token0: USDT, token1: USDG, config: `0x${"00".repeat(32)}` } as const;
  // Synthetic offline provider fixture using 0x's public ABI, not a live route.
  const settlerAbi = parseAbi(["function execute((address recipient, address buyToken, uint256 minAmountOut) slippage, bytes[] actions, bytes32 zid) payable"]);
  const holderAbi = parseAbi(["function exec(address operator, address token, uint256 amount, address target, bytes data) payable returns (bytes)"]);
  const holder = "0x0000000000001fF3684f28c67538d4D072C22734";

  function providerBytes(minimum: bigint) {
    const inner = encodeFunctionData({ abi: settlerAbi, functionName: "execute", args: [
      { recipient: OWNER, buyToken: USDT, minAmountOut: minimum }, [], `0x${"00".repeat(32)}`,
    ] });
    return encodeFunctionData({ abi: holderAbi, functionName: "exec", args: [OWNER, USDG, BigInt(amount), OWNER, inner] });
  }

  function upstream(options: { extraLoss?: bigint; noMinimum?: boolean; zeroLoss?: boolean; amountOut?: bigint; minimum?: unknown; finalOutput?: bigint } = {}) {
    const output = options.amountOut ?? 168620010171n;
    return mockUpstream((input) => {
      const url = new URL(input);
      if (url.hostname === "quoter.test") return Response.json({
        block_number: 26289373, block_hash: "0x01", total_calculated: output.toString(),
        estimated_gas_cost: 25000, price_impact: 0,
        splits: [{ amount_specified: amount, amount_calculated: output.toString(), route: [{ swap: {
          type: "core", pool_key: poolKey, sqrt_ratio_limit: "0x000000000000000000000000", skip_ahead: 0,
        } }] }],
      });
      const finalOutput = url.searchParams.has("slippagePpm") ? (options.finalOutput ?? output) : output;
      const ppm = BigInt(url.searchParams.get("slippagePpm") ?? "0");
      const loss = options.zeroLoss ? 0n : finalOutput * ppm / 1_000_000n + (options.extraLoss ?? 0n);
      return Response.json({ liquidityAvailable: true, sellAmount: amount, buyAmount: finalOutput.toString(),
        ...(options.noMinimum ? {} : { minBuyAmount: options.minimum ?? (finalOutput - loss).toString() }),
        issues: { allowance: null },
        transaction: { to: holder, data: providerBytes(finalOutput - loss), value: "0", gas: "25000" },
      });
    });
  }

  async function quote(protection: Json) {
    const result = await callTool("/mcp/ekubo", "get_quotes_with_plans", { ...args, ...protection });
    expect(result.isError).toBeUndefined();
    return googleTextResult(result);
  }

  it("discovers the absolute base-unit alternative and limitations", async () => {
    const tool = (await listTools("/mcp/ekubo")).find((t) => t.name === "get_quotes_with_plans")!;
    expect(tool.inputSchema.properties.max_output_loss.type).toBe("string");
    expect(tool.inputSchema.properties.max_output_loss.description).toMatch(/base units/);
    expect(tool.inputSchema.properties.max_output_loss.description).toContain("ppm");
    expect(tool.description).toContain("max_output_loss");
  });

  it("encodes the $0.26517 budget exactly in Ekubo and conservatively in unchanged 0x calldata", async () => {
    const fetcher = upstream();
    const result = await quote({ max_output_loss: "265170" });
    const ekubo = result.quotes.find((q: Json) => q.source === "ekubo");
    const zeroX = result.quotes.find((q: Json) => q.source === "0x");
    expect(ekubo.execution.quote.minimum_amount_out).toBe("168619745001");
    expect(zeroX.execution.quote.minimum_amount_out).toBe("168619841551");
    expect(zeroX.execution.quote.slippage_bps).toBeNull();
    expect(zeroX.execution.quote.max_output_loss).toBe("265170");
    const urls = fetcher.mock.calls.map(([url]) => new URL(String(url))).filter((url) => url.hostname !== "quoter.test");
    expect(urls).toHaveLength(2);
    expect(urls[0].searchParams.get("slippageBps")).toBe("0");
    expect(urls[1].searchParams.get("slippagePpm")).toBe("1");
    expect(urls[1].searchParams.has("slippageBps")).toBe(false);
    for (const entry of [ekubo, zeroX]) {
      const loss = output - BigInt(entry.execution.quote.minimum_amount_out);
      expect(loss > 0n && loss <= 265170n).toBe(true);
      const ref = entry.execution.execution_plan_reference;
      const body = await (await fetchArtifact(ref.url)).text();
      expect(keccak256(stringToHex(body))).toBe(ref.integrity.value);
      const plan = JSON.parse(body);
      const data = plan.ordered_steps.at(-1).transaction.data;
      if (entry.source === "0x") {
        expect(data).toBe(providerBytes(168619841551n));
        const outer = decodeFunctionData({ abi: holderAbi, data });
        const inner = decodeFunctionData({ abi: settlerAbi, data: outer.args[4] });
        expect(inner.args[0].minAmountOut).toBe(BigInt(entry.execution.quote.minimum_amount_out));
      }
      else expect(data).toBe(encodeRoutes({
        specifiedToken: USDG, calculatedToken: USDT, recipient: OWNER,
        calculatedAmountThreshold: 168619745001n,
        deadline: ekubo.execution.quote.quote_expiry_timestamp,
        multiHops: [{ specifiedAmount: BigInt(amount), hops: [{ type: "core", poolKey, sqrtRatioLimit: 0n, skipAhead: 0 }] }],
      }));
      expect(plan.simulation_failure_policy.execution_reverted.action).toBe("reprepare_plan");
      expect(plan.simulation_failure_policy.rpc_error.action).toBe("retry_same_plan");
    }
  });

  for (const loss of ["0", "1", "168620", "168621", "265170"]) {
    it(`keeps integer-safe budget ${loss} and rejects sub-ppm rather than substituting zero`, async () => {
      upstream();
      const result = await quote({ max_output_loss: loss });
      const ekubo = result.quotes.find((q: Json) => q.source === "ekubo");
      expect(ekubo.execution.quote.minimum_amount_out).toBe((output - BigInt(loss)).toString());
      if (loss === "1" || loss === "168620") {
        expect(result.unavailable_sources).toMatchObject([{ source: "0x", code: "unsupported_swap_protection", retry_recommended: false }]);
      } else {
        const zeroX = result.quotes.find((q: Json) => q.source === "0x");
        const actualLoss = output - BigInt(zeroX.execution.quote.minimum_amount_out);
        expect(actualLoss <= BigInt(loss)).toBe(true);
      }
    });
  }

  for (const bps of [0, 1]) {
    it(`preserves exact whole-bps behavior at ${bps}`, async () => {
      upstream();
      const result = await quote({ slippage_bps: bps });
      const ekubo = result.quotes.find((q: Json) => q.source === "ekubo");
      expect(ekubo.execution.quote.minimum_amount_out).toBe((output * 10000n / (10000n + BigInt(bps))).toString());
      expect(ekubo.execution.quote.slippage_bps).toBe(String(bps));
      expect(ekubo.execution.quote).not.toHaveProperty("max_output_loss");
    });
  }

  for (const largeOutput of [9007199254740993n, 10n ** 30n]) {
    it(`preserves single-base-unit bounds above Number.MAX_SAFE_INTEGER: ${largeOutput}`, async () => {
      upstream({ amountOut: largeOutput });
      const result = await quote({ max_output_loss: "1" });
      expect(result.quotes[0].execution.quote.minimum_amount_out).toBe((largeOutput - 1n).toString());
      expect(result.unavailable_sources[0].code).toBe("unsupported_swap_protection");
    });
  }

  for (const invalid of [
    { max_output_loss: "-1" }, { max_output_loss: "0.27" }, { max_output_loss: 265170 },
    { max_output_loss: "01" }, { max_output_loss: "1e3" }, { max_output_loss: "1".repeat(79) },
    { max_output_loss: "265170", slippage_bps: 0 },
    { max_output_loss: "265170", quote_type: "exact_output" },
    { max_output_loss: "265170", sender: undefined }, { slippage_bps: 0.015745 },
    { sender: OWNER },
  ]) {
    it(`rejects malformed or incomplete protection before upstream: ${JSON.stringify(invalid)}`, async () => {
      const fetcher = upstream();
      const result = await callTool("/mcp/ekubo", "get_quotes_with_plans", { ...args, ...invalid });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/max_output_loss|slippage_bps/);
      expect(fetcher).not.toHaveBeenCalled();
    });
  }

  it("rejects unsupported cross-chain absolute budgets without upstream calls", async () => {
    const fetcher = upstream();
    const result = await callTool("/mcp/ekubo", "get_quotes_with_plans", { ...args, destination_chain_id: "8453", max_output_loss: "265170" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("unsupported_swap_protection");
    expect(fetcher).not.toHaveBeenCalled();
  });

  for (const options of [{ extraLoss: 265171n }, { noMinimum: true }, { zeroLoss: true }, { minimum: "1.5" }, { minimum: 123 }, { finalOutput: 500000000000n }]) {
    it(`never hands off 0x bytes when the returned bound is unsafe: ${Object.keys(options)}`, async () => {
      upstream(options);
      const result = await quote({ max_output_loss: "265170" });
      expect(result.quotes.map((q: Json) => q.source)).toEqual(["ekubo"]);
      expect(result.unavailable_sources[0].source).toBe("0x");
      expect(result.unavailable_sources[0].message).toMatch(/minBuyAmount/);
    });
  }

  it("expires references and re-quotes changed state, without relaxing the budget", async () => {
    const fetcher = upstream();
    const first = await quote({ max_output_loss: "265170" });
    const ref = first.quotes[0].execution.execution_plan_reference;
    const id = ref.url.split("/artifact/")[1];
    store.entries.get(`artifact/${id}`)!.uploaded = new Date(Date.now() - (ARTIFACT_TTL_SECONDS + 1) * 1000);
    expect((await fetchArtifact(ref.url)).status).toBe(404);
    fetcher.mockRestore();
    upstream({ amountOut: output - 100n });
    const fresh = await quote({ max_output_loss: "265170" });
    expect(fresh.quotes[0].execution.quote.max_output_loss).toBe("265170");
    expect(fresh.quotes[0].execution.quote.minimum_amount_out).toBe((output - 100n - 265170n).toString());
    expect(fresh.quotes[0].execution.execution_plan_reference.integrity).not.toEqual(ref.integrity);
    expect((await fetchArtifact(fresh.quotes[0].execution.execution_plan_reference.url)).status).toBe(200);
  });

  it("rejects budgets at or above quoted output without an executable plan", async () => {
    upstream();
    const result = await quote({ max_output_loss: output.toString() });
    expect(result.quotes[0].execution).toBeNull();
    expect(result.quotes[0].execution_unavailable.code).toBe("invalid_swap_protection");
    expect(result.quotes.every((q: Json) => q.execution === null)).toBe(true);
  });

  it("returns explicit empty-liquidity and timeout errors without fallback protection", async () => {
    mockUpstream((url) => {
      if (url.startsWith("https://quoter.test")) throw new DOMException("timed out", "TimeoutError");
      return Response.json({ liquidityAvailable: false });
    });
    const result = await callTool("/mcp/ekubo", "get_quotes_with_plans", { ...args, max_output_loss: "265170" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("upstream_timeout");
    expect(JSON.stringify(result)).toContain("quote_unavailable");
    expect(JSON.stringify(result)).not.toContain("execution_plan_reference");
  });
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
    const content = googleTextResult(result);
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
    const content = googleTextResult(result);

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
    expect(JSON.stringify(plan).toLowerCase()).toContain("f".repeat(64));
  });

  it("is safe to retry: an identical call yields an identical plan under a fresh reference", async () => {
    const first = googleTextResult(await callTool("/mcp/ekubo", "prepare_transfers", args));
    const second = googleTextResult(await callTool("/mcp/ekubo", "prepare_transfers", args));
    expect(second.plan_id).toBe(first.plan_id);
    expect(second.execution_plan_reference.integrity).toEqual(
      first.execution_plan_reference.integrity,
    );
    expect(second.execution_plan_reference.url).not.toBe(first.execution_plan_reference.url);
    expect((await fetchArtifact(first.execution_plan_reference.url)).status).toBe(200);
    expect((await fetchArtifact(second.execution_plan_reference.url)).status).toBe(200);
  });

  it("expires a reference with recovery guidance, and re-running the tool recovers", async () => {
    const stale = googleTextResult(await callTool("/mcp/ekubo", "prepare_transfers", args));
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

    const fresh = googleTextResult(await callTool("/mcp/ekubo", "prepare_transfers", args));
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

describe("normalized quote gas estimates", () => {
  const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

  it("reports the gas limit of a captured indicative 0x price through get_quotes_with_plans", async () => {
    const upstream = mockUpstream((url) => {
      if (url.startsWith("https://quoter.test/")) return Response.json(zeroXIndicative.ekubo_quote);
      if (url.startsWith("https://api.0x.org/swap/allowance-holder/price?")) {
        return Response.json(zeroXIndicative.zero_x_price);
      }
      return new Response("unexpected upstream", { status: 500 });
    });
    const result = await callTool("/mcp/ekubo", "get_quotes_with_plans", {
      chain_id: "1",
      token_in: NATIVE,
      token_out: USDC_MAINNET,
      quote_type: "exact_input",
      amount: "1000000000000000000",
    });
    expect(result.isError).toBeUndefined();
    const quotes = result.structuredContent!.quotes as Json[];
    const normalized = Object.fromEntries(quotes.map((quote) => [quote.source, quote.normalized]));
    expect(normalized["0x"]).toEqual({
      ...zeroXIndicative.normalized_before_fix["0x"],
      estimated_gas: 1058057,
    });
    expect(normalized.ekubo.estimated_gas).toBe(412468);
    expect(result.structuredContent!.comparison.comparison_basis).toBe("highest_calculated_amount_out");
    for (const quote of quotes) expect(quote.execution).toBeNull();
    expect(upstream.mock.calls.map(([input]) => new URL(input.toString()).pathname)).not.toContain(
      "/swap/allowance-holder/quote",
    );
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

describe("retired HyperRouter tools are gone from every endpoint", () => {
  const REMOVED = ["prepare_old_gekubo_unwrap"];
  const HYPER_ROUTER_V2 = "0x8CCB1ffD5C2aa6Bd926473425Dea4c8c15DE60fd";
  const LEGACY = /prepare_old_gekubo_unwrap|unwrap_old_gekubo|hyper.?router|0x8ccb1ffd5c2aa6bd926473425dea4c8c15de60fd/i;
  const MCP_PATHS = [
    "/mcp",
    "/mcp?protocols=ekubo+ekubo-advanced",
    ...PROTOCOLS.map((protocol) => protocolMcpPath(protocol.slug)),
  ];
  const HTTP_DOCUMENTS = [
    "/",
    "/tools",
    "/tools?protocols=ekubo+ekubo-advanced",
    ...PROTOCOLS.map((protocol) => `/tools?protocol=${protocol.slug}`),
    "/llms.txt",
    "/openapi.json",
    "/.well-known/mcp.json",
    "/.well-known/mcp/server-card.json",
  ];

  for (const path of MCP_PATHS) {
    it(`${path} neither lists nor describes a removed tool`, async () => {
      const names = (await listTools(path)).map((tool) => tool.name);
      expect(names.length).toBeGreaterThan(0);
      for (const name of REMOVED) expect(names).not.toContain(name);
      const listed = JSON.stringify(await listTools(path));
      expect(listed).not.toMatch(LEGACY);
      const init = await rpc(path, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "removal-test", version: "0" },
      });
      expect(JSON.stringify(init.body.result)).not.toMatch(LEGACY);
    });

    const calls: [string, Json][] = [
      ["valid synthetic arguments", { chain_id: "1", sender: OWNER, amount: "1000000000000000000" }],
      ["malformed arguments", { chain_id: 1, sender: "not-an-address", amount: "-1" }],
      ["no arguments", {}],
    ];
    for (const [label, args] of calls) {
      it(`${path} rejects a cached removed-tool call with ${label} and prepares nothing`, async () => {
        const upstream = mockUpstream(() => {
          throw new Error("a removed tool must not reach an upstream");
        });
        const storedBefore = store.entries.size;
        for (const name of REMOVED) {
          const { status, body } = await rpc(path, "tools/call", { name, arguments: args });
          expect(status).toBe(200);
          expect(body.result).toBeUndefined();
          expect(body.error.code).toBe(-32602);
          expect(body.error.message).toContain(name);
          expect(JSON.stringify(body)).not.toContain("execution_plan");
        }
        expect(upstream).not.toHaveBeenCalled();
        expect(store.entries.size).toBe(storedBefore);
      });
    }
  }

  for (const path of HTTP_DOCUMENTS) {
    it(`${path} does not advertise a removed tool`, async () => {
      const response = await worker.fetch(new Request(`https://mcp.ekubo.org${path}`), env, context);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toMatch(LEGACY);
    });
  }

  it("still plans a maintained Ekubo swap through the Yul router only", async () => {
    mockUpstream((url) => {
      if (!url.startsWith("https://quoter.test/")) return new Response("not found", { status: 404 });
      return Response.json({
        block_number: 123, block_hash: "0x01", total_calculated: "900",
        estimated_gas_cost: 25000, price_impact: 0.001,
        splits: [{ amount_specified: "1000", amount_calculated: "900", route: [{ swap: {
          type: "core", pool_key: { token0: NATIVE, token1: USDC_BASE, config: `0x${"00".repeat(32)}` },
          sqrt_ratio_limit: "0x000000000000000000000000", skip_ahead: 0,
        } }] }],
      });
    });
    const result = await callTool("/mcp/ekubo", "get_quotes_with_plans", {
      chain_id: "8453", token_in: NATIVE, token_out: USDC_BASE,
      quote_type: "exact_input", amount: "1000", sender: OWNER, slippage_bps: 10,
    });
    expect(result.isError).toBeUndefined();
    const ekubo = (result.structuredContent!.quotes as Json[]).find(
      (quote) => quote.execution?.execution_plan_reference !== undefined,
    )!;
    const reference = ekubo.execution.execution_plan_reference;
    const body = await (await fetchArtifact(reference.url)).text();
    expect(keccak256(stringToHex(body))).toBe(reference.integrity.value);
    const targets = (JSON.parse(body).ordered_steps as Json[]).map((step) => step.transaction.to);
    expect(targets).toContain(YUL_ROUTER_ADDRESS);
    expect(targets).not.toContain(HYPER_ROUTER_V2);
  });

  it("still revokes an allowance left on the retired router", async () => {
    const result = await callTool("/mcp/ekubo-advanced", "prepare_approval_revocations", {
      chain_id: "1",
      sender: OWNER,
      approvals: [{ token: "0x04C46E830Bb56ce22735d5d8Fc9CB90309317d0f", spender: HYPER_ROUTER_V2 }],
    });
    expect(result.isError).toBeUndefined();
    const reference = result.structuredContent!.execution_plan_reference;
    const plan = JSON.parse(await (await fetchArtifact(reference.url)).text());
    expect(plan.ordered_steps).toHaveLength(1);
    const transaction = plan.ordered_steps[0].transaction;
    expect(transaction.to).toBe("0x04C46E830Bb56ce22735d5d8Fc9CB90309317d0f");
    expect(transaction.value).toBe("0");
    expect(
      decodeFunctionData({ abi: erc20Abi, data: transaction.data }),
    ).toEqual({ functionName: "approve", args: [HYPER_ROUTER_V2, 0n] });
  });
});
