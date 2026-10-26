import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { encodeQuoteCalldata, YUL_ROUTER_ABI, YUL_ROUTER_ADDRESS } from "@ekubo/yul-router-sdk";
import {
  type Address, decodeFunctionData, encodeFunctionResult, erc20Abi, getAddress, type Hex, keccak256, numberToHex, stringToHex, zeroAddress,
} from "viem";
import worker from "../../src/index.js";
import { ARTIFACT_TTL_SECONDS } from "../../src/artifact-store.js";
import { extensionAbi, peripheryAbi } from "../../src/launchpad/zero-seed/abi.js";
import { launchPoolConfig, launchRange, poolIdOf } from "../../src/launchpad/zero-seed/codec.js";
import { DISCLOSURE_CODES } from "../../src/launchpad/zero-seed/disclosures.js";
import { fakeArtifactStore } from "../fake-r2.js";
import { listAggregates } from "./api-aggregates.js";

// Acceptance through the MCP boundary (worker.fetch tools/list and tools/call) with a mocked chain RPC and indexed
// launch API. Runtimes served by the mock are the frozen expected runtimes with their immutables set to the test
// deployment, so the deployment check runs for real.
type Json = Record<string, any>;
const store = fakeArtifactStore();
const RPC = "https://rpc.launch.test/";
const API = "https://launch-api.test";
const CORE = getAddress("0x00000000000014aa86c5d3c41765bb24e11bd701");
const EXTENSION = getAddress("0x5100000000000000000000000000000000000abc");
const PERIPHERY = getAddress("0x00000000000000000000000000000000000fe001");
const ROUTER = getAddress(YUL_ROUTER_ADDRESS);
const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const TRADER = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0xbede2b5c9f579f31dbc0c3bdda97cabc8ca5f9a1");
const NOW = 1_800_000_000n;
const DEPLOYMENT = { chain_id: "31337", rpc_url: RPC, core: CORE, extension: EXTENSION, periphery: PERIPHERY, router: ROUTER, deployment_block: "2" };
const baseEnv = {
  ARTIFACT_STORE: store, EKUBO_API_URL: "https://api.test", EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused", ACROSS_API_KEY: "unused", ACROSS_INTEGRATOR_ID: "unused", LAYER_ZERO_API_KEY: "unused",
  LI_FI_API_KEY: "unused", DUNE_API_KEY: "unused",
};
const env: Json = { ...baseEnv, LAUNCHPAD_API_URL: API, LAUNCHPAD_DEPLOYMENTS: JSON.stringify([DEPLOYMENT]) };

const fixture = (name: string) => readFileSync(new URL(`../fixtures/launchpad/local-chain/${name}`, import.meta.url), "utf8").trim();
const patch = (code: string, offsets: number[], address: Address) => {
  let out = code;
  for (const offset of offsets) {
    const at = 2 + offset * 2;
    out = out.slice(0, at) + address.slice(2).toLowerCase().padStart(64, "0") + out.slice(at + 64);
  }
  return out;
};
const EXTENSION_CODE = fixture("ZeroSeedLaunch.runtime.expected.hex");
const PERIPHERY_CODE = patch(fixture("ZeroSeedLaunchPeriphery.runtime.expected.hex"), [748, 2673, 3007, 4610], EXTENSION);

// The fixture launch: native quote (token0), launch token token1, default range.
const RANGE = launchRange(-13815500, -9210300);
const KEY = { token0: zeroAddress, token1: TOKEN, config: launchPoolConfig(EXTENSION, RANGE.tickSpacing) };
const POOL_ID = poolIdOf(KEY);
const SCHEDULE = { controller: PERIPHERY, tradingStart: NOW - 100n, decayRateX32: 68913100933n, initialFee: 1n << 63n, finalFee: 55340232221128654n,
  tickLower: -RANGE.alignedUpperTick, tickUpper: -RANGE.alignedAskTick };

const state = { owner: OWNER as Address, fees: [10n, 20n] as [bigint, bigint], allowance: 0n, quoteOut: 5000n, rpcCalls: 0, apiCalls: 0 };

