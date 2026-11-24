import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { fakeArtifactStore } from "./fake-r2.js";
import worker from "../src/index.js";
import { LINK_SECRET, owner, withProof } from "./onramp-helpers.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateJwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
const CDP_SECRET = Buffer.concat([Buffer.from(privateJwk.d, "base64url"), Buffer.from(privateJwk.x, "base64url")]).toString("base64");
const KEY_ID = "organizations/fixture-org/apiKeys/fixture-key";
const MP_SECRET_TEST = "sk_test_fixture-secret";
const MP_SECRET_LIVE = "sk_live_fixture-secret";

const baseEnv = {
  ARTIFACT_STORE: fakeArtifactStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ALLOWED_ORIGINS: "https://mcp.ekubo.org",
  ONRAMP_LINK_SECRET: LINK_SECRET,
  COINBASE_CDP_API_KEY_ID: KEY_ID,
  COINBASE_CDP_API_KEY_SECRET: CDP_SECRET,
};
const sandboxEnv = { ...baseEnv, MOONPAY_PUBLISHABLE_KEY: "pk_test_fixture", MOONPAY_SECRET_KEY: MP_SECRET_TEST };
const liveEnv = { ...baseEnv, ONRAMP_MODE: "live", MOONPAY_PUBLISHABLE_KEY: "pk_live_fixture", MOONPAY_SECRET_KEY: MP_SECRET_LIVE };
const context = {} as unknown as ExecutionContext;
const wallet = owner.address.toLowerCase();

type ToolResponse = { result: { isError?: boolean; structuredContent: Record<string, any>; tools?: { name: string }[] } };

async function call(path: string, name: string, args: Record<string, unknown>, env: Record<string, unknown>) {
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
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env as never,
    context,
  );
  const body = await response.text();
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? body.split("\n").find((line) => line.startsWith("data:"))!.slice(5)
    : body;
  return JSON.parse(data) as ToolResponse;
}

