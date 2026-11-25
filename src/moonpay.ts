import { getAddress } from "viem";
import { z } from "zod";
import { ServiceError } from "./core.js";
import { ownershipProofFields, ownershipStep, type OnrampProofEnv } from "./onramp-proof.js";
import { rampMode, type RampMode, type RampModeEnv } from "./ramp-mode.js";

export const MOONPAY_WIDGET_HOSTS = {
  buy: { sandbox: "https://buy-sandbox.moonpay.com", live: "https://buy.moonpay.com" },
  sell: { sandbox: "https://sell-sandbox.moonpay.com", live: "https://sell.moonpay.com" },
} as const;

const SEPOLIA_CHAIN_ID = 11155111;

/**
 * MoonPay currency codes this server offers, with the chain each delivers on
 * (from GET https://api.moonpay.com/v3/currencies). Sandbox supports only the
 * codes MoonPay marks supportsTestMode, delivered on Sepolia; sell marks the
 * codes MoonPay marks isSellSupported.
 */
export const MOONPAY_CURRENCIES = {
  eth: { asset: "ETH", network: "Ethereum", chainId: 1, testMode: true, sell: true },
  usdc: { asset: "USDC", network: "Ethereum", chainId: 1, testMode: true, sell: true },
  eth_base: { asset: "ETH", network: "Base", chainId: 8453, testMode: false, sell: true },
  usdc_base: { asset: "USDC", network: "Base", chainId: 8453, testMode: false, sell: true },
  eth_arbitrum: { asset: "ETH", network: "Arbitrum", chainId: 42161, testMode: false, sell: true },
  usdc_arbitrum: { asset: "USDC", network: "Arbitrum", chainId: 42161, testMode: false, sell: true },
  eth_optimism: { asset: "ETH", network: "Optimism", chainId: 10, testMode: false, sell: false },
  usdc_optimism: { asset: "USDC", network: "Optimism", chainId: 10, testMode: false, sell: false },
} as const;
export type MoonPayCurrency = keyof typeof MOONPAY_CURRENCIES;
const CURRENCY_CODES = Object.keys(MOONPAY_CURRENCIES) as [MoonPayCurrency, ...MoonPayCurrency[]];
const FIAT_CURRENCIES = ["usd", "eur", "gbp"] as const;

export type MoonPayKeys = RampModeEnv & {
  MOONPAY_PUBLISHABLE_KEY?: string;
  MOONPAY_SECRET_KEY?: string;
};

export const moonPayCheckoutSchema = z.strictObject({
  wallet_address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .describe("EVM address that receives the purchase, normally the user's own wallet; MoonPay pre-fills it and the user cannot change it"),
  currency_code: z
    .enum(CURRENCY_CODES)
    .describe("Crypto to buy, as MoonPay's code: eth or usdc on Ethereum, or eth_/usdc_ with _base, _arbitrum or _optimism. Sandbox offers only eth and usdc, delivered on Sepolia"),
  base_currency_code: z
    .enum(FIAT_CURRENCIES)
    .default("usd")
    .describe("Fiat currency the user pays with; default usd"),
  base_currency_amount: z
    .string()
    .regex(/^[1-9][0-9]{0,5}$/)
    .optional()
    .describe("Whole fiat amount to pre-fill in major units (50 means $50, not base units), 1 to 999999; MoonPay enforces its own minimum and maximum. Omit to let the user choose"),
});

export const createMoonPayBuyLinkSchema = moonPayCheckoutSchema.extend(ownershipProofFields);

