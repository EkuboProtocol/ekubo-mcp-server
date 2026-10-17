import { getAddress } from "viem";
import { z } from "zod";
import { ServiceError } from "./core.js";

export const MOONPAY_SANDBOX_WIDGET_URL = "https://buy-sandbox.moonpay.com";

// The only Ethereum assets MoonPay's currencies API marks supportsTestMode.
// Sandbox delivers them on Sepolia, ERC-20s as MoonPay's own test token.
const SANDBOX_CURRENCIES = ["eth", "usdc"] as const;
const FIAT_CURRENCIES = ["usd", "eur", "gbp"] as const;

export type MoonPayKeys = {
  MOONPAY_PUBLISHABLE_KEY?: string;
  MOONPAY_SECRET_KEY?: string;
};

export const createMoonPayBuyLinkSchema = z.strictObject({
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

export async function createMoonPayBuyLink(
  keys: MoonPayKeys,
  input: z.output<typeof createMoonPayBuyLinkSchema>,
) {
  const { publishable, secret } = sandboxKeys(keys);
  const walletAddress = getAddress(input.wallet_address);
  const query = new URLSearchParams({
    apiKey: publishable,
    currencyCode: input.currency_code,
    baseCurrencyCode: input.base_currency_code,
    ...(input.base_currency_amount === undefined
      ? {}
      : { baseCurrencyAmount: input.base_currency_amount }),
    walletAddress,
  });
  const search = `?${query.toString()}`;
  const signature = await moonPaySignature(secret, search);
  return {
    provider: "moonpay",
    environment: "sandbox",
    checkout_url: `${MOONPAY_SANDBOX_WIDGET_URL}/${search}&signature=${encodeURIComponent(signature)}`,
    request: {
      wallet_address: walletAddress,
      currency_code: input.currency_code,
      base_currency_code: input.base_currency_code,
      base_currency_amount: input.base_currency_amount ?? null,
    },
    delivery: {
      network: "Ethereum Sepolia testnet",
      chain_id: "11155111",
      note: "Sandbox delivers 1/100th of the quoted amount; ERC-20 purchases deliver MoonPay's Sepolia test token, not real USDC",
    },
    user_handoff:
      "Show checkout_url to the user to open in a browser. MoonPay collects identity (KYC) and payment on its own page; this server never sees card details or funds. In sandbox only MoonPay's published test cards work and no real money moves.",
    real_payment:
      "Not available. This endpoint signs sandbox links only and refuses live MoonPay keys.",
  };
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
