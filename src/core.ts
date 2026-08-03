import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  keccak256,
  stringToHex,
} from "viem";
import {
  buildQuoterQuoteUrl,
  type EvmQuoterQuote,
  type EvmQuoterQuoteType,
  prepareSwapFromQuote,
} from "./yul-router.js";
import {
  type PreparedTransaction,
  transactionIdentity,
  executionPlan,
} from "./execution-plan.js";

export type Env = Cloudflare.Env & {
  ZERO_X_API_URL?: string;
  ACROSS_API_URL?: string;
  ALLOWED_HOSTNAMES?: string;
  ALLOWED_ORIGINS?: string;
  RATE_LIMITER?: RateLimit;
};

export type QuoteSource = "auto" | "ekubo" | "0x" | "across";

export interface QuoteIntent {
  chainId: string;
  destinationChainId?: string;
  tokenIn: Address;
  tokenOut: Address;
  quoteType: EvmQuoterQuoteType;
  amount: string;
  source?: QuoteSource;
  slippageBps?: number;
  sender?: Address;
  recipient?: Address;
}

export interface PrepareSwapIntent extends QuoteIntent {
  slippageBps: number;
  recipient?: Address;
  sender: Address;
}

interface UnsignedTransaction {
  chainId: string;
  to: Address;
  data: Hex;
  value: bigint;
  gas?: bigint;
}

interface QuoteCandidate {
  source: Exclude<QuoteSource, "auto">;
  sourceUrl: string;
  raw: unknown;
  amountIn: bigint;
  amountOut: bigint;
  minimumAmountOut: bigint | null;
  maximumAmountIn: bigint | null;
  estimatedGas: number | null;
  priceImpact: number | null;
  transaction: UnsignedTransaction | null;
  approvalRequired: boolean;
  approvalSpender: Address | null;
  approvalActual: bigint | null;
  approvalTransactions: UnsignedTransaction[];
  quoteExpiryTimestamp: number | null;
  expectedFillTime: number | null;
}

interface CandidateFailure {
  source: Exclude<QuoteSource, "auto">;
  code: string;
  message: string;
  retry_recommended: boolean;
}

interface ZeroXQuote {
  liquidityAvailable: boolean;
  buyAmount?: string;
  sellAmount?: string | null;
  estimatedNetSellAmount?: string | null;
  minBuyAmount?: string;
  maxSellAmount?: string | null;
  allowanceTarget?: Address;
  issues?: {
    allowance?: { actual: string; spender: Address } | null;
  };
  transaction?: {
    to: Address;
    data: Hex;
    value: string;
    gas?: string;
  };
  [key: string]: unknown;
}

interface AcrossQuote {
  inputAmount: string;
  maxInputAmount: string;
  expectedOutputAmount: string;
  minOutputAmount: string;
  expectedFillTime?: number;
  quoteExpiryTimestamp?: number;
  checks?: {
    allowance?: { token: Address; spender: Address };
  };
  approvalTxns?: AcrossTransaction[];
  swapTx: AcrossTransaction;
  [key: string]: unknown;
}

interface AcrossTransaction {
  chainId: number;
  to: Address;
  data: Hex;
  value?: string;
  gas?: string;
}

const ZERO_X_NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO_X_DEFAULT_URL = "https://api.0x.org";
const ACROSS_DEFAULT_URL = "https://app.across.to/api";
const ACROSS_PREVIEW_DEPOSITOR = "0x0000000000000000000000000000000000000001";
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
  const tokens = normalizeResponseChainIds(
    await fetchJson<Record<string, unknown>[]>(url.toString(), fetcher),
  );
  const normalizedQuery = input.query.trim().toLowerCase();
  return [...tokens].sort((left, right) => {
    const priorityDifference =
      visibilityPriority(right) - visibilityPriority(left);
    if (priorityDifference !== 0) return priorityDifference;

    const leftExact = tokenSymbol(left) === normalizedQuery ? 1 : 0;
    const rightExact = tokenSymbol(right) === normalizedQuery ? 1 : 0;
    if (leftExact !== rightExact) return rightExact - leftExact;

    return tokenSymbol(left).localeCompare(tokenSymbol(right));
  });
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
  return normalizeResponseChainIds(
    await fetchJson<Record<string, unknown>>(url.toString(), fetcher),
  );
}