export const MOONPAY_REDIRECT_PATH = "/onramp/moonpay";
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
  const { mode } = moonPayKeys(keys);
  const delivery = moonPayDelivery(mode, input.currency_code, "buy");
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
    chainId: delivery.chainId,
    summary: `${delivery.asset} on ${delivery.network}${amount}`,
    issuedAt: input.issued_at,
    signature: input.signature,
  });
  return {
    provider: "moonpay",
    environment: mode,
    ...step,
    request: {
      wallet_address: walletAddress,
      currency_code: input.currency_code,
      base_currency_code: input.base_currency_code,
      base_currency_amount: input.base_currency_amount ?? null,
    },
    delivery: {
      asset: delivery.asset,
      network: delivery.network,
      chain_id: String(delivery.chainId),
      ...(mode === "sandbox"
        ? { note: "Sandbox delivers 1/100th of the quoted amount; ERC-20 purchases deliver MoonPay's Sepolia test token, not real USDC" }
        : {}),
    },
    ...(step.status === "verified"
      ? {
          user_handoff:
            `Show checkout_url to the user to open in a browser before link_expires_at. MoonPay collects identity (KYC) and payment on its own page and sends the crypto to wallet_address; this server never sees card details or funds.${mode === "sandbox" ? " In sandbox only MoonPay's published test cards work and no real money moves." : " This is a real purchase: the user pays MoonPay real money."}`,
          link_behavior:
            "Opening checkout_url redirects to MoonPay with a widget URL signed for the opening browser's IP address. If MoonPay reports an unverified connection (for example after switching networks or VPNs), open checkout_url again.",
        }
      : {}),
    real_payment: mode === "live",
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
  const { publishable, secret, mode } = moonPayKeys(keys);
  moonPayDelivery(mode, input.currency_code, "buy");
  const query = new URLSearchParams({
    apiKey: publishable,
    currencyCode: input.currency_code,
    baseCurrencyCode: input.base_currency_code,
    ...(input.base_currency_amount === undefined
      ? {}
      : { baseCurrencyAmount: input.base_currency_amount }),
    walletAddress: getAddress(input.wallet_address),
  });
  return signedWidgetUrl(MOONPAY_WIDGET_HOSTS.buy[mode], secret, query, ip);
}

/** Signs a widget query, binding it to ip when known (MoonPay IP matching). */
export async function signedWidgetUrl(host: string, secret: string, query: URLSearchParams, ip: string | null): Promise<string> {
  if (ip !== null) query.set("allowedIpAddress", await moonPaySignature(secret, ip));
  const search = `?${query.toString()}`;
  const signature = await moonPaySignature(secret, search);
  return `${host}/${search}&signature=${encodeURIComponent(signature)}`;
}

/** The delivery (buy) or source (sell) chain for a currency code, refusing codes the mode does not offer. */
export function moonPayDelivery(mode: RampMode, code: MoonPayCurrency, side: "buy" | "sell") {
  const currency = MOONPAY_CURRENCIES[code];
  if (side === "sell" && !currency.sell) {
    throw new ServiceError("moonpay_currency_unsupported", `MoonPay does not buy back ${code}; choose eth, usdc or a _base or _arbitrum code`);
  }
  if (mode === "sandbox") {
    if (!currency.testMode) {
      throw new ServiceError("moonpay_currency_unsupported", `MoonPay sandbox supports only eth and usdc (on Sepolia), not ${code}`);
    }
    return { asset: currency.asset, network: "Ethereum Sepolia (sandbox)", chainId: SEPOLIA_CHAIN_ID };
  }
  return { asset: currency.asset, network: currency.network, chainId: currency.chainId };
}

export function moonPayKeys(keys: MoonPayKeys) {
  const mode = rampMode(keys);
  const publishable = keys.MOONPAY_PUBLISHABLE_KEY;
  const secret = keys.MOONPAY_SECRET_KEY;
  if (!publishable || !secret) {
    throw new ServiceError(
      "moonpay_not_configured",
      "MoonPay checkout is not configured on this server. Do not retry; tell the user MoonPay checkout is not available here yet.",
    );
  }
  const prefix = mode === "live" ? "live" : "test";
  if (!publishable.startsWith(`pk_${prefix}_`) || !secret.startsWith(`sk_${prefix}_`)) {
    throw new ServiceError(
      "moonpay_keys_mismatch",
      `This server's MoonPay keys are not ${mode} keys, so it refuses to use them. Do not retry; tell the user MoonPay checkout is not available here right now.`,
    );
  }
  return { publishable, secret, mode };
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

export const MOONPAY_SELL_REDIRECT_PATH = "/offramp/moonpay";
export const MOONPAY_SELL_DONE_PATH = "/offramp/moonpay/done";
const MOONPAY_API = "https://api.moonpay.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const moonPaySellCheckoutSchema = z.strictObject({
  wallet_address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .describe("EVM address that holds the crypto being sold and sends it to MoonPay; MoonPay refunds a failed sale here"),
  currency_code: z
    .enum(CURRENCY_CODES)
    .describe("Crypto to sell, as MoonPay's code: eth or usdc on Ethereum, or eth_base, usdc_base, eth_arbitrum, usdc_arbitrum. MoonPay does not buy back on Optimism. Sandbox offers only eth and usdc on Sepolia"),
  base_currency_amount: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,18})?$/)
    .refine((value) => Number(value) > 0, "must be positive")
    .optional()
    .describe("Amount of crypto to sell in whole units, e.g. 0.05 or 100, not base units or wei; MoonPay enforces its own minimum and maximum. Omit to let the user choose"),
  quote_currency_code: z
    .enum(FIAT_CURRENCIES)
    .default("usd")
    .describe("Fiat currency the user is paid out in; default usd"),
});

