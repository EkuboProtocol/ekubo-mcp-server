import { getAddress } from "viem";
import { z } from "zod";
import {
  ASSETS,
  coinbaseError,
  coinbaseJwt,
  coinbaseKey,
  type CoinbaseKeys,
  NETWORK_CHAIN_IDS,
  NETWORKS,
  partnerUserRef,
  responseJson,
} from "./coinbase-onramp.js";
import { ServiceError } from "./core.js";
import { evmAddress, numeric, text } from "./moonpay.js";
import { ownershipProofFields, ownershipStep, type OnrampProofEnv } from "./onramp-proof.js";
import { rampMode } from "./ramp-mode.js";

/** Coinbase Offramp still uses the v1 session-token API; there is no v2 offramp session. */
export const COINBASE_V1_HOST = "api.developer.coinbase.com";
const TOKEN_PATH = "/onramp/v1/token";
const SELL_URL = "https://pay.coinbase.com/v3/sell/input";
export const COINBASE_SELL_REDIRECT_PATH = "/offramp/coinbase";
export const COINBASE_SELL_DONE_PATH = "/offramp/coinbase/done";
const REF = /^(sandbox-)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Coinbase cancels a sale whose crypto has not arrived 30 minutes after the user cashes out. */
const SEND_WINDOW_MINUTES = 30;

export const coinbaseSellCheckoutSchema = z.strictObject({
  wallet_address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .describe("EVM address that holds the crypto being sold and sends it to Coinbase"),
  asset: z.enum(ASSETS).describe("Crypto to sell: ETH or USDC"),
  network: z.enum(NETWORKS).default("base").describe("Network the crypto is sent from; default base"),
  crypto_amount: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,18})?$/)
    .refine((value) => Number(value) > 0, "must be positive")
    .optional()
    .describe("Amount of the asset to sell in whole units, e.g. 0.05 or 100. Omit to let the user choose on Coinbase"),
});

export const createCoinbaseOfframpLinkSchema = coinbaseSellCheckoutSchema.extend(ownershipProofFields);

/**
 * Off-ramp: after wallet_address proves control on network, returns a link
 * to this server that creates a Coinbase session token for the user's browser
 * and redirects to Coinbase's sell page. The user needs a Coinbase account;
 * Coinbase pays out to their bank or Coinbase balance. The link carries the
 * partner_user_ref the agent uses with get_coinbase_offramp_transaction.
 */
export async function createCoinbaseOfframpLink(
  keys: CoinbaseKeys & OnrampProofEnv,
  input: z.output<typeof createCoinbaseOfframpLinkSchema>,
  origin: string,
) {
  await coinbaseKey(keys);
  const mode = rampMode(keys);
  const walletAddress = getAddress(input.wallet_address);
  const query = new URLSearchParams({
    wallet_address: walletAddress,
    asset: input.asset,
    network: input.network,
    ...(input.crypto_amount === undefined ? {} : { crypto_amount: input.crypto_amount }),
  });
  const ref = partnerUserRef(mode);
  const amount = input.crypto_amount === undefined ? "" : `${input.crypto_amount} `;
  const step = await ownershipStep(keys, origin, {
    provider: "coinbase",
    providerName: "Coinbase",
    side: "sell",
    redirectPath: COINBASE_SELL_REDIRECT_PATH,
    query,
    linkExtras: { partner_user_ref: ref },
    address: walletAddress,
    chainId: NETWORK_CHAIN_IDS[input.network],
    summary: `${amount}${input.asset} on ${input.network}`,
    issuedAt: input.issued_at,
    signature: input.signature,
  });
  return {
    provider: "coinbase",
    environment: mode,
    ...step,
    request: {
      wallet_address: walletAddress,
      asset: input.asset,
      network: input.network,
      crypto_amount: input.crypto_amount ?? null,
    },
    ...(step.status === "verified"
      ? {
          partner_user_ref: ref,
          user_handoff:
            "Show checkout_url to the user to open in a browser before link_expires_at. Selling needs a Coinbase account with a linked payout method; the user signs in, reviews the quote and presses Cash out on Coinbase's page. The user, not Coinbase, then sends the crypto from wallet_address. This server never holds funds.",
          next_step: `After the user presses Cash out, call get_coinbase_offramp_transaction with partner_user_ref to read the Coinbase deposit address and exact amount, and send only that amount of that asset on that network from wallet_address within ${SEND_WINDOW_MINUTES} minutes. Never send to an address from any other source.`,
        }
      : {}),
    real_payment: mode === "live",
  };
}

