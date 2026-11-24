import { getAddress } from "viem";
import { z } from "zod";
import { clientIp } from "./client-ip.js";
import {
  COINBASE_REDIRECT_PATH,
  coinbaseCheckoutSchema,
  coinbasePost,
  type CoinbaseKeys,
} from "./coinbase-onramp.js";
import { failureCode, ServiceError } from "./core.js";
import { checkSignedLink, type OnrampProofEnv } from "./onramp-proof.js";
import { enforceToolRate, rateLimitActor, type RateLimitBindings } from "./rate-limit.js";

/**
 * Coinbase guest checkout (Headless Onramp): Apple Pay without a Coinbase
 * account, US only. Coinbase requires the integrator to collect and OTP-verify
 * the buyer's phone and email, so this page collects them in the buyer's
 * browser; they never pass through the agent. Every API call here needs the
 * signed checkout link the MCP tool issued after the wallet ownership proof.
 */
export const GUEST_PATHS = {
  account: `${COINBASE_REDIRECT_PATH}/account`,
  verify: `${COINBASE_REDIRECT_PATH}/verify`,
  confirm: `${COINBASE_REDIRECT_PATH}/confirm`,
  order: `${COINBASE_REDIRECT_PATH}/order`,
} as const;

const VERIFICATIONS_PATH = "/platform/v2/onramp/verifications";
const ORDERS_PATH = "/platform/v2/onramp/orders";
const PAYMENT_ORIGIN = "https://pay.coinbase.com";
const MAX_BODY_BYTES = 4096;

// Sandbox only: codes go to Coinbase's sandbox destinations (+1000...,
// @sandbox.test), which send no real SMS or email and accept 000000, so this
// page can never message real people. Orders validate the phone as a real US
// number, so the buyer enters one and the code goes to its sandbox twin.
const US_PHONE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const SANDBOX_EMAIL = /^[A-Za-z0-9._%+-]{1,64}@sandbox\.test$/;
const VERIFICATION_ID = /^onramp_verification_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const linkField = z.string().min(1).max(1024);
const verifySchema = z.strictObject({
  link: linkField,
  channel: z.enum(["sms", "email"]),
  destination: z.string().max(254),
});
const confirmSchema = z.strictObject({
  link: linkField,
  verification_id: z.string().regex(VERIFICATION_ID),
  code: z.string().regex(/^\d{6}$/),
});
const orderSchema = z.strictObject({
  link: linkField,
  phone: z.string().regex(US_PHONE),
  email: z.string().regex(SANDBOX_EMAIL),
  sms_verification_id: z.string().regex(VERIFICATION_ID),
  email_verification_id: z.string().regex(VERIFICATION_ID),
  agreement_accepted: z.literal(true),
  payment_amount: z
    .string()
    .regex(/^[1-9][0-9]{0,5}(\.[0-9]{1,2})?$/)
    .optional(),
});

type Keys = CoinbaseKeys & OnrampProofEnv & RateLimitBindings;
type Checkout = z.output<typeof coinbaseCheckoutSchema>;

/** Handles the guest checkout routes; null for any other path. */
export async function coinbaseGuest(request: Request, keys: Keys, fetcher: typeof fetch = fetch): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === COINBASE_REDIRECT_PATH) return pageRoute(request, url, keys);
  const handler = API_HANDLERS[url.pathname];
  if (handler === undefined) return null;
  const body = await readJson(request, url);
  if (body instanceof Response) return body;
  const link = await signedCheckout(keys, url.origin, (body as { link?: unknown } | null)?.link);
  if ("status" in link) return jsonError(link.status, link.code);
  // Each call reaches Coinbase, so it draws on the metered-provider budget.
  const rejection = await enforceToolRate(keys, rateLimitActor(request), { units: 1, meteredCalls: 1 });
  if (rejection !== null) return jsonError(429, "rate_limited", { "retry-after": String(rejection.retryAfterSeconds) });
  try {
    return Response.json(await handler(keys, body, link.checkout, request, fetcher), { headers: noStore() });
  } catch (error) {
    return failure(error);
  }
}

