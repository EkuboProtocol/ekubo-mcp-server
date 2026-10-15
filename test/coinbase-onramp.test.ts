import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { fakeArtifactStore } from "./fake-r2.js";
import worker from "../src/index.js";
import { parseProtocolFacet } from "../src/protocols.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateJwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
const SECRET = Buffer.concat([Buffer.from(privateJwk.d, "base64url"), Buffer.from(privateJwk.x, "base64url")]).toString("base64");
const KEY_ID = "organizations/fixture-org/apiKeys/fixture-key";

const baseEnv = {
  ARTIFACT_STORE: fakeArtifactStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ALLOWED_ORIGINS: "https://mcp.ekubo.org",
};
const configured = { ...baseEnv, COINBASE_CDP_API_KEY_ID: KEY_ID, COINBASE_CDP_API_KEY_SECRET: SECRET };
const context = {} as unknown as ExecutionContext;
const wallet = "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae";
const SESSION_URL = "https://pay.coinbase.com/buy?sessionToken=fixture-token";

type ToolResponse = { result: { isError?: boolean; structuredContent: Record<string, any>; tools?: { name: string }[] } };

async function mcp(method: string, params: Record<string, unknown>, env: Record<string, unknown> = configured, path = "/mcp/coinbase") {
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
  return JSON.parse(data) as ToolResponse;
}

const onramp = (args: Record<string, unknown>, env?: Record<string, unknown>) =>
  mcp("tools/call", { name: "create_coinbase_onramp_link", arguments: args }, env);

function mockCoinbase(respond: (request: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push(request.clone() as unknown as Request);
    return respond(request);
  }) as typeof fetch);
  return { seen, spy };
}

const ok = () => Response.json({ session: { onrampUrl: SESSION_URL } }, { status: 201 });

afterEach(() => {
  (globalThis.fetch as { mockRestore?: () => void }).mockRestore?.();
});