export const createMoonPaySellLinkSchema = moonPaySellCheckoutSchema.extend(ownershipProofFields);

/**
 * Off-ramp: after wallet_address proves control, returns a link to this
 * server that redirects to MoonPay's sell widget. The link carries a fresh
 * external transaction ID the agent uses with get_moonpay_sell_transaction to
 * learn where and how much to send once the user confirms the sale.
 */
export async function createMoonPaySellLink(
  keys: MoonPayKeys & OnrampProofEnv,
  input: z.output<typeof createMoonPaySellLinkSchema>,
  origin: string,
) {
  const { mode } = moonPayKeys(keys);
  const source = moonPayDelivery(mode, input.currency_code, "sell");
  const walletAddress = getAddress(input.wallet_address);
  const query = new URLSearchParams({
    wallet_address: walletAddress,
    currency_code: input.currency_code,
    quote_currency_code: input.quote_currency_code,
    ...(input.base_currency_amount === undefined ? {} : { base_currency_amount: input.base_currency_amount }),
  });
  const amount = input.base_currency_amount === undefined ? "" : `${input.base_currency_amount} `;
  const externalTransactionId = crypto.randomUUID();
  const step = await ownershipStep(keys, origin, {
    provider: "moonpay",
    providerName: "MoonPay",
    side: "sell",
    redirectPath: MOONPAY_SELL_REDIRECT_PATH,
    query,
    linkExtras: { external_transaction_id: externalTransactionId },
    address: walletAddress,
    chainId: source.chainId,
    summary: `${amount}${source.asset} on ${source.network} for ${input.quote_currency_code.toUpperCase()}`,
    issuedAt: input.issued_at,
    signature: input.signature,
  });
  return {
    provider: "moonpay",
    environment: mode,
    ...step,
    request: {
      wallet_address: walletAddress,
      currency_code: input.currency_code,
      base_currency_amount: input.base_currency_amount ?? null,
      quote_currency_code: input.quote_currency_code,
    },
    source: { asset: source.asset, network: source.network, chain_id: String(source.chainId) },
    ...(step.status === "verified"
      ? {
          external_transaction_id: externalTransactionId,
          user_handoff:
            "Show checkout_url to the user to open in a browser before link_expires_at. MoonPay collects identity (KYC) and payout details on its own page and then shows a deposit address. The user, not MoonPay, sends the crypto from wallet_address. This server never holds funds.",
          next_step:
            "After the user confirms the sale on MoonPay, call get_moonpay_sell_transaction with external_transaction_id to read the deposit address and exact amount, and send only that amount of that asset on that network from wallet_address, before the quote expires. Never send to an address from any other source.",
        }
      : {}),
    real_payment: mode === "live",
  };
}

/**
 * The signed MoonPay sell widget URL for a redirect request, bound to the
 * browser's IP like buy links (MoonPay rejects the signature without it).
 */
export async function moonPaySellWidgetUrl(
  keys: MoonPayKeys,
  input: z.output<typeof moonPaySellCheckoutSchema> & { external_transaction_id: string },
  ip: string | null,
  origin: string,
): Promise<string> {
  const { publishable, secret, mode } = moonPayKeys(keys);
  moonPayDelivery(mode, input.currency_code, "sell");
  const query = new URLSearchParams({
    apiKey: publishable,
    baseCurrencyCode: input.currency_code,
    ...(input.base_currency_amount === undefined ? {} : { baseCurrencyAmount: input.base_currency_amount }),
    quoteCurrencyCode: input.quote_currency_code,
    refundWalletAddress: getAddress(input.wallet_address),
    externalTransactionId: input.external_transaction_id,
    redirectURL: `${new URL(origin).origin}${MOONPAY_SELL_DONE_PATH}`,
  });
  return signedWidgetUrl(MOONPAY_WIDGET_HOSTS.sell[mode], secret, query, ip);
}

