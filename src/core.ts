import {
  type Address,
  getAddress,
  keccak256,
  stringToHex,
} from "viem";
import {
  buildQuoterQuoteUrl,
  type EvmQuoterQuote,
  type EvmQuoterQuoteType,
  prepareSwapFromQuote,
} from "./yul-router.js";

export interface Env {
  EKUBO_API_URL: string;
  EKUBO_QUOTER_URL: string;
  ALLOWED_HOSTNAMES?: string;
  ALLOWED_ORIGINS?: string;
  RATE_LIMITER?: RateLimit;
}

export interface QuoteIntent {
  chainId: string;
  tokenIn: Address;
  tokenOut: Address;
  quoteType: EvmQuoterQuoteType;
  amount: string;
}

export interface PrepareSwapIntent extends QuoteIntent {
  slippageBps: number;
  recipient?: Address;
  sender?: Address;
}

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type Fetcher = typeof fetch;

export async function searchTokens(
  env: Env,
  input: { chainId: string; query: string; pageSize: number },
  fetcher: Fetcher = fetch,
) {
  const url = new URL("/tokens", normalizedBase(env.EKUBO_API_URL));
  url.searchParams.set("chainId", input.chainId);
  url.searchParams.set("search", input.query);
  url.searchParams.set("pageSize", input.pageSize.toString());
  return fetchJson<unknown[]>(url.toString(), fetcher);
}

export async function getToken(
  env: Env,
  input: { chainId: string; address: string },
  fetcher: Fetcher = fetch,
) {
  const url = new URL(
    `/tokens/${encodeURIComponent(input.chainId)}/${encodeURIComponent(input.address)}`,
    normalizedBase(env.EKUBO_API_URL),
  );
  return fetchJson<Record<string, unknown>>(url.toString(), fetcher);
}

export async function getQuote(
  env: Env,
  intent: QuoteIntent,
  fetcher: Fetcher = fetch,
) {
  const url = buildQuoterQuoteUrl({
    quoterUrl: env.EKUBO_QUOTER_URL,
    chainId: intent.chainId,
    tokenIn: intent.tokenIn,
    tokenOut: intent.tokenOut,
    quoteType: intent.quoteType,
    amount: intent.amount,
  });
  const quote = await fetchJson<EvmQuoterQuote>(url, fetcher);
  return {
    request: {
      chain_id: intent.chainId,
      token_in: getAddress(intent.tokenIn),
      token_out: getAddress(intent.tokenOut),
      quote_type: intent.quoteType,
      amount: intent.amount,
    },
    source_url: url,
    quote,
  };
}

export async function prepareSwap(
  env: Env,
  intent: PrepareSwapIntent,
  fetcher: Fetcher = fetch,
) {
  const quoted = await getQuote(env, intent, fetcher);
  const prepared = prepareSwapFromQuote({
    quote: quoted.quote,
    tokenIn: intent.tokenIn,
    tokenOut: intent.tokenOut,
    quoteType: intent.quoteType,
    amount: intent.amount,
    slippageBps: intent.slippageBps,
    recipient: intent.recipient,
  });
  const identity = {
    chain_id: intent.chainId,
    block_number: prepared.block.number.toString(),
    block_hash: prepared.block.hash,
    sender: intent.sender ?? null,
    recipient: prepared.recipient,
    to: prepared.transaction.to,
    data: prepared.transaction.data,
    value: prepared.transaction.value.toString(),
  };

  return {
    schema_version: "1",
    action: "ekubo_swap",
    plan_id: keccak256(stringToHex(JSON.stringify(identity))),
    requires_user_confirmation: true,
    confirmation_ready: true,
    wallet_validation_required: true,
    request: quoted.request,
    quote_source_url: quoted.source_url,
    quote: {
      amount_in: prepared.amountIn.toString(),
      amount_out: prepared.amountOut.toString(),
      minimum_amount_out: prepared.minimumAmountOut?.toString() ?? null,
      maximum_amount_in: prepared.maximumAmountIn?.toString() ?? null,
      slippage_bps: prepared.slippageBps.toString(),
      price_impact: prepared.priceImpact,
      estimated_route_gas: prepared.estimatedRouteGas,
      block_number: prepared.block.number.toString(),
      block_hash: prepared.block.hash,
      raw: quoted.quote,
    },
    transaction: {
      chain_id: intent.chainId,
      to: prepared.transaction.to,
      data: prepared.transaction.data,
      value: prepared.transaction.value.toString(),
    },
    approval:
      prepared.approval === null
        ? null
        : {
            token: prepared.approval.token,
            spender: prepared.approval.spender,
            amount: prepared.approval.amount.toString(),
            transaction: {
              chain_id: intent.chainId,
              to: prepared.approval.transaction.to,
              data: prepared.approval.transaction.data,
              value: prepared.approval.transaction.value.toString(),
            },
          },
    confirmation: {
      instruction:
        "Ask the user to confirm this exact plan_id and slippage tolerance before signing. Re-prepare after any change or stale quote.",
      recipient: prepared.recipient ?? intent.sender ?? "transaction_sender",
      sender: intent.sender ?? null,
    },
    client_execution: {
      wallet: "Use the user's wallet or signature tooling; never send credentials to this MCP server",
      provider:
        "Use the user's connected provider to validate the transaction, estimate gas, submit, and confirm receipts",
      must_revalidate_before_signing: true,
      steps: [
        ...(prepared.approval === null
          ? []
          : [
              "Check current allowance and ask for confirmation before signing the approval transaction if it is required",
            ]),
        "Validate the exact swap transaction against current state through the user's connected wallet or provider",
        "Ask the user to confirm the exact plan ID, slippage bound, recipient, value, and calldata",
        "Have the user's wallet sign and submit; this MCP server must not receive a private key or seed phrase",
      ],
    },
  };
}

async function fetchJson<T>(url: string, fetcher: Fetcher): Promise<T> {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new ServiceError(
      "invalid_upstream_response",
      `Upstream returned non-JSON content from ${url}`,
    );
  }
  if (!response.ok) {
    const upstream = body as { code?: unknown; error?: unknown };
    throw new ServiceError(
      typeof upstream.code === "string" ? upstream.code : "upstream_error",
      typeof upstream.error === "string"
        ? upstream.error
        : `${response.status} ${response.statusText} from ${url}`,
      body,
    );
  }
  return body as T;
}

function normalizedBase(url: string): string {
  return `${url.replace(/\/+$/, "")}/`;
}