export async function getTokens(
  env: Env,
  input: { tokens: { chainId: string; address: string }[] },
  fetcher: Fetcher = fetch,
) {
  const url = new URL("/tokens/batch", normalizedBase(env.EKUBO_API_URL));
  for (const token of input.tokens) {
    url.searchParams.append("id", `${token.chainId}:${token.address}`);
  }
  const tokens = await fetchJson<unknown>(url.toString(), fetcher);
  if (!Array.isArray(tokens) || !tokens.every(isRecord)) {
    throw new ServiceError(
      "invalid_upstream_response",
      "Batch token response must be an array of objects",
    );
  }
  return normalizeResponseChainIds(tokens);
}

export async function getChainTokens(
  env: Env,
  input: { chainId: string },
  fetcher: Fetcher = fetch,
) {
  const url = new URL("/tokens", normalizedBase(env.EKUBO_API_URL));
  url.searchParams.set("chainId", input.chainId);
  url.searchParams.set("pageSize", "10000");
  url.searchParams.set("minVisibilityPriority", "0");
  const tokens = await fetchJson<unknown>(url.toString(), fetcher);
  if (!Array.isArray(tokens) || !tokens.every(isRecord)) {
    throw new ServiceError(
      "invalid_upstream_response",
      "Chain token response must be an array of objects",
    );
  }
  if (tokens.length === 10_000) {
    throw new ServiceError(
      "token_list_too_large",
      "The canonical token list reached the interface page-size limit, so a complete TokenDataFetcher call cannot be prepared",
      { chain_id: input.chainId, page_size: 10_000 },
    );
  }
  return {
    tokens: normalizeResponseChainIds(tokens),
    sourceUrl: url.toString(),
  };
}

export async function getOwnedVe33Tokens(
  env: Env,
  input: { chainId: string; veToken: Address; owner: Address },
  fetcher: Fetcher = fetch,
) {
  const url = new URL(
    `/ve33/${encodeURIComponent(input.veToken)}/${encodeURIComponent(input.owner)}`,
    normalizedBase(env.EKUBO_API_URL),
  );
  url.searchParams.set("chainId", input.chainId);
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("page", "1");
  const response = await fetchJson<{
    data?: unknown;
    pagination?: {
      page?: unknown;
      pageSize?: unknown;
      totalPages?: unknown;
      totalItems?: unknown;
    };
  }>(url.toString(), fetcher);
  if (!Array.isArray(response.data)) {
    throw new ServiceError(
      "invalid_upstream_response",
      "VeToken ownership response is missing its data array",
    );
  }
  const totalItems = response.pagination?.totalItems;
  const totalPages = response.pagination?.totalPages;
  if (
    typeof totalItems !== "number" ||
    !Number.isInteger(totalItems) ||
    totalItems < 0 ||
    typeof totalPages !== "number" ||
    !Number.isInteger(totalPages) ||
    totalPages < 0
  ) {
    throw new ServiceError(
      "invalid_upstream_response",
      "VeToken ownership response has invalid pagination",
    );
  }
  if (totalItems > 100 || totalPages > 1) {
    throw new ServiceError(
      "too_many_ve_tokens",
      "VeToken portfolio workflows currently support at most 100 owned NFTs",
      { total_items: totalItems, maximum: 100 },
    );
  }
  if (response.data.length !== totalItems) {
    throw new ServiceError(
      "invalid_upstream_response",
      "VeToken ownership page does not contain every indexed item",
      { returned_items: response.data.length, total_items: totalItems },
    );
  }
  return {
    sourceUrl: url.toString(),
    tokens: response.data as Record<string, unknown>[],
    totalItems,
  };
}