/** Creates a session token bound to the browser's IP and returns Coinbase's sell URL. */
export async function coinbaseSellUrl(
  keys: CoinbaseKeys,
  input: z.output<typeof coinbaseSellCheckoutSchema> & { partner_user_ref: string },
  ip: string | null,
  origin: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (!REF.test(input.partner_user_ref)) throw new ServiceError("invalid_link", "The link's reference is malformed");
  const { keyId, signingKey } = await coinbaseKey(keys);
  const jwt = await coinbaseJwt(keyId, signingKey, "POST", COINBASE_V1_HOST, TOKEN_PATH);
  const response = await fetcher(`https://${COINBASE_V1_HOST}${TOKEN_PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      addresses: [{ address: getAddress(input.wallet_address), blockchains: [input.network] }],
      assets: [input.asset],
      ...(ip === null ? {} : { clientIp: ip }),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const parsed = await responseJson(response);
  if (!response.ok) throw coinbaseError(response.status, parsed);
  const token = (parsed as { token?: unknown }).token;
  if (typeof token !== "string" || token.length === 0) {
    throw new ServiceError("invalid_upstream_response", "Coinbase returned no session token; retry once, then report it");
  }
  const query = new URLSearchParams({
    sessionToken: token,
    partnerUserRef: input.partner_user_ref,
    redirectUrl: `${new URL(origin).origin}${COINBASE_SELL_DONE_PATH}`,
    defaultAsset: input.asset,
    defaultNetwork: input.network,
    ...(input.crypto_amount === undefined ? {} : { presetCryptoAmount: input.crypto_amount }),
  });
  return `${SELL_URL}?${query.toString()}`;
}

export const getCoinbaseOfframpTransactionSchema = z.strictObject({
  partner_user_ref: z.string().regex(REF).describe("partner_user_ref returned by create_coinbase_offramp_link"),
});

type Amount = { value?: unknown; currency?: unknown } | undefined;
type SellTransaction = {
  status?: unknown;
  transaction_id?: unknown;
  asset?: unknown;
  network?: unknown;
  sell_amount?: Amount;
  total?: Amount;
  to_address?: unknown;
  from_address?: unknown;
  tx_hash?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

/** Reads the newest Coinbase sell transaction for a partner_user_ref this server issued. */
export async function getCoinbaseOfframpTransaction(
  keys: CoinbaseKeys,
  input: z.output<typeof getCoinbaseOfframpTransactionSchema>,
  fetcher: typeof fetch = fetch,
) {
  const mode = rampMode(keys);
  const { keyId, signingKey } = await coinbaseKey(keys);
  const path = `/onramp/v1/sell/user/${input.partner_user_ref}/transactions`;
  const jwt = await coinbaseJwt(keyId, signingKey, "GET", COINBASE_V1_HOST, path);
  const response = await fetcher(`https://${COINBASE_V1_HOST}${path}?page_size=1`, {
    headers: { authorization: `Bearer ${jwt}`, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const parsed = await responseJson(response);
  if (!response.ok) throw coinbaseError(response.status, parsed);
  const tx = ((parsed as { transactions?: unknown }).transactions as SellTransaction[] | undefined)?.[0];
  if (tx === undefined || tx === null || typeof tx !== "object") {
    return {
      provider: "coinbase",
      environment: mode,
      status: "not_started",
      next_step:
        "Coinbase has no sale for this reference yet. The user has not pressed Cash out on Coinbase's page; ask them to finish it, then call again. Do not send any funds yet.",
    };
  }
  return { provider: "coinbase", environment: mode, ...sellTransactionView(tx) };
}

function sellTransactionView(tx: SellTransaction) {
  const status = (text(tx.status) ?? "UNKNOWN").replace(/^TRANSACTION_STATUS_/, "");
  const network = text(tx.network);
  const deposit = evmAddress(tx.to_address);
  const created = Date.parse(text(tx.created_at) ?? "");
  return {
    status,
    transaction_id: text(tx.transaction_id),
    asset: text(tx.asset),
    network,
    chain_id: chainIdOf(network),
    amount: numeric(tx.sell_amount?.value),
    payout: tx.total === undefined ? null : { value: numeric(tx.total.value), currency: text(tx.total.currency) },
    deposit_address: deposit,
    from_address: text(tx.from_address),
    tx_hash: text(tx.tx_hash),
    send_by: Number.isFinite(created) ? new Date(created + SEND_WINDOW_MINUTES * 60_000).toISOString() : null,
    next_step: sellNextStep(status, deposit),
  };
}

function chainIdOf(network: string | null): string | null {
  const id = network === null ? undefined : (NETWORK_CHAIN_IDS as Record<string, number>)[network];
  return id === undefined ? null : String(id);
}

const NOT_COMPLETED = "The sale did not complete; do not send funds. Create a new link if the user still wants to sell.";
const SELL_NEXT_STEPS: Record<string, string> = {
  SUCCESS: "The sale is complete; Coinbase pays out to the user's chosen method.",
  FAILED: NOT_COMPLETED,
  EXPIRED: NOT_COMPLETED,
};

function sellNextStep(status: string, deposit: string | null): string {
  if (status === "STARTED" && deposit !== null) {
    return "Send exactly amount of asset on network to deposit_address from the wallet the link was issued for, with the user's approval in their wallet, before send_by. Coinbase matches sender, recipient, amount, asset and network; a late or different transfer lands in the user's Coinbase account instead of paying out.";
  }
  return SELL_NEXT_STEPS[status] ?? "Nothing to send now. Call again shortly if the user is still completing the sale.";
}
