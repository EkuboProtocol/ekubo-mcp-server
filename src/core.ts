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

export type QuoteSource = "ekubo" | "0x" | "across";

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

  if (isCrossChain && source !== "all" && source !== "across") {
    throw new ServiceError(
      "invalid_quote_source",
      `cross-chain requests require source=across, received ${source}`,
    );
  }
  if (!isCrossChain && source === "across") {
    throw new ServiceError(
      "invalid_quote_source",
      "source=across requires different origin and destination chain IDs",
    );
  }

  const requestedSources: QuoteSource[] = isCrossChain
    ? ["across"]
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