export async function getVe33Pools(
  env: Env,
  input: { chainId: string; ve33: Address },
  fetcher: Fetcher = fetch,
) {
  const url = new URL(
    `/ve33/${encodeURIComponent(input.ve33)}/pools`,
    normalizedBase(env.EKUBO_API_URL),
  );
  url.searchParams.set("chainId", input.chainId);
  url.searchParams.set("pageSize", "200");
  url.searchParams.set("page", "1");
  const response = await fetchJson<{
    data?: unknown;
    total_vote_weight?: unknown;
    pagination?: {
      totalPages?: unknown;
      totalItems?: unknown;
    };
  }>(url.toString(), fetcher);
  if (!Array.isArray(response.data)) {
    throw new ServiceError(
      "invalid_upstream_response",
      "Ve33 pool response is missing its data array",
    );
  }
  const totalItems = response.pagination?.totalItems;
  const totalPages = response.pagination?.totalPages;
  if (
    typeof totalItems !== "number" ||
    !Number.isInteger(totalItems) ||
    totalItems < 0 ||
    typeof totalPages !== "number" ||
    !Number.isInteger(totalPages) ||
    totalPages < 0
  ) {
    throw new ServiceError(
      "invalid_upstream_response",
      "Ve33 pool response has invalid pagination",
    );
  }
  if (totalItems > 200 || totalPages > 1) {
    throw new ServiceError(
      "too_many_ve33_pools",
      "Ve33 target resolution currently supports at most 200 pools",
      { total_items: totalItems, maximum: 200 },
    );
  }
  if (response.data.length !== totalItems) {
    throw new ServiceError(
      "invalid_upstream_response",
      "Ve33 pool page does not contain every indexed item",
      { returned_items: response.data.length, total_items: totalItems },
    );
  }
  return {
    sourceUrl: url.toString(),
    pools: response.data as Record<string, unknown>[],
    totalItems,
    totalVoteWeight: response.total_vote_weight,
  };
}

export async function getQuote(
  env: Env,
  intent: QuoteIntent,
  fetcher: Fetcher = fetch,
) {
  const result = await selectQuote(env, intent, fetcher);
  const selection = quoteSelection(intent, result);
  return {
    request: quoteRequest(intent),
    source: result.selected.source,
    source_url: result.selected.sourceUrl,
    quote: result.selected.raw,
    normalized: serializeCandidate(result.selected),
    candidates: result.candidates.map(serializeCandidate),
    unavailable_sources: result.failures,
    selection,
  };
}

