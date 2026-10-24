import { quoteJurisdiction } from "./token-restrictions.js";
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
import { swapDeadline } from "./swap-deadline.js";
import {
  type PreparedTransaction,
  transactionIdentity,
  executionPlan,
} from "./execution-plan.js";
import { MCP_SERVER_VERSION } from "./version.js";

/**
 * Bindings declared in `wrangler.jsonc`, which makes the generated types
 * require them, that the code treats as absent-tolerant on purpose.
 *
 * The rate limiters are the original case: `wrangler dev` and any deployment
 * that has not provisioned the namespaces must still serve, with abuse
 * protection degraded rather than the endpoint down. `LI_FI_INTEGRATOR` is the
 * same shape of claim — a deployment that has not named an integration still
 * quotes LI.FI, it simply attributes nothing. Widening them back to optional
 * here keeps that contract in the type system instead of only in the comments.
 */
type OptionalBindings =
  | "RATE_LIMITER"
  | "RATE_LIMITER_BURST"
  | "RATE_LIMITER_TOOLS"
  | "RATE_LIMITER_METERED"
  | "LI_FI_INTEGRATOR";

export type Env = Omit<Cloudflare.Env, OptionalBindings> &
  Partial<Pick<Cloudflare.Env, OptionalBindings>> & {
    ZERO_X_API_URL?: string;
    ACROSS_API_URL?: string;
    LAYER_ZERO_API_URL?: string;
    LI_FI_API_URL?: string;
    ALLOWED_HOSTNAMES?: string;
    ALLOWED_ORIGINS?: string;
  };

export type QuoteSource = "ekubo" | "0x" | "across" | "layerzero" | "lifi";

type QuoteCollectionSource = QuoteSource | "all";

export interface QuoteIntent {
  chainId: string;
  destinationChainId?: string;
  tokenIn: Address;
  tokenOut: Address;
  quoteType: EvmQuoterQuoteType;
  amount: string;
}

export interface SwapPreparationIntent extends QuoteIntent {
  slippageBps: number;
  recipient?: Address;
  sender: Address;
  swapDeadlineMinutes?: number;
}

export interface PrepareSwapIntent extends SwapPreparationIntent {
  source: QuoteSource;
}

