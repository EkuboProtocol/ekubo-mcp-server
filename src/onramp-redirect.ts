import { clientIp } from "./client-ip.js";
import {
  COINBASE_REDIRECT_PATH,
  type CoinbaseKeys,
  coinbaseCheckoutSchema,
  createCoinbaseSession,
} from "./coinbase-onramp.js";
import { GUEST_PATHS } from "./coinbase-guest.js";
import { failureCode, ServiceError } from "./core.js";
import {
  MOONPAY_REDIRECT_PATH,
  MOONPAY_SELL_DONE_PATH,
  MOONPAY_SELL_REDIRECT_PATH,
  type MoonPayKeys,
  moonPayCheckoutSchema,
  moonPaySellCheckoutSchema,
  moonPaySellWidgetUrl,
  moonPayWidgetUrl,
} from "./moonpay.js";
import { COINBASE_SELL_DONE_PATH, COINBASE_SELL_REDIRECT_PATH, coinbaseSellCheckoutSchema, coinbaseSellUrl } from "./coinbase-offramp.js";
import { checkSignedLink, type OnrampProofEnv } from "./onramp-proof.js";
import { enforceToolRate, rateLimitActor, type RateLimitBindings } from "./rate-limit.js";

/**
 * Follows a checkout_url returned by create_moonpay_buy_link or
 * create_coinbase_onramp_link: the provider link is built here, from the
 * user's browser request, so it can be bound to the browser's IP address.
 * Returns null for any other path.
 */
export async function onrampRedirect(
  request: Request,
  keys: Keys,
): Promise<Response | null> {
  const url = new URL(request.url);
  const done = DONE_PAGES[url.pathname];
  if (done !== undefined) return donePage(request, done);
  const provider = PROVIDERS[url.pathname];
  if (provider === undefined) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorPage(405, provider.name, "method_not_allowed", { allow: "GET, HEAD" });
  }
  const link = await checkSignedLink(keys, url, Date.now(), provider.signedPath);
  if (!link.ok) return errorPage(link.status, provider.name, link.code);
  const build = provider.parse(link.params);
  if (build === null) return errorPage(400, provider.name, "invalid_link");
  // A HEAD request (link previews, crawlers) never signs or creates a session.
  if (request.method === "HEAD") return new Response(null, { status: 204, headers: baseHeaders() });
  const limited = await meteredRejection(request, keys, provider);
  if (limited !== null) return limited;
  return redirectTo(request, keys, provider, build, url.origin);
}

/** Opening a metered link calls the provider's API, so it draws on the metered-provider budget. */
async function meteredRejection(request: Request, keys: Keys, provider: Provider): Promise<Response | null> {
  if (!provider.metered) return null;
  const rejection = await enforceToolRate(keys, rateLimitActor(request), { units: 1, meteredCalls: 1 });
  if (rejection === null) return null;
  return errorPage(429, provider.name, "rate_limited", { "retry-after": String(rejection.retryAfterSeconds) });
}

async function redirectTo(request: Request, keys: Keys, provider: Provider, build: Build, origin: string): Promise<Response> {
  try {
    const location = await build(keys, clientIp(request), origin);
    return new Response(null, { status: 302, headers: { ...baseHeaders(), location } });
  } catch (error) {
    const code = failureCode(error);
    const status = error instanceof ServiceError && code.endsWith("_not_configured") ? 503 : 502;
    return errorPage(status, provider.name, code);
  }
}

type Keys = MoonPayKeys & CoinbaseKeys & OnrampProofEnv & RateLimitBindings;
type Build = (keys: Keys, ip: string | null, origin: string) => Promise<string>;

type Provider = { name: string; signedPath: string; metered: boolean; parse: (params: Record<string, string>) => Build | null };

// The Coinbase link opens a page offering guest checkout or a Coinbase account
// (coinbase-guest.ts); only the account choice redirects from here.
const PROVIDERS: Record<string, Provider> = {
  [MOONPAY_REDIRECT_PATH]: {
    name: "MoonPay",
    signedPath: MOONPAY_REDIRECT_PATH,
    metered: false,
    parse(params) {
      const parsed = moonPayCheckoutSchema.safeParse(params);
      return parsed.success ? (keys, ip) => moonPayWidgetUrl(keys, parsed.data, ip) : null;
    },
  },
  [GUEST_PATHS.account]: {
    name: "Coinbase",
    signedPath: COINBASE_REDIRECT_PATH,
    metered: true,
    parse(params) {
      const parsed = coinbaseCheckoutSchema.safeParse(params);
      return parsed.success ? (keys, ip) => createCoinbaseSession(keys, parsed.data, ip) : null;
    },
  },
  [MOONPAY_SELL_REDIRECT_PATH]: {
    name: "MoonPay",
    signedPath: MOONPAY_SELL_REDIRECT_PATH,
    metered: false,
    parse(params) {
      const { external_transaction_id: id, ...rest } = params;
      const parsed = moonPaySellCheckoutSchema.safeParse(rest);
      if (!parsed.success || id === undefined || !/^[0-9a-f-]{36}$/.test(id)) return null;
      return (keys, ip, origin) => moonPaySellWidgetUrl(keys, { ...parsed.data, external_transaction_id: id }, ip, origin);
    },
  },
  [COINBASE_SELL_REDIRECT_PATH]: {
    name: "Coinbase",
    signedPath: COINBASE_SELL_REDIRECT_PATH,
    metered: true,
    parse(params) {
      const { partner_user_ref: ref, ...rest } = params;
      const parsed = coinbaseSellCheckoutSchema.safeParse(rest);
      if (!parsed.success || ref === undefined) return null;
      return (keys, ip, origin) => coinbaseSellUrl(keys, { ...parsed.data, partner_user_ref: ref }, ip, origin);
    },
  },
};

// Where the provider sends the browser after the user confirms a sale. The
// provider's own query (deposit details) is deliberately not echoed: the
// agent reads them from the provider's API.
const DONE_PAGES: Record<string, string> = {
  [MOONPAY_SELL_DONE_PATH]: "MoonPay",
  [COINBASE_SELL_DONE_PATH]: "Coinbase",
};

function donePage(request: Request, provider: string): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorPage(405, provider, "method_not_allowed", { allow: "GET, HEAD" });
  }
  const body = `Your ${provider} sale is confirmed.\n\nGo back to your assistant. It reads the deposit address and exact amount from ${provider} and asks you to approve the transfer from your wallet. Send only to the address ${provider} gives for this sale, before the time limit.\n`;
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers: { ...baseHeaders(), "content-type": "text/plain; charset=utf-8" },
  });
}

function baseHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex",
  };
}

const ERROR_REASONS: Record<number, (provider: string) => string> = {
  400: () => "This checkout link is incomplete, altered or was not issued by this server. Ask your assistant for a new link.",
  405: () => "Open this link in a browser.",
  410: () => "This checkout link has expired. Ask your assistant for a new link.",
  429: () => "Too many checkout attempts from this network. Wait a minute, then open the link again.",
  503: (provider) => `${provider} checkout is not available on this server yet.`,
};

function errorPage(status: number, provider: string, code: string, extra: Record<string, string> = {}): Response {
  const reason =
    ERROR_REASONS[status]?.(provider) ?? `${provider} could not start the checkout. Try opening the link again in a minute.`;
  return new Response(`${reason}\n\nError code: ${code}\n`, {
    status,
    headers: { ...baseHeaders(), "content-type": "text/plain; charset=utf-8", ...extra },
  });
}