export async function prepareSwap(
  env: Env,
  intent: PrepareSwapIntent,
  fetcher: Fetcher = fetch,
) {
  const quoted = await selectQuote(env, intent, fetcher);
  const selected = quoted.selected;
  const selection = quoteSelection(intent, quoted);
  const recipient = getAddress(intent.recipient ?? intent.sender);
  let mainTransaction: UnsignedTransaction;
  let approvals: UnsignedTransaction[];
  let minimumAmountOut = selected.minimumAmountOut;
  let maximumAmountIn = selected.maximumAmountIn;
  let blockNumber: string | null = null;
  let blockHash: Hex | null = null;
  let estimatedRouteGas = selected.estimatedGas;
  let priceImpact = selected.priceImpact;
  let approvalSpender = selected.approvalSpender;

  if (selected.source === "ekubo") {
    const prepared = prepareSwapFromQuote({
      quote: selected.raw as EvmQuoterQuote,
      tokenIn: intent.tokenIn,
      tokenOut: intent.tokenOut,
      quoteType: intent.quoteType,
      amount: intent.amount,
      slippageBps: intent.slippageBps,
      recipient,
    });
    mainTransaction = {
      chainId: intent.chainId,
      to: prepared.transaction.to,
      data: prepared.transaction.data,
      value: prepared.transaction.value,
    };
    approvals =
      prepared.approval === null
        ? []
        : [
            {
              chainId: intent.chainId,
              to: prepared.approval.transaction.to,
              data: prepared.approval.transaction.data,
              value: prepared.approval.transaction.value,
            },
          ];
    approvalSpender = prepared.approval?.spender ?? null;
    minimumAmountOut = prepared.minimumAmountOut;
    maximumAmountIn = prepared.maximumAmountIn;
    blockNumber = prepared.block.number.toString();
    blockHash = prepared.block.hash;
    estimatedRouteGas = prepared.estimatedRouteGas;
    priceImpact = prepared.priceImpact;
  } else {
    if (selected.transaction === null) {
      throw new ServiceError(
        "firm_quote_required",
        `${selected.source} did not return executable calldata; provide sender and request a fresh quote`,
      );
    }
    mainTransaction = selected.transaction;
    approvals = selected.approvalTransactions.length
      ? selected.approvalTransactions
      : buildApprovalTransactions(intent, selected);
  }

  const cleanupTransactions =
    intent.quoteType === "exact_output" &&
    selected.source !== "across" &&
    BigInt(intent.tokenIn) !== 0n &&
    approvalSpender !== null &&
    approvals.length > 0
      ? [erc20Approval(intent.chainId, intent.tokenIn, approvalSpender, 0n)]
      : [];

  const serializedTransaction = serializeTransaction(mainTransaction);
  const serializedApprovals = approvals.map(serializeTransaction);
  const serializedCleanupTransactions =
    cleanupTransactions.map(serializeTransaction);

  const identity = {
    source: selected.source,
    chain_id: mainTransaction.chainId,
    destination_chain_id: intent.destinationChainId ?? intent.chainId,
    block_number: blockNumber,
    block_hash: blockHash,
    quote_expiry_timestamp: selected.quoteExpiryTimestamp,
    sender: getAddress(intent.sender),
    recipient,
    approvals: serializedApprovals.map(transactionIdentity),
    transaction: transactionIdentity(serializedTransaction),
    post_execution_transactions:
      serializedCleanupTransactions.map(transactionIdentity),
  };

  return {
    schema_version: "2",
    action:
      (intent.destinationChainId ?? intent.chainId) === intent.chainId
        ? "ekubo_swap"
        : "ekubo_bridge",
    source: selected.source,
    plan_id: keccak256(stringToHex(JSON.stringify(identity))),
    execution_plan_ready: !selection.retry_recommended,
    agent_confirmation_required: false,
    wallet_validation_required: true,
    request: quoteRequest(intent),
    selection,
    unavailable_sources: quoted.failures,
    quote_source_url: selected.sourceUrl,
    quote: {
      amount_in: selected.amountIn.toString(),
      amount_out: selected.amountOut.toString(),
      minimum_amount_out: minimumAmountOut?.toString() ?? null,
      maximum_amount_in: maximumAmountIn?.toString() ?? null,
      slippage_bps: intent.slippageBps.toString(),
      price_impact: priceImpact,
      estimated_route_gas: estimatedRouteGas,
      block_number: blockNumber,
      block_hash: blockHash,
      quote_expiry_timestamp: selected.quoteExpiryTimestamp,
      expected_fill_time_seconds: selected.expectedFillTime,
      raw: selected.raw,
    },
    transaction: serializedTransaction,
    approvals: serializedApprovals,
    post_execution_transactions: serializedCleanupTransactions,
    approval:
      approvals.length === 1
        ? { transaction: serializeTransaction(approvals[0]) }
        : null,
    wallet_handoff: {
      instruction:
        selection.retry_recommended
          ? "Do not submit this plan: an Ekubo or 0x comparison quote failed. Tell the user to retry, then re-prepare and use only a result whose selection.retry_recommended is false."
          : "Pass this complete plan to the wallet's simulation and authorization flow. Do not ask the user for a separate agent-level approval; the wallet presents the simulated result and collects authorization or signature. Re-prepare after any change or stale quote.",
      recipient,
      sender: getAddress(intent.sender),
    },
    execution_plan: executionPlan({
      chainId: intent.chainId,
      sender: intent.sender,
      approvals: serializedApprovals,
      transaction: serializedTransaction,
      postExecutionTransactions: serializedCleanupTransactions,
      atomicBatchRequired:
        serializedApprovals.length > 0 ||
        serializedCleanupTransactions.length > 0,
      simulationFailurePolicy: {
        rpc_error: {
          action: "retry_same_plan",
          instruction:
            "The quote and calldata remain usable after a transient RPC or local simulation infrastructure failure. Retry the same wallet plan once the service recovers, provided the quote has not expired.",
        },
        execution_reverted: {
          action: "reprepare_plan",
          instruction:
            "The swap or bridge reverted against current state, including slippage or price movement. Do not retry these bytes; request a fresh quote and prepare new calldata.",
        },
        simulation_setup_error: {
          action: "user_review",
          instruction:
            "Check that the wallet and network match this plan and that the wallet simulation environment is healthy before requesting new calldata.",
        },
      },
    }),
    client_execution: {
      wallet:
        "Use the user's wallet or signature tooling; never send credentials to this MCP server",
      provider:
        "Use the user's connected provider to validate the transaction, estimate gas, submit, and confirm receipts",
      must_revalidate_before_signing: true,
      steps: selection.retry_recommended
        ? [
            "Stop before wallet submission, tell the user that an Ekubo or 0x quote failed, and retry the preparation so both configured same-chain sources can be compared",
          ]
        : [
            ...(approvals.length === 0
              ? []
              : [
                  "Check current allowance so the wallet can omit an approval transaction that is no longer required",
                ]),
            "Validate the exact swap transaction against current state through the user's connected wallet or provider",
            "Pass the complete execution_plan to the wallet; do not request a separate agent-level confirmation",
            "Have the wallet present the simulated result, collect authorization or signature, and submit; this MCP server must not receive a private key or seed phrase",
            ...(cleanupTransactions.length === 0
              ? []
              : [
                  "After the exact-output swap succeeds, clear the remaining router allowance with the supplied post-execution transaction",
                ]),
          ],
    },
  };
}