export interface QuoteDiscoveryIntent extends QuoteIntent {
  slippageBps?: number;
  recipient?: Address;
  sender?: Address;
  swapDeadlineMinutes?: number;
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
  quoteExpiryTimestamp: number | null;
  estimatedRouteGas: number | null;
  priceImpact: number | null;
  executionPlan: ReturnType<typeof executionPlan> & { extensions: { "ekubo.jurisdiction": ReturnType<typeof quoteJurisdiction> } };
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
  // Firm /quote responses carry the gas limit on the transaction; indicative
  // /price responses carry it at the top level. Both are nullable upstream.
  gas?: unknown;
  transaction?: {
    to: Address;
    data: Hex;
    value: string;
    gas?: string | null;
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

interface LiFiQuote {
  id?: string;
  tool?: string;
  estimate?: {
    fromAmount?: string;
    toAmount?: string;
    toAmountMin?: string;
    approvalAddress?: Address;
    executionDuration?: number;
  };
  transactionRequest?: LiFiTransactionRequest;
  [key: string]: unknown;
}

interface LiFiTransactionRequest {
  to?: Address;
  data?: Hex;
  value?: string;
  chainId?: number;
  gasLimit?: string;
}

interface LiFiStatusResponse {
  status?: string;
  substatus?: string;
  substatusMessage?: string;
  tool?: string;
  lifiExplorerLink?: string;
  bridgeExplorerLink?: string;
  sending?: LiFiStatusTransaction;
  receiving?: LiFiStatusTransaction;
  [key: string]: unknown;
}

interface LiFiStatusTransaction {
  txHash?: string;
  chainId?: number;
  timestamp?: number;
}

const ZERO_X_NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO_X_DEFAULT_URL = "https://api.0x.org";
const ACROSS_DEFAULT_URL = "https://app.across.to/api";
const ACROSS_PREVIEW_DEPOSITOR = "0x0000000000000000000000000000000000000001";
const LAYERZERO_DEFAULT_URL = "https://transfer.layerzero-api.com/v1";
const LAYERZERO_NATIVE_TOKEN = ZERO_X_NATIVE_TOKEN;
const LAYERZERO_PREVIEW_WALLET = "0x0000000000000000000000000000000000000001";
const LAYERZERO_CHAINS_TTL_MS = 10 * 60 * 1000;
const LAYERZERO_CHAINS_MAX_PAGES = 20;
const LIFI_DEFAULT_URL = "https://li.quest/v1";
const LIFI_PREVIEW_SENDER = "0x0000000000000000000000000000000000000001";

/**
 * Workers send no User-Agent unless one is set, and LayerZero's edge answers a
 * request without one with a 403 HTML page rather than JSON. Naming the client
 * is what keeps the API reachable from a Worker at all, so this is load-bearing
 * rather than courtesy, and every third-party API is given the same name for
 * the same reason.
 */
const MCP_USER_AGENT = `ekubo-mcp/${MCP_SERVER_VERSION}`;

function layerZeroHeaders(apiKey?: string): Record<string, string> {
  return {
    "user-agent": MCP_USER_AGENT,
    ...(apiKey === undefined ? {} : { "x-api-key": apiKey }),
  };
}

function liFiHeaders(apiKey: string): Record<string, string> {
  return { "user-agent": MCP_USER_AGENT, "x-lifi-api-key": apiKey };
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

export function failureCode(error: unknown): string {
  if (error instanceof ServiceError) return error.code;
  if (error instanceof Error && error.name === "TimeoutError") {
    return "upstream_timeout";
  }
  return "unexpected_error";
}

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

    if (normalizedQuery.length > 0) {
      const leftExact = tokenSymbol(left) === normalizedQuery ? 1 : 0;
      const rightExact = tokenSymbol(right) === normalizedQuery ? 1 : 0;
      if (leftExact !== rightExact) return rightExact - leftExact;
    }

    return tokenSymbol(left).localeCompare(tokenSymbol(right));
  });
}

export const CANONICAL_TOKEN_LIST_NAME = "Ekubo canonical token list";

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