// The API's v7 golden detail of a launch with the same native quote and default range, moved onto the test deployment.
const goldenApi = JSON.parse(readFileSync(new URL("../fixtures/launchpad/zero-seed-launch-api-v7.golden.json", import.meta.url), "utf8")) as Json;
function launchRow(overrides: Json = {}) {
  const template = goldenApi.l1;
  return {
    ...template, pool_id: POOL_ID,
    pool_key: { ...template.pool_key, core_address: CORE.toLowerCase(), token1: TOKEN.toLowerCase(), config: KEY.config, extension: EXTENSION.toLowerCase() },
    token: { ...template.token, address: TOKEN.toLowerCase(), name: "Zero Seed", symbol: "ZERO" },
    controller: PERIPHERY.toLowerCase(), owner: OWNER.toLowerCase(), creator: OWNER.toLowerCase(), logo_url: null,
    parameters: { ...template.parameters, initial_fee: SCHEDULE.initialFee.toString(), final_fee: SCHEDULE.finalFee.toString(), decay_rate_x32: "68913100933",
      trading_start: SCHEDULE.tradingStart.toString() },
    trading_start: Number(SCHEDULE.tradingStart), status: "trading",
    ...overrides,
  };
}
const page = (data: Json[], next: string | null, extra: Json = {}) => ({
  schema_version: "zero-seed-launch-api/v7", chain_id: "31337", pool_id: POOL_ID, next_cursor: next, as_of: goldenApi.l1.as_of, data, ...extra,
});
const listBody = (data: Json[], extra: Json = {}) => ({ ...goldenApi.list, data, total: data.length, totals: { all: data.length, trading: data.length, upcoming: 0 },
  aggregates: listAggregates(data as never), next_offset: null, ...extra });

function ethCall(tx: { to: string; data: Hex }): Hex {
  const to = getAddress(tx.to);
  if (to === PERIPHERY) {
    const call = decodeFunctionData({ abi: peripheryAbi, data: tx.data });
    if (call.functionName === "launchOwner") return encodeFunctionResult({ abi: peripheryAbi, functionName: "launchOwner", result: state.owner });
    if (call.functionName === "previewInstallation") {
      const p = (call.args as any[])[1];
      const range = launchRange(p.askTick, p.upperTick);
      return encodeFunctionResult({ abi: peripheryAbi, functionName: "previewInstallation", result: {
        token: TOKEN, poolKey: { ...KEY, config: launchPoolConfig(EXTENSION, range.tickSpacing) }, positionId: `0x${"ab".repeat(32)}`,
        initialTick: -range.alignedAskTick, liquidity: 1121810267768648385524834n, installedSupply: p.supply - 492n,
        tickSpacing: range.tickSpacing, askTick: range.alignedAskTick, upperTick: range.alignedUpperTick,
      } as never });
    }
  }
  if (to === EXTENSION) {
    const call = decodeFunctionData({ abi: extensionAbi, data: tx.data });
    if (call.functionName === "getLaunch") return encodeFunctionResult({ abi: extensionAbi, functionName: "getLaunch", result: SCHEDULE as never });
    if (call.functionName === "feeAt") return encodeFunctionResult({ abi: extensionAbi, functionName: "feeAt", result: 9222638624014016259n as never });
    if (call.functionName === "creatorFees") return encodeFunctionResult({ abi: extensionAbi, functionName: "creatorFees", result: state.fees as never });
  }
  if (to === ROUTER) {
    const route = decodeFunctionData({ abi: YUL_ROUTER_ABI, data: tx.data }).args[0] as Hex;
    expect(encodeQuoteCalldata(route).toLowerCase()).toBe(tx.data.toLowerCase());
    return encodeFunctionResult({ abi: YUL_ROUTER_ABI, functionName: "quote", result: [zeroAddress, TOKEN, 1000n, state.quoteOut] });
  }
  if (to === TOKEN) return encodeFunctionResult({ abi: erc20Abi, functionName: "allowance", result: state.allowance });
  throw new Error(`unexpected eth_call to ${to}`);
}

