import { getAddress } from "viem";
import { z } from "zod";
import { ServiceError } from "./core.js";
import { ownershipProofFields, ownershipStep, type OnrampProofEnv } from "./onramp-proof.js";

export const MOONPAY_SANDBOX_WIDGET_URL = "https://buy-sandbox.moonpay.com";

// The only Ethereum assets MoonPay's currencies API marks supportsTestMode.
// Sandbox delivers them on Sepolia, ERC-20s as MoonPay's own test token.
const SANDBOX_CURRENCIES = ["eth", "usdc"] as const;
const FIAT_CURRENCIES = ["usd", "eur", "gbp"] as const;

export type MoonPayKeys = {
  MOONPAY_PUBLISHABLE_KEY?: string;
  MOONPAY_SECRET_KEY?: string;
};

export const moonPayCheckoutSchema = z.strictObject({
  wallet_address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .describe("EVM address that receives the purchase, normally the user's own wallet; MoonPay pre-fills it and the user cannot change it"),
  currency_code: z
    .enum(SANDBOX_CURRENCIES)
    .describe("Crypto to buy: eth (native ETH) or usdc. Sandbox delivers on Sepolia"),
  base_currency_code: z
    .enum(FIAT_CURRENCIES)
    .default("usd")
    .describe("Fiat currency the user pays with; default usd"),
  base_currency_amount: z
    .string()
    .regex(/^[1-9][0-9]{0,5}$/)
    .optional()
    .describe("Whole fiat amount to pre-fill, 1 to 999999; MoonPay enforces its own minimum and maximum. Omit to let the user choose"),
});

export const createMoonPayBuyLinkSchema = moonPayCheckoutSchema.extend(ownershipProofFields);

export const MOONPAY_REDIRECT_PATH = "/onramp/moonpay";
const SANDBOX_CHAIN_ID = 11155111;

/**
 * Returns a link to this server's redirect, not to MoonPay, once the requester
 * proves control of wallet_address. MoonPay binds each signed widget URL to
 * the IP address that will open it, and an MCP call comes from the agent
 * platform rather than the user's browser, so the widget URL is signed only
 * when the user's browser follows the link.
 */
export async function createMoonPayBuyLink(
  keys: MoonPayKeys & OnrampProofEnv,
  input: z.output<typeof createMoonPayBuyLinkSchema>,
  origin: string,
) {
  sandboxKeys(keys);
  const walletAddress = getAddress(input.wallet_address);
  const query = new URLSearchParams({
    wallet_address: walletAddress,
    currency_code: input.currency_code,
    base_currency_code: input.base_currency_code,
    ...(input.base_currency_amount === undefined
      ? {}
      : { base_currency_amount: input.base_currency_amount }),
  });
  const amount = input.base_currency_amount === undefined ? "" : ` for ${input.base_currency_amount} ${input.base_currency_code.toUpperCase()}`;
  const step = await ownershipStep(keys, origin, {
    provider: "moonpay",
    providerName: "MoonPay",
    redirectPath: MOONPAY_REDIRECT_PATH,
    query,
    address: walletAddress,
    chainId: SANDBOX_CHAIN_ID,
    summary: `${input.currency_code.toUpperCase()} on Ethereum Sepolia (sandbox)${amount}`,
    issuedAt: input.issued_at,
    signature: input.signature,
  });
  return {
    provider: "moonpay",
    environment: "sandbox",
    ...step,
    request: {
      wallet_address: walletAddress,
      currency_code: input.currency_code,
      base_currency_code: input.base_currency_code,
      base_currency_amount: input.base_currency_amount ?? null,
    },
    delivery: {
      network: "Ethereum Sepolia testnet",
      chain_id: String(SANDBOX_CHAIN_ID),
      note: "Sandbox delivers 1/100th of the quoted amount; ERC-20 purchases deliver MoonPay's Sepolia test token, not real USDC",
    },
    ...(step.status === "verified"
      ? {
          user_handoff:
            "Show checkout_url to the user to open in a browser before link_expires_at. MoonPay collects identity (KYC) and payment on its own page; this server never sees card details or funds. In sandbox only MoonPay's published test cards work and no real money moves.",
          link_behavior:
            "Opening checkout_url redirects to MoonPay with a widget URL signed for the opening browser's IP address. If MoonPay reports an unverified connection (for example after switching networks or VPNs), open checkout_url again.",
        }
      : {}),
    real_payment:
      "Not available. This endpoint signs sandbox links only and refuses live MoonPay keys.",
  };
}

/**
 * The signed MoonPay widget URL for a redirect request. With the browser's IP
 * it adds allowedIpAddress (HMAC-SHA256 of the IP under the secret key) inside
 * the signed query, so the URL only loads for that IP; without one MoonPay
 * skips IP enforcement but still checks the signature.
 */
export async function moonPayWidgetUrl(
  keys: MoonPayKeys,
  input: z.output<typeof moonPayCheckoutSchema>,
  ip: string | null,
): Promise<string> {
  const { publishable, secret } = sandboxKeys(keys);
  const query = new URLSearchParams({
    apiKey: publishable,
    currencyCode: input.currency_code,
    baseCurrencyCode: input.base_currency_code,
    ...(input.base_currency_amount === undefined
      ? {}
      : { baseCurrencyAmount: input.base_currency_amount }),
    walletAddress: getAddress(input.wallet_address),
  });
  if (ip !== null) query.set("allowedIpAddress", await moonPaySignature(secret, ip));
  const search = `?${query.toString()}`;
  const signature = await moonPaySignature(secret, search);
  return `${MOONPAY_SANDBOX_WIDGET_URL}/${search}&signature=${encodeURIComponent(signature)}`;
}

function sandboxKeys(keys: MoonPayKeys) {
  const publishable = keys.MOONPAY_PUBLISHABLE_KEY;
  const secret = keys.MOONPAY_SECRET_KEY;
  if (!publishable || !secret) {
    throw new ServiceError(
      "moonpay_not_configured",
      "MoonPay checkout is not configured on this server. Do not retry; tell the user card purchases are not available here yet.",
    );
  }
  if (!publishable.startsWith("pk_test_") || !secret.startsWith("sk_test_")) {
    throw new ServiceError(
      "moonpay_live_keys_refused",
      "This server is configured with non-sandbox MoonPay keys, which it refuses to use. Do not retry; tell the user card purchases are not available here yet.",
    );
  }
  return { publishable, secret };
}

export async function moonPaySignature(secret: string, search: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(search)));
  return btoa(String.fromCharCode(...mac));
}