export async function getQuotesWithPlans(
  env: Env,
  intent: QuoteDiscoveryIntent,
  fetcher: Fetcher = fetch,
) {
  const preparation = swapPreparationIntent(intent);
  const result = await collectQuotes(
    env,
    { ...intent, source: "all" },
    fetcher,
  );
  return {
    request: quoteDiscoveryRequest(intent),
    jurisdiction: swapJurisdiction(intent),
    quotes: result.candidates.map((candidate) =>
      serializeCompleteQuote(
        intent,
        candidate,
        preparation,
        intent.includeRawQuotes,
      ),
    ),
    unavailable_sources: result.failures,
    comparison: quoteComparison(intent, result),
    execution: quoteExecutionGuidance(preparation),
  };
}

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
    jurisdiction: swapJurisdiction(intent),
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
  let quoteExpiryTimestamp = selected.quoteExpiryTimestamp;

  if (selected.source === "ekubo") {
    const prepared = prepareSwapFromQuote({
      quote: selected.raw as EvmQuoterQuote,
      tokenIn: intent.tokenIn,
      tokenOut: intent.tokenOut,
      quoteType: intent.quoteType,
      amount: intent.amount,
      slippageBps: intent.slippageBps,
      recipient,
      deadline: swapDeadline(intent.swapDeadlineMinutes),
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
    quoteExpiryTimestamp = prepared.deadline;
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
    quote_expiry_timestamp: quoteExpiryTimestamp,
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
    quoteExpiryTimestamp,
    estimatedRouteGas,
    priceImpact,
    executionPlan: { ...executionPlan({
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
    }), extensions: { "ekubo.jurisdiction": swapJurisdiction(intent) } },
  };
}

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
    native_fee: nativeFee(intent, selected)?.toString() ?? null,
    total_native_input: selected.transaction?.value.toString() ?? null,
    slippage_bps: intent.slippageBps.toString(),
    price_impact: prepared.priceImpact,
    estimated_route_gas: prepared.estimatedRouteGas,
    block_number: prepared.blockNumber,
    block_hash: prepared.blockHash,
    quote_expiry_timestamp: prepared.quoteExpiryTimestamp,
    expected_fill_time_seconds: selected.expectedFillTime,
  };
}

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
      `cross-chain requests require source=across, source=layerzero, or source=lifi, received ${source}`,
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
      ? [
          "across",
          ...(env.LAYER_ZERO_API_KEY ? (["layerzero"] as const) : []),
          ...(env.LI_FI_API_KEY ? (["lifi"] as const) : []),
        ]
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
        case "lifi":
          return quoteLiFi(env, intent, fetcher);
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
      code: failureCode(result.reason),
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
  const surcharged = result.candidates.filter((candidate) => {
    const fee = nativeFee(intent, candidate);
    return fee !== null && fee > 0n;
  });
  const outputIsNative = BigInt(intent.tokenOut) === 0n;
  const exactOutput = intent.quoteType === "exact_output";
  const basis = exactOutput
    ? "lowest_calculated_amount_in"
    : surcharged.length > 0 && outputIsNative
      ? "highest_calculated_amount_out_net_of_native_fee"
      : "highest_calculated_amount_out";
  const basisOmitsFee = surcharged.length > 0 && !outputIsNative;
  return {
    comparison_basis: basis,
    compared_sources: result.candidates.map((candidate) => candidate.source),
    comparison_complete: result.failures.length === 0 && !basisOmitsFee,
    ...(surcharged.length > 0
      ? {
          native_fee_sources: surcharged.map((candidate) => candidate.source),
          native_fee_instruction: basisOmitsFee
            ? `${surcharged.map((candidate) => candidate.source).join(", ")} charge a native fee on top of the input, in a different token than the output. Compare native_fee and total_native_input alongside amount_out; ranking on amount_out alone understates their cost.`
            : `${surcharged.map((candidate) => candidate.source).join(", ")} charge a native fee on top of the input. The basis nets it out, so rank on amount_out minus native_fee rather than on amount_out.`,
        }
      : {}),
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
  const exactOutput = intent.quoteType === "exact_output";
  const requested = BigInt(intent.amount);
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
    estimatedGas: zeroXGasLimit(quote),
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
    approvalTransactions: [],
    quoteExpiryTimestamp: quote.quoteExpiryTimestamp ?? null,
    expectedFillTime: quote.expectedFillTime ?? null,
  };
}

function isCrossChainSource(source: QuoteCollectionSource): boolean {
  return source === "across" || source === "layerzero" || source === "lifi";
}

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
    const body = await fetchJson<LayerZeroChainsResponse>(
      url.toString(),
      fetcher,
      { headers: layerZeroHeaders() },
    );
    for (const chain of body.chains ?? []) {
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

function layerZeroExpiry(expiresAt: string | undefined): number | null {
  if (expiresAt === undefined) return null;
  const parsed = Date.parse(expiresAt);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

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
    approvalTransactions: [],
    quoteExpiryTimestamp: layerZeroExpiry(quote.expiresAt),
    expectedFillTime: layerZeroFillTimeSeconds(quote.duration?.estimated),
  };
}

/**
 * The origin-chain call one LI.FI quote resolves to.
 *
 * The chain is checked rather than trusted. Everything downstream states the
 * origin chain from the intent, so a transactionRequest built for a different
 * one would otherwise be relabelled and signed against the wrong network
 * instead of rejected.
 */
function liFiTransaction(
  request: LiFiTransactionRequest | undefined,
  chainId: string,
): UnsignedTransaction {
  if (!request?.to || !request.data) {
    throw new ServiceError(
      "invalid_upstream_response",
      "LI.FI quote omitted the transaction that executes it",
      request,
    );
  }
  if (
    request.chainId !== undefined &&
    BigInt(request.chainId) !== BigInt(chainId)
  ) {
    throw new ServiceError(
      "invalid_upstream_response",
      `LI.FI returned a transaction for chain ${request.chainId} on a transfer whose origin is ${chainId}`,
      request,
    );
  }
  return {
    chainId,
    to: getAddress(request.to),
    data: request.data,
    value: BigInt(request.value ?? 0),
    ...(request.gasLimit === undefined
      ? {}
      : { gas: BigInt(request.gasLimit) }),
  };
}

