import { getAddress } from "viem";
import { z } from "zod";
import { ServiceError } from "./core.js";
import { ownershipProofFields, ownershipStep, type OnrampProofEnv } from "./onramp-proof.js";

export const COINBASE_ONRAMP_HOST = "api.cdp.coinbase.com";
export const COINBASE_ONRAMP_PATH = "/platform/v2/onramp/sessions";

const NETWORKS = ["base", "ethereum", "arbitrum", "optimism"] as const;
const NETWORK_CHAIN_IDS: Record<(typeof NETWORKS)[number], number> = { base: 8453, ethereum: 1, arbitrum: 42161, optimism: 10 };
const ASSETS = ["ETH", "USDC"] as const;
const FIAT_CURRENCIES = ["USD", "EUR", "GBP", "CAD"] as const;

export type CoinbaseKeys = {
  COINBASE_CDP_API_KEY_ID?: string;
  COINBASE_CDP_API_KEY_SECRET?: string;
};

export const coinbaseCheckoutSchema = z.strictObject({
  wallet_address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .describe("EVM address that receives the purchase, normally the user's own wallet"),
  asset: z.enum(ASSETS).describe("Crypto to buy: ETH or USDC"),
  network: z.enum(NETWORKS).default("base").describe("Network the purchase is delivered on; default base"),
  payment_currency: z.enum(FIAT_CURRENCIES).default("USD").describe("Fiat currency the user pays with; default USD"),
  payment_amount: z
    .string()
    .regex(/^[1-9][0-9]{0,5}(\.[0-9]{1,2})?$/)
    .optional()
    .describe("Fiat amount to pre-fill including fees, e.g. 50 or 49.99. Omit to let the user choose"),
});

export const createCoinbaseOnrampLinkSchema = coinbaseCheckoutSchema.extend(ownershipProofFields);

export const COINBASE_REDIRECT_PATH = "/onramp/coinbase";

/**
 * Returns a link to this server's redirect, not to Coinbase, once the
 * requester proves control of wallet_address on the delivery network. The
 * session is created when the user's browser follows the link, so it is bound
 * to that browser's IP address, and link previews cannot use up a single-use
 * session.
 */
export async function createCoinbaseOnrampLink(
  keys: CoinbaseKeys & OnrampProofEnv,
  input: z.output<typeof createCoinbaseOnrampLinkSchema>,
  origin: string,
) {
  await coinbaseKey(keys);
  const destinationAddress = getAddress(input.wallet_address);
  const query = new URLSearchParams({
    wallet_address: destinationAddress,
    asset: input.asset,
    network: input.network,
    payment_currency: input.payment_currency,
    ...(input.payment_amount === undefined ? {} : { payment_amount: input.payment_amount }),
  });
  const amount = input.payment_amount === undefined ? "" : ` for ${input.payment_amount} ${input.payment_currency}`;
  const step = await ownershipStep(keys, origin, {
    provider: "coinbase",
    providerName: "Coinbase",
    redirectPath: COINBASE_REDIRECT_PATH,
    query,
    address: destinationAddress,
    chainId: NETWORK_CHAIN_IDS[input.network],
    summary: `${input.asset} on ${input.network}${amount}`,
    issuedAt: input.issued_at,
    signature: input.signature,
  });
  return {
    provider: "coinbase",
    environment: "sandbox",
    ...step,
    request: {
      wallet_address: destinationAddress,
      asset: input.asset,
      network: input.network,
      payment_currency: input.payment_currency,
      payment_amount: input.payment_amount ?? null,
    },
    ...(step.status === "verified"
      ? {
          user_handoff:
            "Show checkout_url to the user to open in a browser before link_expires_at. The page offers Apple Pay without a Coinbase account (US only; the user enters email and phone on the page, never in chat) or continuing with a Coinbase account. Coinbase collects identity and payment; this server never sees card details or funds. Sandbox sessions move no real money.",
        }
      : {}),
    real_payment: "Not available. This endpoint only creates Coinbase sandbox sessions.",
  };
}

