import { getAddress } from "viem";
import { z } from "zod";
import { ServiceError } from "./core.js";

export const COINBASE_ONRAMP_HOST = "api.cdp.coinbase.com";
export const COINBASE_ONRAMP_PATH = "/platform/v2/onramp/sessions";

const NETWORKS = ["base", "ethereum", "arbitrum", "optimism"] as const;
const ASSETS = ["ETH", "USDC"] as const;
const FIAT_CURRENCIES = ["USD", "EUR", "GBP", "CAD"] as const;

export type CoinbaseKeys = {
  COINBASE_CDP_API_KEY_ID?: string;
  COINBASE_CDP_API_KEY_SECRET?: string;
};

export const createCoinbaseOnrampLinkSchema = z.strictObject({
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

export async function createCoinbaseOnrampLink(
  keys: CoinbaseKeys,
  input: z.output<typeof createCoinbaseOnrampLinkSchema>,
  fetcher: typeof fetch = fetch,
) {
  const { keyId, signingKey } = await coinbaseKey(keys);
  const destinationAddress = getAddress(input.wallet_address);
  // Coinbase runs a session as a test with no real funds when partnerUserRef
  // starts with "sandbox-"; this server never creates any other kind.
  const partnerUserRef = `sandbox-${crypto.randomUUID()}`;
  const body = {
    destinationAddress,
    destinationNetwork: input.network,
    purchaseCurrency: input.asset,
    paymentCurrency: input.payment_currency,
    ...(input.payment_amount === undefined ? {} : { paymentAmount: input.payment_amount }),
    partnerUserRef,
  };
  const jwt = await coinbaseJwt(keyId, signingKey, "POST", COINBASE_ONRAMP_HOST, COINBASE_ONRAMP_PATH);
  const response = await fetcher(`https://${COINBASE_ONRAMP_HOST}${COINBASE_ONRAMP_PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const onrampUrl = await sessionUrl(response);
  return {
    provider: "coinbase",
    environment: "sandbox",
    checkout_url: onrampUrl,
    single_use: true,
    request: {
      wallet_address: destinationAddress,
      asset: input.asset,
      network: input.network,
      payment_currency: input.payment_currency,
      payment_amount: input.payment_amount ?? null,
      partner_user_ref: partnerUserRef,
    },
    user_handoff:
      "Show checkout_url to the user to open in a browser. It works once, for one person. Coinbase collects identity and payment on its own page; this server never sees card details or funds. Sandbox sessions move no real money.",
    real_payment: "Not available. This endpoint only creates Coinbase sandbox sessions.",
  };
}

async function sessionUrl(response: Response): Promise<string> {
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ServiceError("invalid_upstream_response", "Coinbase returned a non-JSON response; retry once, then report it", {
      status: response.status,
    });
  }
  if (!response.ok) {
    const error = parsed as { errorType?: unknown; correlationId?: unknown };
    throw new ServiceError(
      response.status === 400 ? "coinbase_invalid_request" : "upstream_error",
      response.status === 400
        ? "Coinbase rejected the request; check wallet_address, asset and network, then change the request rather than retrying"
        : "Coinbase could not create the session; retry later",
      {
        status: response.status,
        error_type: typeof error.errorType === "string" ? error.errorType : null,
        correlation_id: typeof error.correlationId === "string" ? error.correlationId : null,
      },
    );
  }
  const url = (parsed as { session?: { onrampUrl?: unknown } }).session?.onrampUrl;
  if (typeof url !== "string" || !url.startsWith("https://pay.coinbase.com/")) {
    throw new ServiceError("invalid_upstream_response", "Coinbase returned no checkout URL; retry once, then report it", {
      status: response.status,
    });
  }
  return url;
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