async function list(path: string) {
  const response = await worker.fetch(
    new Request(`https://mcp.ekubo.org${path}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        origin: "https://mcp.ekubo.org",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
    sandboxEnv as never,
    context,
  );
  const body = await response.text();
  const line = body.split("\n").find((l) => l.startsWith("data:"));
  return (JSON.parse(line ? line.slice(5) : body) as ToolResponse).result.tools!.map((tool) => tool.name);
}

async function verified(path: string, name: string, args: Record<string, unknown>, env: Record<string, unknown>) {
  const json = await withProof((a) => call(path, name, a, env), args);
  expect(json.result.isError).not.toBe(true);
  return json.result.structuredContent;
}

function open(link: string, env: Record<string, unknown>, headers: Record<string, string> = { "cf-connecting-ip": "203.0.113.42" }) {
  return worker.fetch(new Request(link, { headers }), env as never, context);
}

function mockFetch(respond: (request: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push(request.clone() as unknown as Request);
    return respond(request);
  }) as typeof fetch);
  return seen;
}

function jwtClaims(request: Request) {
  const token = request.headers.get("authorization")!.replace(/^Bearer /, "");
  const [header, claims, signature] = token.split(".");
  expect(verify(null, Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  return JSON.parse(Buffer.from(claims!, "base64url").toString()) as { uris: string[] };
}

afterEach(() => {
  (globalThis.fetch as { mockRestore?: () => void }).mockRestore?.();
});

describe("ramp endpoints list buy and sell tools", () => {
  it("serves buy, sell and sale-status tools on each provider endpoint only", async () => {
    expect(await list("/mcp/moonpay")).toEqual(["create_moonpay_buy_link", "create_moonpay_sell_link", "get_moonpay_sell_transaction"]);
    expect(await list("/mcp/coinbase")).toEqual([
      "create_coinbase_onramp_link",
      "create_coinbase_offramp_link",
      "get_coinbase_offramp_transaction",
    ]);
    const bundled = await list("/mcp");
    expect(bundled.some((tool) => tool.includes("moonpay") || tool.includes("coinbase"))).toBe(false);
  });
});

describe("live mode", () => {
  it("defaults to sandbox unless ONRAMP_MODE is exactly live", async () => {
    for (const mode of [undefined, "LIVE", "production", ""]) {
      const env = { ...liveEnv, ONRAMP_MODE: mode };
      const result = await call("/mcp/moonpay", "create_moonpay_buy_link", { wallet_address: wallet, currency_code: "eth" }, env);
      // Live keys are refused when the mode is not live.
      expect(result.result.structuredContent.error.code).toBe("moonpay_keys_mismatch");
    }
    const testKeysLive = { ...sandboxEnv, ONRAMP_MODE: "live" };
    const refused = await call("/mcp/moonpay", "create_moonpay_buy_link", { wallet_address: wallet, currency_code: "eth" }, testKeysLive);
    expect(refused.result.structuredContent.error.code).toBe("moonpay_keys_mismatch");
    expect(JSON.stringify(refused)).not.toContain("fixture");
  });

  it("signs a live MoonPay buy on Base for the browser's IP", async () => {
    const seen = mockFetch(() => new Response("unexpected", { status: 500 }));
    const args = { wallet_address: wallet, currency_code: "usdc_base", base_currency_amount: "100" };
    const first = await call("/mcp/moonpay", "create_moonpay_buy_link", args, liveEnv);
    expect(first.result.structuredContent.ownership_proof.chain_id).toBe("8453");
    expect(first.result.structuredContent.ownership_proof.message).toContain("USDC on Base for 100 USD");
    const result = await verified("/mcp/moonpay", "create_moonpay_buy_link", args, liveEnv);
    expect(result).toMatchObject({ environment: "live", real_payment: true, delivery: { chain_id: "8453", network: "Base" } });
    const response = await open(result.checkout_url, liveEnv);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://buy.moonpay.com");
    expect(location.searchParams.get("apiKey")).toBe("pk_live_fixture");
    expect(location.searchParams.get("currencyCode")).toBe("usdc_base");
    expect(location.searchParams.get("allowedIpAddress")).toBe(createHmac("sha256", MP_SECRET_LIVE).update("203.0.113.42").digest("base64"));
    const signature = location.searchParams.get("signature")!;
    location.searchParams.delete("signature");
    expect(createHmac("sha256", MP_SECRET_LIVE).update(location.search).digest("base64")).toBe(signature);
    expect(seen).toHaveLength(0);
  });

  it("refuses MoonPay codes sandbox cannot test, before asking for a signature", async () => {
    const result = await call("/mcp/moonpay", "create_moonpay_buy_link", { wallet_address: wallet, currency_code: "eth_base" }, sandboxEnv);
    expect(result.result.structuredContent.error.code).toBe("moonpay_currency_unsupported");
  });

  it("creates live Coinbase sessions without the sandbox reference prefix", async () => {
    const seen = mockFetch(() => Response.json({ session: { onrampUrl: "https://pay.coinbase.com/buy?sessionToken=t" } }, { status: 201 }));
    const result = await verified(
      "/mcp/coinbase",
      "create_coinbase_onramp_link",
      { wallet_address: wallet, asset: "ETH", network: "base", payment_amount: "25" },
      liveEnv,
    );
    expect(result).toMatchObject({ environment: "live", real_payment: true });
    const account = result.checkout_url.replace("/onramp/coinbase?", "/onramp/coinbase/account?");
    const response = await open(account, liveEnv);
    expect(response.status).toBe(302);
    const body = (await seen[0]!.json()) as { partnerUserRef: string; clientIp: string };
    expect(body.partnerUserRef).toMatch(/^[0-9a-f]{8}-/);
    expect(body.clientIp).toBe("203.0.113.42");
  });

  it("shows no sandbox note on the live Coinbase checkout page", async () => {
    const result = await verified("/mcp/coinbase", "create_coinbase_onramp_link", { wallet_address: wallet, asset: "USDC" }, liveEnv);
    const live = await (await open(result.checkout_url, liveEnv)).text();
    expect(live).not.toContain("Sandbox:");
    const sandboxLink = await verified("/mcp/coinbase", "create_coinbase_onramp_link", { wallet_address: wallet, asset: "USDC" }, sandboxEnv);
    expect(await (await open(sandboxLink.checkout_url, sandboxEnv)).text()).toContain("Sandbox:");
  });
});

describe("MoonPay sell", () => {
  const args = { wallet_address: wallet, currency_code: "eth_base", base_currency_amount: "0.05" };

  it("asks the selling wallet to sign, then links to a signed sell widget with a fresh reference", async () => {
    const seen = mockFetch(() => new Response("unexpected", { status: 500 }));
    const first = await call("/mcp/moonpay", "create_moonpay_sell_link", args, liveEnv);
    expect(first.result.structuredContent.ownership_proof.message).toContain("Confirm that this wallet sells through MoonPay: 0.05 ETH on Base for USD.");
    const result = await verified("/mcp/moonpay", "create_moonpay_sell_link", args, liveEnv);
    expect(result).toMatchObject({ environment: "live", real_payment: true, source: { chain_id: "8453" } });
    const id = result.external_transaction_id as string;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    const link = new URL(result.checkout_url);
    expect(link.pathname).toBe("/offramp/moonpay");
    expect(link.searchParams.get("external_transaction_id")).toBe(id);

    const response = await open(result.checkout_url, liveEnv);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://sell.moonpay.com");
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      apiKey: "pk_live_fixture",
      baseCurrencyCode: "eth_base",
      baseCurrencyAmount: "0.05",
      quoteCurrencyCode: "usd",
      refundWalletAddress: owner.address,
      externalTransactionId: id,
      redirectURL: "https://mcp.ekubo.org/offramp/moonpay/done",
    });
    const signature = location.searchParams.get("signature")!;
    location.searchParams.delete("signature");
    expect(createHmac("sha256", MP_SECRET_LIVE).update(location.search).digest("base64")).toBe(signature);
    expect(seen).toHaveLength(0);
  });

  it("refuses a link whose reference was swapped", async () => {
    const result = await verified("/mcp/moonpay", "create_moonpay_sell_link", args, liveEnv);
    const link = new URL(result.checkout_url);
    link.searchParams.set("external_transaction_id", crypto.randomUUID());
    expect((await open(link.toString(), liveEnv)).status).toBe(400);
  });

  it("refuses currencies MoonPay does not buy back", async () => {
    const result = await call("/mcp/moonpay", "create_moonpay_sell_link", { wallet_address: wallet, currency_code: "usdc_optimism" }, liveEnv);
    expect(result.result.structuredContent.error.code).toBe("moonpay_currency_unsupported");
  });

  it("reports a sale not yet started, then the deposit details MoonPay returns", async () => {
    const id = crypto.randomUUID();
    let found = false;
    const deposit = "0x" + "ab".repeat(20);
    const seen = mockFetch((request) => {
      const url = new URL(request.url);
      expect(url.origin + url.pathname).toBe(`https://api.moonpay.com/v3/sell_transactions/ext/${id}`);
      expect(url.searchParams.get("apiKey")).toBe("pk_live_fixture");
      if (!found) return Response.json({ message: "not found" }, { status: 404 });
      return Response.json([
        {
          id: "mp-1",
          status: "waitingForDeposit",
          baseCurrencyAmount: 0.05,
          quoteCurrencyAmount: 150.12,
          quoteExpiresAt: "2026-11-24T22:30:00.000Z",
          baseCurrency: { code: "eth_base", metadata: { chainId: "8453", contractAddress: "0x0000000000000000000000000000000000000000" } },
          quoteCurrency: { code: "usd" },
          depositWallet: { walletAddress: deposit },
        },
      ]);
    });
    const before = await call("/mcp/moonpay", "get_moonpay_sell_transaction", { external_transaction_id: id }, liveEnv);
    expect(before.result.structuredContent).toMatchObject({ status: "not_started" });
    found = true;
    const after = await call("/mcp/moonpay", "get_moonpay_sell_transaction", { external_transaction_id: id }, liveEnv);
    expect(after.result.structuredContent).toMatchObject({
      status: "waitingForDeposit",
      chain_id: "8453",
      amount: "0.05",
      quote_expires_at: "2026-11-24T22:30:00.000Z",
    });
    expect(after.result.structuredContent.deposit_address.toLowerCase()).toBe(deposit);
    expect(JSON.stringify(after)).not.toContain(MP_SECRET_LIVE);
    expect(seen).toHaveLength(2);
  });

  it("serves a plain confirmation page that echoes nothing from the provider", async () => {
    const response = await open("https://mcp.ekubo.org/offramp/moonpay/done?depositWalletAddress=%3Cscript%3E&transactionId=x", liveEnv);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("Go back to your assistant");
    expect(text).not.toContain("script");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("Coinbase sell", () => {
  const args = { wallet_address: wallet, asset: "USDC", network: "base", crypto_amount: "100" };

  it("creates a v1 session token for the browser and redirects to Coinbase's sell page", async () => {
    const seen = mockFetch(() => Response.json({ token: "fixture-session-token", channel_id: "" }));
    const first = await call("/mcp/coinbase", "create_coinbase_offramp_link", args, liveEnv);
    expect(first.result.structuredContent.ownership_proof.message).toContain("Confirm that this wallet sells through Coinbase: 100 USDC on base.");
    const result = await verified("/mcp/coinbase", "create_coinbase_offramp_link", args, liveEnv);
    expect(seen).toHaveLength(0);
    const ref = result.partner_user_ref as string;
    expect(ref).toMatch(/^[0-9a-f]{8}-/);
    expect(ref.length).toBeLessThan(50);

    const response = await open(result.checkout_url, liveEnv);
    expect(response.status).toBe(302);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.developer.coinbase.com/onramp/v1/token");
    expect(jwtClaims(seen[0]!).uris).toEqual(["POST api.developer.coinbase.com/onramp/v1/token"]);
    expect(await seen[0]!.json()).toEqual({
      addresses: [{ address: owner.address, blockchains: ["base"] }],
      assets: ["USDC"],
      clientIp: "203.0.113.42",
    });
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://pay.coinbase.com/v3/sell/input");
    expect(Object.fromEntries(location.searchParams)).toEqual({
      sessionToken: "fixture-session-token",
      partnerUserRef: ref,
      redirectUrl: "https://mcp.ekubo.org/offramp/coinbase/done",
      defaultAsset: "USDC",
      defaultNetwork: "base",
      presetCryptoAmount: "100",
    });
    expect(response.headers.get("location")).not.toContain(CDP_SECRET);
  });

  it("uses a sandbox- reference in sandbox mode", async () => {
    const result = await verified("/mcp/coinbase", "create_coinbase_offramp_link", args, sandboxEnv);
    expect(result.partner_user_ref).toMatch(/^sandbox-/);
    expect(result).toMatchObject({ environment: "sandbox", real_payment: false });
  });

  it("does not call Coinbase for link previews", async () => {
    const seen = mockFetch(() => Response.json({ token: "t" }));
    const result = await verified("/mcp/coinbase", "create_coinbase_offramp_link", args, liveEnv);
    const head = await worker.fetch(new Request(result.checkout_url, { method: "HEAD" }), liveEnv as never, context);
    expect(head.status).toBe(204);
    expect(seen).toHaveLength(0);
  });

  it("reads the newest sale for the reference and returns the deposit details", async () => {
    const ref = crypto.randomUUID();
    const deposit = "0x" + "cd".repeat(20);
    let started = false;
    const seen = mockFetch(() =>
      Response.json(
        started
          ? {
              transactions: [
                {
                  status: "TRANSACTION_STATUS_STARTED",
                  transaction_id: "cb-1",
                  asset: "USDC",
                  network: "base",
                  sell_amount: { value: "100", currency: "USDC" },
                  total: { value: "99.01", currency: "USD" },
                  to_address: deposit,
                  from_address: owner.address,
                  created_at: "2026-11-24T22:00:00.000Z",
                },
              ],
            }
          : { transactions: [], total_count: "0" },
      ),
    );
    const before = await call("/mcp/coinbase", "get_coinbase_offramp_transaction", { partner_user_ref: ref }, liveEnv);
    expect(before.result.structuredContent.status).toBe("not_started");
    started = true;
    const after = await call("/mcp/coinbase", "get_coinbase_offramp_transaction", { partner_user_ref: ref }, liveEnv);
    expect(after.result.structuredContent).toMatchObject({
      status: "STARTED",
      asset: "USDC",
      network: "base",
      chain_id: "8453",
      amount: "100",
      payout: { value: "99.01", currency: "USD" },
      send_by: "2026-11-24T22:30:00.000Z",
    });
    expect(after.result.structuredContent.deposit_address.toLowerCase()).toBe(deposit);
    const path = `/onramp/v1/sell/user/${ref}/transactions`;
    expect(new URL(seen[1]!.url).pathname).toBe(path);
    expect(jwtClaims(seen[1]!).uris).toEqual([`GET api.developer.coinbase.com${path}`]);
  });

  it("rejects references this server could not have issued", async () => {
    const seen = mockFetch(() => Response.json({}));
    const result = await call("/mcp/coinbase", "get_coinbase_offramp_transaction", { partner_user_ref: "../../token" }, liveEnv);
    expect(result.result.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });
});

describe("checkout pages never allow cross-origin reads", () => {
  it("strips CORS from rate-limited and unknown ramp paths", async () => {
    const denying: RateLimit = { limit: async () => ({ success: false }) };
    const env = { ...liveEnv, RATE_LIMITER: denying, RATE_LIMITER_BURST: denying };
    for (const path of ["/onramp/moonpay?x=1", "/offramp/coinbase/done", "/onramp/coinbase/verify"]) {
      const response = await worker.fetch(new Request(`https://mcp.ekubo.org${path}`), env as never, context);
      expect(response.status).toBe(429);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    const unknown = await worker.fetch(new Request("https://mcp.ekubo.org/offramp/elsewhere"), liveEnv as never, context);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("access-control-allow-origin")).toBeNull();
  });
});
