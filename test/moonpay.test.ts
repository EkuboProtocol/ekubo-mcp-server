import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHmac } from "node:crypto";
import { fakeArtifactStore } from "./fake-r2.js";
import worker from "../src/index.js";
import { parseProtocolFacet } from "../src/protocols.js";
import { LINK_SECRET, owner, withProof } from "./onramp-helpers.js";

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
const sandboxEnv = { ...baseEnv, MOONPAY_PUBLISHABLE_KEY: "pk_test_fixture", MOONPAY_SECRET_KEY: SECRET, ONRAMP_LINK_SECRET: LINK_SECRET };
const context = {} as unknown as ExecutionContext;
const wallet = owner.address.toLowerCase();

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

async function linkFor(args: Record<string, unknown>, env: Record<string, unknown> = sandboxEnv) {
  const { result } = await withProof(async (a) => (await buy(a, env)).json, args);
  expect(result.isError).not.toBe(true);
  return result.structuredContent.checkout_url as string;
}

function open(link: string, headers: Record<string, string>, env: Record<string, unknown> = sandboxEnv) {
  return worker.fetch(new Request(link, { headers }), env as never, context);
}

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

  it("asks wallet_address to sign before returning a link, then links to this server without keys", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const args = { wallet_address: wallet, currency_code: "usdc", base_currency_amount: "50" };
    const { json: first } = await buy(args);
    const challenge = first.result.structuredContent;
    expect(challenge.status).toBe("signature_required");
    expect(challenge).not.toHaveProperty("checkout_url");
    expect(challenge.ownership_proof).toMatchObject({ signer: owner.address, chain_id: "11155111" });
    expect(challenge.ownership_proof.message).toContain(`mcp.ekubo.org wants you to sign in with your Ethereum account:\n${owner.address}`);
    expect(challenge.ownership_proof.message).toContain("USDC on Ethereum Sepolia (sandbox) for 50 USD");
    expect(challenge.ownership_proof.message).toContain("Chain ID: 11155111");
    const json = await withProof(async (a) => (await buy(a)).json, args);
    expect(fetchSpy).not.toHaveBeenCalled();
    const result = json.result.structuredContent;
    expect(result).toMatchObject({ provider: "moonpay", environment: "sandbox", status: "verified" });
    expect(result.delivery.chain_id).toBe("11155111");
    const url = new URL(result.checkout_url);
    expect(`${url.origin}${url.pathname}`).toBe("https://mcp.ekubo.org/onramp/moonpay");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      wallet_address: owner.address,
      currency_code: "usdc",
      base_currency_code: "usd",
      base_currency_amount: "50",
      expires: expect.stringMatching(/^\d+$/),
      proof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(Number(url.searchParams.get("expires")) * 1000 - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(JSON.stringify(json)).not.toContain(SECRET);
    expect(JSON.stringify(json)).not.toContain(LINK_SECRET);
    expect(JSON.stringify(json)).not.toContain("pk_test_fixture");
  });

  it("redirects the browser to a MoonPay URL signed for its IP address", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const link = await linkFor({ wallet_address: wallet, currency_code: "usdc", base_currency_amount: "50" });
    const response = await open(link, { "cf-connecting-ip": "203.0.113.42" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const url = new URL(response.headers.get("location")!);
    expect(url.origin).toBe("https://buy-sandbox.moonpay.com");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      apiKey: "pk_test_fixture",
      currencyCode: "usdc",
      baseCurrencyCode: "usd",
      baseCurrencyAmount: "50",
      walletAddress: owner.address,
      allowedIpAddress: createHmac("sha256", SECRET).update("203.0.113.42").digest("base64"),
    });
    const signature = url.searchParams.get("signature")!;
    url.searchParams.delete("signature");
    expect(createHmac("sha256", SECRET).update(url.search).digest("base64")).toBe(signature);
    expect(response.headers.get("location")!.endsWith(`&signature=${encodeURIComponent(signature)}`)).toBe(true);
  });

  it("hashes the IP in canonical form and prefers True-Client-IP", async () => {
    const link = await linkFor({ wallet_address: wallet, currency_code: "eth" });
    for (const [headers, ip] of [
      [{ "cf-connecting-ip": "2001:0DB8:0000:0000:0000:0000:0000:0001" }, "2001:db8::1"],
      [{ "cf-connecting-ip": "::ffff:203.0.113.42" }, "203.0.113.42"],
      [{ "cf-connecting-ip": "240.1.2.3", "cf-connecting-ipv6": "2001:db8:0:0:1:0:0:1" }, "2001:db8::1:0:0:1"],
      [{ "true-client-ip": "198.51.100.7", "cf-connecting-ip": "203.0.113.42" }, "198.51.100.7"],
    ] as const) {
      const location = new URL((await open(link, headers)).headers.get("location")!);
      expect(location.searchParams.get("allowedIpAddress")).toBe(createHmac("sha256", SECRET).update(ip).digest("base64"));
    }
    const noIp = new URL((await open(link, {})).headers.get("location")!);
    expect(noIp.searchParams.has("allowedIpAddress")).toBe(false);
    expect(noIp.searchParams.has("baseCurrencyAmount")).toBe(false);
  });

  it("answers bad, previewed or unconfigured redirects without signing or leaking keys", async () => {
    const good = await linkFor({ wallet_address: wallet, currency_code: "eth" });
    const unsigned = await open("https://mcp.ekubo.org/onramp/moonpay?wallet_address=" + wallet + "&currency_code=eth", {});
    expect(unsigned.status).toBe(400);
    expect(await unsigned.text()).toContain("invalid_link");
    const head = await worker.fetch(new Request(good, { method: "HEAD" }), sandboxEnv as never, context);
    expect(head.status).toBe(204);
    expect(head.headers.get("location")).toBeNull();
    const post = await worker.fetch(new Request(good, { method: "POST" }), sandboxEnv as never, context);
    expect(post.status).toBe(405);
    const unconfigured = await open(good, {}, { ...baseEnv, ONRAMP_LINK_SECRET: LINK_SECRET });
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.text()).toContain("moonpay_not_configured");
    const live = await open(good, {}, { ...sandboxEnv, MOONPAY_PUBLISHABLE_KEY: "pk_live_fixture", MOONPAY_SECRET_KEY: "sk_live_x" });
    expect(live.status).toBe(502);
    const body = await live.text();
    expect(body).toContain("moonpay_live_keys_refused");
    expect(body).not.toContain("fixture");
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
