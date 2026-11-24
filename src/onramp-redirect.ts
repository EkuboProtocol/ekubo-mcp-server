import { clientIp } from "./client-ip.js";
import {
  COINBASE_REDIRECT_PATH,
  type CoinbaseKeys,
  coinbaseCheckoutSchema,
  createCoinbaseSession,
} from "./coinbase-onramp.js";
import { GUEST_PATHS } from "./coinbase-guest.js";
import { failureCode, ServiceError } from "./core.js";
import { MOONPAY_REDIRECT_PATH, type MoonPayKeys, moonPayCheckoutSchema, moonPayWidgetUrl } from "./moonpay.js";
import { checkSignedLink, type OnrampProofEnv } from "./onramp-proof.js";

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
  try {
    const location = await build(keys, clientIp(request));
    return new Response(null, { status: 302, headers: { ...baseHeaders(), location } });
  } catch (error) {
    const code = failureCode(error);
    const status = error instanceof ServiceError && code.endsWith("_not_configured") ? 503 : 502;
    return errorPage(status, provider.name, code);
  }
}

type Keys = MoonPayKeys & CoinbaseKeys & OnrampProofEnv;
type Build = (keys: Keys, ip: string | null) => Promise<string>;

type Provider = { name: string; signedPath: string; parse: (params: Record<string, string>) => Build | null };

// The Coinbase link opens a page offering guest checkout or a Coinbase account
// (coinbase-guest.ts); only the account choice redirects from here.
const PROVIDERS: Record<string, Provider> = {
  [MOONPAY_REDIRECT_PATH]: {
    name: "MoonPay",
    signedPath: MOONPAY_REDIRECT_PATH,
    parse(params) {
      const parsed = moonPayCheckoutSchema.safeParse(params);
      return parsed.success ? (keys, ip) => moonPayWidgetUrl(keys, parsed.data, ip) : null;
    },
  },
  [GUEST_PATHS.account]: {
    name: "Coinbase",
    signedPath: COINBASE_REDIRECT_PATH,
    parse(params) {
      const parsed = coinbaseCheckoutSchema.safeParse(params);
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

const ERROR_REASONS: Record<number, (provider: string) => string> = {
  400: () => "This checkout link is incomplete, altered or was not issued by this server. Ask your assistant for a new link.",
  405: () => "Open this link in a browser.",
  410: () => "This checkout link has expired. Ask your assistant for a new link.",
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
