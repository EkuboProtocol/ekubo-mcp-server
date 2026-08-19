import {
  type Address,
  decodeFunctionData,
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
import { MCP_SERVER_VERSION } from "./version.js";

/**
 * Rate limiter bindings are declared in `wrangler.jsonc`, so generated types
 * make them required, but the code treats every one of them as absent-tolerant
 * on purpose: `wrangler dev` and any deployment that has not provisioned the
 * namespaces must still serve, with abuse protection degraded rather than the
 * endpoint down. Widening them back to optional here keeps that contract in
 * the type system instead of only in the comments.
 */
type OptionalBindings =
  | "RATE_LIMITER"
  | "RATE_LIMITER_BURST"
  | "RATE_LIMITER_TOOLS"
  | "RATE_LIMITER_METERED";

export type Env = Omit<Cloudflare.Env, OptionalBindings> &
  Partial<Pick<Cloudflare.Env, OptionalBindings>> & {
    ZERO_X_API_URL?: string;
    ACROSS_API_URL?: string;
    LAYER_ZERO_API_URL?: string;
    ALLOWED_HOSTNAMES?: string;
    ALLOWED_ORIGINS?: string;
  };

export type QuoteSource = "ekubo" | "0x" | "across" | "layerzero";

type QuoteCollectionSource = QuoteSource | "all";

export interface QuoteIntent {
  chainId: string;
  destinationChainId?: string;
  tokenIn: Address;
  tokenOut: Address;
  quoteType: EvmQuoterQuoteType;
  amount: string;
}

/**
 * Everything needed to turn one quote into calldata, minus the choice of which
 * provider produced it. `prepareSwap` adds that choice; `getQuotesWithPlans` applies this
 * to every option it already fetched.
 */
export interface SwapPreparationIntent extends QuoteIntent {
  slippageBps: number;
  recipient?: Address;
  sender: Address;
}

export interface PrepareSwapIntent extends SwapPreparationIntent {
  source: QuoteSource;
}

/**
 * A quote request that may already know who will sign it.
 *
 * A quote is only worth what it can still execute for, and every second spent
 * between fetching one and broadcasting against it is a second the price can
 * move. Supplying a sender and a slippage tolerance up front lets discovery
 * return the calldata for each option it fetched, so the agent hands one
 * straight to the wallet instead of spending a second round trip — and a whole
 * agent turn — asking a provider to repeat what it just said.
 *
 * Both fields are optional together: without them this is the indicative
 * comparison it has always been, which is the right shape for "what would I
 * get" questions that are not going anywhere near a signature.
 */
export interface QuoteDiscoveryIntent extends QuoteIntent {
  slippageBps?: number;
  recipient?: Address;
  sender?: Address;
  /**
   * Echo each provider's untouched response back alongside the normalized
   * amounts. Off by default: the raw blobs are the largest thing here and the
   * smallest thing an agent needs, since every field a choice turns on is
   * already normalized. They stay available for diagnosing a provider.
   */
  includeRawQuotes?: boolean;
}

type QuoteSelectionIntent = QuoteIntent & {
  source: QuoteCollectionSource;
  slippageBps?: number;
  sender?: Address;
  recipient?: Address;
};

interface UnsignedTransaction {
  chainId: string;
  to: Address;
  data: Hex;
  value: bigint;
  gas?: bigint;
}

interface QuoteCandidate {
  source: QuoteSource;
  sourceUrl: string;
  raw: unknown;
  /**
   * The provider's own identifier for this quote, for providers that issue one
   * that outlives the quote. LayerZero's quote id becomes the transfer id once
   * the transfer is broadcast, so it is what `get_value_transfer_status` is
   * polled with. It has to reach the caller through the normalized fields
   * because raw provider responses are off by default, and a transfer whose id
   * was never returned cannot be tracked at all.
   */
  providerQuoteId: string | null;
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

/** One quote rendered as the exact transactions that would execute it. */
interface PreparedCandidate {
  planId: Hex;
  recipient: Address;
  transaction: PreparedTransaction;
  approvals: PreparedTransaction[];
  postExecutionTransactions: PreparedTransaction[];
  minimumAmountOut: bigint | null;
  maximumAmountIn: bigint | null;
  blockNumber: string | null;
  blockHash: Hex | null;
  estimatedRouteGas: number | null;
  priceImpact: number | null;
  executionPlan: ReturnType<typeof executionPlan>;
}

interface CandidateFailure {
  source: QuoteSource;
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
    allowance?: { token: Address; spender: Address; actual?: string };
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

/**
 * One entry of the LayerZero chain catalog. The Value Transfer API addresses
 * chains by a string key ("base", "arbitrum"), not by EIP-155 id, so every
 * request has to be translated through this list first.
 */
interface LayerZeroChain {
  chainKey: string;
  chainType?: string;
  chainId?: number;
}

interface LayerZeroChainsResponse {
  chains?: LayerZeroChain[];
  pagination?: { nextToken?: string };
}

interface LayerZeroEncodedTransaction {
  to: Address;
  data: Hex;
  value?: string;
  chainId?: number;
  from?: Address;
  gasLimit?: string;
}

interface LayerZeroUserStep {
  type?: string;
  description?: string;
  chainKey?: string;
  chainType?: string;
  transaction?: { encoded?: LayerZeroEncodedTransaction };
}

interface LayerZeroQuote {
  id?: string;
  srcAmount?: string;
  dstAmount?: string;
  dstAmountMin?: string;
  feeUsd?: string;
  duration?: { estimated?: string | number | null };
  userSteps?: LayerZeroUserStep[];
  expiresAt?: string;
  [key: string]: unknown;
}

interface LayerZeroQuotesResponse {
  error?: { status?: number; message?: string; issues?: unknown } | null;
  quotes?: LayerZeroQuote[];
  [key: string]: unknown;
}

interface LayerZeroStatusResponse {
  status?: string;
  explorerUrl?: string;
  executionHistory?: {
    event?: string;
    transaction?: { chainKey?: string; hash?: string; timestamp?: number };
  }[];
  [key: string]: unknown;
}

const ZERO_X_NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO_X_DEFAULT_URL = "https://api.0x.org";
const ACROSS_DEFAULT_URL = "https://app.across.to/api";
const ACROSS_PREVIEW_DEPOSITOR = "0x0000000000000000000000000000000000000001";
const LAYERZERO_DEFAULT_URL = "https://transfer.layerzero-api.com/v1";
// LayerZero uses the same sentinel as 0x for a chain's native currency.
const LAYERZERO_NATIVE_TOKEN = ZERO_X_NATIVE_TOKEN;
const LAYERZERO_PREVIEW_WALLET = "0x0000000000000000000000000000000000000001";
/**
 * How long one fetch of the chain catalog is reused. The mapping from EIP-155
 * id to chain key changes only when LayerZero onboards a chain, so re-reading
 * it per quote would spend a round trip of the quote's own lifetime on data
 * that is effectively static.
 */
const LAYERZERO_CHAINS_TTL_MS = 10 * 60 * 1000;
/** Stops a malformed pagination cursor from looping the catalog walk forever. */
const LAYERZERO_CHAINS_MAX_PAGES = 20;
/**
 * Workers send no User-Agent unless one is set, and LayerZero's edge answers a
 * request without one with a 403 HTML page rather than JSON. Naming the client
 * is what keeps the API reachable from a Worker at all, so this is load-bearing
 * rather than courtesy.
 */
const LAYERZERO_USER_AGENT = `ekubo-mcp/${MCP_SERVER_VERSION}`;

function layerZeroHeaders(apiKey?: string): Record<string, string> {
  return {
    "user-agent": LAYERZERO_USER_AGENT,
    ...(apiKey === undefined ? {} : { "x-api-key": apiKey }),
  };
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

export async function listTokens(
  env: Env,
  input: {
    chainId?: string;
    search?: string;
    pageSize: number;
    afterToken?: string;
    minVisibilityPriority: number;
  },
  fetcher: Fetcher = fetch,
) {
  const url = new URL("/tokens", normalizedBase(env.EKUBO_API_URL));
  if (input.chainId !== undefined) {
    url.searchParams.set("chainId", input.chainId);
  }
  if (input.search !== undefined) {
    url.searchParams.set("search", input.search);
  }
  url.searchParams.set("pageSize", input.pageSize.toString());
  if (input.afterToken !== undefined) {
    url.searchParams.set("afterToken", input.afterToken);
  }
  url.searchParams.set(
    "minVisibilityPriority",
    input.minVisibilityPriority.toString(),
  );
  const tokens = normalizeResponseChainIds(
    await fetchJson<Record<string, unknown>[]>(url.toString(), fetcher),
  );
  const normalizedQuery = input.search?.trim().toLowerCase() ?? "";
  return [...tokens].sort((left, right) => {
    const priorityDifference =
      visibilityPriority(right) - visibilityPriority(left);
    if (priorityDifference !== 0) return priorityDifference;

    // Exact symbol matches outrank prefix and suffix matches at equal
    // visibility priority; with no search term every symbol is a non-match.
    if (normalizedQuery.length > 0) {
      const leftExact = tokenSymbol(left) === normalizedQuery ? 1 : 0;
      const rightExact = tokenSymbol(right) === normalizedQuery ? 1 : 0;
      if (leftExact !== rightExact) return rightExact - leftExact;
    }

    return tokenSymbol(left).localeCompare(tokenSymbol(right));
  });
}

/**
 * The canonical list's name, recorded as the source of any suggestion made
 * from it. A wallet's owner reviews suggestions grouped under this, deciding
 * a whole list at once, so it has to name the real curator rather than the
 * tool that relayed it.
 */
export const CANONICAL_TOKEN_LIST_NAME = "Ekubo canonical token list";

/**
 * Reduce canonical token records to the five fields a wallet acts on.
 *
 * Everything else the API returns — logo URLs, prices, supplies, per-chain
 * bridge maps — is display data for this server's own callers and makes up
 * most of the 483 KB the full list weighs. A wallet needs only the claim
 * "this address is called this and scales by this", so that is all the
 * stored artifact says, and all its integrity digest commits to.
 *
 * Entries missing any of those fields are dropped: a wallet cannot name a
 * token it has no symbol for, and a half-entry is worse than an absent one.
 */
export function tokenListEntries(
  tokens: Record<string, unknown>[],
): { chain_id: string; address: string; symbol: string; name: string; decimals: number }[] {
  return tokens.flatMap((token) => {
    const { chain_id, address, symbol, name, decimals } = token;
    if (
      typeof chain_id !== "string" ||
      typeof address !== "string" ||
      typeof symbol !== "string" ||
      typeof decimals !== "number"
    ) {
      return [];
    }
    return [
      {
        chain_id,
        address,
        symbol,
        name: typeof name === "string" ? name : symbol,
        decimals,
      },
    ];
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

/**
 * Every available quote, each already carrying the calldata that executes it.
 *
 * This is the whole swap path: one call fetches every provider's quote and
 * turns each one into an execution plan, so the agent picks an option and
 * hands its plan to a wallet without going back to any provider. The quote the
 * user compares is therefore the quote that executes, which a second
 * preparation round trip could never promise — it would fetch a different
 * quote after the user had already agreed to the first.
 */
export async function getQuotesWithPlans(
  env: Env,
  intent: QuoteDiscoveryIntent,
  fetcher: Fetcher = fetch,
) {
  // Naming the signer up front changes what the providers are asked for, not
  // just what is done with the answer: 0x returns a firm quote with calldata
  // instead of an indicative price, and Across estimates the real origin
  // transaction for the real depositor.
  const preparation = swapPreparationIntent(intent);
  const result = await collectQuotes(
    env,
    { ...intent, source: "all" },
    fetcher,
  );
  return {
    request: quoteDiscoveryRequest(intent),
    quotes: result.candidates.map((candidate) =>
      serializeCompleteQuote(candidate, preparation, intent.includeRawQuotes),
    ),
    unavailable_sources: result.failures,
    comparison: quoteComparison(intent, result),
    execution: quoteExecutionGuidance(preparation),
  };
}

/**
 * The preparation intent hiding inside a discovery request, or null when this
 * request is only asking what a swap would be worth.
 *
 * Both fields are required together because neither is meaningful alone: a
 * sender without a slippage tolerance has no bound to write into the calldata,
 * and a tolerance without a sender has nothing to write calldata for.
 */
function swapPreparationIntent(
  intent: QuoteDiscoveryIntent,
): SwapPreparationIntent | null {
  if (intent.sender === undefined && intent.slippageBps === undefined) {
    return null;
  }
  if (intent.sender === undefined || intent.slippageBps === undefined) {
    throw new ServiceError(
      "incomplete_execution_request",
      "sender and slippage_bps must be supplied together: a sender has no bound to write into calldata without a tolerance, and a tolerance has no calldata to write without a sender. Supply both to receive execution plans, or neither for an indicative comparison.",
    );
  }
  return { ...intent, sender: intent.sender, slippageBps: intent.slippageBps };
}

function quoteExecutionGuidance(preparation: SwapPreparationIntent | null) {
  return preparation === null
    ? {
        execution_plans_included: false,
        instruction:
          "These quotes are indicative and carry no calldata, because this request named no sender. Once the user has settled on swapping, call this tool again with sender and slippage_bps and every option arrives with the execution_plan that executes it.",
        client_execution: null,
      }
    : {
        execution_plans_included: true,
        instruction:
          "Each quote carries the execution_plan_reference that executes it. Choose one option and pass that quote's execution.execution_plan_reference envelope unchanged as the wallet's reference argument, which fetches and verifies the plan body itself. Do not call this tool again for the option you just chose: it would buy a fresh quote and restart the clock on a plan you already hold. Call it again only after a revert, an expiry, or a change to the amount, tokens, sender, recipient, or slippage.",
        sender: getAddress(preparation.sender),
        recipient: getAddress(preparation.recipient ?? preparation.sender),
        slippage_bps: preparation.slippageBps.toString(),
        client_execution: clientExecution(),
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
  const prepared = prepareCandidate(intent, selected);
  return {
    schema_version: "2",
    action:
      (intent.destinationChainId ?? intent.chainId) === intent.chainId
        ? "ekubo_swap"
        : "ekubo_bridge",
    source: selected.source,
    plan_id: prepared.planId,
    execution_plan_ready: true,
    agent_confirmation_required: false,
    wallet_validation_required: true,
    request: quoteRequest(intent, intent.source),
    selection,
    unavailable_sources: quoted.failures,
    quote_source_url: selected.sourceUrl,
    quote: {
      ...preparedQuote(intent, selected, prepared),
      raw: selected.raw,
    },
    wallet_handoff: {
      instruction:
        "Pass the execution_plan_reference envelope unchanged as the wallet's reference argument for simulation and authorization; the wallet fetches and verifies the plan body itself. Do not ask the user for a separate agent-level approval; the wallet presents the simulated result and collects authorization or signature. Simulate once and send that simulation rather than simulating the same plan twice. Re-prepare after any change or stale quote.",
      recipient: prepared.recipient,
      sender: getAddress(intent.sender),
    },
    execution_plan: prepared.executionPlan,
    client_execution: clientExecution(),
  };
}

/**
 * Turn one already-fetched quote into the exact bytes that would execute it.
 *
 * This is deliberately pure and free of network access. Every provider round
 * trip has already happened by the time it is called, so the same quote can be
 * made executable at the moment it is fetched — which is the only moment at
 * which it is fully worth what it says.
 */
function prepareCandidate(
  intent: SwapPreparationIntent,
  selected: QuoteCandidate,
): PreparedCandidate {
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
    planId: keccak256(stringToHex(JSON.stringify(identity))),
    recipient,
    transaction: serializedTransaction,
    approvals: serializedApprovals,
    postExecutionTransactions: serializedCleanupTransactions,
    minimumAmountOut,
    maximumAmountIn,
    blockNumber,
    blockHash,
    estimatedRouteGas,
    priceImpact,
    executionPlan: executionPlan({
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
  };
}

/** One quote's fetched amounts joined to the bounds its calldata enforces. */
function preparedQuote(
  intent: SwapPreparationIntent,
  selected: QuoteCandidate,
  prepared: PreparedCandidate,
) {
  return {
    provider_quote_id: selected.providerQuoteId,
    amount_in: selected.amountIn.toString(),
    amount_out: selected.amountOut.toString(),
    minimum_amount_out: prepared.minimumAmountOut?.toString() ?? null,
    maximum_amount_in: prepared.maximumAmountIn?.toString() ?? null,
    slippage_bps: intent.slippageBps.toString(),
    price_impact: prepared.priceImpact,
    estimated_route_gas: prepared.estimatedRouteGas,
    block_number: prepared.blockNumber,
    block_hash: prepared.blockHash,
    quote_expiry_timestamp: selected.quoteExpiryTimestamp,
    expected_fill_time_seconds: selected.expectedFillTime,
  };
}

/**
 * How to execute any of these plans. Stated once for the whole response rather
 * than copied onto each option: it is the same text every time, and an agent
 * pays to read it once per copy. It is phrased against whatever the chosen
 * plan happens to contain so that it does not need to vary per option.
 */
function clientExecution() {
  return {
    wallet:
      "Use the user's wallet or signature tooling; never send credentials to this MCP server",
    provider:
      "Use the user's connected provider to validate the transaction, estimate gas, submit, and confirm receipts",
    must_revalidate_before_signing: true,
    steps: [
      "Pass the chosen option's execution_plan_reference envelope unchanged as the wallet's reference argument and let its own simulation establish current state, including whether an approval step is still required; the wallet fetches and verifies the plan body itself, and a separate allowance read or validation call beforehand buys nothing the simulation does not already cover and spends time this quote does not have",
      "Simulate once, present that simulated result, and submit that same simulation rather than paying for an identical one immediately before signing; do not request a separate agent-level confirmation",
      "Have the wallet collect authorization or signature and submit; this MCP server must not receive a private key or seed phrase",
      "If the plan carries an allowance_cleanup step, submit it only after the execution step has a successful receipt",
    ],
  };
}

async function selectQuote(
  env: Env,
  intent: PrepareSwapIntent,
  fetcher: Fetcher,
): Promise<{
  selected: QuoteCandidate;
  candidates: QuoteCandidate[];
  failures: CandidateFailure[];
}> {
  const result = await collectQuotes(env, intent, fetcher);
  return { ...result, selected: result.candidates[0] };
}

async function collectQuotes(
  env: Env,
  intent: QuoteSelectionIntent,
  fetcher: Fetcher,
): Promise<{
  candidates: QuoteCandidate[];
  failures: CandidateFailure[];
}> {
  const destinationChainId = intent.destinationChainId ?? intent.chainId;
  const source = intent.source;
  const isCrossChain = destinationChainId !== intent.chainId;

  if (isCrossChain && source !== "all" && !isCrossChainSource(source)) {
    throw new ServiceError(
      "invalid_quote_source",
      `cross-chain requests require source=across or source=layerzero, received ${source}`,
    );
  }
  if (!isCrossChain && isCrossChainSource(source)) {
    throw new ServiceError(
      "invalid_quote_source",
      `source=${source} requires different origin and destination chain IDs`,
    );
  }

  const requestedSources: QuoteSource[] = isCrossChain
    ? source === "all"
      ? // LayerZero joins the cross-chain comparison only where it is
        // configured. A deployment without the key keeps serving Across routes
        // rather than reporting a provider failure on every bridge request.
        ["across", ...(env.LAYER_ZERO_API_KEY ? (["layerzero"] as const) : [])]
      : [source]
    : source === "all"
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
        case "layerzero":
          return quoteLayerZero(env, intent, fetcher);
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

  return { candidates, failures };
}

function quoteComparison(
  intent: QuoteIntent,
  result: {
    candidates: QuoteCandidate[];
    failures: CandidateFailure[];
  },
) {
  const retryRecommended =
    result.candidates.length === 0 &&
    result.failures.some((failure) => failure.retry_recommended);
  return {
    comparison_basis:
      intent.quoteType === "exact_output"
        ? "lowest_calculated_amount_in"
        : "highest_calculated_amount_out",
    compared_sources: result.candidates.map((candidate) => candidate.source),
    comparison_complete: result.failures.length === 0,
    retry_recommended: retryRecommended,
    retry_instruction: retryRecommended
      ? "No provider returned a usable quote; retry before relying on this result."
      : null,
  };
}

function quoteSelection(
  intent: QuoteIntent,
  result: {
    selected: QuoteCandidate;
    candidates: QuoteCandidate[];
    failures: CandidateFailure[];
  },
) {
  return {
    ...quoteComparison(intent, result),
    selected_source: result.selected.source,
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
    providerQuoteId: null,
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
  intent: QuoteSelectionIntent,
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
    providerQuoteId: null,
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
  intent: QuoteSelectionIntent,
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
  // Relative, not root-relative: the Across base carries a path (/api), and a
  // leading slash would discard it and hit the app's HTML router instead.
  const url = new URL(
    "swap/approval",
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
    providerQuoteId: null,
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
    approvalActual:
      quote.checks?.allowance?.actual != null
        ? BigInt(quote.checks.allowance.actual)
        : null,
    // Across returns an unlimited (uint256 max) approval. Drop it so
    // buildApprovalTransactions issues an exact-amount approval instead,
    // matching the ekubo and 0x paths, which both return [] here.
    approvalTransactions: [],
    quoteExpiryTimestamp: quote.quoteExpiryTimestamp ?? null,
    expectedFillTime: quote.expectedFillTime ?? null,
  };
}

/** Providers that only ever quote a transfer between two different chains. */
function isCrossChainSource(source: QuoteCollectionSource): boolean {
  return source === "across" || source === "layerzero";
}

/**
 * The LayerZero chain catalog, indexed by EIP-155 chain id.
 *
 * Cached per base URL for {@link LAYERZERO_CHAINS_TTL_MS} because it is the
 * one round trip in a LayerZero quote that buys nothing time-sensitive, and a
 * quote's worth decays from the moment it is fetched. A rejected lookup is
 * evicted rather than cached, so one failed catalog read does not disable the
 * provider for the rest of the isolate's life.
 */
const layerZeroChainCatalog = new Map<
  string,
  { fetchedAt: number; keys: Promise<Map<string, string>> }
>();

function layerZeroChainKeys(
  baseUrl: string,
  fetcher: Fetcher,
): Promise<Map<string, string>> {
  const cached = layerZeroChainCatalog.get(baseUrl);
  if (cached && Date.now() - cached.fetchedAt < LAYERZERO_CHAINS_TTL_MS) {
    return cached.keys;
  }
  const keys = fetchLayerZeroChainKeys(baseUrl, fetcher).catch(
    (error: unknown) => {
      if (layerZeroChainCatalog.get(baseUrl)?.keys === keys) {
        layerZeroChainCatalog.delete(baseUrl);
      }
      throw error;
    },
  );
  layerZeroChainCatalog.set(baseUrl, { fetchedAt: Date.now(), keys });
  return keys;
}

async function fetchLayerZeroChainKeys(
  baseUrl: string,
  fetcher: Fetcher,
): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  let nextToken: string | undefined;
  for (let page = 0; page < LAYERZERO_CHAINS_MAX_PAGES; page += 1) {
    const url = new URL("chains", normalizedBase(baseUrl));
    if (nextToken !== undefined) {
      url.searchParams.set("pagination[nextToken]", nextToken);
    }
    // Chain discovery is unauthenticated, so it stays usable for diagnosing a
    // deployment whose key is missing or exhausted.
    const body = await fetchJson<LayerZeroChainsResponse>(
      url.toString(),
      fetcher,
      { headers: layerZeroHeaders() },
    );
    for (const chain of body.chains ?? []) {
      // Only EVM chains carry an EIP-155 id that an intent can name, and only
      // those can be executed through an execution plan.
      if (chain.chainType !== "EVM") continue;
      if (typeof chain.chainId !== "number" || !Number.isFinite(chain.chainId))
        continue;
      if (typeof chain.chainKey !== "string" || chain.chainKey === "") continue;
      keys.set(BigInt(chain.chainId).toString(), chain.chainKey);
    }
    nextToken = body.pagination?.nextToken;
    if (nextToken === undefined || nextToken === "") break;
  }
  if (keys.size === 0) {
    throw new ServiceError(
      "invalid_upstream_response",
      "LayerZero returned no EVM chains",
    );
  }
  return keys;
}

async function layerZeroChainKey(
  baseUrl: string,
  fetcher: Fetcher,
  chainId: string,
  side: "origin" | "destination",
): Promise<string> {
  const keys = await layerZeroChainKeys(baseUrl, fetcher);
  const key = keys.get(BigInt(chainId).toString());
  if (key === undefined) {
    throw new ServiceError(
      "unsupported_chain",
      `LayerZero does not list an EVM chain with id ${chainId} as this transfer's ${side}`,
    );
  }
  return key;
}

function layerZeroToken(token: Address): string {
  return BigInt(token) === 0n ? LAYERZERO_NATIVE_TOKEN : getAddress(token);
}

/** The origin-chain calls one LayerZero quote resolves to, or null. */
interface LayerZeroSteps {
  transaction: UnsignedTransaction;
  approvalSpender: Address | null;
}

/**
 * The spender an ERC-20 approval names, or null when the calldata is not an
 * approval at all.
 *
 * The spender is read out of the step LayerZero built rather than assumed: the
 * documented hazard on this API is approving the LZMulticall wrapper instead
 * of the TransferDelegate, and decoding the step the API itself produced is
 * what makes that mistake unrepresentable here.
 */
function erc20ApprovalSpender(data: Hex): Address | null {
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data });
    if (decoded.functionName !== "approve") return null;
    return getAddress(decoded.args[0] as Address);
  } catch {
    return null;
  }
}

/**
 * One quote's user steps rendered as an execution plan's worth of calls, or
 * null when this route cannot be expressed as one.
 *
 * An execution plan is a fixed set of transactions a wallet signs in order, so
 * a route is only usable here if every step is a transaction on the origin
 * chain. Intent routes (AORI) interleave an EIP-712 signature with a
 * round trip to /submit-signature that the plan has no way to perform, and a
 * route that requires it is dropped rather than half-executed.
 */
function layerZeroSteps(
  quote: LayerZeroQuote,
  chainId: string,
): LayerZeroSteps | null {
  const steps = quote.userSteps ?? [];
  if (steps.length === 0) return null;
  const encoded: LayerZeroEncodedTransaction[] = [];
  for (const step of steps) {
    if (step.type !== "TRANSACTION") return null;
    if (step.chainType !== undefined && step.chainType !== "EVM") return null;
    const transaction = step.transaction?.encoded;
    if (!transaction?.to || !transaction.data) return null;
    encoded.push(transaction);
  }
  const transfer = encoded[encoded.length - 1];
  // Everything before the transfer must be an approval this server can re-issue
  // for an exact amount. Anything else is a call it cannot reason about, and
  // passing it through unread is not something a bridge plan should do.
  let approvalSpender: Address | null = null;
  for (const step of encoded.slice(0, -1)) {
    const spender = erc20ApprovalSpender(step.data);
    if (spender === null) return null;
    approvalSpender = spender;
  }
  return {
    transaction: {
      chainId,
      to: getAddress(transfer.to),
      data: transfer.data,
      value: BigInt(transfer.value ?? 0),
      ...(transfer.gasLimit === undefined
        ? {}
        : { gas: BigInt(transfer.gasLimit) }),
    },
    approvalSpender,
  };
}

/**
 * One quote out of the several LayerZero returns for a transfer.
 *
 * Routes that can be executed win outright over routes that cannot, because an
 * option that cannot be handed to a wallet is worth less than a slightly
 * cheaper one that can; within each group the largest destination amount wins.
 * All of these quotes are EXACT_SRC_AMOUNT, so they spend the same input and
 * differ only in what arrives.
 */
function selectLayerZeroQuote(
  quotes: LayerZeroQuote[],
  chainId: string,
): { quote: LayerZeroQuote; steps: LayerZeroSteps | null } {
  const priced = quotes
    .filter(
      (quote) =>
        typeof quote.srcAmount === "string" &&
        typeof quote.dstAmount === "string",
    )
    .map((quote) => ({ quote, steps: layerZeroSteps(quote, chainId) }));
  if (priced.length === 0) {
    throw new ServiceError(
      "invalid_upstream_response",
      "LayerZero returned no quote carrying both a source and a destination amount",
      quotes,
    );
  }
  const executable = priced.filter((entry) => entry.steps !== null);
  const pool = executable.length > 0 ? executable : priced;
  return pool.reduce((best, entry) =>
    BigInt(entry.quote.dstAmount as string) >
    BigInt(best.quote.dstAmount as string)
      ? entry
      : best,
  );
}

/** LayerZero states an ISO expiry; the candidate carries epoch seconds. */
function layerZeroExpiry(expiresAt: string | undefined): number | null {
  if (expiresAt === undefined) return null;
  const parsed = Date.parse(expiresAt);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

/** LayerZero states an estimated duration in milliseconds; Across in seconds. */
function layerZeroFillTimeSeconds(
  estimated: string | number | null | undefined,
): number | null {
  if (estimated === undefined || estimated === null) return null;
  const milliseconds = Number(estimated);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  return Math.round(milliseconds / 1000);
}

async function quoteLayerZero(
  env: Env,
  intent: QuoteSelectionIntent,
  fetcher: Fetcher,
): Promise<QuoteCandidate> {
  if (!env.LAYER_ZERO_API_KEY) {
    throw new ServiceError(
      "provider_not_configured",
      "LayerZero is not configured for this deployment",
    );
  }
  // The Value Transfer API prices a source amount only: there is no
  // EXACT_DST_AMOUNT. Saying so is more use to the caller than a silent
  // absence, since Across can still serve the same exact-output request.
  if (intent.quoteType === "exact_output") {
    throw new ServiceError(
      "unsupported_quote_type",
      "LayerZero quotes an exact source amount only; request exact_input for a LayerZero route, or use Across for exact output",
    );
  }
  const baseUrl = env.LAYER_ZERO_API_URL ?? LAYERZERO_DEFAULT_URL;
  const destinationChainId = intent.destinationChainId ?? intent.chainId;
  const [srcChainKey, dstChainKey] = await Promise.all([
    layerZeroChainKey(baseUrl, fetcher, intent.chainId, "origin"),
    layerZeroChainKey(baseUrl, fetcher, destinationChainId, "destination"),
  ]);
  // Both wallet addresses are required, so an indicative request borrows the
  // same placeholder depositor the Across path uses.
  const srcWalletAddress = intent.sender
    ? getAddress(intent.sender)
    : LAYERZERO_PREVIEW_WALLET;
  const dstWalletAddress = intent.recipient
    ? getAddress(intent.recipient)
    : srcWalletAddress;
  const url = new URL("quotes", normalizedBase(baseUrl));
  const request = {
    srcChainKey,
    dstChainKey,
    srcTokenAddress: layerZeroToken(intent.tokenIn),
    dstTokenAddress: layerZeroToken(intent.tokenOut),
    srcWalletAddress,
    dstWalletAddress,
    amount: intent.amount,
    options: {
      amountType: "EXACT_SRC_AMOUNT",
      // feeTolerance is a percentage, and it is the bound this route enforces
      // on value lost, so the caller's basis points map straight onto it
      // instead of the API's 1% default silently standing in for them.
      ...(intent.slippageBps === undefined
        ? {}
        : {
            feeTolerance: {
              type: "PERCENT",
              amount: intent.slippageBps / 100,
            },
          }),
    },
  };
  const response = await fetchJson<LayerZeroQuotesResponse>(
    url.toString(),
    fetcher,
    {
      method: "POST",
      headers: {
        ...layerZeroHeaders(env.LAYER_ZERO_API_KEY),
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    },
  );
  // A rejected transfer arrives as a populated error on an otherwise ordinary
  // 200, so the body has to be checked even when the status did not complain.
  if (response.error) {
    throw new ServiceError(
      "upstream_error",
      typeof response.error.message === "string"
        ? response.error.message
        : "LayerZero rejected this transfer request",
      response.error,
    );
  }
  const quotes = response.quotes ?? [];
  if (quotes.length === 0) {
    throw new ServiceError(
      "quote_unavailable",
      "LayerZero returned no route for this transfer",
      response,
    );
  }
  const selected = selectLayerZeroQuote(quotes, intent.chainId);
  const quote = selected.quote;
  const steps = selected.steps;
  return {
    source: "layerzero",
    sourceUrl: url.toString(),
    raw: quote,
    providerQuoteId: typeof quote.id === "string" ? quote.id : null,
    amountIn: BigInt(quote.srcAmount as string),
    amountOut: BigInt(quote.dstAmount as string),
    minimumAmountOut:
      quote.dstAmountMin === undefined ? null : BigInt(quote.dstAmountMin),
    // EXACT_SRC_AMOUNT spends exactly what was asked for, so there is no
    // separate upper bound on the input to enforce.
    maximumAmountIn: null,
    estimatedGas:
      steps?.transaction.gas === undefined
        ? null
        : Number(steps.transaction.gas),
    priceImpact: null,
    transaction: steps?.transaction ?? null,
    approvalRequired: steps?.approvalSpender != null,
    approvalSpender: steps?.approvalSpender ?? null,
    approvalActual: null,
    // Dropped so buildApprovalTransactions issues an exact-amount approval to
    // the decoded spender, as the Across path does.
    approvalTransactions: [],
    quoteExpiryTimestamp: layerZeroExpiry(quote.expiresAt),
    expectedFillTime: layerZeroFillTimeSeconds(quote.duration?.estimated),
  };
}

/**
 * Where one LayerZero transfer has got to.
 *
 * A bridge is the one execution plan whose origin receipt does not mean the
 * user has their funds, so the plan alone cannot answer whether the transfer
 * finished. The quote id returned with the executed option is the transfer id
 * here; supplying the origin transaction hash lets LayerZero resolve the
 * transfer before its own indexer has caught up.
 */
export async function getValueTransferStatus(
  env: Env,
  input: { quoteId: string; transactionHash?: string },
  fetcher: Fetcher = fetch,
) {
  if (!env.LAYER_ZERO_API_KEY) {
    throw new ServiceError(
      "provider_not_configured",
      "LayerZero is not configured for this deployment",
    );
  }
  const baseUrl = env.LAYER_ZERO_API_URL ?? LAYERZERO_DEFAULT_URL;
  const url = new URL(
    `status/${encodeURIComponent(input.quoteId)}`,
    normalizedBase(baseUrl),
  );
  if (input.transactionHash !== undefined) {
    url.searchParams.set("txHash", input.transactionHash);
  }
  const body = await fetchJson<LayerZeroStatusResponse>(
    url.toString(),
    fetcher,
    { headers: layerZeroHeaders(env.LAYER_ZERO_API_KEY) },
  );
  const status = typeof body.status === "string" ? body.status : "UNKNOWN";
  const settled = status === "SUCCEEDED" || status === "FAILED";
  return {
    source: "layerzero",
    source_url: url.toString(),
    quote_id: input.quoteId,
    origin_transaction_hash: input.transactionHash ?? null,
    status,
    settled,
    explorer_url: typeof body.explorerUrl === "string" ? body.explorerUrl : null,
    execution_history: (body.executionHistory ?? []).map((entry) => ({
      event: entry.event ?? null,
      chain_key: entry.transaction?.chainKey ?? null,
      transaction_hash: entry.transaction?.hash ?? null,
      timestamp: entry.transaction?.timestamp ?? null,
    })),
    polling: {
      settled,
      instruction: settled
        ? status === "SUCCEEDED"
          ? "The transfer was delivered on the destination chain. Stop polling and report the destination transaction from execution_history."
          : "The transfer failed. Stop polling, report it, and do not resubmit the origin calldata; request a fresh quote before trying again."
        : "The transfer is still in flight. Poll this tool again in fifteen to thirty seconds, passing the same quote_id and the origin transaction_hash. A cross-chain transfer settles in minutes, not seconds, so polling faster than that spends a metered budget the next quote also needs without learning anything sooner. UNKNOWN immediately after submission usually means the transfer has not been indexed yet, not that it is lost.",
    },
  };
}

function quoteDiscoveryRequest(intent: QuoteIntent) {
  return {
    chain_id: intent.chainId,
    destination_chain_id: intent.destinationChainId ?? intent.chainId,
    token_in: getAddress(intent.tokenIn),
    token_out: getAddress(intent.tokenOut),
    quote_type: intent.quoteType,
    amount: intent.amount,
  };
}

function quoteRequest(intent: QuoteSelectionIntent, source: QuoteSource) {
  return {
    ...quoteDiscoveryRequest(intent),
    source,
    sender: intent.sender ? getAddress(intent.sender) : null,
    recipient: intent.recipient ? getAddress(intent.recipient) : null,
  };
}

function serializeCompleteQuote(
  candidate: QuoteCandidate,
  preparation: SwapPreparationIntent | null,
  includeRawQuotes = false,
) {
  // Both execution fields are always present, so every option has one shape
  // whether or not this request asked for calldata. A caller reads
  // `execution` and finds either a plan or null; it never has to know which
  // kind of response it is holding to know how to look.
  return {
    source: candidate.source,
    source_url: candidate.sourceUrl,
    normalized: serializeCandidate(candidate),
    ...(includeRawQuotes ? { quote: candidate.raw } : {}),
    ...(preparation === null
      ? { execution: null, execution_unavailable: null }
      : executableQuote(preparation, candidate)),
  };
}

/**
 * The execution half of one discovered option.
 *
 * A provider that cannot be made executable must not cost the user the ones
 * that can, so the failure is reported beside its own quote and every other
 * option still stands. That matters most for the provider whose quote is
 * indicative by construction: it stays visible for comparison and simply
 * cannot be handed to a wallet.
 */
function executableQuote(
  intent: SwapPreparationIntent,
  candidate: QuoteCandidate,
) {
  let prepared: PreparedCandidate;
  try {
    prepared = prepareCandidate(intent, candidate);
  } catch (error) {
    return {
      execution: null,
      execution_unavailable: {
        code: error instanceof ServiceError ? error.code : "unexpected_error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  // The transactions are deliberately not restated beside the plan. They used
  // to appear twice, byte for byte, and the copy outside the plan is the one
  // nothing consumes: a wallet is handed execution_plan whole, and its
  // ordered_steps already carry every approval, execution, and cleanup call.
  return {
    execution: {
      plan_id: prepared.planId,
      execution_plan_ready: true,
      quote: preparedQuote(intent, candidate, prepared),
      execution_plan: prepared.executionPlan,
    },
    execution_unavailable: null,
  };
}

function serializeCandidate(candidate: QuoteCandidate) {
  return {
    source: candidate.source,
    provider_quote_id: candidate.providerQuoteId,
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
  intent: SwapPreparationIntent,
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
    // What came back instead is the only thing that explains why. A bare
    // "non-JSON" leaves an operator with nothing to act on, and the usual
    // cause — an edge or WAF page in front of the API — names itself in the
    // first line of its own body.
    throw new ServiceError(
      "invalid_upstream_response",
      `Upstream returned non-JSON content from ${url}`,
      {
        status: response.status,
        content_type: response.headers.get("content-type"),
        body_snippet: raw.slice(0, 300),
      },
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
