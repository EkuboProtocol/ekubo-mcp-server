import { clientIp } from "./client-ip.js";
import {
  COINBASE_REDIRECT_PATH,
  type CoinbaseKeys,
  createCoinbaseOnrampLinkSchema,
  createCoinbaseSession,
} from "./coinbase-onramp.js";
import { failureCode, ServiceError } from "./core.js";
import { createMoonPayBuyLinkSchema, MOONPAY_REDIRECT_PATH, type MoonPayKeys, moonPayWidgetUrl } from "./moonpay.js";

/**
 * Follows a checkout_url returned by create_moonpay_buy_link or
 * create_coinbase_onramp_link: the provider link is built here, from the
 * user's browser request, so it can be bound to the browser's IP address.
 * Returns null for any other path.
 */
export async function onrampRedirect(
  request: Request,
  keys: MoonPayKeys & CoinbaseKeys,
): Promise<Response | null> {
  const url = new URL(request.url);
  const provider = PROVIDERS[url.pathname];
  if (provider === undefined) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorPage(405, provider.name, "method_not_allowed", { allow: "GET, HEAD" });
  }
  const build = provider.parse(Object.fromEntries(url.searchParams));
  if (build === null) return errorPage(400, provider.name, "invalid_link");
  // A HEAD request (link previews, crawlers) never signs or creates a session.
  if (request.method === "HEAD") return new Response(null, { status: 204, headers: baseHeaders() });
  try {
    const location = await build(keys, clientIp(request));
    return new Response(null, { status: 302, headers: { ...baseHeaders(), location } });
  } catch (error) {
    const code = failureCode(error);
    const status = error instanceof ServiceError && code.endsWith("_not_configured") ? 503 : 502;
    return errorPage(status, provider.name, code);
  }
}

type Keys = MoonPayKeys & CoinbaseKeys;
type Build = (keys: Keys, ip: string | null) => Promise<string>;

const PROVIDERS: Record<string, { name: string; parse: (params: Record<string, string>) => Build | null }> = {
  [MOONPAY_REDIRECT_PATH]: {
    name: "MoonPay",
    parse(params) {
      const parsed = createMoonPayBuyLinkSchema.safeParse(params);
      return parsed.success ? (keys, ip) => moonPayWidgetUrl(keys, parsed.data, ip) : null;
    },
  },
  [COINBASE_REDIRECT_PATH]: {
    name: "Coinbase",
    parse(params) {
      const parsed = createCoinbaseOnrampLinkSchema.safeParse(params);
      return parsed.success ? (keys, ip) => createCoinbaseSession(keys, parsed.data, ip) : null;
    },
  },
};

function baseHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex",
  };
}

function errorPage(status: number, provider: string, code: string, extra: Record<string, string> = {}): Response {
  const reason =
    status === 400
      ? "This checkout link is incomplete or malformed. Ask your assistant for a new link."
      : status === 503
        ? `${provider} checkout is not available on this server yet.`
        : status === 405
          ? "Open this link in a browser."
          : `${provider} could not start the checkout. Try opening the link again in a minute.`;
  return new Response(`${reason}\n\nError code: ${code}\n`, {
    status,
    headers: { ...baseHeaders(), "content-type": "text/plain; charset=utf-8", ...extra },
  });
}