async function quoteLiFi(
  env: Env,
  intent: QuoteSelectionIntent,
  fetcher: Fetcher,
): Promise<QuoteCandidate> {
  if (!env.LI_FI_API_KEY) {
    throw new ServiceError(
      "provider_not_configured",
      "LI.FI is not configured for this deployment",
    );
  }
  const baseUrl = env.LI_FI_API_URL ?? LIFI_DEFAULT_URL;
  const destinationChainId = intent.destinationChainId ?? intent.chainId;
  const exactOutput = intent.quoteType === "exact_output";
  const url = new URL(
    exactOutput ? "quote/toAmount" : "quote",
    normalizedBase(baseUrl),
  );
  url.searchParams.set("fromChain", intent.chainId);
  url.searchParams.set("toChain", destinationChainId);
  url.searchParams.set("fromToken", getAddress(intent.tokenIn));
  url.searchParams.set("toToken", getAddress(intent.tokenOut));
  url.searchParams.set(exactOutput ? "toAmount" : "fromAmount", intent.amount);
  url.searchParams.set(
    "fromAddress",
    intent.sender ? getAddress(intent.sender) : LIFI_PREVIEW_SENDER,
  );
  if (intent.recipient) {
    url.searchParams.set("toAddress", getAddress(intent.recipient));
  }
  if (intent.slippageBps !== undefined) {
    url.searchParams.set("slippage", (intent.slippageBps / 10_000).toString());
  }
  if (env.LI_FI_INTEGRATOR) {
    url.searchParams.set("integrator", env.LI_FI_INTEGRATOR);
  }
  if (!intent.sender) url.searchParams.set("skipSimulation", "true");

  const quote = await fetchJson<LiFiQuote>(url.toString(), fetcher, {
    headers: liFiHeaders(env.LI_FI_API_KEY),
  });
  const estimate = quote.estimate;
  if (
    typeof estimate?.fromAmount !== "string" ||
    typeof estimate.toAmount !== "string"
  ) {
    throw new ServiceError(
      "invalid_upstream_response",
      "LI.FI quote omitted the amounts it estimates",
      quote,
    );
  }
  const transaction = liFiTransaction(quote.transactionRequest, intent.chainId);
  const approvalRequired =
    BigInt(intent.tokenIn) !== 0n && estimate.approvalAddress !== undefined;
  return {
    source: "lifi",
    sourceUrl: url.toString(),
    raw: quote,
    providerQuoteId: typeof quote.id === "string" ? quote.id : null,
    amountIn: BigInt(estimate.fromAmount),
    amountOut: BigInt(estimate.toAmount),
    minimumAmountOut:
      typeof estimate.toAmountMin === "string"
        ? BigInt(estimate.toAmountMin)
        : null,
    maximumAmountIn: exactOutput ? BigInt(estimate.fromAmount) : null,
    estimatedGas:
      transaction.gas === undefined ? null : Number(transaction.gas),
    priceImpact: null,
    transaction,
    approvalRequired,
    approvalSpender: approvalRequired
      ? getAddress(estimate.approvalAddress as Address)
      : null,
    approvalActual: null,
    approvalTransactions: [],
    quoteExpiryTimestamp: null,
    expectedFillTime:
      typeof estimate.executionDuration === "number"
        ? estimate.executionDuration
        : null,
  };
}

export interface ValueTransferStatusInput {
  source?: "layerzero" | "lifi";
  quoteId?: string;
  transactionHash?: string;
  originChainId?: string;
  destinationChainId?: string;
}

export async function getValueTransferStatus(
  env: Env,
  input: ValueTransferStatusInput,
  fetcher: Fetcher = fetch,
) {
  return (input.source ?? "layerzero") === "lifi"
    ? liFiTransferStatus(env, input, fetcher)
    : layerZeroTransferStatus(env, input, fetcher);
}