function rpcResult(body: { method: string; params: any[] }): unknown {
  switch (body.method) {
    case "eth_chainId": return "0x7a69";
    case "eth_getBlockByNumber": return { number: "0x10", hash: `0x${"cd".repeat(32)}`, timestamp: numberToHex(NOW) };
    case "eth_getCode": {
      const address = getAddress(body.params[0]);
      if (body.params[1] === "0x1" && address === PERIPHERY) return "0x";
      return address === EXTENSION ? EXTENSION_CODE : address === PERIPHERY ? PERIPHERY_CODE : "0x";
    }
    case "eth_call": return ethCall(body.params[0]);
    default: throw new Error(`unexpected ${body.method}`);
  }
}

let api: (url: URL) => Response | Promise<Response> = (url) => {
  if (url.pathname === "/launches") return Response.json(listBody([launchRow()]));
  if (url.pathname === `/launches/31337/${POOL_ID}`) return Response.json(launchRow());
  if (url.pathname.endsWith("/claims")) {
    const claim = goldenApi["l1/claims?limit=200"].data[0];
    return Response.json(page([claim, claim], null, { totals: goldenApi["l1/claims?limit=200"].totals }));
  }
  if (url.pathname.endsWith("/swaps") || url.pathname.endsWith("/owners")) return Response.json(page([], url.searchParams.get("after_event_id") === null ? "-42" : null));
  return new Response("{}", { status: 404 });
};
const defaultApi = api;