function pageRoute(request: Request, url: URL, keys: Keys): Promise<Response> | Response {
  if (request.method === "GET") return checkoutPage(url, keys);
  // Link previews and crawlers get nothing to render.
  if (request.method === "HEAD") return new Response(null, { status: 204, headers: { ...noStore(), "x-robots-tag": "noindex" } });
  return jsonError(405, "method_not_allowed", { allow: "GET, HEAD" });
}

async function readJson(request: Request, url: URL): Promise<unknown> {
  if (request.method !== "POST") return jsonError(405, "method_not_allowed", { allow: "POST" });
  if (request.headers.get("origin") !== url.origin) return jsonError(403, "cross_origin_refused");
  if (!request.headers.get("content-type")?.startsWith("application/json")) return jsonError(415, "json_required");
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return jsonError(413, "body_too_large");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return jsonError(400, "invalid_json");
  }
}

function failure(error: unknown): Response {
  if (error instanceof z.ZodError) return jsonError(400, "invalid_request");
  const code = failureCode(error);
  const details = error instanceof ServiceError ? (error.details as { error_type?: unknown; error_message?: unknown } | undefined) : undefined;
  const status = code === "coinbase_not_configured" ? 503 : code.startsWith("coinbase_") ? 400 : 502;
  return jsonError(status, code, {}, {
    coinbase_error: typeof details?.error_type === "string" ? details.error_type : null,
    message: typeof details?.error_message === "string" ? details.error_message : null,
  });
}

type Handler = (keys: Keys, body: unknown, checkout: Checkout, request: Request, fetcher: typeof fetch) => Promise<unknown>;

const API_HANDLERS: Record<string, Handler> = {
  async [GUEST_PATHS.verify](keys, body, _checkout, _request, fetcher) {
    const input = verifySchema.parse(body);
    const destination = sandboxDestination(input.channel, input.destination);
    const result = (await coinbasePost(keys, VERIFICATIONS_PATH, { channel: input.channel, destination }, fetcher)) as {
      verificationId?: unknown;
      otpExpiresAt?: unknown;
    };
    if (typeof result.verificationId !== "string" || !VERIFICATION_ID.test(result.verificationId)) {
      throw new ServiceError("invalid_upstream_response", "Coinbase returned no verification ID");
    }
    return { verification_id: result.verificationId, expires_at: typeof result.otpExpiresAt === "string" ? result.otpExpiresAt : null };
  },

  async [GUEST_PATHS.confirm](keys, body, _checkout, _request, fetcher) {
    const input = confirmSchema.parse(body);
    await coinbasePost(keys, `${VERIFICATIONS_PATH}/${input.verification_id}/submit`, { otpCode: input.code }, fetcher);
    return { verified: true };
  },

  async [GUEST_PATHS.order](keys, body, checkout, request, fetcher) {
    const input = orderSchema.parse(body);
    if (checkout.payment_currency !== "USD") {
      throw new ServiceError("coinbase_guest_currency_unsupported", "Guest checkout pays in USD only");
    }
    const paymentAmount = checkout.payment_amount ?? input.payment_amount;
    if (paymentAmount === undefined) throw new ServiceError("coinbase_amount_required", "Enter an amount in USD");
    const now = new Date().toISOString();
    const ip = clientIp(request);
    const result = (await coinbasePost(
      keys,
      ORDERS_PATH,
      {
        paymentAmount,
        paymentCurrency: "USD",
        purchaseCurrency: checkout.asset,
        paymentMethod: "GUEST_CHECKOUT_APPLE_PAY",
        destinationAddress: getAddress(checkout.wallet_address),
        destinationNetwork: checkout.network,
        // Coinbase treats any partnerUserRef starting "sandbox-" as a test with
        // no real funds; this server creates no other kind.
        partnerUserRef: `sandbox-${crypto.randomUUID()}`,
        email: input.email,
        phoneNumber: input.phone,
        emailVerificationId: input.email_verification_id,
        smsVerificationId: input.sms_verification_id,
        phoneNumberVerifiedAt: now,
        agreementAcceptedAt: now,
        domain: new URL(request.url).hostname,
        ...(ip === null ? {} : { clientIp: ip }),
      },
      fetcher,
    )) as { paymentLink?: { url?: unknown }; order?: { orderId?: unknown; status?: unknown } };
    const link = result.paymentLink?.url;
    if (typeof link !== "string" || !link.startsWith(`${PAYMENT_ORIGIN}/`)) {
      throw new ServiceError("invalid_upstream_response", "Coinbase returned no payment link");
    }
    return {
      payment_link: link,
      order_id: typeof result.order?.orderId === "string" ? result.order.orderId : null,
    };
  },
};

