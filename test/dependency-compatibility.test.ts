import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { keccak256, stringToHex } from "viem";
import worker from "../src/index.js";
import { fakeArtifactStore } from "./fake-r2.js";
import { dependencyFixtureNow, dependencyPlanCases, dependencyQuoteCases, dependencyV4PlanCases } from "./dependency-cases.js";
import golden from "./fixtures/dependency-compatibility.json";
import v4Golden from "./fixtures/dependency-v4-compatibility.json";

const env = {
  ARTIFACT_STORE: fakeArtifactStore(), EKUBO_API_URL: "https://api.test", EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused", ACROSS_API_KEY: "unused", ACROSS_INTEGRATOR_ID: "unused",
  LAYER_ZERO_API_KEY: "unused", LI_FI_API_KEY: "unused", DUNE_API_KEY: "unused",
};
const context = {} as ExecutionContext;
type Json = Record<string, any>;

async function rpc(version: string, method: string, params: Json) {
  const modern = version === "2026-07-28";
  const headers: Record<string, string> = {
    "content-type": "application/json", accept: "application/json, text/event-stream",
    "mcp-protocol-version": version, "mcp-method": method,
  };
  if (params.name) headers["mcp-name"] = params.name;
  const response = await worker.fetch(new Request("https://mcp.ekubo.org/mcp", {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {
      ...params, ...(modern ? { _meta: {
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientCapabilities": {},
      } } : {}),
    } }),
  }), env, context);
  const text = await response.text();
  const payload = text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data:"))!.slice(5);
  return { response, body: JSON.parse(payload) };
}

const hash = (value: unknown): string => keccak256(stringToHex(JSON.stringify(value)));

describe("dependency compatibility against the pre-update source fixtures", () => {
  beforeEach(() => { setSystemTime(new Date(dependencyFixtureNow)); });
  afterEach(() => { setSystemTime(); });
  for (const version of ["2025-03-26", "2025-11-25", "2026-07-28"]) {
    it(`${version} keeps initialization, stateless sessions and affected tool schemas`, async () => {
      // Modern MCP is discovery-based and has no initialize method or session.
      const init = version === "2026-07-28"
        ? await rpc(version, "server/discover", {})
        : await rpc(version, "initialize", {
          protocolVersion: version, capabilities: {}, clientInfo: { name: "dependency-fixture", version: "1" },
        });
      expect(init.response.status).toBe(200);
      expect(init.body.error).toBeUndefined();
      if (version !== "2026-07-28") expect(init.body.result.protocolVersion).toBe(version);
      expect(init.response.headers.get("mcp-session-id")).toBeNull();
      const catalog = await rpc(version, "tools/list", {});
      expect(catalog.body.error).toBeUndefined();
      const names = new Set([...dependencyPlanCases.map((entry) => entry.name), "quote_uniswap_liquidity"]);
      const tools = catalog.body.result.tools.filter((tool: Json) => names.has(tool.name));
      expect(hash(tools)).toBe(golden.catalog_hash);
      expect(tools).toHaveLength(names.size);
      expect(tools.every((tool: Json) => tool.outputSchema.type === "object")).toBe(true);
      const v4Names = new Set(dependencyV4PlanCases.map((entry) => entry.name));
      const v4Tools = catalog.body.result.tools.filter((tool: Json) => v4Names.has(tool.name));
      expect(v4Tools).toHaveLength(v4Names.size);
      expect(hash(v4Tools)).toBe(v4Golden.catalog_hash);
      const allNames = catalog.body.result.tools.map((tool: Json) => tool.name);
      expect(allNames.join(" ")).not.toMatch(/launchpad|moonpay|coinbase_onramp/);
    });

    const cases = [...dependencyPlanCases, ...dependencyV4PlanCases];
    const planHashes = [...golden.plan_hashes, ...v4Golden.plan_hashes];
    for (const [index, input] of cases.entries()) {
      it(`${version} preserves exact unsigned bytes for ${input.name} case ${index}`, async () => {
        const { body } = await rpc(version, "tools/call", input);
        expect(body.error).toBeUndefined();
        expect(body.result.isError).not.toBe(true);
        const content = body.result.structuredContent;
        expect(JSON.parse(body.result.content[0].text)).toEqual(content);
        expect(content.execution_plan).toBeUndefined();
        expect(content.wallet_validation_required).toBe(true);
        const reference = content.execution_plan_reference;
        const artifact = await worker.fetch(new Request(reference.url), env, context);
        expect(artifact.status).toBe(200);
        const bytes = await artifact.text();
        expect(keccak256(stringToHex(bytes))).toBe(reference.integrity.value);
        expect(new TextEncoder().encode(bytes).length).toBe(reference.bytes);
        expect(hash(JSON.parse(bytes))).toBe(planHashes[index]);
        expect(JSON.stringify(content)).not.toMatch(/"(signature|transaction_hash|submitted|confirmed)":/);
      });
    }

    for (const [index, args] of dependencyQuoteCases.entries()) {
      it(`${version} preserves liquidity math at price boundary ${index}`, async () => {
        const { body } = await rpc(version, "tools/call", { name: "quote_uniswap_liquidity", arguments: args });
        expect(body.error).toBeUndefined();
        expect(body.result.isError).not.toBe(true);
        expect(body.result.structuredContent).toEqual(golden.quotes[index]);
      });
    }
  }
});