async function selectQuote(
  env: Env,
  intent: QuoteIntent,
  fetcher: Fetcher,
): Promise<{
  selected: QuoteCandidate;
  candidates: QuoteCandidate[];
  failures: CandidateFailure[];
}> {
  const destinationChainId = intent.destinationChainId ?? intent.chainId;
  const source = intent.source ?? "auto";
  const isCrossChain = destinationChainId !== intent.chainId;

  if (isCrossChain && source !== "auto" && source !== "across") {
    throw new ServiceError(
      "invalid_quote_source",
      `cross-chain requests require source=across or source=auto, received ${source}`,
    );
  }
  if (!isCrossChain && source === "across") {
    throw new ServiceError(
      "invalid_quote_source",
      "source=across requires different origin and destination chain IDs",
    );
  }

  const requestedSources: Exclude<QuoteSource, "auto">[] = isCrossChain
    ? ["across"]
    : source === "auto"
      ? ["ekubo", ...(env.ZERO_X_API_KEY ? (["0x"] as const) : [])]
      : [source];

  const settled = await Promise.allSettled(
    requestedSources.map((requestedSource) => {
      switch (requestedSource) {
        case "ekubo":
          return quoteEkubo(env, intent, fetcher);
        case "0x":
          return quoteZeroX(env, intent, fetcher);
        case "across":
          return quoteAcross(env, intent, fetcher);
      }
    }),
  );
  const candidates: QuoteCandidate[] = [];
  const failures: CandidateFailure[] = [];
  settled.forEach((result, index) => {
    const requestedSource = requestedSources[index];
    if (result.status === "fulfilled") {
      candidates.push(result.value);
      return;
    }
    failures.push({
      source: requestedSource,
      code:
        result.reason instanceof ServiceError
          ? result.reason.code
          : "unexpected_error",
      message:
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
      retry_recommended:
        requestedSource === "ekubo" || requestedSource === "0x",
    });
  });

  if (candidates.length === 0) {
    throw new ServiceError(
      "quote_unavailable",
      failures.some((failure) => failure.retry_recommended)
        ? "No requested quote source returned a usable route; tell the user to retry because an Ekubo or 0x quote failed"
        : "No requested quote source returned a usable route",
      failures,
    );
  }

  let selected = candidates[0];
  if (source === "auto" && !isCrossChain) {
    selected = candidates.reduce((best, candidate) => {
      if (intent.quoteType === "exact_output") {
        if (candidate.amountIn < best.amountIn) return candidate;
      } else if (candidate.amountOut > best.amountOut) {
        return candidate;
      }
      return candidate.amountIn === best.amountIn &&
        candidate.amountOut === best.amountOut &&
        candidate.source === "ekubo"
        ? candidate
        : best;
    });
  }

  return { selected, candidates, failures };
}

function quoteSelection(
  intent: QuoteIntent,
  result: {
    selected: QuoteCandidate;
    candidates: QuoteCandidate[];
    failures: CandidateFailure[];
  },
) {
  const retryRecommended = result.failures.some(
    (failure) => failure.retry_recommended,
  );
  return {
    comparison_basis:
      intent.quoteType === "exact_output"
        ? "lowest_calculated_amount_in"
        : "highest_calculated_amount_out",
    compared_sources: result.candidates.map((candidate) => candidate.source),
    comparison_complete: result.failures.length === 0,
    selected_source: result.selected.source,
    retry_recommended: retryRecommended,
    retry_instruction: retryRecommended
      ? "Tell the user that an Ekubo or 0x quote failed and retry before relying on or executing this result."
      : null,
  };
}