describe("Coinbase Onramp sandbox endpoint", () => {
  it("lists only the onramp tool and stays out of /mcp", async () => {
    const own = await mcp("tools/list", {});
    expect(own.result.tools!.map((tool) => tool.name)).toEqual(["create_coinbase_onramp_link"]);
    const bundled = await mcp("tools/list", {}, configured, "/mcp");
    expect(bundled.result.tools!.some((tool) => tool.name.includes("coinbase"))).toBe(false);
    for (const query of ["protocols=coinbase", "protocols=ekubo+coinbase"]) {
      expect(parseProtocolFacet(new URLSearchParams(query))).toHaveProperty("error");
    }
  });

  it("creates a sandbox session with a CDP JWT that verifies independently", async () => {
    const { seen } = mockCoinbase(ok);
    const json = await onramp({ wallet_address: wallet, asset: "USDC", payment_amount: "49.99" });
    expect(json.result.isError).not.toBe(true);
    expect(seen).toHaveLength(1);
    const request = seen[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.cdp.coinbase.com/platform/v2/onramp/sessions");
    const body = (await request.json()) as Record<string, unknown>;
    expect(body).toEqual({
      destinationAddress: "0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe",
      destinationNetwork: "base",
      purchaseCurrency: "USDC",
      paymentCurrency: "USD",
      paymentAmount: "49.99",
      partnerUserRef: expect.stringMatching(/^sandbox-[0-9a-f-]{36}$/),
    });
    const jwt = request.headers.get("authorization")!.replace(/^Bearer /, "");
    const [encodedHeader, encodedPayload, encodedSignature] = jwt.split(".") as [string, string, string];
    const valid = verify(null, Buffer.from(`${encodedHeader}.${encodedPayload}`), publicKey, Buffer.from(encodedSignature, "base64url"));
    expect(valid).toBe(true);
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString());
    expect(header).toMatchObject({ alg: "EdDSA", kid: KEY_ID, typ: "JWT" });
    expect(header.nonce).toMatch(/^[0-9a-f]{32}$/);
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString());
    expect(payload).toMatchObject({ iss: "cdp", sub: KEY_ID, uris: ["POST api.cdp.coinbase.com/platform/v2/onramp/sessions"] });
    expect(payload.exp - payload.nbf).toBe(120);
    expect(Math.abs(payload.iat - Date.now() / 1000)).toBeLessThan(5);

    const result = json.result.structuredContent;
    expect(result).toMatchObject({ provider: "coinbase", environment: "sandbox", checkout_url: SESSION_URL, single_use: true });
    expect(result.request.partner_user_ref).toBe(body.partnerUserRef);
    expect(JSON.stringify(json)).not.toContain(SECRET);
  });

  it("uses a fresh sandbox reference per session and omits an unset amount", async () => {
    const { seen } = mockCoinbase(ok);
    await onramp({ wallet_address: wallet, asset: "ETH", network: "ethereum" });
    await onramp({ wallet_address: wallet, asset: "ETH", network: "ethereum" });
    const [first, second] = (await Promise.all(seen.map((request) => request.json()))) as Record<string, unknown>[];
    expect(first.partnerUserRef).not.toBe(second.partnerUserRef);
    expect(first).not.toHaveProperty("paymentAmount");
    expect(first.destinationNetwork).toBe("ethereum");
  });

  it("names the bad argument before calling Coinbase", async () => {
    const { spy } = mockCoinbase(ok);
    for (const [args, field] of [
      [{ wallet_address: "0x1234", asset: "ETH" }, "wallet_address"],
      [{ wallet_address: wallet, asset: "BTC" }, "asset"],
      [{ wallet_address: wallet, asset: "ETH", network: "solana" }, "network"],
      [{ wallet_address: wallet, asset: "ETH", payment_amount: "0" }, "payment_amount"],
      [{ wallet_address: wallet, asset: "ETH", payment_amount: "1.234" }, "payment_amount"],
      [{ wallet_address: wallet, asset: "ETH", payment_currency: "JPY" }, "payment_currency"],
    ] as const) {
      const json = await onramp(args);
      expect(json.result.isError).toBe(true);
      expect(JSON.stringify(json.result)).toContain(field);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses when unconfigured or given a non-Ed25519 key, without calling Coinbase", async () => {
    const { spy } = mockCoinbase(ok);
    const unconfigured = await onramp({ wallet_address: wallet, asset: "ETH" }, baseEnv);
    expect(unconfigured.result.structuredContent.error.code).toBe("coinbase_not_configured");
    const ecPem = { ...configured, COINBASE_CDP_API_KEY_SECRET: "-----BEGIN EC PRIVATE KEY-----\nfixture\n-----END EC PRIVATE KEY-----\n" };
    const unsupported = await onramp({ wallet_address: wallet, asset: "ETH" }, ecPem);
    expect(unsupported.result.structuredContent.error.code).toBe("coinbase_key_unsupported");
    expect(JSON.stringify(unsupported)).not.toContain("fixture");
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps Coinbase failures to structured errors without leaking credentials", async () => {
    const cases: [() => Response | Promise<Response>, string][] = [
      [() => Response.json({ errorType: "invalid_request", errorMessage: "bad address", correlationId: "c-1" }, { status: 400 }), "coinbase_invalid_request"],
      [() => Response.json({ errorType: "internal_server_error" }, { status: 500 }), "upstream_error"],
      [() => Response.json({ errorType: "unauthorized" }, { status: 401 }), "upstream_error"],
      [() => new Response("<html>", { status: 502 }), "invalid_upstream_response"],
      [() => Response.json({ session: { onrampUrl: "https://evil.example/buy" } }, { status: 201 }), "invalid_upstream_response"],
      [() => Response.json({}, { status: 201 }), "invalid_upstream_response"],
      [() => Promise.reject(new DOMException("timed out", "TimeoutError")), "upstream_timeout"],
    ];
    for (const [respond, code] of cases) {
      mockCoinbase(respond);
      const json = await onramp({ wallet_address: wallet, asset: "ETH" });
      expect(json.result.isError).toBe(true);
      expect(json.result.structuredContent.error.code).toBe(code);
      expect(JSON.stringify(json)).not.toContain(SECRET);
      expect(JSON.stringify(json)).not.toContain("Bearer");
      (globalThis.fetch as { mockRestore?: () => void }).mockRestore?.();
    }
  });
});
