import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHmac } from "node:crypto";
import { fakeArtifactStore } from "./fake-r2.js";
import worker from "../src/index.js";
import { parseProtocolFacet } from "../src/protocols.js";

const SECRET = "sk_test_fixture-secret";
const baseEnv = {
  ARTIFACT_STORE: fakeArtifactStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused",
  ACROSS_API_KEY: "unused",
  ACROSS_INTEGRATOR_ID: "unused",
  LAYER_ZERO_API_KEY: "unused",
  LI_FI_API_KEY: "unused",
  DUNE_API_KEY: "unused",
  ALLOWED_ORIGINS: "https://mcp.ekubo.org",
};
const sandboxEnv = { ...baseEnv, MOONPAY_PUBLISHABLE_KEY: "pk_test_fixture", MOONPAY_SECRET_KEY: SECRET };
const context = {} as unknown as ExecutionContext;
const wallet = "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae";

type ToolResponse = { result: { isError?: boolean; structuredContent: Record<string, any>; tools?: { name: string }[] } };

async function mcp(path: string, method: string, params: Record<string, unknown>, env: Record<string, unknown> = sandboxEnv) {
  const response = await worker.fetch(
    new Request(`https://mcp.ekubo.org${path}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        host: "mcp.ekubo.org",
        origin: "https://mcp.ekubo.org",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env as never,
    context,
  );
  const body = await response.text();
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? body.split("\n").find((line) => line.startsWith("data:"))!.slice(5)
    : body;
  return { status: response.status, json: JSON.parse(data) as ToolResponse };
}

const buy = (args: Record<string, unknown>, env?: Record<string, unknown>) =>
  mcp("/mcp/moonpay", "tools/call", { name: "create_moonpay_buy_link", arguments: args }, env);

afterEach(() => {
  (globalThis.fetch as { mockRestore?: () => void }).mockRestore?.();
});

describe("MoonPay sandbox endpoint", () => {
  it("lists only the buy-link tool and stays out of /mcp", async () => {
    const own = await mcp("/mcp/moonpay", "tools/list", {});
    expect(own.json.result.tools!.map((tool) => tool.name)).toEqual(["create_moonpay_buy_link"]);
    const bundled = await mcp("/mcp", "tools/list", {});
    expect(bundled.json.result.tools!.some((tool) => tool.name.includes("moonpay"))).toBe(false);
    for (const query of ["protocols=moonpay", "protocols=ekubo+moonpay"]) {
      expect(parseProtocolFacet(new URLSearchParams(query))).toHaveProperty("error");
    }
  });

  it("returns a sandbox URL whose signature verifies with MoonPay's documented method", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const { json } = await buy({ wallet_address: wallet, currency_code: "usdc", base_currency_amount: "50" });
    expect(json.result.isError).not.toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    const result = json.result.structuredContent;
    expect(result).toMatchObject({ provider: "moonpay", environment: "sandbox" });
    expect(result.delivery.chain_id).toBe("11155111");
    const url = new URL(result.checkout_url);
    expect(url.origin).toBe("https://buy-sandbox.moonpay.com");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      apiKey: "pk_test_fixture",
      currencyCode: "usdc",
      baseCurrencyCode: "usd",
      baseCurrencyAmount: "50",
      walletAddress: "0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe",
    });
    const signature = url.searchParams.get("signature")!;
    url.searchParams.delete("signature");
    expect(createHmac("sha256", SECRET).update(url.search).digest("base64")).toBe(signature);
    expect(JSON.stringify(json)).not.toContain(SECRET);
  });

  it("omits the amount when the user has not chosen one", async () => {
    const { json } = await buy({ wallet_address: wallet, currency_code: "eth", base_currency_code: "eur" });
    const url = new URL(json.result.structuredContent.checkout_url);
    expect(url.searchParams.has("baseCurrencyAmount")).toBe(false);
    expect(url.searchParams.get("baseCurrencyCode")).toBe("eur");
  });

  it("names the bad argument before signing anything", async () => {
    for (const [args, field] of [
      [{ wallet_address: "0x1234", currency_code: "eth" }, "wallet_address"],
      [{ wallet_address: wallet, currency_code: "btc" }, "currency_code"],
      [{ wallet_address: wallet, currency_code: "eth", base_currency_amount: "0" }, "base_currency_amount"],
      [{ wallet_address: wallet, currency_code: "eth", base_currency_amount: "12.5" }, "base_currency_amount"],
      [{ wallet_address: wallet, currency_code: "eth", base_currency_code: "jpy" }, "base_currency_code"],
      [{ currency_code: "eth" }, "wallet_address"],
    ] as const) {
      const { json } = await buy(args);
      expect(json.result.isError).toBe(true);
      expect(JSON.stringify(json.result)).toContain(field);
    }
  });

  it("refuses when unconfigured or given live keys, without echoing them", async () => {
    const unconfigured = await buy({ wallet_address: wallet, currency_code: "eth" }, baseEnv);
    expect(unconfigured.json.result.structuredContent.error.code).toBe("moonpay_not_configured");
    const live = { ...baseEnv, MOONPAY_PUBLISHABLE_KEY: "pk_live_fixture", MOONPAY_SECRET_KEY: "sk_live_fixture-secret" };
    const refused = await buy({ wallet_address: wallet, currency_code: "eth" }, live);
    expect(refused.json.result.structuredContent.error.code).toBe("moonpay_live_keys_refused");
    expect(JSON.stringify(refused.json)).not.toContain("fixture");
    const mixed = { ...sandboxEnv, MOONPAY_SECRET_KEY: "sk_live_fixture-secret" };
    expect((await buy({ wallet_address: wallet, currency_code: "eth" }, mixed)).json.result.structuredContent.error.code).toBe(
      "moonpay_live_keys_refused",
    );
  });
});