async function quoteEkubo(
  env: Env,
  intent: QuoteIntent,
  fetcher: Fetcher,
): Promise<QuoteCandidate> {
  const url = buildQuoterQuoteUrl({
    quoterUrl: env.EKUBO_QUOTER_URL,
    chainId: intent.chainId,
    tokenIn: intent.tokenIn,
    tokenOut: intent.tokenOut,
    quoteType: intent.quoteType,
    amount: intent.amount,
  });
  const quote = await fetchJson<EvmQuoterQuote>(url, fetcher);
  const calculated = parseSignedAmount(
    quote.total_calculated,
    "total_calculated",
  );
  const requested = BigInt(intent.amount);
  const exactOutput = intent.quoteType === "exact_output";
  if ((exactOutput && calculated >= 0n) || (!exactOutput && calculated <= 0n)) {
    throw new ServiceError(
      "invalid_upstream_response",
      "Ekubo quote returned total_calculated with the wrong sign",
      quote,
    );
  }
  return {
    source: "ekubo",
    sourceUrl: url,
    raw: quote,
    amountIn: exactOutput ? -calculated : requested,
    amountOut: exactOutput ? requested : calculated,
    minimumAmountOut: null,
    maximumAmountIn: null,
    estimatedGas: quote.estimated_gas_cost,
    priceImpact: quote.price_impact,
    transaction: null,
    approvalRequired: false,
    approvalSpender: null,
    approvalActual: null,
    approvalTransactions: [],
    quoteExpiryTimestamp: null,
    expectedFillTime: null,
  };
}

async function quoteZeroX(
  env: Env,
  intent: QuoteIntent,
  fetcher: Fetcher,
): Promise<QuoteCandidate> {
  if (!env.ZERO_X_API_KEY) {
    throw new ServiceError(
      "provider_not_configured",
      "0x is not configured for this deployment",
    );
  }
  const endpoint = intent.sender ? "quote" : "price";
  const url = new URL(
    `/swap/allowance-holder/${endpoint}`,
    normalizedBase(env.ZERO_X_API_URL ?? ZERO_X_DEFAULT_URL),
  );
  url.searchParams.set("chainId", intent.chainId);
  url.searchParams.set("sellToken", zeroXToken(intent.tokenIn));
  url.searchParams.set("buyToken", zeroXToken(intent.tokenOut));
  url.searchParams.set(
    intent.quoteType === "exact_output" ? "buyAmount" : "sellAmount",
    intent.amount,
  );
  if (intent.sender) url.searchParams.set("taker", getAddress(intent.sender));
  if (intent.recipient)
    url.searchParams.set("recipient", getAddress(intent.recipient));
  if (intent.slippageBps !== undefined)
    url.searchParams.set("slippageBps", intent.slippageBps.toString());

  const quote = await fetchJson<ZeroXQuote>(url.toString(), fetcher, {
    headers: {
      "0x-api-key": env.ZERO_X_API_KEY,
      "0x-version": "v2",
    },
  });
  if (!quote.liquidityAvailable) {
    throw new ServiceError(
      "quote_unavailable",
      "0x reported no liquidity for this pair",
      quote,
    );
  }
  const exactOutput = intent.quoteType === "exact_output";
  const amountInRaw = exactOutput
    ? (quote.estimatedNetSellAmount ?? quote.sellAmount)
    : (quote.sellAmount ?? intent.amount);
  if (!amountInRaw || !quote.buyAmount) {
    throw new ServiceError(
      "invalid_upstream_response",
      "0x quote omitted required buy or sell amounts",
      quote,
    );
  }
  const transaction = quote.transaction
    ? toUnsignedTransaction(intent.chainId, quote.transaction)
    : null;
  return {
    source: "0x",
    sourceUrl: url.toString(),
    raw: quote,
    amountIn: BigInt(amountInRaw),
    amountOut: BigInt(quote.buyAmount),
    minimumAmountOut:
      !exactOutput && quote.minBuyAmount ? BigInt(quote.minBuyAmount) : null,
    maximumAmountIn:
      exactOutput && quote.maxSellAmount ? BigInt(quote.maxSellAmount) : null,
    estimatedGas: quote.transaction?.gas ? Number(quote.transaction.gas) : null,
    priceImpact: null,
    transaction,
    approvalRequired: quote.issues?.allowance != null,
    approvalSpender:
      quote.issues?.allowance?.spender ?? quote.allowanceTarget ?? null,
    approvalActual: quote.issues?.allowance
      ? BigInt(quote.issues.allowance.actual)
      : null,
    approvalTransactions: [],
    quoteExpiryTimestamp: null,
    expectedFillTime: null,
  };
}