async function layerZeroTransferStatus(
  env: Env,
  input: ValueTransferStatusInput,
  fetcher: Fetcher,
) {
  if (!env.LAYER_ZERO_API_KEY) {
    throw new ServiceError(
      "provider_not_configured",
      "LayerZero is not configured for this deployment",
    );
  }
  if (input.quoteId === undefined) {
    throw new ServiceError(
      "missing_quote_id",
      "LayerZero reuses the quote id as the transfer id and resolves a transfer by it; pass the executed option's provider_quote_id as quote_id.",
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
    substatus: null,
    substatus_message: null,
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

async function liFiTransferStatus(
  env: Env,
  input: ValueTransferStatusInput,
  fetcher: Fetcher,
) {
  if (!env.LI_FI_API_KEY) {
    throw new ServiceError(
      "provider_not_configured",
      "LI.FI is not configured for this deployment",
    );
  }
  if (input.transactionHash === undefined) {
    throw new ServiceError(
      "missing_transaction_hash",
      "LI.FI resolves a transfer only by its origin transaction hash; pass transaction_hash. Unlike LayerZero the quote id is not a transfer id here — LI.FI rejects it outright — so there is nothing to look up before the origin transaction has been sent.",
    );
  }
  const baseUrl = env.LI_FI_API_URL ?? LIFI_DEFAULT_URL;
  const url = new URL("status", normalizedBase(baseUrl));
  url.searchParams.set("txHash", input.transactionHash);
  if (input.originChainId !== undefined) {
    url.searchParams.set("fromChain", input.originChainId);
  }
  if (input.destinationChainId !== undefined) {
    url.searchParams.set("toChain", input.destinationChainId);
  }
  const body = await liFiStatusBody(url.toString(), fetcher, env.LI_FI_API_KEY);
  const status = typeof body.status === "string" ? body.status : "UNKNOWN";
  const substatus = typeof body.substatus === "string" ? body.substatus : null;
  // DONE and FAILED are final. So is INVALID, which says this hash is not a
  // transfer LI.FI can resolve rather than that it has not landed yet, and no
  // amount of polling changes that. NOT_FOUND is the not-yet-indexed one.
  const settled =
    status === "DONE" || status === "FAILED" || status === "INVALID";
  return {
    source: "lifi",
    source_url: url.toString(),
    quote_id: input.quoteId ?? null,
    origin_transaction_hash: input.transactionHash,
    status,
    substatus,
    substatus_message:
      typeof body.substatusMessage === "string" ? body.substatusMessage : null,
    settled,
    explorer_url:
      typeof body.lifiExplorerLink === "string"
        ? body.lifiExplorerLink
        : typeof body.bridgeExplorerLink === "string"
          ? body.bridgeExplorerLink
          : null,
    execution_history: liFiStatusHistory(body),
    polling: {
      settled,
      instruction: liFiStatusInstruction(status, substatus),
    },
  };
}

const LIFI_NOT_FOUND_CODE = 1003;

async function liFiStatusBody(
  url: string,
  fetcher: Fetcher,
  apiKey: string,
): Promise<LiFiStatusResponse> {
  try {
    return await fetchJson<LiFiStatusResponse>(url, fetcher, {
      headers: liFiHeaders(apiKey),
    });
  } catch (error) {
    if (
      error instanceof ServiceError &&
      isRecord(error.details) &&
      error.details.code === LIFI_NOT_FOUND_CODE
    ) {
      return { status: "NOT_FOUND" };
    }
    throw error;
  }
}

function liFiStatusHistory(body: LiFiStatusResponse) {
  return (
    [
      ["SENT", body.sending],
      ["RECEIVED", body.receiving],
    ] as const
  ).flatMap(([event, leg]) =>
    typeof leg?.txHash !== "string"
      ? []
      : [
          {
            event,
            chain_key: leg.chainId === undefined ? null : String(leg.chainId),
            transaction_hash: leg.txHash,
            timestamp: leg.timestamp ?? null,
          },
        ],
  );
}

function liFiStatusInstruction(
  status: string,
  substatus: string | null,
): string {
  if (status === "DONE") {
    // A DONE transfer is not automatically a delivered one: LI.FI reports a
    // refund and a partial fill as completed states of the transfer, and the
    // difference is the whole of what the user needs to hear.
    if (substatus === "REFUNDED") {
      return "The transfer could not be completed and the input was refunded on the origin chain. Stop polling and report the refund; the destination never received these funds.";
    }
    if (substatus === "PARTIAL") {
      return "The transfer was only partially filled: some destination assets arrived and the rest was refunded or is held. Stop polling, report the amounts from execution_history, and check the destination balance before acting on it.";
    }
    return "The transfer was delivered on the destination chain. Stop polling and report the destination transaction from execution_history.";
  }
  if (status === "FAILED") {
    return "The transfer failed. Stop polling, report it, and do not resubmit the origin calldata; request a fresh quote before trying again.";
  }
  if (status === "INVALID") {
    return "LI.FI does not recognize this hash or step id as one of its transfers. Stop polling and check that the identifier came from an executed LI.FI option and that origin_chain_id names the chain it was sent on; polling cannot resolve this.";
  }
  return "The transfer is still in flight. Poll this tool again in fifteen to thirty seconds, passing the same identifiers. A cross-chain transfer settles in minutes, not seconds, so polling faster spends a metered budget the next quote also needs without learning anything sooner. NOT_FOUND immediately after submission usually means the transfer has not been indexed yet, not that it is lost.";
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

function swapJurisdiction(intent: QuoteIntent) {
  return quoteJurisdiction([
    { chainId: intent.chainId, token: intent.tokenIn, side: "sell" },
    { chainId: intent.destinationChainId ?? intent.chainId, token: intent.tokenOut, side: "buy" },
  ]);
}

function serializeCompleteQuote(
  intent: QuoteIntent,
  candidate: QuoteCandidate,
  preparation: SwapPreparationIntent | null,
  includeRawQuotes = false,
) {
  return {
    source: candidate.source,
    source_url: candidate.sourceUrl,
    normalized: serializeCandidate(intent, candidate),
    jurisdiction: swapJurisdiction(intent),
    ...(includeRawQuotes ? { quote: candidate.raw } : {}),
    ...(preparation === null
      ? { execution: null, execution_unavailable: null }
      : executableQuote(preparation, candidate)),
  };
}

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
  return {
    execution: {
      plan_id: prepared.planId,
      execution_plan_ready: true,
      jurisdiction: swapJurisdiction(intent),
      quote: preparedQuote(intent, candidate, prepared),
      execution_plan: prepared.executionPlan,
    },
    execution_unavailable: null,
  };
}

function nativeFee(
  intent: QuoteIntent,
  candidate: QuoteCandidate,
): bigint | null {
  if (candidate.transaction === null) return null;
  const swapped = BigInt(intent.tokenIn) === 0n ? candidate.amountIn : 0n;
  const value = candidate.transaction.value;
  return value > swapped ? value - swapped : 0n;
}

function serializeCandidate(intent: QuoteIntent, candidate: QuoteCandidate) {
  const fee = nativeFee(intent, candidate);
  return {
    source: candidate.source,
    provider_quote_id: candidate.providerQuoteId,
    amount_in: candidate.amountIn.toString(),
    amount_out: candidate.amountOut.toString(),
    minimum_amount_out: candidate.minimumAmountOut?.toString() ?? null,
    maximum_amount_in: candidate.maximumAmountIn?.toString() ?? null,
    native_fee: fee?.toString() ?? null,
    total_native_input: candidate.transaction?.value.toString() ?? null,
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
  transaction: {
    to: Address;
    data: Hex;
    value?: string;
    gas?: string | null;
  },
): UnsignedTransaction {
  return {
    chainId,
    to: getAddress(transaction.to),
    data: transaction.data,
    value: BigInt(transaction.value ?? 0),
    ...(transaction.gas == null ? {} : { gas: BigInt(transaction.gas) }),
  };
}

// The firm transaction's gas limit takes precedence over the indicative
// top-level estimate. A missing, null, zero or malformed value is unknown
// (null), never zero.
function zeroXGasLimit(quote: ZeroXQuote): number | null {
  return gasUnits(quote.transaction?.gas) ?? gasUnits(quote.gas);
}

function gasUnits(value: unknown): number | null {
  const parsed =
    typeof value === "string" && /^[0-9]+$/.test(value)
      ? Number(value)
      : typeof value === "number"
        ? value
        : null;
  return parsed !== null && Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : null;
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