beforeEach(() => {
  Object.assign(state, { owner: OWNER, fees: [10n, 20n], allowance: 0n, quoteOut: 5000n, rpcCalls: 0, apiCalls: 0 });
  api = defaultApi;
  spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    if (url.href === RPC) {
      state.rpcCalls++;
      const body = JSON.parse(String(init!.body));
      return Response.json({ jsonrpc: "2.0", id: 1, result: rpcResult(body) });
    }
    if (url.origin === API) {
      state.apiCalls++;
      return api(url);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
});
afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

async function mcp(path: string, method: string, params: Json, environment: Json = env) {
  const response = await worker.fetch(new Request(`https://mcp.ekubo.org${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }), environment as never, {} as ExecutionContext);
  const text = await response.text();
  return JSON.parse(text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data:"))!.slice(5));
}

async function call(name: string, args: Json, environment: Json = env) {
  const body = await mcp("/mcp/launchpad", "tools/call", { name, arguments: args }, environment);
  return body.result as { isError?: boolean; structuredContent: Json; content: { text: string }[] };
}

const errorOf = async (name: string, args: Json, environment: Json = env) => {
  const result = await call(name, args, environment);
  expect(result.isError).toBe(true);
  return result.structuredContent?.error ?? { message: result.content[0].text };
};

const createArgs = {
  chain_id: "31337", sender: OWNER, name: "Zero Seed", symbol: "ZERO", total_supply: "1000000000",
  ask_tick: -13815500, upper_tick: -9210300, trading_start: String(NOW + 600n),
};

describe("launchpad catalog", () => {
  test("ten tools, choosable from their entries, only at /mcp/launchpad", async () => {
    const tools = (await mcp("/mcp/launchpad", "tools/list", {})).result.tools as Json[];
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "launchpad_get_claims", "launchpad_get_launch", "launchpad_get_owners", "launchpad_get_swaps", "launchpad_list_launches",
      "launchpad_prepare_claim_fees", "launchpad_prepare_create", "launchpad_prepare_trade", "launchpad_prepare_transfer_launch",
      "launchpad_preview_launch",
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(30);
      expect(tool.outputSchema?.type).toBe("object");
      for (const required of tool.inputSchema.required ?? []) expect(tool.inputSchema.properties).toHaveProperty(required);
    }
    const root = (await mcp("/mcp", "tools/list", {})).result.tools as Json[];
    expect(root.some((tool) => tool.name.startsWith("launchpad_"))).toBe(false);
  });
});

describe("support disabled by default", () => {
  test("no deployment: structured refusal before any request", async () => {
    const disabled = { ...baseEnv, LAUNCHPAD_API_URL: API };
    for (const [name, args] of [
      ["launchpad_list_launches", {}],
      ["launchpad_get_launch", { chain_id: "31337", pool_id: POOL_ID }],
      ["launchpad_preview_launch", createArgs],
      ["launchpad_prepare_transfer_launch", { chain_id: "31337", sender: OWNER, pool_id: POOL_ID, new_owner: TRADER }],
    ] as const) {
      const error = await errorOf(name, args, disabled);
      expect(error.code).toBe("launch_support_disabled");
    }
    expect(state.rpcCalls + state.apiCalls).toBe(0);
  });

  test("unconfigured chain, historical contracts and foreign runtimes are refused", async () => {
    expect((await errorOf("launchpad_get_launch", { chain_id: "1", pool_id: POOL_ID })).code).toBe("launch_support_disabled");
    const historical = { ...env, LAUNCHPAD_DEPLOYMENTS: JSON.stringify([{ ...DEPLOYMENT, extension: "0x51bDfB5aB2076B5220B5067Ac29167a56147a139" }]) };
    expect((await errorOf("launchpad_get_launch", { chain_id: "31337", pool_id: POOL_ID }, historical)).code).toBe("launch_deployment_invalid");
    const foreign = { ...env, LAUNCHPAD_DEPLOYMENTS: JSON.stringify([{ ...DEPLOYMENT, periphery: "0x00000000000000000000000000000000000fe002" }]) };
    expect((await errorOf("launchpad_get_launch", { chain_id: "31337", pool_id: POOL_ID }, foreign)).code).toBe("launch_deployment_mismatch");
    expect((await errorOf("launchpad_list_launches", {}, { ...env, LAUNCHPAD_DEPLOYMENTS: "not json" })).code).toBe("launch_deployment_invalid");
  });

  test("deployment_block is required and must be the block the periphery was deployed in", async () => {
    const { deployment_block: _, ...withoutBlock } = DEPLOYMENT;
    const missing = { ...env, LAUNCHPAD_DEPLOYMENTS: JSON.stringify([withoutBlock]) };
    expect((await errorOf("launchpad_get_launch", { chain_id: "31337", pool_id: POOL_ID }, missing)).code).toBe("launch_deployment_invalid");
    for (const block of ["1", "3"]) {
      const wrong = { ...env, LAUNCHPAD_DEPLOYMENTS: JSON.stringify([{ ...DEPLOYMENT, deployment_block: block }]) };
      const error = await errorOf("launchpad_get_launch", { chain_id: "31337", pool_id: POOL_ID }, wrong);
      expect([error.code, error.message.includes("deployment_block")]).toEqual(["launch_deployment_mismatch", true]);
    }
  });
});

describe("create: preview then prepare", () => {
  test("invalid input names the argument before any upstream call", async () => {
    const cases: [Json, string][] = [
      [{ name: "x".repeat(32) }, "name"],
      [{ symbol: "" }, "symbol"],
      [{ total_supply: "1000000000000.000000000000000001" }, "total_supply"],
      [{ total_supply: "0" }, "total_supply"],
      [{ total_supply: "1e9" }, "total_supply"],
      [{ start_price: "1" }, "start_price"],
      [{ initial_fee_percent: "1", final_fee_percent: "2" }, "final_fee_percent"],
      [{ initial_fee_percent: "100" }, "initial_fee_percent"],
      [{ half_life_seconds: "0" }, "half_life_seconds"],
      [{ upper_tick: -13815500 }, "upper_tick"],
    ];
    for (const [override, argument] of cases) {
      const error = await errorOf("launchpad_preview_launch", { ...createArgs, ...override });
      expect([error.code, error.details?.argument]).toEqual(["invalid_argument", argument]);
    }
    expect((await errorOf("launchpad_prepare_create", { ...createArgs, salt: `0x${"11".repeat(32)}`, preview_id: `0x${"22".repeat(32)}`, logo_url: "javascript:alert(1)" })).details.argument).toBe("logo_url");
    const unbound = await errorOf("launchpad_prepare_create", createArgs);
    expect(unbound.message).toContain("salt");
    expect(unbound.message).toContain("preview_id");
    expect(state.rpcCalls + state.apiCalls).toBe(0);
    const missing = await call("launchpad_preview_launch", { chain_id: "31337" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("sender");
  });

  test("boundaries: 31-byte metadata and one trillion tokens are accepted; the start window is enforced", async () => {
    const ok = await call("launchpad_preview_launch", { ...createArgs, name: "n".repeat(31), symbol: "s".repeat(31), total_supply: "1000000000000" });
    expect(ok.isError).toBeUndefined();
    expect(ok.structuredContent.parameters.supply).toBe("1000000000000000000000000000000");
    for (const start of [NOW + 299n, NOW + 86_401n]) {
      const error = await errorOf("launchpad_preview_launch", { ...createArgs, trading_start: String(start) });
      expect([error.code, error.details.argument]).toEqual(["invalid_argument", "trading_start"]);
    }
    expect((await call("launchpad_preview_launch", { ...createArgs, trading_start: String(NOW + 300n) })).isError).toBeUndefined();
    expect((await call("launchpad_preview_launch", { ...createArgs, trading_start: String(NOW + 86_400n) })).isError).toBeUndefined();
  });

  test("preview reports the derived range, fee curve and installation; create is bound to it", async () => {
    const preview = (await call("launchpad_preview_launch", createArgs)).structuredContent;
    expect(preview.range).toMatchObject({ tick_spacing: 17990, installed_ask_tick: -13798330, installed_upper_tick: -9210880 });
    expect(preview.parameters).toMatchObject({ decimals: 18, initial_fee: "9223372036854775808", final_fee: "55340232221128654", decay_rate_x32: "68913100933" });
    expect(preview.parameters.salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(preview.fee_schedule.curve[3]).toEqual({ seconds_after_start: "86400", fee_q64: "4639356258918185573", fee_percent: "25.1500%" });
    expect(preview.installation.uninstalled_remainder).toBe("492");
    expect(preview.disclosures.version).toBe(7);
    expect(preview.disclosures.statements.map((entry: Json) => entry.code)).toEqual(DISCLOSURE_CODES);
    expect(preview.disclosures.statements.at(-1).text).toContain("native ETH");
    expect(JSON.stringify(preview.disclosures)).not.toContain("Zero Seed");
    const args = { ...createArgs, salt: preview.parameters.salt, preview_id: preview.preview_id };

    const mismatch = await errorOf("launchpad_prepare_create", { ...args, trading_start: String(NOW + 601n) });
    expect([mismatch.code, mismatch.details.argument]).toEqual(["preview_mismatch", "preview_id"]);

    const first = (await call("launchpad_prepare_create", { ...args, logo_url: "https://example.org/a.png" })).structuredContent;
    expect(first.execution_plan).toBeUndefined();
    const reference = first.execution_plan_reference;
    const response = await worker.fetch(new Request(reference.url), env as never, {} as ExecutionContext);
    const body = await response.text();
    expect(keccak256(stringToHex(body))).toBe(reference.integrity.value);
    const plan = JSON.parse(body);
    expect(plan.ordered_steps).toHaveLength(1);
    const decoded = decodeFunctionData({ abi: peripheryAbi, data: plan.ordered_steps[0].transaction.data });
    expect(decoded.functionName).toBe("create");
    expect((decoded.args as any[])[1]).toBe("https://example.org/a.png");
    expect((decoded.args as any[])[0].salt).toBe(preview.parameters.salt);
    expect(plan.ordered_steps[0].transaction.to).toBe(PERIPHERY);
    expect(first.details.summary).toContain("becomes the owner");
    expect(first.details.disclosures).toEqual(preview.disclosures);

    // Owner review: the sealed create v6 body describes exactly the planned call, bound to the sealed preview read.
    const review = first.owner_review;
    expect(keccak256(stringToHex(review.artifact.body))).toBe(review.artifact.integrity);
    expect(new TextEncoder().encode(review.artifact.body).length).toBe(review.artifact.bytes);
    const artifact = JSON.parse(review.artifact.body);
    expect(JSON.stringify(artifact)).toBe(review.artifact.body);
    expect(Object.keys(artifact)).toEqual(["schema_version", "scope", "executable", "chain_id", "sender", "target", "data", "value", "pin", "quote",
      "disclosure_version", "build", "requested", "logo_url", "installation", "preview"]);
    expect(artifact).toMatchObject({ schema_version: "zero-seed-local-create/v6", executable: false, sender: OWNER.toLowerCase(), target: PERIPHERY.toLowerCase(),
      data: plan.ordered_steps[0].transaction.data.toLowerCase(), value: "0", logo_url: "https://example.org/a.png", disclosure_version: 7,
      quote: { kind: "native", address: zeroAddress, runtime: null } });
    expect(artifact.pin).toEqual({ chainId: "31337", feeModel: "tick_rate_final", core: CORE.toLowerCase(), extension: EXTENSION.toLowerCase(),
      periphery: PERIPHERY.toLowerCase(), extensionRuntime: keccak256(EXTENSION_CODE as Hex), peripheryRuntime: keccak256(PERIPHERY_CODE as Hex), deploymentBlock: "2",
      extensionAbiSha256: "6a131c2d2f70f85a5e2a54395b9d77c4dd5028a7a4bbf632f3d3364ac61e56eb", peripheryAbiSha256: "5d05426f8190cb0bcd6a021e7aceb46f468708cb36bd5a5d818548650499c839" });
    expect(artifact.build).toEqual({ buildTime: NOW.toString(), executionExpiry: (NOW + 300n).toString(), blockNumber: "16", blockHash: `0x${"cd".repeat(32)}`, blockTime: NOW.toString() });
    expect(artifact.preview).toEqual({ count: 1, read_integrity: review.preview_read.integrity, read_bytes: review.preview_read.bytes });
    expect(JSON.parse(review.preview_read.body)).toMatchObject({ schema_version: "zero-seed-preview-read/v1", block_hash: `0x${"cd".repeat(32)}`, to: PERIPHERY.toLowerCase() });
    const summary = review.owner_summary;
    const { summary_keccak256: hash, ...unhashed } = summary;
    expect(hash).toBe(keccak256(stringToHex(JSON.stringify(unhashed))));
    expect(summary).toMatchObject({ schema_version: "zero-seed-launch-owner-summary/v6", method: "create", selector: "0x9a09bd5d" });
    expect(summary.statements).toEqual(first.details.disclosures.statements.map((entry: Json) => entry.text));
    expect(summary.fields.binding.preview_read_integrity).toBe(review.preview_read.integrity);

    const retry = (await call("launchpad_prepare_create", { ...args, logo_url: "https://example.org/a.png" })).structuredContent;
    expect(retry.execution_plan_reference.integrity).toEqual(reference.integrity);
    expect(retry.execution_plan_reference.url).not.toBe(reference.url);

    const id = reference.url.split("/artifact/")[1];
    store.entries.get(`artifact/${id}`)!.uploaded = new Date(Date.now() - (ARTIFACT_TTL_SECONDS + 1) * 1000);
    expect((await worker.fetch(new Request(reference.url), env as never, {} as ExecutionContext)).status).toBe(404);
  });

  test("a contract refusal becomes a named argument", async () => {
    const refusing = { ...env };
    (globalThis.fetch as any).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      if (body.method === "eth_call") return Response.json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted", data: "0x10074548" } });
      return Response.json({ jsonrpc: "2.0", id: 1, result: rpcResult(body) });
    });
    const error = await errorOf("launchpad_preview_launch", createArgs, refusing);
    expect([error.code, error.details.argument, error.details.contract_error]).toEqual(["invalid_argument", "total_supply", "ZeroLiquidity"]);
  });
});

describe("reads", () => {
  test("list, detail with on-chain state, paging and claim dedupe", async () => {
    const list = (await call("launchpad_list_launches", { status: "trading", sort: "market_cap_usd" })).structuredContent;
    expect(list.launches).toHaveLength(1);
    expect(list.launches[0].token.address).toBe(TOKEN);
    expect([list.total, list.totals]).toEqual([1, { all: 1, trading: 1, upcoming: 0 }]);
    expect(list.aggregates).toMatchObject({ launch_count: 1, trade_count: goldenApi.l1.market.trade_count, by_quote: [{ quote_token: getAddress(`0x${"0".repeat(40)}`), volume: goldenApi.l1.market.volume }],
      usd: { volume: null, market_cap: null, priced_launch_count: 0, excluded_launch_count: 1 } });
    const detail = (await call("launchpad_get_launch", { chain_id: "31337", pool_id: POOL_ID })).structuredContent;
    expect(detail.onchain).toMatchObject({ owner: OWNER, owner_matches_index: true, controller: PERIPHERY, trading_open: true, current_fee_q64: "9222638624014016259",
      unclaimed_fees: { amount0: "10", amount1: "20" } });
    expect(detail.fee_schedule.half_life_seconds).toBe("86400.000001");
    expect(detail.disclosures.statements.map((entry: Json) => entry.code)).toEqual(DISCLOSURE_CODES);
    expect(detail.disclosures.statements[4].text).toContain(`${OWNER.toLowerCase()} is the current launch owner`);
    expect(detail.disclosures.statements.at(-1).text).toBe("Quote trust: the quote is native ETH, which Core accounts for itself. No quote token contract is trusted.");
    const claims = (await call("launchpad_get_claims", { chain_id: "31337", pool_id: POOL_ID })).structuredContent;
    expect(claims.claims).toHaveLength(1);
    const first = (await call("launchpad_get_swaps", { chain_id: "31337", pool_id: POOL_ID })).structuredContent;
    expect(first).toEqual({ swaps: [], next_cursor: "-42", as_of: goldenApi.l1.as_of });
    const second = (await call("launchpad_get_owners", { chain_id: "31337", pool_id: POOL_ID, cursor: "-42" })).structuredContent;
    expect(second).toEqual({ owners: [], next_cursor: null, as_of: goldenApi.l1.as_of });
  });

  test("empty results, unknown launch, filter violations, upstream failure and timeout", async () => {
    api = () => Response.json(listBody([]));
    const empty = (await call("launchpad_list_launches", { owner: OWNER })).structuredContent;
    expect([empty.launches, empty.aggregates]).toEqual([[], { launch_count: 0, trade_count: 0, by_quote: [], usd: { volume: null, market_cap: null, priced_launch_count: 0, excluded_launch_count: 0 } }]);
    api = () => new Response("{}", { status: 404 });
    expect((await errorOf("launchpad_get_launch", { chain_id: "31337", pool_id: POOL_ID })).code).toBe("launch_not_found");
    api = () => Response.json(listBody([launchRow({ status: "upcoming" })]));
    expect((await errorOf("launchpad_list_launches", { status: "trading" })).code).toBe("invalid_upstream_response");
    api = () => Response.json({ data: "nope" });
    expect((await errorOf("launchpad_list_launches", {})).code).toBe("invalid_upstream_response");
    api = () => new Response("boom", { status: 503 });
    const failure = await errorOf("launchpad_list_launches", {});
    expect([failure.code, failure.details.retryable]).toEqual(["upstream_error", true]);
    api = () => { throw new DOMException("timed out", "TimeoutError"); };
    const timeout = await errorOf("launchpad_list_launches", {});
    expect([timeout.code, timeout.details.retryable]).toEqual(["upstream_timeout", true]);
    expect((await errorOf("launchpad_list_launches", {}, { ...env, LAUNCHPAD_API_URL: undefined })).code).toBe("launch_api_not_configured");
  });
});

describe("trade and owner actions", () => {
  test("buy: router plan with the fee-inclusive quote, default slippage and deadline", async () => {
    const result = (await call("launchpad_prepare_trade", { chain_id: "31337", sender: TRADER, pool_id: POOL_ID, side: "buy", amount: "1000" })).structuredContent;
    expect(result.details).toMatchObject({ expected_amount_out: "5000", minimum_amount_out: "4975", slippage_bps: 50, deadline: String(NOW + 1800n),
      creator_fee_percent: "49.9960%", approval_included: false, token_in: zeroAddress, token_out: TOKEN });
    expect(result.execution_plan_reference.artifact_type).toBe("execution_plan");
  });

  test("sell adds an approval only when the allowance is short", async () => {
    const args = { chain_id: "31337", sender: TRADER, pool_id: POOL_ID, side: "sell", amount: "1000" };
    expect((await call("launchpad_prepare_trade", args)).structuredContent.details.approval_included).toBe(true);
    state.allowance = 1000n;
    expect((await call("launchpad_prepare_trade", args)).structuredContent.details.approval_included).toBe(false);
  });

  test("trade refusals", async () => {
    expect((await errorOf("launchpad_prepare_trade", { chain_id: "31337", sender: TRADER, pool_id: POOL_ID, side: "buy", amount: "0" })).details.argument).toBe("amount");
    expect((await errorOf("launchpad_prepare_trade", { chain_id: "31337", sender: TRADER, pool_id: POOL_ID, side: "buy", amount: "1", recipient: CORE })).details.argument).toBe("recipient");
    expect((await call("launchpad_prepare_trade", { chain_id: "31337", sender: TRADER, pool_id: POOL_ID, side: "buy", amount: "1", slippage_bps: 5001 })).isError).toBe(true);
    state.quoteOut = 0n;
    expect((await errorOf("launchpad_prepare_trade", { chain_id: "31337", sender: TRADER, pool_id: POOL_ID, side: "buy", amount: "1000" })).code).toBe("insufficient_liquidity");
  });

  test("claim and transfer check the on-chain owner", async () => {
    const claim = (await call("launchpad_prepare_claim_fees", { chain_id: "31337", sender: OWNER, pool_id: POOL_ID })).structuredContent;
    expect(claim.details.unclaimed).toMatchObject({ amount0: "10", amount1: "20" });
    const claimBody = JSON.parse(claim.owner_review.artifact.body);
    expect(claimBody).toMatchObject({ schema_version: "zero-seed-local-claim/v5", recipient: OWNER.toLowerCase(), pool_key: { token0: zeroAddress, token1: TOKEN.toLowerCase() },
      owner_check: { block_number: "16", pool_id: POOL_ID, launch_owner: OWNER.toLowerCase() }, build: { buildTime: NOW.toString(), executionExpiry: (NOW + 300n).toString() } });
    expect(claim.owner_review.owner_summary).toMatchObject({ method: "claimFees", fields: { recipient: OWNER.toLowerCase() } });
    expect((await errorOf("launchpad_prepare_claim_fees", { chain_id: "31337", sender: TRADER, pool_id: POOL_ID })).code).toBe("not_launch_owner");
    expect((await errorOf("launchpad_prepare_claim_fees", { chain_id: "31337", sender: OWNER, pool_id: POOL_ID, recipient: TOKEN })).details.argument).toBe("recipient");
    state.fees = [0n, 0n];
    expect((await errorOf("launchpad_prepare_claim_fees", { chain_id: "31337", sender: OWNER, pool_id: POOL_ID })).code).toBe("no_fees_to_claim");
    const transfer = (await call("launchpad_prepare_transfer_launch", { chain_id: "31337", sender: OWNER, pool_id: POOL_ID, new_owner: TRADER })).structuredContent;
    expect(transfer.details).toMatchObject({ previous_owner: OWNER, new_owner: TRADER });
    const transferBody = JSON.parse(transfer.owner_review.artifact.body);
    expect(Object.keys(transferBody)).toEqual(["schema_version", "scope", "executable", "chain_id", "sender", "target", "data", "value", "pin", "quote",
      "pool_key", "pool_id", "new_owner", "owner_check", "build"]);
    expect(transferBody).toMatchObject({ schema_version: "zero-seed-local-transfer/v1", pool_id: POOL_ID, new_owner: TRADER.toLowerCase(), owner_check: { launch_owner: OWNER.toLowerCase() } });
    expect(transfer.owner_review.owner_summary).toMatchObject({ method: "transferLaunch", selector: "0x8b1cb36f", fields: { new_owner: TRADER.toLowerCase() } });
    expect((await errorOf("launchpad_prepare_transfer_launch", { chain_id: "31337", sender: OWNER, pool_id: POOL_ID, new_owner: zeroAddress })).details.argument).toBe("new_owner");
    expect((await errorOf("launchpad_prepare_transfer_launch", { chain_id: "31337", sender: OWNER, pool_id: POOL_ID, new_owner: OWNER })).details.argument).toBe("new_owner");
    expect((await errorOf("launchpad_prepare_transfer_launch", { chain_id: "31337", sender: TRADER, pool_id: POOL_ID, new_owner: OWNER })).code).toBe("not_launch_owner");
  });
});