/** Creates a Coinbase sandbox session for a redirect request and returns its checkout URL. */
export async function createCoinbaseSession(
  keys: CoinbaseKeys,
  input: z.output<typeof coinbaseCheckoutSchema>,
  ip: string | null,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const { keyId, signingKey } = await coinbaseKey(keys);
  // Coinbase runs a session as a test with no real funds when partnerUserRef
  // starts with "sandbox-"; this server never creates any other kind.
  const body = {
    destinationAddress: getAddress(input.wallet_address),
    destinationNetwork: input.network,
    purchaseCurrency: input.asset,
    paymentCurrency: input.payment_currency,
    ...(input.payment_amount === undefined ? {} : { paymentAmount: input.payment_amount }),
    partnerUserRef: `sandbox-${crypto.randomUUID()}`,
    ...(ip === null ? {} : { clientIp: ip }),
  };
  const parsed = await coinbasePost(keys, COINBASE_ONRAMP_PATH, body, fetcher, keyId, signingKey);
  const url = (parsed as { session?: { onrampUrl?: unknown } }).session?.onrampUrl;
  if (typeof url !== "string" || !url.startsWith("https://pay.coinbase.com/")) {
    throw new ServiceError("invalid_upstream_response", "Coinbase returned no checkout URL; retry once, then report it");
  }
  return url;
}

/**
 * POSTs to a CDP endpoint with a fresh API-key JWT and returns the parsed
 * body. Failures become ServiceErrors carrying Coinbase's errorType, never
 * the key or token.
 */
export async function coinbasePost(
  keys: CoinbaseKeys,
  path: string,
  body: unknown,
  fetcher: typeof fetch = fetch,
  keyId?: string,
  signingKey?: CryptoKey,
): Promise<unknown> {
  const key = keyId !== undefined && signingKey !== undefined ? { keyId, signingKey } : await coinbaseKey(keys);
  const jwt = await coinbaseJwt(key.keyId, key.signingKey, "POST", COINBASE_ONRAMP_HOST, path);
  const response = await fetcher(`https://${COINBASE_ONRAMP_HOST}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const parsed = await responseJson(response);
  if (!response.ok) throw coinbaseError(response.status, parsed);
  return parsed;
}

async function responseJson(response: Response): Promise<unknown> {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ServiceError("invalid_upstream_response", "Coinbase returned a non-JSON response; retry once, then report it", {
      status: response.status,
    });
  }
}

function coinbaseError(status: number, parsed: unknown): ServiceError {
  const error = (parsed ?? {}) as { errorType?: unknown; errorMessage?: unknown; correlationId?: unknown };
  const clientError = status === 400 || status === 404 || status === 429;
  const [code, message] =
    status === 400
      ? ["coinbase_invalid_request", "Coinbase rejected the request; check wallet_address, asset and network, then change the request rather than retrying"]
      : clientError
        ? ["coinbase_refused", "Coinbase refused the request"]
        : ["upstream_error", "Coinbase could not complete the request; retry later"];
  return new ServiceError(code, message, {
    status,
    error_type: typeof error.errorType === "string" ? error.errorType : null,
    error_message: clientError && typeof error.errorMessage === "string" ? error.errorMessage.slice(0, 300) : null,
    correlation_id: typeof error.correlationId === "string" ? error.correlationId : null,
  });
}

async function coinbaseKey(keys: CoinbaseKeys) {
  const keyId = keys.COINBASE_CDP_API_KEY_ID;
  const secret = keys.COINBASE_CDP_API_KEY_SECRET;
  if (!keyId || !secret) {
    throw new ServiceError(
      "coinbase_not_configured",
      "Coinbase checkout is not configured on this server. Do not retry; tell the user card purchases are not available here yet.",
    );
  }
  const raw = decodeBase64(secret);
  if (raw?.length !== 64) {
    throw new ServiceError(
      "coinbase_key_unsupported",
      "This server's Coinbase key is not an Ed25519 key. Do not retry; tell the user card purchases are not available here yet.",
    );
  }
  const signingKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", d: base64Url(raw.subarray(0, 32)), x: base64Url(raw.subarray(32)) },
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  return { keyId, signingKey };
}

/** CDP API-key bearer token, matching generateJwt in @coinbase/cdp-sdk for Ed25519 keys. */
export async function coinbaseJwt(
  keyId: string,
  signingKey: CryptoKey,
  method: string,
  host: string,
  path: string,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const header = { alg: "EdDSA", kid: keyId, typ: "JWT", nonce };
  const claims = { sub: keyId, iss: "cdp", uris: [`${method} ${host}${path}`], iat: now, nbf: now, exp: now + 120 };
  const encoder = new TextEncoder();
  const signingInput = `${base64Url(encoder.encode(JSON.stringify(header)))}.${base64Url(encoder.encode(JSON.stringify(claims)))}`;
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", signingKey, encoder.encode(signingInput)));
  return `${signingInput}.${base64Url(signature)}`;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value.trim()), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