async function quoteAcross(
  env: Env,
  intent: QuoteIntent,
  fetcher: Fetcher,
): Promise<QuoteCandidate> {
  if (!env.ACROSS_API_KEY || !env.ACROSS_INTEGRATOR_ID) {
    throw new ServiceError(
      "provider_not_configured",
      "Across is not configured for this deployment",
    );
  }
  const destinationChainId = intent.destinationChainId ?? intent.chainId;
  const depositor = intent.sender
    ? getAddress(intent.sender)
    : ACROSS_PREVIEW_DEPOSITOR;
  const url = new URL(
    "/swap/approval",
    normalizedBase(env.ACROSS_API_URL ?? ACROSS_DEFAULT_URL),
  );
  url.searchParams.set(
    "tradeType",
    intent.quoteType === "exact_output" ? "exactOutput" : "exactInput",
  );
  url.searchParams.set("amount", intent.amount);
  url.searchParams.set("inputToken", getAddress(intent.tokenIn));
  url.searchParams.set("outputToken", getAddress(intent.tokenOut));
  url.searchParams.set("originChainId", intent.chainId);
  url.searchParams.set("destinationChainId", destinationChainId);
  url.searchParams.set("depositor", depositor);
  url.searchParams.set("integratorId", env.ACROSS_INTEGRATOR_ID);
  url.searchParams.set("strictTradeType", "true");
  if (!intent.sender) url.searchParams.set("skipOriginTxEstimation", "true");
  if (intent.recipient)
    url.searchParams.set("recipient", getAddress(intent.recipient));
  if (intent.slippageBps !== undefined)
    url.searchParams.set("slippage", (intent.slippageBps / 10_000).toString());

  const quote = await fetchJson<AcrossQuote>(url.toString(), fetcher, {
    headers: { Authorization: `Bearer ${env.ACROSS_API_KEY}` },
  });
  if (!quote.swapTx) {
    throw new ServiceError(
      "invalid_upstream_response",
      "Across quote omitted swapTx",
      quote,
    );
  }
  return {
    source: "across",
    sourceUrl: url.toString(),
    raw: quote,
    amountIn: BigInt(quote.inputAmount),
    amountOut: BigInt(quote.expectedOutputAmount),
    minimumAmountOut: BigInt(quote.minOutputAmount),
    maximumAmountIn: BigInt(quote.maxInputAmount),
    estimatedGas: quote.swapTx.gas ? Number(quote.swapTx.gas) : null,
    priceImpact: null,
    transaction: acrossTransaction(quote.swapTx),
    approvalRequired:
      (quote.approvalTxns?.length ?? 0) > 0 || quote.checks?.allowance != null,
    approvalSpender: quote.checks?.allowance?.spender ?? null,
    approvalActual: null,
    approvalTransactions: (quote.approvalTxns ?? []).map(acrossTransaction),
    quoteExpiryTimestamp: quote.quoteExpiryTimestamp ?? null,
    expectedFillTime: quote.expectedFillTime ?? null,
  };
}

function quoteRequest(intent: QuoteIntent) {
  return {
    chain_id: intent.chainId,
    destination_chain_id: intent.destinationChainId ?? intent.chainId,
    token_in: getAddress(intent.tokenIn),
    token_out: getAddress(intent.tokenOut),
    quote_type: intent.quoteType,
    amount: intent.amount,
    source: intent.source ?? "auto",
    sender: intent.sender ? getAddress(intent.sender) : null,
    recipient: intent.recipient ? getAddress(intent.recipient) : null,
  };
}

