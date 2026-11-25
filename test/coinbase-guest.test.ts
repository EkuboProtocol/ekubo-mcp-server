import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { fakeArtifactStore } from "./fake-r2.js";
import worker from "../src/index.js";
import { LINK_SECRET, owner, withProof } from "./onramp-helpers.js";

const { privateKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
const SECRET = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
const env = {
  ARTIFACT_STORE: fakeArtifactStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ALLOWED_ORIGINS: "https://mcp.ekubo.org",
  COINBASE_CDP_API_KEY_ID: "organizations/fixture/apiKeys/fixture",
  COINBASE_CDP_API_KEY_SECRET: SECRET,
  ONRAMP_LINK_SECRET: LINK_SECRET,
};
const context = {} as unknown as ExecutionContext;
const ORIGIN = "https://mcp.ekubo.org";
const SMS_ID = "onramp_verification_00000000-a312-43a5-b77d-54d79aa1d326";
const EMAIL_ID = "onramp_verification_00000000-fd56-4afd-96a8-11bca90d14c4";
const PAY_URL = "https://pay.coinbase.com/v2/api-onramp/apple-pay?sessionToken=fixture";

type ToolResult = { result: { isError?: boolean; structuredContent: Record<string, any> } };

async function onramp(args: Record<string, unknown>): Promise<ToolResult> {
  const response = await worker.fetch(
    new Request(`${ORIGIN}/mcp/coinbase`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        host: "mcp.ekubo.org",
        origin: ORIGIN,
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_coinbase_onramp_link", arguments: args } }),
    }),
    env as never,
    context,
  );
  const body = await response.text();
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? body.split("\n").find((line) => line.startsWith("data:"))!.slice(5)
    : body;
  return JSON.parse(data) as ToolResult;
}

async function checkoutLink(args: Record<string, unknown> = { asset: "USDC", payment_amount: "50" }) {
  const { result } = await withProof(onramp, { wallet_address: owner.address, ...args });
  return new URL(result.structuredContent.checkout_url as string);
}