export const getMoonPaySellTransactionSchema = z.strictObject({
  external_transaction_id: z
    .string()
    .regex(UUID)
    .describe("external_transaction_id returned by create_moonpay_sell_link"),
});

type MoonPaySellTransaction = {
  id?: unknown;
  status?: unknown;
  baseCurrencyAmount?: unknown;
  quoteCurrencyAmount?: unknown;
  quoteExpiresAt?: unknown;
  depositHash?: unknown;
  failureReason?: unknown;
  refundWalletAddress?: unknown;
  createdAt?: unknown;
  baseCurrency?: { code?: unknown; metadata?: { chainId?: unknown; contractAddress?: unknown; networkCode?: unknown } };
  quoteCurrency?: { code?: unknown };
  depositWallet?: { walletAddress?: unknown; walletAddressTag?: unknown } | null;
};

/**
 * Reads a sell transaction by the external ID this server issued. The deposit
 * address is returned only as MoonPay reports it for this transaction.
 */
export async function getMoonPaySellTransaction(
  keys: MoonPayKeys,
  input: z.output<typeof getMoonPaySellTransactionSchema>,
  fetcher: typeof fetch = fetch,
) {
  const { publishable, mode } = moonPayKeys(keys);
  const url = `${MOONPAY_API}/v3/sell_transactions/ext/${input.external_transaction_id}?apiKey=${encodeURIComponent(publishable)}`;
  const response = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) {
    return {
      provider: "moonpay",
      environment: mode,
      status: "not_started",
      next_step:
        "MoonPay has no sale with this ID yet. The user has not confirmed the sale on MoonPay's page; ask them to finish it, then call again. Do not send any funds yet.",
    };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ServiceError("invalid_upstream_response", "MoonPay returned a non-JSON response; retry once, then report it", { status: response.status });
  }
  if (!response.ok) {
    throw new ServiceError(response.status >= 500 ? "upstream_error" : "moonpay_refused", "MoonPay could not return the sale; retry later", {
      status: response.status,
    });
  }
  const list = (Array.isArray(parsed) ? parsed : [parsed]) as MoonPaySellTransaction[];
  const tx = list.find((item) => item !== null && typeof item === "object");
  if (tx === undefined) throw new ServiceError("invalid_upstream_response", "MoonPay returned no sale");
  return { provider: "moonpay", environment: mode, ...sellTransactionView(tx) };
}

function sellTransactionView(tx: MoonPaySellTransaction) {
  const status = text(tx.status) ?? "unknown";
  const meta = tx.baseCurrency?.metadata ?? {};
  const deposit = evmAddress(tx.depositWallet?.walletAddress);
  return {
    status,
    transaction_id: text(tx.id),
    currency_code: text(tx.baseCurrency?.code),
    chain_id: numeric(meta.chainId),
    token_address: text(meta.contractAddress),
    amount: numeric(tx.baseCurrencyAmount),
    payout_amount: numeric(tx.quoteCurrencyAmount),
    payout_currency: text(tx.quoteCurrency?.code),
    deposit_address: deposit,
    quote_expires_at: text(tx.quoteExpiresAt),
    deposit_hash: text(tx.depositHash),
    failure_reason: text(tx.failureReason),
    next_step: sellNextStep(status, deposit),
  };
}

const SELL_NEXT_STEPS: Record<string, string> = {
  completed: "The sale is complete; MoonPay pays out to the user's chosen method.",
  failed: "The sale failed; do not send funds. MoonPay refunds any deposit to the refund wallet.",
};

function sellNextStep(status: string, deposit: string | null): string {
  if (status !== "waitingForDeposit") {
    return SELL_NEXT_STEPS[status] ?? "Nothing to send now. Call again later if the user is still completing the sale.";
  }
  return deposit === null
    ? "MoonPay is waiting for the deposit but did not report the address here. Have the user use the deposit details shown on MoonPay's page; do not guess an address."
    : "Send exactly amount of currency_code on chain_id from the sale's wallet to deposit_address before quote_expires_at, with the user's approval in their wallet, then confirm on MoonPay's page. A token_address of 0x000…0 means the native coin.";
}

/** A string field from a provider response, or null. */
export function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A numeric (number or numeric string) provider field as a string, or null. */
export function numeric(value: unknown): string | null {
  return typeof value === "number" || typeof value === "string" ? String(value) : null;
}

/** A checksummed EVM address from a provider response, or null. */
export function evmAddress(value: unknown): `0x${string}` | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? getAddress(value) : null;
}