function sandboxDestination(channel: "sms" | "email", destination: string): string {
  if (channel === "sms" && US_PHONE.test(destination)) return `+1000${destination.slice(-7)}`;
  if (channel === "email" && SANDBOX_EMAIL.test(destination)) return destination;
  throw new ServiceError(
    "coinbase_sandbox_contact_required",
    "Sandbox checkout needs a US mobile number in +1 format (no text is sent) and an email address ending @sandbox.test",
  );
}

async function signedCheckout(
  keys: Keys,
  origin: string,
  link: unknown,
): Promise<{ checkout: Checkout } | { status: number; code: string }> {
  if (typeof link !== "string" || link.length > 1024) return { status: 400, code: "invalid_link" };
  const check = await checkSignedLink(keys, new URL(`${origin}${COINBASE_REDIRECT_PATH}?${link}`));
  if (!check.ok) return check;
  const parsed = coinbaseCheckoutSchema.safeParse(check.params);
  return parsed.success ? { checkout: parsed.data } : { status: 400, code: "invalid_link" };
}

async function checkoutPage(url: URL, keys: Keys): Promise<Response> {
  const check = await checkSignedLink(keys, url);
  const parsed = check.ok ? coinbaseCheckoutSchema.safeParse(check.params) : null;
  if (!check.ok || parsed === null || !parsed.success) {
    const status = check.ok ? 400 : check.status;
    const code = check.ok ? "invalid_link" : check.code;
    return new Response(`This checkout link cannot be used.\n\nError code: ${code}\n`, {
      status,
      headers: { ...noStore(), "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" },
    });
  }
  const nonce = base64(crypto.getRandomValues(new Uint8Array(16)));
  return new Response(pageHtml(parsed.data, url.search.slice(1), nonce), {
    headers: {
      ...noStore(),
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
      "x-frame-options": "DENY",
      "content-security-policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        `frame-src ${PAYMENT_ORIGIN}`,
        "form-action 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    },
  });
}

function pageHtml(checkout: Checkout, link: string, nonce: string): string {
  const address = getAddress(checkout.wallet_address);
  const usd = checkout.payment_currency === "USD";
  const amount = checkout.payment_amount;
  const config = JSON.stringify({ link, paths: GUEST_PATHS, amount: amount ?? null, paymentOrigin: PAYMENT_ORIGIN }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Buy ${escapeHtml(checkout.asset)} on ${escapeHtml(checkout.network)}</title>
<style nonce="${nonce}">
body{font:16px/1.45 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#111}
section{border:1px solid #ddd;border-radius:.6rem;padding:1rem;margin:1rem 0}
label{display:block;margin:.6rem 0 .2rem}input[type=text],input[type=email],input[type=tel]{width:100%;padding:.5rem;box-sizing:border-box}
button,.button{display:inline-block;margin-top:.8rem;padding:.6rem 1rem;border-radius:.4rem;border:0;background:#0052ff;color:#fff;text-decoration:none;cursor:pointer}
.address{font-family:ui-monospace,monospace;word-break:break-all}.note{color:#555;font-size:.9rem}.error{color:#b00020}
iframe{width:100%;height:28rem;border:0}[hidden]{display:none}
</style></head><body>
<h1>Buy ${escapeHtml(checkout.asset)} on ${escapeHtml(checkout.network)}</h1>
<p>Delivered to <span class="address">${escapeHtml(address)}</span>${amount === undefined ? "" : ` for ${escapeHtml(amount)} ${escapeHtml(checkout.payment_currency)}`}.</p>
<p class="note"><strong>Sandbox:</strong> no real money moves. Enter any US mobile number (no text is sent), an email ending @sandbox.test and the code 000000 for both.</p>
${
  usd
    ? `<section id="guest"><h2>Apple Pay, no account needed</h2><p class="note">US residents with a US mobile number only. Coinbase processes the payment.</p>
<div id="contact">
${amount === undefined ? '<label for="amount">Amount (USD)</label><input id="amount" type="text" inputmode="decimal" autocomplete="off">' : ""}
<label for="email">Email</label><input id="email" type="email" autocomplete="email">
<label for="phone">US mobile number</label><input id="phone" type="tel" autocomplete="tel" placeholder="+1">
<label><input id="agree" type="checkbox"> I accept Coinbase's <a href="https://www.coinbase.com/legal/guest-checkout/us" target="_blank" rel="noopener">Guest Checkout Terms</a>, <a href="https://www.coinbase.com/legal/user_agreement" target="_blank" rel="noopener">User Agreement</a> and <a href="https://www.coinbase.com/legal/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</label>
<button id="send" type="button">Send verification codes</button></div>
<div id="codes" hidden><label for="sms-code">Code sent by text</label><input id="sms-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
<label for="email-code">Code sent by email</label><input id="email-code" type="text" inputmode="numeric" maxlength="6">
<button id="verify" type="button">Verify and continue</button></div>
<iframe id="pay" hidden sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" allow="payment" title="Coinbase payment"></iframe>
<p id="status" class="note" role="status"></p></section>`
    : ""
}
<section><h2>Have a Coinbase account?</h2><p class="note">Pay with your Coinbase balance, card or bank account on Coinbase's own page.</p>
<a class="button" href="${escapeHtml(`${GUEST_PATHS.account}?${link}`)}">Continue with Coinbase</a></section>
<script nonce="${nonce}">${PAGE_SCRIPT.replace("__CONFIG__", config)}</script>
</body></html>`;
}

const PAGE_SCRIPT = `(() => {
const config = __CONFIG__;
const $ = (id) => document.getElementById(id);
const status = (text, error) => { const el = $("status"); if (!el) return; el.textContent = text; el.className = error ? "error" : "note"; };
const ids = {};
async function post(path, body) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link: config.link, ...body }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data.error && (data.error.message || data.error.code)) || "Request failed");
  return data;
}
const send = $("send");
if (send) send.addEventListener("click", async () => {
  if (!$("agree").checked) return status("Accept Coinbase's terms to continue.", true);
  send.disabled = true; status("Sending codes...");
  try {
    const [sms, email] = await Promise.all([
      post(config.paths.verify, { channel: "sms", destination: $("phone").value.trim() }),
      post(config.paths.verify, { channel: "email", destination: $("email").value.trim() }),
    ]);
    ids.sms = sms.verification_id; ids.email = email.verification_id;
    $("contact").hidden = true; $("codes").hidden = false; status("Enter the two codes.");
  } catch (error) { status(error.message, true); send.disabled = false; }
});
const verify = $("verify");
if (verify) verify.addEventListener("click", async () => {
  verify.disabled = true; status("Verifying...");
  try {
    await Promise.all([
      post(config.paths.confirm, { verification_id: ids.sms, code: $("sms-code").value.trim() }),
      post(config.paths.confirm, { verification_id: ids.email, code: $("email-code").value.trim() }),
    ]);
    const amount = config.amount === null ? { payment_amount: $("amount").value.trim() } : {};
    const order = await post(config.paths.order, { phone: $("phone").value.trim(), email: $("email").value.trim(), sms_verification_id: ids.sms, email_verification_id: ids.email, agreement_accepted: true, ...amount });
    $("codes").hidden = true; const frame = $("pay"); frame.src = order.payment_link; frame.hidden = false; status("Complete the payment with Apple Pay.");
  } catch (error) { status(error.message, true); verify.disabled = false; }
});
window.addEventListener("message", (event) => {
  if (event.origin !== config.paymentOrigin) return;
  let data = event.data; try { if (typeof data === "string") data = JSON.parse(data); } catch { return; }
  const name = data && data.eventName;
  if (name === "onramp_api.commit_success") status("Payment submitted. Waiting for Coinbase to confirm...");
  else if (name === "onramp_api.polling_success") status("Payment complete. The purchase is on its way to your wallet.");
  else if (name === "onramp_api.cancel") status("Payment cancelled.", true);
  else if (typeof name === "string" && name.endsWith("_error")) status((data.data && data.data.errorMessage) || "Payment failed.", true);
});
})();`;

function jsonError(status: number, code: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  return Response.json({ error: { code, ...extra } }, { status, headers: { ...noStore(), ...headers } });
}

function noStore(): Record<string, string> {
  return { "cache-control": "no-store" };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