function api(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return worker.fetch(
    new Request(`${ORIGIN}/onramp/coinbase/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": "203.0.113.42", ...headers },
      body: JSON.stringify(body),
    }),
    env as never,
    context,
  );
}

function mockCoinbase(respond: (request: Request) => Response) {
  const seen: { url: string; body: any }[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, body: JSON.parse(await request.clone().text()) });
    return respond(request);
  }) as typeof fetch);
  return { seen, spy };
}

afterEach(() => {
  (globalThis.fetch as { mockRestore?: () => void }).mockRestore?.();
});

describe("Coinbase guest checkout page", () => {
  it("renders a locked-down page for a signed link and offers both checkouts", async () => {
    const link = await checkoutLink();
    const response = await worker.fetch(new Request(link), env as never, context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const csp = response.headers.get("content-security-policy")!;
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
    expect(csp).toContain("frame-src https://pay.coinbase.com");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    const html = await response.text();
    expect(html).toContain(owner.address);
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain('id="guest"');
    expect(html).toContain(`/onramp/coinbase/account?${link.search.slice(1).replace(/&/g, "&#38;")}`);
    expect(html).toContain("https://www.coinbase.com/legal/guest-checkout/us");
    expect(html).not.toContain(LINK_SECRET);
    expect(html).not.toContain(SECRET);
  });

  it("refuses unsigned links, answers previews without content and hides guest checkout outside USD", async () => {
    const unsigned = await worker.fetch(new Request(`${ORIGIN}/onramp/coinbase?wallet_address=${owner.address}&asset=ETH`), env as never, context);
    expect(unsigned.status).toBe(400);
    const link = await checkoutLink();
    const head = await worker.fetch(new Request(link, { method: "HEAD" }), env as never, context);
    expect(head.status).toBe(204);
    const eur = await checkoutLink({ asset: "ETH", payment_currency: "EUR" });
    const html = await (await worker.fetch(new Request(eur), env as never, context)).text();
    expect(html).not.toContain('id="guest"');
    expect(html).toContain("Continue with Coinbase");
  });
});

describe("Coinbase guest checkout API", () => {
  it("sends codes only to Coinbase sandbox destinations, never to the entered number", async () => {
    const link = (await checkoutLink()).search.slice(1);
    const { seen } = mockCoinbase(() => Response.json({ verificationId: SMS_ID, otpExpiresAt: "2026-10-20T15:00:00Z" }, { status: 201 }));
    const foreign = await api("verify", { link, channel: "sms", destination: "+447700900123" });
    expect(foreign.status).toBe(400);
    expect(((await foreign.json()) as any).error.code).toBe("coinbase_sandbox_contact_required");
    const realEmail = await api("verify", { link, channel: "email", destination: "someone@example.com" });
    expect(realEmail.status).toBe(400);
    expect(seen).toHaveLength(0);

    const sent = await api("verify", { link, channel: "sms", destination: "+14155552671" });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ verification_id: SMS_ID, expires_at: "2026-10-20T15:00:00Z" });
    expect(seen).toEqual([{ url: "https://api.cdp.coinbase.com/platform/v2/onramp/verifications", body: { channel: "sms", destination: "+10005552671" } }]);
  });

  it("submits codes to the verification Coinbase issued", async () => {
    const link = (await checkoutLink()).search.slice(1);
    const { seen } = mockCoinbase(() => Response.json({ verificationId: SMS_ID }, { status: 200 }));
    const response = await api("confirm", { link, verification_id: SMS_ID, code: "000000" });
    expect(await response.json()).toEqual({ verified: true });
    expect(seen[0]).toEqual({ url: `https://api.cdp.coinbase.com/platform/v2/onramp/verifications/${SMS_ID}/submit`, body: { otpCode: "000000" } });
    const bad = await api("confirm", { link, verification_id: "../orders", code: "000000" });
    expect(bad.status).toBe(400);
  });

  it("creates a sandbox Apple Pay order from the signed link, not from the page", async () => {
    const link = (await checkoutLink()).search.slice(1);
    const { seen } = mockCoinbase(() => Response.json({ order: { orderId: "order-1" }, paymentLink: { url: PAY_URL, paymentLinkType: "PAYMENT_LINK_TYPE_APPLE_PAY_BUTTON" } }, { status: 201 }));
    const response = await api("order", {
      link,
      phone: "+14155552671",
      email: "tester@sandbox.test",
      sms_verification_id: SMS_ID,
      email_verification_id: EMAIL_ID,
      agreement_accepted: true,
      payment_amount: "999",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ payment_link: PAY_URL, order_id: "order-1" });
    expect(seen[0]!.url).toBe("https://api.cdp.coinbase.com/platform/v2/onramp/orders");
    expect(seen[0]!.body).toEqual({
      paymentAmount: "50",
      paymentCurrency: "USD",
      purchaseCurrency: "USDC",
      paymentMethod: "GUEST_CHECKOUT_APPLE_PAY",
      destinationAddress: owner.address,
      destinationNetwork: "base",
      partnerUserRef: expect.stringMatching(/^sandbox-[0-9a-f-]{36}$/),
      email: "tester@sandbox.test",
      phoneNumber: "+14155552671",
      emailVerificationId: EMAIL_ID,
      smsVerificationId: SMS_ID,
      phoneNumberVerifiedAt: expect.any(String),
      agreementAcceptedAt: expect.any(String),
      domain: "mcp.ekubo.org",
      clientIp: "203.0.113.42",
    });
  });

  it("needs an amount, the terms and a payment link from Coinbase", async () => {
    const link = (await checkoutLink({ asset: "ETH" })).search.slice(1);
    const order = { link, phone: "+14155552671", email: "tester@sandbox.test", sms_verification_id: SMS_ID, email_verification_id: EMAIL_ID, agreement_accepted: true };
    mockCoinbase(() => Response.json({ paymentLink: { url: "https://evil.example/pay" } }, { status: 201 }));
    expect(((await (await api("order", order)).json()) as any).error.code).toBe("coinbase_amount_required");
    expect((await api("order", { ...order, agreement_accepted: false, payment_amount: "20" })).status).toBe(400);
    const evil = await api("order", { ...order, payment_amount: "20" });
    expect(evil.status).toBe(502);
    expect(((await evil.json()) as any).error.code).toBe("invalid_upstream_response");
  });

  it("passes Coinbase refusals through without leaking credentials", async () => {
    const link = (await checkoutLink()).search.slice(1);
    mockCoinbase(() =>
      Response.json(
        { errorType: "guest_transaction_limit", errorMessage: "This transaction would exceed the user's weekly guest onramp transaction limit." },
        { status: 429 },
      ),
    );
    const response = await api("order", { link, phone: "+14155552671", email: "tester@sandbox.test", sms_verification_id: SMS_ID, email_verification_id: EMAIL_ID, agreement_accepted: true });
    expect(response.status).toBe(400);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("guest_transaction_limit");
    expect(body).toContain("weekly guest onramp transaction limit");
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain("Bearer");
  });

  it("refuses cross-origin, non-JSON, unsigned and tampered requests before calling Coinbase", async () => {
    const signed = await checkoutLink();
    const { spy } = mockCoinbase(() => Response.json({}));
    const body = { link: signed.search.slice(1), channel: "sms", destination: "+10005550100" };
    expect((await api("verify", body, { origin: "https://evil.example" })).status).toBe(403);
    const form = await worker.fetch(
      new Request(`${ORIGIN}/onramp/coinbase/verify`, { method: "POST", headers: { origin: ORIGIN, "content-type": "text/plain" }, body: JSON.stringify(body) }),
      env as never,
      context,
    );
    expect(form.status).toBe(415);
    expect((await api("verify", { ...body, link: `wallet_address=${owner.address}&asset=ETH` })).status).toBe(400);
    const tampered = new URL(signed);
    tampered.searchParams.set("payment_amount", "5000");
    expect((await api("verify", { ...body, link: tampered.search.slice(1) })).status).toBe(400);
    const get = await worker.fetch(new Request(`${ORIGIN}/onramp/coinbase/order`), env as never, context);
    expect(get.status).toBe(405);
    expect(spy).not.toHaveBeenCalled();
  });
});