function serializeCandidate(candidate: QuoteCandidate) {
  return {
    source: candidate.source,
    amount_in: candidate.amountIn.toString(),
    amount_out: candidate.amountOut.toString(),
    minimum_amount_out: candidate.minimumAmountOut?.toString() ?? null,
    maximum_amount_in: candidate.maximumAmountIn?.toString() ?? null,
    estimated_gas: candidate.estimatedGas,
    price_impact: candidate.priceImpact,
    quote_expiry_timestamp: candidate.quoteExpiryTimestamp,
    expected_fill_time_seconds: candidate.expectedFillTime,
  };
}

function buildApprovalTransactions(
  intent: PrepareSwapIntent,
  candidate: QuoteCandidate,
): UnsignedTransaction[] {
  if (
    BigInt(intent.tokenIn) === 0n ||
    !candidate.approvalRequired ||
    candidate.approvalSpender === null
  ) {
    return [];
  }
  const amount = candidate.maximumAmountIn ?? candidate.amountIn;
  return [
    ...(candidate.approvalActual !== null && candidate.approvalActual > 0n
      ? [
          erc20Approval(
            intent.chainId,
            intent.tokenIn,
            candidate.approvalSpender,
            0n,
          ),
        ]
      : []),
    erc20Approval(
      intent.chainId,
      intent.tokenIn,
      candidate.approvalSpender,
      amount,
    ),
  ];
}

function erc20Approval(
  chainId: string,
  token: Address,
  spender: Address,
  amount: bigint,
): UnsignedTransaction {
  return {
    chainId,
    to: getAddress(token),
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
    }),
    value: 0n,
  };
}

function serializeTransaction(
  transaction: UnsignedTransaction,
): PreparedTransaction {
  return {
    chain_id: transaction.chainId,
    to: transaction.to,
    data: transaction.data,
    value: transaction.value.toString(),
    ...(transaction.gas === undefined
      ? {}
      : { gas: transaction.gas.toString() }),
  };
}

function toUnsignedTransaction(
  chainId: string,
  transaction: { to: Address; data: Hex; value?: string; gas?: string },
): UnsignedTransaction {
  return {
    chainId,
    to: getAddress(transaction.to),
    data: transaction.data,
    value: BigInt(transaction.value ?? 0),
    ...(transaction.gas === undefined ? {} : { gas: BigInt(transaction.gas) }),
  };
}

function acrossTransaction(
  transaction: AcrossTransaction,
): UnsignedTransaction {
  return toUnsignedTransaction(transaction.chainId.toString(), transaction);
}

function zeroXToken(token: Address): string {
  return BigInt(token) === 0n ? ZERO_X_NATIVE_TOKEN : getAddress(token);
}

function parseSignedAmount(value: string, label: string): bigint {
  if (!/^-?[0-9]+$/.test(value)) {
    throw new ServiceError(
      "invalid_upstream_response",
      `${label} must be a signed integer`,
    );
  }
  return BigInt(value);
}

function visibilityPriority(token: Record<string, unknown>): number {
  return typeof token.visibility_priority === "number"
    ? token.visibility_priority
    : Number.MIN_SAFE_INTEGER;
}

function tokenSymbol(token: Record<string, unknown>): string {
  return typeof token.symbol === "string" ? token.symbol.toLowerCase() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeResponseChainIds<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeResponseChainIds(entry)) as T;
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "chain_id" &&
      (typeof entry === "string" || typeof entry === "number")
        ? normalizeResponseChainId(entry)
        : normalizeResponseChainIds(entry),
    ]),
  ) as T;
}

function normalizeResponseChainId(value: string | number): string {
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed.toString() : String(value);
  } catch {
    return String(value);
  }
}

async function fetchJson<T>(
  url: string,
  fetcher: Fetcher,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetcher(url, {
    ...init,
    headers: { accept: "application/json", ...init.headers },
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
    const upstream = body as {
      code?: unknown;
      error?: unknown;
      message?: unknown;
      name?: unknown;
    };
    throw new ServiceError(
      typeof upstream.code === "string"
        ? upstream.code
        : typeof upstream.name === "string"
          ? upstream.name
          : "upstream_error",
      typeof upstream.error === "string"
        ? upstream.error
        : typeof upstream.message === "string"
          ? upstream.message
          : `${response.status} ${response.statusText} from ${url}`,
      body,
    );
  }
  return body as T;
}

function normalizedBase(url: string): string {
  return `${url.replace(/\/+$/, "")}/`;
}
