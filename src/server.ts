import {
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import {
  type Address,
  getAddress,
  type Hex,
  isAddress,
  numberToHex,
} from "viem";
import { z } from "zod";
import {
  CONTRACT_ADDRESS_TEMPLATE,
  CONTRACT_CHAIN_TEMPLATE,
  CONTRACT_DIRECTORY_URI,
  contractAddressCompletions,
  contractAddressResource,
  contractChainCompletions,
  contractChainResource,
  contractDirectory,
} from "./contracts.js";
import {
  CANONICAL_TOKEN_LIST_NAME,
  type Env,
  getQuotesWithPlans,
  getToken,
  getTokens,
  getValueTransferStatus,
  listTokens,
  prepareSwap,
  type QuoteSource,
  ServiceError,
  tokenListEntries,
} from "./core.js";
import {
  canonicalChainId,
  decodePoolConfig,
  derivePoolId,
  getPool,
  getPoolLiquidity,
  getPositionPoolCandidates,
  getPositionsByOwner,
  listPoolKeys,
  type PoolKeyInput,
} from "./pools.js";
import { getPosition } from "./positions.js";
import {
  prepareLpPositionDeposit,
  prepareLpPositionEarningsClaim,
  prepareLpPositionWithdraw,
  preparePoolInitialization,
} from "./liquidity.js";
import {
  getVe33Allocations,
  prepareAllVe33FeeClaims,
  prepareVe33Claim,
  prepareVe33Extend,
  prepareVe33IncreaseStake,
  prepareVe33Merge,
  prepareVe33Reallocation,
  prepareVe33Reinvest,
  prepareVe33Split,
  prepareVe33Stake,
  prepareVe33Vote,
  prepareVe33Withdraw,
  type Ve33PoolKeyInput,
} from "./ve33.js";
import {
  prepareApprovalRevocations,
  prepareExecuteTwammVirtualOrders,
  prepareLpPositionTransfer,
  prepareManualPoolBoost,
  prepareOldGekuboUnwrap,
  prepareOracleCapacityExpansion,
  prepareWrapUnwrap,
} from "./ui-actions.js";
import { prepareFixPoolPrice } from "./fix-price.js";
import {
  prepareTwammOrder,
  prepareTwammOrderCollection,
  prepareTwammOrderStop,
} from "./orders.js";
import {
  prepareAuctionComplete,
  prepareAuctionCreate,
  prepareAuctionCreatorProceeds,
} from "./auctions.js";
import {
  getRewardsClaimsByOwner,
  prepareRevenueBuybacks,
  prepareRewardsClaim,
} from "./claims.js";
import { getStonxAllocationRecommendation } from "./recommendations.js";
import {
  getLiquidityOpportunities,
  type LiquidityOpportunityType,
} from "./opportunities.js";
import {
  artifactReferenceSchema,
  referenceWalletArtifacts,
  storeArtifact,
} from "./artifact-store.js";
import { MCP_SERVER_VERSION, MCP_TOOL_CATALOG_REVISION } from "./version.js";
import { PROTOCOL_SKILLS } from "./protocol-skills.js";
import {
  getAaveV3Markets,
  prepareAaveV3Borrow,
  prepareAaveV3Collateral,
  prepareAaveV3EMode,
  prepareAaveV3Repay,
  prepareAaveV3Supply,
  prepareAaveV3Withdraw,
} from "./aave.js";
import {
  getMorphoVaults,
  prepareMorphoVaultDeposit,
  prepareMorphoVaultRedeem,
  prepareMorphoVaultWithdraw,
} from "./morpho.js";
import {
  getAerodromeDeployment,
  prepareAerodromeGaugeClaim,
  prepareAerodromeGaugeDeposit,
  prepareAerodromeGaugeWithdraw,
  prepareAerodromeIncentiveClaim,
  prepareAerodromeLiquidityDeposit,
  prepareAerodromeLiquidityWithdraw,
  prepareAerodromeLock,
  prepareAerodromeSugarReads,
  prepareAerodromeVote,
} from "./aerodrome.js";
import { getMerklDeployment, prepareMerklClaim } from "./merkl.js";
import {
  getSkySavingsDeployment,
  prepareSkySavingsDeposit,
  prepareSkySavingsRedeem,
  prepareSkySavingsWithdraw,
} from "./sky.js";
import {
  getLidoDeployment,
  prepareLidoStake,
  prepareLidoUnwrap,
  prepareLidoWithdrawalClaim,
  prepareLidoWithdrawalRequest,
  prepareLidoWrap,
} from "./lido.js";
import {
  MAX_TRANSFERS_PER_PLAN,
  prepareTransfers,
} from "./transfers.js";
import {
  assertAssetsTradable,
  type RequestCountry,
} from "./token-restrictions.js";

export const ROBINHOOD_STONX_CHAIN_ID = "4663";
export const ROBINHOOD_STONX_VE_TOKEN = getAddress(
  "0x9d7008E169D040B6c0140eb92E7cA82B12643497",
);
export const ROBINHOOD_STONX_VE33 = getAddress(
  "0xD18685a514E59b06d59824e16Db07e73345d9953",
);

function isPositiveBigInt(value: string | number): boolean {
  try {
    return BigInt(value) > 0n;
  } catch {
    return false;
  }
}

const chainId = z
  .union([
    z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    z
      .string()
      .regex(
        /^(?:[1-9][0-9]*|0x[0-9a-fA-F]+)$/,
        "chain_id must be a positive decimal or hexadecimal integer",
      ),
  ])
  .refine(isPositiveBigInt, "chain_id must be positive")
  .describe(
    "EVM chain ID as a JSON integer, decimal string, or hexadecimal string; responses use a canonical decimal string",
  );
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte EVM address")
  .describe("20-byte EVM token address; use all-zeroes for the native token");
const tokenIdentifier = z
  .string()
  .regex(
    /^(?:0x[0-9a-fA-F]{1,40}|eip155:[0-9]+:0x[0-9a-fA-F]{1,40})$/,
    "must be an EVM address or eip155:<chain_id>:<address>",
  )
  .describe(
    "Raw EVM address or CAIP-10 eip155:<chain_id>:<address>; all-zeroes denotes the native token",
  );
const uintString = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/, "must be an unsigned decimal integer");
const signedIntString = z
  .string()
  .regex(/^-?(?:0|[1-9][0-9]*)$/, "must be a signed decimal integer");
const uintLikeString = z
  .string()
  .regex(
    /^(?:(?:0|[1-9][0-9]*)|0x[0-9a-fA-F]+)$/,
    "must be an unsigned decimal or hexadecimal integer",
  );
const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be exactly 32 bytes")
  .describe("0x-prefixed bytes32");
const quoteType = z.enum(["exact_input", "exact_output"]);
const quoteSource = z.enum(["ekubo", "0x", "across", "layerzero", "lifi"]);
const amount = z
  .string()
  .regex(/^[0-9]*[1-9][0-9]*$/, "amount must be a positive base-unit integer")
  .describe("Positive exact-input or exact-output token amount in base units");

// Every list-token filter is optional so an agent can call the tool with no
// arguments; the interface visibility threshold and a context-sized page are
// applied here instead of in the published schema.
const DEFAULT_TOKEN_PAGE_SIZE = 20;
/**
 * How many entries an export carries when the caller names no limit.
 *
 * Set to what a wallet accepts in one import rather than to everything that
 * exists, because an export past the importer's limit is refused whole: a
 * larger default would turn "export mainnet" — over 5,000 tokens — from a
 * short list into a failed one.
 */
const DEFAULT_TOKEN_EXPORT_SIZE = 1_000;
/** Largest page the canonical token API will serve. */
const UPSTREAM_MAX_TOKEN_PAGE_SIZE = 10_000;

export const listTokensSchema = z.object({
  chain_id: chainId
    .optional()
    .describe(
      "Restrict the list to one EVM chain; omit to list tokens across every indexed chain",
    ),
  search: z
    .string()
    .min(1)
    .max(32)
    .optional()
    .describe(
      "Case-insensitive token symbol prefix or suffix match; omit to list the whole canonical set. Symbols only, not names or addresses",
    ),
  min_visibility_priority: z
    .number()
    .int()
    .min(-100)
    .max(100)
    .optional()
    .describe(
      "Lowest visibility_priority to include; defaults to 0, the interface threshold. Pass a negative value to reach tokens the interface hides",
    ),
  page_size: z
    .number()
    .int()
    .min(1)
    .max(1_000)
    .optional()
    .describe("Maximum tokens to return; defaults to 20"),
  after_token: z
    .string()
    .regex(
      /^(?:[1-9][0-9]*|0x[0-9a-fA-F]+):0x[0-9a-fA-F]+$/,
      "after_token must be <chain_id>:<address>",
    )
    .optional()
    .describe(
      "Keep only tokens whose (chain_id, address) pair sorts after this <chain_id>:<address> identifier. Results are ordered by visibility_priority rather than by that pair, so this filters the candidate set instead of continuing a page boundary",
    ),
});

/**
 * Exporting is a different job from listing, so it is a different tool rather
 * than a flag on one.
 *
 * `list_tokens` answers a question the model reasons about — which
 * address is the USDC the user meant — and its search, paging, and full
 * metadata all serve that. Export answers no question: it hands a wallet a
 * list to hold. No entry ever reaches the model, so the knobs that shape what
 * the model reads would be noise, and the metadata that makes a record
 * readable is dead weight in a body only a wallet parses. What is left is the
 * whole surface: which chain, and how many at most.
 *
 * The visibility threshold is fixed at the interface's own, rather than
 * exposed. Reaching below it is how a caller asks for tokens the interface
 * deliberately hides, and a bulk export destined for the screen where an
 * owner grants names is the last place that should be reachable in one
 * argument.
 */
export const exportTokensSchema = z.object({
  chain_id: chainId
    .optional()
    .describe(
      "Export only this EVM chain's tokens. Almost always pass this: a wallet holds names for the chain it is on. Note that scoping by chain does not by itself bring an export under a wallet's per-import limit — at the interface visibility threshold Ethereum carries about 5,600 tokens, BNB Chain 3,600, Base 2,600, and Arbitrum and Polygon around 1,000 each. Omit to export across every indexed chain",
    ),
  max_tokens: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .optional()
    .describe(
      "Largest number of entries to export; defaults to 1,000, which is what a wallet accepts in one import. An export larger than the importer's limit is refused whole rather than truncated, so a bigger number is not a safer one. When more tokens exist than this allows, the result reports complete=false and carries the first max_tokens of them",
    ),
});

export const getTokenSchema = z.object({
  chain_id: chainId,
  address: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, "address must be hexadecimal")
    .describe("EVM or Starknet token address"),
});

export const getTokensSchema = z.object({
  tokens: z
    .array(
      z.object({
        chain_id: chainId,
        address: z
          .string()
          .regex(/^0x[0-9a-fA-F]+$/, "address must be hexadecimal")
          .describe("EVM or Starknet token address"),
      }),
    )
    .min(1)
    .max(1_000)
    .describe("Exact token identifiers; entries may span multiple chains"),
});

const quoteRequestSchema = z.object({
  chain_id: chainId,
  destination_chain_id: chainId
    .optional()
    .describe("Destination chain; defaults to chain_id for a same-chain swap"),
  token_in: tokenIdentifier,
  token_out: tokenIdentifier,
  quote_type: quoteType,
  amount,
});

export const getValueTransferStatusSchema = z.object({
  source: z
    .enum(["layerzero", "lifi"])
    .optional()
    .describe(
      "Which provider carried the transfer, taken from the executed quote's source. Defaults to layerzero. The two are tracked differently, so naming the wrong one cannot find the transfer.",
    ),
  quote_id: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "The provider_quote_id of the option that was executed, taken from that quote's normalized or execution.quote fields. Required for layerzero, which reuses the quote id as the transfer id. For lifi it is optional and used only to label the answer, because LI.FI does not accept a quote id as a lookup key.",
    ),
  transaction_hash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte transaction hash")
    .optional()
    .describe(
      "Origin-chain transaction hash of the submitted transfer. Required for lifi, which resolves a transfer by nothing else. For layerzero it is optional but should always be passed once it is known: it lets LayerZero resolve the transfer before its own indexer has caught up, and some route types (Stargate taxi among them) refuse to report status without it.",
    ),
  origin_chain_id: chainId
    .optional()
    .describe(
      "Chain the transfer was sent from. Only used by lifi, where it narrows the lookup to one chain instead of every chain LI.FI indexes, and is therefore worth passing every time.",
    ),
  destination_chain_id: chainId
    .optional()
    .describe("Chain the transfer is being delivered to. Only used by lifi."),
});

export const getQuotesWithPlansSchema = quoteRequestSchema.extend({
  sender: address
    .optional()
    .describe(
      "Transaction sender/taker/depositor. Supply it together with slippage_bps as soon as the user has decided to swap: providers are then asked for firm quotes with calldata rather than indicative prices, and every returned option carries the execution_plan_reference that executes it, so the chosen one goes straight to the wallet with no second round trip. Omit both fields for an indicative comparison.",
    ),
  recipient: address
    .optional()
    .describe(
      "Optional output recipient; defaults to sender when execution plans are requested",
    ),
  slippage_bps: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .describe(
      "Slippage tolerance in basis points. Honor an explicit user preference. Otherwise keep the maximum value lost to slippage approximately equal to one estimated transaction gas fee: slippage_bps ~= 10,000 * gas-cost value / swap-notional value, comparing both in the same currency. Do not use a generic 50 bps (0.5%) default, especially on Ethereum mainnet. Required alongside sender, and only meaningful with it, because it is the bound written into the returned calldata. Prefer a fresh quote and newly prepared transaction after a slippage failure over widening this bound; never retry reverted calldata unchanged.",
    ),
  include_raw_quotes: z
    .boolean()
    .optional()
    .describe(
      "Echo each provider's untouched response beside the normalized amounts. Off by default: these blobs are the largest part of a response and the least useful, since every field a choice turns on is already normalized. Turn it on to diagnose a provider.",
    ),
});

export const prepareSwapSchema = quoteRequestSchema.extend({
  source: quoteSource.describe("Provider selected from a quote response"),
  sender: address.describe(
    "Transaction sender/taker/depositor used for firm quotes and validation",
  ),
  recipient: address
    .optional()
    .describe("Optional output recipient; defaults to sender when preparing"),
  slippage_bps: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .describe("User-selected slippage tolerance in basis points"),
});

const stableswapParamsSchema = z.object({
  center_tick: z.number().int(),
  amplification: z.number().int().min(0).max(127),
});

const poolAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{1,40}$/, "must fit in a 20-byte EVM address");

const poolKeySchema = z
  .object({
    token0: poolAddress,
    token1: poolAddress,
    config: bytes32.optional(),
    fee: uintLikeString.optional(),
    tick_spacing: z
      .union([z.number().int().min(0), uintLikeString])
      .nullable()
      .optional(),
    extension: poolAddress.optional(),
    stableswap_params: stableswapParamsSchema.nullable().optional(),
  })
  .refine(
    (poolKey) =>
      poolKey.config !== undefined ||
      (poolKey.fee !== undefined && poolKey.extension !== undefined),
    "provide config, or provide fee, tick_spacing, and extension",
  );

const exactPoolKeySchema = z
  .object({
    token0: poolAddress,
    token1: poolAddress,
    config: bytes32.optional(),
    fee: uintLikeString
      .optional()
      .describe(
        "Exact uint64 Q64 fee as a decimal or hexadecimal string; never pass it as a JSON number",
      ),
    tick_spacing: z.union([z.number().int().min(1), uintLikeString]).optional(),
    extension: poolAddress.optional(),
    stableswap_params: stableswapParamsSchema.optional(),
  })
  .refine(
    (poolKey) =>
      poolKey.config !== undefined ||
      (poolKey.fee !== undefined &&
        poolKey.extension !== undefined &&
        (poolKey.tick_spacing !== undefined ||
          poolKey.stableswap_params !== undefined)),
    "provide config, or fee, extension, and tick_spacing/stableswap_params",
  );

const encodedPoolKeySchema = z.object({
  token0: address,
  token1: address,
  config: bytes32,
});

export const getPositionsByOwnerSchema = z.object({
  owner: address,
  chain_id: chainId.optional(),
  state: z.enum(["opened", "closed"]).optional(),
  page_size: z.number().int().min(1).max(200).default(50),
  page: z.number().int().min(1).default(1),
});

export const getPositionSchema = z.object({
  owner: address.describe(
    "Current indexed owner used to locate the exact position without ERC721 enumeration",
  ),
  chain_id: chainId,
  positions_address: address.describe(
    "Ekubo Positions or Ve33Positions manager",
  ),
  token_id: uintLikeString.describe(
    "Position NFT token ID as an exact decimal or hexadecimal integer string",
  ),
});

export const getPoolSchema = z.object({
  chain_id: chainId,
  core_address: poolAddress,
  pool_id: uintLikeString.describe(
    "PoolKey hash as an exact decimal or hexadecimal integer string",
  ),
});

export const getPoolLiquiditySchema = getPoolSchema;

export const listPoolKeysSchema = z.object({
  chain_id: chainId,
  core_address: poolAddress.describe(
    "Exact Core deployment whose initialized pools to enumerate",
  ),
  token_a: poolAddress
    .optional()
    .describe("Keep only pools containing this token on either side"),
  token_b: poolAddress
    .optional()
    .describe(
      "With token_a, keep only pools for the exact pair (order-insensitive)",
    ),
  extension: poolAddress
    .optional()
    .describe(
      "Keep only pools using this extension; pass the zero address for extensionless pools",
    ),
  page_size: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(100)
    .describe("Pools per page"),
  after_pool_id: uintLikeString
    .optional()
    .describe(
      "Keyset cursor: return pools whose pool_id is strictly greater; pass the previous page's next_after_pool_id",
    ),
});

export const derivePoolIdSchema = z.object({
  pool_key: exactPoolKeySchema,
});

export const decodePoolConfigSchema = z.object({ config: bytes32 });

export const getPositionPoolCandidatesSchema = z.object({
  chain_id: chainId,
  token_a: poolAddress.describe("First token in either numeric order"),
  token_b: poolAddress.describe("Second token in either numeric order"),
  min_tvl_usd: z
    .number()
    .finite()
    .min(0)
    .default(0)
    .describe(
      "Optional indexed TVL floor. Zero is the creation-safe default so tiny initialized pools are not hidden",
    ),
  core_address: poolAddress.optional().describe("Optional exact Core filter"),
  extension: poolAddress.optional().describe("Optional exact extension filter"),
  pool_type: z.enum(["concentrated", "stableswap"]).optional(),
});

export const prepareLpPositionDepositSchema = z
  .object({
    chain_id: chainId,
    sender: address,
    core_address: poolAddress.describe(
      "Exact v3 Core address from pool discovery or the interface configuration",
    ),
    pool_id: uintLikeString
      .optional()
      .describe("Exact pool ID; may be omitted when pool_key is supplied"),
    pool_key: encodedPoolKeySchema
      .optional()
      .describe(
        "Exact v3 PoolKey. Required for a new uninitialized pool because it is not yet recoverable from the index.",
      ),
    pool_initialized: z
      .boolean()
      .optional()
      .describe(
        "Set false only for a new pool that must be initialized in this transaction",
      ),
    mode: z.enum(["mint_new", "add_liquidity"]).default("mint_new"),
    token_id: uintLikeString
      .optional()
      .describe(
        "Required only for add_liquidity; omit when minting a new position NFT",
      ),
    tick_lower: z.number().int().min(-88_722_835).max(88_722_835),
    tick_upper: z.number().int().min(-88_722_835).max(88_722_835),
    initial_tick: z
      .number()
      .int()
      .min(-88_722_835)
      .max(88_722_835)
      .optional()
      .describe(
        "Required only when minting into an uninitialized pool; the MCP prepends maybeInitializePool at this exact tick",
      ),
    max_amount0: uintString.describe(
      "Maximum token0 input in base units; use zero for a single-sided deposit",
    ),
    max_amount1: uintString.describe(
      "Maximum token1 input in base units; use zero for a single-sided deposit",
    ),
    slippage_bps: z
      .number()
      .int()
      .min(1)
      .max(5_000)
      .describe(
        "User-selected liquidity slippage tolerance; used to derive a nonzero minimum liquidity",
      ),
  })
  .refine(
    (input) =>
      (input.mode === "mint_new" && input.token_id === undefined) ||
      (input.mode === "add_liquidity" && input.token_id !== undefined),
    "mint_new must omit token_id; add_liquidity must provide token_id",
  )
  .refine(
    (input) => input.pool_id !== undefined || input.pool_key !== undefined,
    "provide pool_id or pool_key",
  )
  .refine(
    (input) =>
      input.pool_initialized !== false ||
      (input.pool_key !== undefined && input.initial_tick !== undefined),
    "an uninitialized pool requires pool_key and initial_tick",
  );

export const preparePoolInitializationSchema = z.object({
  chain_id: chainId,
  sender: address.describe(
    "Wallet that will submit the permissionless initialization transaction",
  ),
  core_address: poolAddress.describe("Exact current v3 Core address"),
  pool_key: encodedPoolKeySchema.describe(
    "Exact v3 PoolKey to initialize; the pool ID is derived and returned",
  ),
  initial_tick: z
    .number()
    .int()
    .min(-88_722_835)
    .max(88_722_835)
    .describe(
      "Initial EVM tick. The first successful initialization permanently selects the pool's initial price.",
    ),
});

export const prepareLpPositionEarningsClaimSchema = z.object({
  chain_id: chainId,
  sender: address.describe(
    "Current position owner and wallet that will submit the transaction",
  ),
  positions_address: address.describe(
    "Exact Positions or Ve33Positions manager from the owned position",
  ),
  token_id: uintLikeString.describe(
    "Position NFT token ID as an exact decimal or hexadecimal integer string",
  ),
  recipient: address
    .optional()
    .describe("Fee or reward recipient; defaults to sender"),
});

const lpPositionWithdrawalSchema = z.object({
  positions_address: address.describe(
    "Exact Positions or Ve33Positions manager from the owned position",
  ),
  token_id: uintLikeString.describe(
    "Position NFT token ID as an exact decimal or hexadecimal integer string",
  ),
  liquidity: amount.describe(
    "Exact positive uint128 liquidity to withdraw, normally selected from the decoded pending current-state query",
  ),
  recipient: address
    .optional()
    .describe("Principal and earnings recipient; defaults to sender"),
});

export const prepareLpPositionWithdrawSchema = z
  .object({
    chain_id: chainId,
    sender: address.describe(
      "Current owner of every position and wallet that will submit the transaction",
    ),
    withdrawals: z
      .array(lpPositionWithdrawalSchema)
      .min(1)
      .max(100)
      .describe(
        "One or more position withdrawals to prepare in one wallet-batch-capable execution plan",
      ),
  })
  .strict();

export const prepareWrapUnwrapSchema = z.object({
  chain_id: chainId,
  sender: address,
  direction: z.enum(["wrap", "unwrap"]),
  amount,
});

const transferChainId = chainId.refine(
  fitsTransferUint256,
  "chain_id must fit uint256",
).describe(
  "EVM chain ID as a positive JSON integer, decimal string, or hexadecimal string; must fit uint256",
);
const transferSender = address.refine(
  isNonzeroTransferAddress,
  "sender must be a valid-checksum nonzero address",
).describe("Nonzero wallet that owns and will send every asset");
const transferRecipient = address.refine(
  isNonzeroTransferAddress,
  "recipient must be a valid-checksum nonzero address",
).describe("Nonzero account or contract that will receive this transfer");
const transferToken = address.refine(
  isNonzeroTransferAddress,
  "token must be a valid-checksum nonzero contract address",
).describe("Nonzero ERC token contract address");
const transferTokenId = uintString.describe(
  "ERC token ID as an unsigned decimal integer; zero is valid",
).refine(fitsTransferUint256, "token_id must fit uint256");
const positiveTransferAmount = z.string().regex(
  /^[1-9][0-9]*$/,
  "amount must be a positive canonical decimal integer",
).refine(fitsTransferUint256, "amount must fit uint256");

function fitsTransferUint256(value: string | number): boolean {
  try {
    return BigInt(value) < 1n << 256n;
  } catch {
    return false;
  }
}

function isNonzeroTransferAddress(value: string): boolean {
  return isAddress(value) && !/^0x0{40}$/i.test(value);
}
const nativeTransferSchema = z.object({
  kind: z.literal("native"),
  recipient: transferRecipient,
  amount: positiveTransferAmount.describe(
    "Positive native-token amount in wei",
  ),
}).strict();
const erc20TransferSchema = z.object({
  kind: z.literal("erc20"),
  token: transferToken,
  recipient: transferRecipient,
  amount: positiveTransferAmount.describe(
    "Positive ERC-20 amount in base units",
  ),
}).strict();
const erc721TransferSchema = z.object({
  kind: z.literal("erc721"),
  token: transferToken,
  recipient: transferRecipient,
  token_id: transferTokenId,
  safe: z.boolean().optional().describe(
    "Omit or set true to use safeTransferFrom (the default); set false to use transferFrom",
  ),
  data: z.string().regex(
    /^0x(?:[0-9a-fA-F]{2})*$/,
    "data must be 0x-prefixed whole bytes",
  ).optional().describe(
    "Optional receiver callback data for the four-argument safeTransferFrom overload; requires safe to be omitted or true",
  ),
})
  .strict()
  .refine(
    (transfer) => transfer.safe !== false || transfer.data === undefined,
    {
      path: ["data"],
      message:
        "ERC-721 data requires safeTransferFrom; omit data when safe is false",
    },
  );
const erc1155TransferSchema = z.object({
  kind: z.literal("erc1155"),
  token: transferToken,
  recipient: transferRecipient,
  token_id: transferTokenId,
  amount: positiveTransferAmount.describe(
    "Positive ERC-1155 token amount in base units",
  ),
  safe: z.literal(true).optional().describe(
    "Omit or set true; ERC-1155 defines safeTransferFrom but no unsafe transferFrom method",
  ),
  data: z.string().regex(
    /^0x(?:[0-9a-fA-F]{2})*$/,
    "data must be 0x-prefixed whole bytes",
  ).optional().describe(
    "Optional receiver callback data; omitted data defaults to empty bytes (0x)",
  ),
}).strict();

export const prepareTransfersSchema = z.object({
  chain_id: transferChainId,
  sender: transferSender,
  transfers: z.array(
    z.discriminatedUnion("kind", [
      nativeTransferSchema,
      erc20TransferSchema,
      erc721TransferSchema,
      erc1155TransferSchema,
    ]),
  ).min(1).max(MAX_TRANSFERS_PER_PLAN).describe(
    `One to ${MAX_TRANSFERS_PER_PLAN} ordered, optionally mixed native, ERC-20, ERC-721, or ERC-1155 transfers`,
  ),
}).strict();

export const prepareLpPositionTransferSchema = z.object({
  chain_id: chainId,
  sender: address,
  positions_address: address,
  token_id: uintLikeString,
  recipient: address,
});

export const prepareFixPoolPriceSchema = z.object({
  chain_id: chainId,
  sender: address,
  core_address: address,
  pool_id: uintLikeString,
  base_token: address,
  target_price: z
    .string()
    .regex(
      /^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|\.[0-9]+)$/,
      "must be a decimal price",
    ),
  pending_current_sqrt_ratio: uintString.optional(),
  quote_result: z
    .object({
      specified_token: address,
      calculated_token: address,
      specified_amount: signedIntString,
      calculated_amount: signedIntString,
      block_number: uintLikeString.optional(),
      block_hash: bytes32.optional(),
    })
    .optional(),
});

export const prepareTwammOrderSchema = z.object({
  chain_id: chainId,
  sender: address,
  sell_token: address,
  buy_token: address,
  orders: z
    .array(
      z.object({
        fee: uintString,
        start_time: uintString,
        end_time: uintString,
        amount,
      }),
    )
    .min(1)
    .max(100),
  pending_timestamp: uintString,
  deadline_seconds: z.number().int().min(0).max(3_600).default(120),
  salt: bytes32
    .optional()
    .describe(
      "Salt the order NFT is minted against, which fixes its token id. Omit it and one is derived from the request, so the same order always resolves to the same id and a retry is detectable instead of minting a second order. Supply your own only when identical orders need independent ids.",
    ),
});

export const prepareTwammOrderCollectionSchema = z.object({
  chain_id: chainId,
  sender: address,
  orders_address: address,
  token_id: uintLikeString,
  order_keys: z.array(encodedPoolKeySchema).min(1).max(100),
});

export const prepareTwammOrderStopSchema = z.object({
  chain_id: chainId,
  sender: address,
  orders_address: address,
  token_id: uintLikeString,
  pending_timestamp: uintString,
  orders: z
    .array(
      z.object({
        order_key: encodedPoolKeySchema,
        end_time: uintString,
        sale_rate: uintString,
      }),
    )
    .min(1)
    .max(100),
});

export const prepareTwammVirtualOrdersSchema = z.object({
  chain_id: chainId,
  sender: address,
  pool_key: encodedPoolKeySchema,
});

export const prepareAuctionCreateSchema = z.object({
  chain_id: chainId,
  sender: address,
  sell_token: address,
  buy_token: address,
  sell_amount: amount,
  creator_fee_q32: uintString,
  min_boost_duration: z.number().int().min(0).max(0xff_ffff),
  graduation_pool_fee_q64: uintString,
  graduation_pool_tick_spacing: z.number().int().min(0).max(0xffff_ffff),
  start_time: uintString,
  auction_duration: z.number().int().min(0).max(0xffff_ffff),
  salt: bytes32,
});

export const prepareAuctionCompleteSchema = z.object({
  chain_id: chainId,
  sender: address,
  token_id: uintLikeString,
  auction_key: encodedPoolKeySchema,
  graduation_pool_initialized: z.boolean(),
  launch_pool_tick: z
    .number()
    .int()
    .min(-0x8000_0000)
    .max(0x7fff_ffff)
    .optional(),
});

export const prepareAuctionCreatorProceedsSchema = z.object({
  chain_id: chainId,
  sender: address,
  token_id: uintLikeString,
  auction_key: encodedPoolKeySchema,
});

export const prepareManualPoolBoostSchema = z.object({
  chain_id: chainId,
  sender: address,
  pool_key: encodedPoolKeySchema,
  start_time: uintString,
  end_time: uintString,
  amount0: uintString,
  amount1: uintString,
});

export const prepareOracleCapacityExpansionSchema = z.object({
  chain_id: chainId,
  sender: address,
  token: address,
  min_capacity: z.number().int().min(0).max(0xffff_ffff),
});

export const prepareApprovalRevocationsSchema = z.object({
  chain_id: chainId,
  sender: address,
  approvals: z
    .array(z.object({ token: address, spender: address }))
    .min(1)
    .max(200),
});

export const prepareOldGekuboUnwrapSchema = z.object({
  chain_id: chainId,
  sender: address,
  amount,
});

export const getRewardsClaimsByOwnerSchema = z.object({ owner: address });

const rewardsClaimSchema = z.object({
  drop_address: address,
  key: z.object({ owner: address, token: address, root: bytes32 }),
  claim: z.object({ index: uintString, account: address, amount }),
  proof: z.array(bytes32),
});

export const prepareRewardsClaimSchema = z.object({
  chain_id: chainId,
  sender: address,
  claims: z.array(rewardsClaimSchema).min(1).max(200),
});

export const prepareRevenueBuybacksSchema = z.object({
  chain_id: chainId,
  sender: address,
  ended_order_collects: z
    .array(
      z.object({ sell_token: address, fee: uintString, end_time: uintString }),
    )
    .max(200),
  protocol_fee_pairs: z
    .array(z.object({ token0: address, token1: address }))
    .max(200),
  roll_tokens: z.array(address).max(200),
});

export const prepareVe33IncreaseStakeSchema = z.object({
  chain_id: chainId,
  ve_token: address,
  sender: address,
  stake_token: address,
  ve_id: uintString,
  amount,
});

export const prepareVe33MergeSchema = z.object({
  chain_id: chainId,
  ve_token: address,
  sender: address,
  destination_ve_id: uintString,
  destination_pool_key: poolKeySchema.optional(),
  sources: z
    .array(
      z.object({
        ve_id: uintString,
        current_pool_key: poolKeySchema.optional(),
      }),
    )
    .min(1)
    .max(99),
  resulting_vote: z
    .object({ pool_key: poolKeySchema, swap_fee: uintString })
    .nullable()
    .optional(),
});

export const prepareVe33WithdrawSchema = z.object({
  chain_id: chainId,
  ve_token: address,
  sender: address,
  ve_id: uintString,
  current_pool_key: poolKeySchema.optional(),
});

const claimSchema = z.object({
  ve_id: uintString,
  pool_key: poolKeySchema,
});

export const prepareVe33VoteSchema = z.object({
  chain_id: chainId,
  ve_token: address,
  sender: address,
  source_ve_id: uintString,
  source_amount: amount,
  current_vote: z
    .object({
      pool_key_id: z.string().min(1),
      pool_key: poolKeySchema,
      swap_fee: uintString.optional(),
    })
    .describe(
      "Required active indexed vote; its pool is claimed unconditionally before any split, clear, or replacement vote",
    ),
  allocations: z
    .array(
      z.object({
        pool_key_id: z.string().min(1),
        pool_key: poolKeySchema,
        swap_fee: uintString,
        permille: z.number().int().min(1).max(1_000),
      }),
    )
    .min(1)
    .max(100),
  unallocated_permille: z.number().int().min(0).max(1_000),
  salt_nonce: bytes32.describe(
    "User-selected nonce used to derive deterministic, replay-detectable split salts",
  ),
});

export const prepareVe33ExtendSchema = z
  .object({
    chain_id: chainId,
    ve_token: address,
    sender: address,
    ve_id: uintString,
    duration_seconds: z.number().int().min(1).max(0xffff_ffff).optional(),
    max_duration: z.boolean().default(false),
    current_pool_key: poolKeySchema
      .optional()
      .describe(
        "Active pool key when voted; the MCP claims fees atomically before extension. Omit only for an unvoted VeToken.",
      ),
  })
  .refine(
    (input) => input.max_duration !== (input.duration_seconds !== undefined),
    "choose max_duration=true or provide duration_seconds",
  );

export const prepareVe33SplitSchema = z.object({
  chain_id: chainId,
  ve_token: address,
  sender: address,
  ve_id: uintString,
  amount,
  salt: bytes32,
});

export const prepareVe33StakeSchema = z
  .object({
    chain_id: chainId,
    ve_token: address,
    sender: address,
    stake_token: address,
    amount,
    salt: bytes32.describe(
      "User-selected salt for a deterministic, replay-detectable VeToken ID",
    ),
    duration_seconds: z.number().int().min(1).max(0xffff_ffff).optional(),
    max_duration: z
      .boolean()
      .optional()
      .describe(
        "Defaults to true when duration_seconds is omitted; set false only with an explicit duration_seconds",
      ),
  })
  .superRefine((input, context) => {
    if (input.duration_seconds === undefined && input.max_duration === false) {
      context.addIssue({
        code: "custom",
        message: "max_duration=false requires duration_seconds",
      });
    }
    if (input.duration_seconds !== undefined && input.max_duration === true) {
      context.addIssue({
        code: "custom",
        message: "choose max_duration=true or duration_seconds, not both",
      });
    }
  });

export const prepareVe33ClaimSchema = z.object({
  chain_id: chainId,
  ve_token: address,
  sender: address,
  recipient: address.optional(),
  claims: z.array(claimSchema).min(1).max(100),
});

export const prepareAllVe33FeeClaimsSchema = z.object({
  chain_id: chainId,
  ve_token: address,
  sender: address.describe(
    "Owner whose indexed VeTokens and active votes should be discovered",
  ),
  recipient: address
    .optional()
    .describe("Fee recipient; defaults to sender for claimPoolFeesToSelf"),
});

export const getVe33AllocationsSchema = z
  .object({
    chain_id: chainId
      .optional()
      .describe(
        "Optional with ve_token; omit both for the production Ekubo STONX deployment",
      ),
    ve_token: address
      .optional()
      .describe(
        `Optional with chain_id; omit both for the canonical STONX VeToken ${ROBINHOOD_STONX_VE_TOKEN}`,
      ),
    owner: address.describe(
      "Connected EVM wallet whose complete Ekubo STONX/VeToken allocation should be shown; the server cannot infer 'my', so ask the user when no wallet address is available",
    ),
  })
  .refine(
    (input) =>
      (input.chain_id === undefined) === (input.ve_token === undefined),
    "provide chain_id and ve_token together, or omit both for production STONX",
  );

export const prepareVe33ReallocationSchema = z.object({
  chain_id: chainId,
  ve_token: address,
  sender: address.describe(
    "VeToken owner that will execute the atomic batch",
  ),
  current_state_id: bytes32.describe(
    "Exact state_id returned by get_ve33_allocations; preparation fails if indexed state changed",
  ),
  targets: z
    .array(
      z.object({
        pool_key_id: uintString.describe(
          "Canonical Ekubo Ve33 pool key ID; the server resolves and verifies the full pool key",
        ),
        swap_fee: uintString.describe("Selected uint64 swap fee vote"),
        weight_bps: z
          .number()
          .int()
          .min(1)
          .max(10_000)
          .describe("Target share of allocated voting power in basis points"),
      }),
    )
    .min(1)
    .max(25)
    .describe(
      "At most 25 targets. compact_max_lock creates one final voting VeToken per target; preserve_existing_locks may require multiple NFTs per target to keep expiry-cohort decay proportional.",
    ),
  salt_nonce: bytes32.describe(
    "User-selected nonce for deterministic child VeToken IDs created by required splits",
  ),
  strategy: z
    .enum(["preserve_existing_locks", "compact_max_lock"])
    .optional()
    .describe(
      "Defaults to preserve_existing_locks. compact_max_lock explicitly claims fees, consolidates active stake into one surviving NFT, extends it to four years, then creates exactly one voting NFT per target; redundant source NFT IDs are burned.",
    ),
});

export const prepareVe33ReinvestSchema = z
  .object({
    phase: z.enum(["claim", "swap", "stake", "stake_all"]),
    chain_id: chainId,
    ve_token: address,
    sender: address,
    claims: z.array(claimSchema).min(1).max(100).optional(),
    stake_token: address.optional(),
    fee_balances: z
      .array(z.object({ token: address, amount: uintString }))
      .min(1)
      .max(200)
      .optional(),
    slippage_bps: z.number().int().min(0).max(10_000).default(50),
    source: quoteSource.optional(),
    ve_id: uintString.optional(),
    amount: uintString.optional(),
    current_state_id: bytes32.optional(),
  })
  .superRefine((input, context) => {
    if (
      input.phase === "swap" &&
      (input.stake_token === undefined || input.fee_balances === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "swap phase requires stake_token and fee_balances",
      });
    }
    if (input.phase === "swap" && input.source === undefined) {
      context.addIssue({
        code: "custom",
        message: "swap phase requires a quote source",
      });
    }
    if (
      input.phase === "stake" &&
      (input.stake_token === undefined ||
        input.ve_id === undefined ||
        input.amount === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "stake phase requires stake_token, ve_id, and amount",
      });
    }
    if (
      input.phase === "stake_all" &&
      (input.stake_token === undefined ||
        input.current_state_id === undefined ||
        input.amount === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "stake_all phase requires stake_token, current_state_id, and amount",
      });
    }
  });

export const getStonxAllocationRecommendationSchema = z.object({});

export const getLiquidityOpportunitiesSchema = z.object({
  chain_id: chainId
    .optional()
    .describe(
      "Optional production chain filter; omit to match the interface's cross-chain opportunity feed",
    ),
  types: z
    .array(z.enum(["boosted_fees", "incentive", "ve33_emissions"]))
    .min(1)
    .max(3)
    .refine((types) => new Set(types).size === types.length, {
      message: "types must not contain duplicates",
    })
    .default(["boosted_fees", "incentive", "ve33_emissions"])
    .describe("Opportunity classes to include; defaults to all interface classes"),
  token: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, "token must be hexadecimal")
    .optional()
    .describe("Optional EVM or Starknet token address appearing in the pair"),
  min_apr: z
    .number()
    .finite()
    .min(0)
    .optional()
    .describe("Optional APR ratio floor; 1.0 means 100%, not 1%"),
  limit: z.number().int().min(1).max(100).default(25),
  ve33_emission_state: z
    .object({
      current_timestamp: uintString.describe(
        "Locally decoded getEmissionState state.currentTimestamp",
      ),
      current_emission_rate: uintString.describe(
        "Locally decoded Q32 getEmissionState state.currentEmissionRate",
      ),
      total_remaining_emissions: uintString.describe(
        "Locally decoded getEmissionState state.totalRemainingEmissions",
      ),
    })
    .optional()
    .describe(
      "Wallet-locally decoded emission state from the tool's local_read_requirement; omit on the first call",
    ),
});

export const getAaveV3MarketsSchema = z.object({
  chain_id: chainId
    .optional()
    .describe(
      "Optional exact chain filter. Omit to return every fixed Aave V3 core market supported by the preparation tools.",
    ),
});

const aaveV3ReserveActionSchema = z.object({
  chain_id: chainId.describe(
    "Chain of a fixed Aave V3 core market returned by get_aave_v3_markets",
  ),
  sender: address.describe("Wallet that will execute the Aave action"),
  asset: address.describe(
    "Exact underlying ERC-20 address from the selected market's fixed major-reserve list",
  ),
});

export const prepareAaveV3SupplySchema = aaveV3ReserveActionSchema.extend({
  amount: amount.describe("Positive underlying-token amount in base units"),
  on_behalf_of: address
    .optional()
    .describe("aToken recipient; defaults to sender"),
});

export const prepareAaveV3WithdrawSchema = aaveV3ReserveActionSchema.extend({
  amount: amount.describe(
    "Positive underlying-token amount in base units; uint256 maximum requests all available balance",
  ),
  recipient: address
    .optional()
    .describe("Underlying-token recipient; defaults to sender"),
});

export const prepareAaveV3BorrowSchema = aaveV3ReserveActionSchema.extend({
  amount: amount.describe("Positive borrow amount in base units"),
  on_behalf_of: address
    .optional()
    .describe(
      "Debt owner; defaults to sender. A different owner must already have delegated variable debt to sender.",
    ),
});

export const prepareAaveV3RepaySchema = aaveV3ReserveActionSchema.extend({
  amount: amount.describe(
    "Positive repayment amount in base units; uint256 maximum requests all available variable debt",
  ),
  on_behalf_of: address
    .optional()
    .describe("Debt owner; defaults to sender"),
  funding_source: z
    .enum(["underlying", "a_token"])
    .default("underlying")
    .describe(
      "Use underlying ERC-20 with a temporary exact Pool approval, or burn sender-owned aTokens with repayWithATokens",
    ),
});

export const prepareAaveV3CollateralSchema =
  aaveV3ReserveActionSchema.extend({
    use_as_collateral: z
      .boolean()
      .describe("True enables this supplied reserve as collateral; false disables it"),
  });

export const prepareAaveV3EModeSchema = z.object({
  chain_id: chainId.describe(
    "Chain of a fixed Aave V3 core market returned by get_aave_v3_markets",
  ),
  sender: address.describe("Wallet whose eMode selection will change"),
  category_id: z
    .number()
    .int()
    .min(0)
    .max(255)
    .describe(
      "Current onchain Aave eMode category; zero disables eMode. Obtain nonzero category IDs from Aave's public GraphQL API, because this server does not query them.",
    ),
});

export const getMorphoVaultsSchema = z.object({
  chain_id: chainId
    .optional()
    .describe("Optional exact chain filter for the fixed Morpho Vault V2 catalog"),
});

const morphoVaultActionSchema = z.object({
  chain_id: chainId.describe("Chain returned by get_morpho_vaults"),
  sender: address.describe("Wallet that will execute the Morpho action"),
  vault: address.describe("Exact Morpho Vault V2 address returned by get_morpho_vaults"),
});

export const prepareMorphoVaultDepositSchema = morphoVaultActionSchema.extend({
  amount: amount.describe("Positive underlying-asset amount in base units"),
  max_share_price_ray: amount.describe(
    "Maximum acceptable vault share price in RAY (1e27), derived by the agent from fresh Morpho/onchain vault state plus the user's slippage tolerance",
  ),
  recipient: address.optional().describe("Vault-share recipient; defaults to sender"),
});

export const prepareMorphoVaultWithdrawSchema = morphoVaultActionSchema.extend({
  amount: amount.describe("Exact underlying-asset amount to withdraw in base units"),
  recipient: address.optional().describe("Underlying-asset recipient; defaults to sender"),
  owner: address.optional().describe("Vault-share owner; defaults to sender"),
});

export const prepareMorphoVaultRedeemSchema = morphoVaultActionSchema.extend({
  shares: amount.describe("Exact vault-share amount to redeem in base units"),
  recipient: address.optional().describe("Underlying-asset recipient; defaults to sender"),
  owner: address.optional().describe("Vault-share owner; defaults to sender"),
});

const skySavingsActionSchema = z.object({
  chain_id: chainId.describe("Must be Ethereum chain 1"),
  sender: address.describe("Wallet that will execute the Sky savings action"),
});

export const getSkySavingsDeploymentSchema = z.object({});
export const prepareSkySavingsDepositSchema = skySavingsActionSchema.extend({
  amount: amount.describe("Exact USDS deposit amount in base units"),
  receiver: address.optional().describe("sUSDS recipient; defaults to sender"),
});
export const prepareSkySavingsWithdrawSchema = skySavingsActionSchema.extend({
  amount: amount.describe("Exact USDS amount to withdraw in base units"),
  receiver: address.optional().describe("USDS recipient; defaults to sender"),
  owner: address.optional().describe("sUSDS owner; defaults to sender"),
});
export const prepareSkySavingsRedeemSchema = skySavingsActionSchema.extend({
  shares: amount.describe("Exact sUSDS share amount to redeem in base units"),
  receiver: address.optional().describe("USDS recipient; defaults to sender"),
  owner: address.optional().describe("sUSDS owner; defaults to sender"),
});

export const getMerklDeploymentSchema = z.object({
  chain_id: chainId
    .optional()
    .describe("Optional chain to check against the verified Merkl Distributor catalog"),
});
export const prepareMerklClaimSchema = z.object({
  chain_id: chainId.describe("Chain the rewards were earned on, from the Merkl rewards summary"),
  sender: address.describe("Wallet claiming its own rewards; also the leaf's user address"),
  rewards: z
    .array(
      z.object({
        token: address.describe("Reward token address exactly as Merkl returned it"),
        amount: amount.describe(
          "The reward's cumulative amount field, unchanged. This is not the claimable delta: the contract transfers this minus what was already claimed.",
        ),
        proofs: z
          .array(bytes32)
          .max(64)
          .describe("The token's proofs array, in order, copied unchanged from Merkl"),
      }),
    )
    .min(1)
    .max(32)
    .describe(
      "One entry per reward token on this chain. Batch every token together: the Distributor takes arrays, so a five-token claim is one transaction and one approval.",
    ),
});

const aerodromeActionSchema = z.object({
  chain_id: chainId.describe("Must be Base chain 8453; Aerodrome exists nowhere else"),
  sender: address.describe("Wallet that will execute the Aerodrome action"),
});
const aerodromeDeadline = amount.describe(
  "Unix timestamp after which the router rejects this transaction. Pick a real near-term deadline; one already past makes the plan a guaranteed revert.",
);
const aerodromeClaimSources = z
  .array(
    z.object({
      contract: address.describe(
        "The fee or bribe contract address exactly as a Sugar rewards read returned it",
      ),
      tokens: z
        .array(address)
        .min(1)
        .max(16)
        .describe("Reward tokens to claim from this contract"),
    }),
  )
  .max(32);

export const getAerodromeDeploymentSchema = z.object({
  chain_id: chainId
    .optional()
    .describe("Optional chain to check against Aerodrome's Base-only deployment"),
});
export const prepareAerodromeSugarReadsSchema = z.object({
  chain_id: chainId.describe("Must be Base chain 8453"),
  dataset: z
    .enum([
      "pools",
      "positions",
      "venfts_by_account",
      "venft_by_id",
      "latest_epochs",
      "pool_epochs",
      "venft_rewards",
      "venft_pool_rewards",
    ])
    .describe(
      "Which Sugar dataset to read. pools and positions come from LpSugar, venfts from VeSugar, and epochs and rewards from RewardsSugar.",
    ),
  account: address
    .optional()
    .describe("Required for positions and venfts_by_account"),
  pool: address.optional().describe("Required for pool_epochs and venft_pool_rewards"),
  venft_id: amount
    .optional()
    .describe("Required for venft_by_id, venft_rewards, and venft_pool_rewards"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Page size, capped by the lens contract's own maximum (500 pools, 200 positions)"),
  offset: z.number().int().min(0).optional().describe("Page offset, defaults to 0"),
});
export const prepareAerodromeLiquidityDepositSchema = aerodromeActionSchema.extend({
  token_a: address.describe("First token of the v2 pair"),
  token_b: address.describe("Second token of the v2 pair"),
  stable: z
    .boolean()
    .describe(
      "True for a stable pool, false for a volatile one. The pair plus this flag identifies the pool, so a wrong value targets a different pool or none at all.",
    ),
  amount_a_desired: amount.describe("Maximum token_a to deposit in base units"),
  amount_b_desired: amount.describe("Maximum token_b to deposit in base units"),
  amount_a_min: amount.describe(
    "Minimum token_a the deposit must consume. The pool takes whatever its reserve ratio demands and refunds the rest, so this is the slippage bound.",
  ),
  amount_b_min: amount.describe("Minimum token_b the deposit must consume"),
  deadline: aerodromeDeadline,
  recipient: address.optional().describe("LP token recipient; defaults to sender"),
});
export const prepareAerodromeLiquidityWithdrawSchema = aerodromeActionSchema.extend({
  token_a: address.describe("First token of the v2 pair"),
  token_b: address.describe("Second token of the v2 pair"),
  stable: z.boolean().describe("True for a stable pool, false for a volatile one"),
  liquidity: amount.describe("Exact LP token amount to burn in base units"),
  amount_a_min: amount.describe("Minimum token_a to receive"),
  amount_b_min: amount.describe("Minimum token_b to receive"),
  deadline: aerodromeDeadline,
  recipient: address.optional().describe("Token recipient; defaults to sender"),
  lp_token: address
    .optional()
    .describe(
      "The pool address the router will pull LP tokens from, as resolved by this tool's first-phase pool read. Omit it to get that read back; supply it to get the complete approve + removeLiquidity + cleanup plan.",
    ),
});
export const prepareAerodromeGaugeDepositSchema = aerodromeActionSchema.extend({
  gauge: address.describe("The pool's gauge address, from a Sugar pools read"),
  amount: amount.describe("Exact LP token amount to stake in base units"),
  lp_token: address
    .optional()
    .describe(
      "The gauge's stakingToken, as resolved by this tool's first-phase read. Omit it to get that read back; supply it to get the complete approve + deposit + cleanup plan.",
    ),
});
export const prepareAerodromeGaugeWithdrawSchema = aerodromeActionSchema.extend({
  gauge: address.describe("The pool's gauge address, from a Sugar pools read"),
  amount: amount.describe("Exact LP token amount to unstake in base units"),
});
export const prepareAerodromeGaugeClaimSchema = aerodromeActionSchema.extend({
  gauge: address.describe("The pool's gauge address, from a Sugar pools read"),
  account: address
    .optional()
    .describe(
      "Account whose emissions are claimed; defaults to sender. getReward credits this address, so a non-sender value pays someone else.",
    ),
});
export const prepareAerodromeLockSchema = aerodromeActionSchema.extend({
  action: z
    .enum([
      "create",
      "increase_amount",
      "extend",
      "lock_permanent",
      "unlock_permanent",
      "withdraw",
    ])
    .describe("Which veAERO lock action to build"),
  amount: amount.optional().describe("AERO amount in base units; required for create and increase_amount"),
  lock_duration: amount
    .optional()
    .describe(
      "Lock length in seconds measured from now, required for create and extend. The escrow floors it to a week boundary and caps it at four years.",
    ),
  venft_id: amount.optional().describe("veNFT token id; required for every action but create"),
});
export const prepareAerodromeVoteSchema = aerodromeActionSchema.extend({
  venft_id: amount.describe("veNFT token id casting the vote"),
  pools: z
    .array(
      z.object({
        pool: address.describe("Pool address to vote for"),
        weight: amount.describe(
          "Relative share of this NFT's voting power. Only the ratio matters, so [1,1] and [50,50] are the same vote.",
        ),
      }),
    )
    .max(32)
    .optional()
    .describe(
      "The complete allocation. It replaces any previous vote, so a pool left out is voted zero rather than left alone.",
    ),
  reset: z
    .boolean()
    .optional()
    .describe("Clear this NFT's votes instead of casting new ones; required before withdrawing a voted NFT"),
});
export const prepareAerodromeIncentiveClaimSchema = aerodromeActionSchema.extend({
  venft_id: amount.describe("veNFT token id whose rewards are claimed"),
  fees: aerodromeClaimSources
    .optional()
    .describe("Fee contracts and their tokens, taken from a Sugar venft_rewards read"),
  bribes: aerodromeClaimSources
    .optional()
    .describe("Bribe contracts and their tokens, taken from a Sugar venft_rewards read"),
  claim_rebase: z
    .boolean()
    .optional()
    .describe("Also claim the RewardsDistributor rebase, which compounds into the lock"),
});

const lidoActionSchema = z.object({
  chain_id: chainId.describe("Must be Ethereum chain 1"),
  sender: address.describe("Wallet that will execute the Lido action"),
});

export const getLidoDeploymentSchema = z.object({});
export const prepareLidoStakeSchema = lidoActionSchema.extend({
  amount: amount.describe("Exact native ETH stake amount in wei"),
  referral: address.optional().describe("Optional Lido referral address; defaults to zero address"),
});
export const prepareLidoWrapSchema = lidoActionSchema.extend({
  amount: amount.describe("Exact stETH amount to wrap in base units"),
});
export const prepareLidoUnwrapSchema = lidoActionSchema.extend({
  amount: amount.describe("Exact wstETH amount to unwrap in base units"),
});
export const prepareLidoWithdrawalRequestSchema = lidoActionSchema.extend({
  amounts: z
    .array(amount)
    .min(1)
    .max(64)
    .describe("One to 64 stETH request amounts, each from 100 wei through 1000 stETH"),
  owner: address.optional().describe("Recipient/owner of the unstETH request NFTs; defaults to sender"),
});
export const prepareLidoWithdrawalClaimSchema = lidoActionSchema.extend({
  request_id: amount.describe("Finalized, unclaimed unstETH NFT request ID owned by sender"),
});

// Reads keep readOnlyHint even though storing a read bundle writes the
// artifact bucket: the storage is incidental caching of the tool's own
// result, not an observable state change a client must treat as a side
// effect.
const readerAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// These tools compute from arguments or checked-in constants only: pool IDs,
// packed configs, and fixed Aave deployment discovery. No indexer, RPC, API,
// or artifact bucket. openWorldHint exists
// to say whether a call reaches entities outside this process, so these say
// no; a client that avoids open-world calls can still use all of them.
const localAnnotations = {
  ...readerAnnotations,
  openWorldHint: false,
} as const;

const LOCAL_TOOLS = new Set([
  "derive_pool_id",
  "decode_pool_config",
  "get_aave_v3_markets",
  "get_morpho_vaults",
  "get_sky_savings_deployment",
  "get_lido_deployment",
]);

// Preparation tools only return transaction plans; they never submit them or
// otherwise mutate user-visible state. Storing plan bodies is incidental
// caching of the returned information, just like read bundles above. The
// quotes tool likewise only returns fresh provider information. These tools
// are therefore read-only, though they are not idempotent because repeating a
// call can produce fresh quotes or references.
const preparerAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

function toolAnnotations(name: string) {
  if (
    name.startsWith("prepare_") ||
    name === "get_quotes_with_plans"
  ) {
    return preparerAnnotations;
  }
  return LOCAL_TOOLS.has(name) ? localAnnotations : readerAnnotations;
}

// Output schemas for the handoff tools only: loose shapes that pin where the
// result's primary wallet handoff sits — the execution plan for a preparer,
// the token list for an export, the read bundle a reader wants executed — so
// typed clients can find it without the schema constraining anything else.
// They are not an inventory of every envelope in a result: a preparation
// tool's own validation reads travel under shapes that differ per tool, and
// the plan is the handoff its schema names. Pure informational tools declare
// no output schema.
const preparedPlanOutputSchema = z.looseObject({
  execution_plan_reference: artifactReferenceSchema.optional(),
});
// Export returns the envelope and the count it stands for, and nothing else.
// The count is what lets an agent say "991 tokens from the Ekubo canonical
// list" without fetching a body meant for the wallet; it travels beside the
// envelope, never inside it, and is never handed on, so it cannot become
// something a consumer cross-checks against the bytes.
const exportedTokenListOutputSchema = z.looseObject({
  token_list_reference: artifactReferenceSchema,
  count: z.number().int(),
  complete: z.boolean(),
});
const quotesOutputSchema = z.looseObject({
  quotes: z
    .array(
      z.looseObject({
        execution: z
          .looseObject({
            execution_plan_reference: artifactReferenceSchema.optional(),
          })
          .nullish(),
      }),
    )
    .optional(),
});
const currentStateQueryOutputSchema = z.looseObject({
  current_state_query: z
    .looseObject({
      read_calls_reference: artifactReferenceSchema.optional(),
    })
    .optional(),
});
const chainReadBundleListSchema = z.array(
  z.looseObject({
    chain_id: z.string(),
    read_calls_reference: artifactReferenceSchema,
  }),
);
export function toolOutputSchema(name: string) {
  if (name === "get_quotes_with_plans") return quotesOutputSchema;
  if (name.startsWith("prepare_")) return preparedPlanOutputSchema;
  switch (name) {
    case "export_tokens":
      return exportedTokenListOutputSchema;
    case "get_pool":
    case "get_position":
      return currentStateQueryOutputSchema;
    case "get_positions_by_owner":
      return z.looseObject({
        current_state_reads: chainReadBundleListSchema.optional(),
      });
    case "get_rewards_claims_by_owner":
      return z.looseObject({
        onchain_validation: z
          .looseObject({
            validation_reads: chainReadBundleListSchema.optional(),
          })
          .optional(),
      });
    case "get_ve33_allocations":
      return z.looseObject({
        onchain_validation: z
          .looseObject({
            read_calls_reference: artifactReferenceSchema.optional(),
          })
          .optional(),
      });
    case "get_liquidity_opportunities":
      return z.looseObject({
        // Null is the answer, not the absence of one: a ranking that needed no
        // wallet-local emission read says so by naming the slot and emptying
        // it, the way the result's other inapplicable fields do.
        local_read_requirement: z
          .looseObject({
            read_calls_reference: artifactReferenceSchema.optional(),
          })
          .nullish(),
      });
    default:
      return undefined;
  }
}

export const publicToolCatalog = [
  {
    name: "list_tokens",
    title: "List Ekubo tokens",
    description:
      "First step for symbol-based swaps, including tokenized stocks and stablecoins: list the canonical Ekubo token list, ordered by descending visibility_priority so the preferred token wins ambiguous symbol matches. Pass search to match a symbol prefix or suffix, chain_id to stay on one chain, and min_visibility_priority to reach tokens the interface hides by default.",
    inputSchema: z.toJSONSchema(listTokensSchema),
  },
  {
    name: "export_tokens",
    title: "Export Ekubo tokens for a wallet",
    description:
      "Hand a wallet the canonical token list without reading it. Returns only a token_list_reference envelope and the count it stands for: no entries, so nothing enters your context that you would only pass on. Use this to import token names into a wallet so it can label transactions, or to name the addresses for a bulk balance read; pass the envelope unchanged as the wallet tool's reference argument. The stored body carries exactly what a wallet acts on — chain ID, address, symbol, name, decimals — and none of the logo URLs, prices, supplies, or bridge maps that make the full list 483 KB. Scope it with chain_id: a wallet holds names for the chain it is on. Check complete in the result — false means the chain has more tokens at this visibility than max_tokens allowed and the export is a prefix, not the chain's list; the busiest chains carry several thousand each, well past the 1,000 a wallet accepts in one import. Use list_tokens instead whenever you need to read entries yourself, such as resolving a symbol the user typed.",
    inputSchema: z.toJSONSchema(exportTokensSchema),
  },
  {
    name: "get_token",
    title: "Get an Ekubo token",
    description:
      "Fetch canonical token metadata for an exact chain and address.",
    inputSchema: z.toJSONSchema(getTokenSchema),
  },
  {
    name: "get_tokens",
    title: "Get multiple Ekubo tokens",
    description:
      "Fetch canonical metadata for 1 to 1,000 exact token identifiers in one batch request. Tokens may span chains. Results preserve input order and duplicates; identifiers absent from the canonical token list are omitted.",
    inputSchema: z.toJSONSchema(getTokensSchema),
  },
  {
    name: "get_quotes_with_plans",
    title: "Get swap or bridge quotes with execution plans",
    description:
      "The whole non-browser swap path for onchain swap, trade, exchange, or convert requests on supported EVM chains: one call returns every available Ekubo and 0x quote for a same-chain swap, each already carrying the execution_plan_reference that executes it, without accepting or selecting a source. Choose an option and pass its execution.execution_plan_reference envelope unchanged as the wallet's reference argument; the wallet fetches and verifies the plan body itself; there is no second preparation step, so the quote the user compared is the quote that executes rather than a different one fetched after they agreed. Do not call this tool again for an option it already prepared: that buys a fresh quote and restarts the clock on a plan you already hold. Call it again only after a revert, an expiry, or a change to the request. Omit sender and slippage_bps for an indicative comparison that fetches no calldata; supply both for plans. Unless the user specifies otherwise, choose a low slippage_bps whose maximum value impact is approximately one estimated gas fee (10,000 * gas-cost value / swap-notional value), not a generic 50 bps/0.5%; prefer re-quoting and retrying with a newly prepared transaction after slippage failure to exposing the trade to a wider bound. Never retry reverted calldata unchanged. Cross-chain requests are quoted by Across, LayerZero's Value Transfer API, and LI.FI where each is configured, and are compared the same way as same-chain options; after executing a LayerZero or LI.FI option, get_value_transfer_status is polled to confirm delivery, with that option's provider_quote_id for LayerZero and with the origin transaction hash for LI.FI. Provider failures are reported separately in unavailable_sources, and an option that could not be made executable reports its own execution_unavailable while the rest stand. Compare options on amount_out together with native_fee: some providers, LayerZero among them, charge a messaging fee in native token on top of the input that amount_out does not reflect, and ranking on amount_out alone can pick an option that costs an order of magnitude more all in. When any option charges one the comparison block names it in native_fee_sources and says whether its basis nets it out. Set include_raw_quotes only to diagnose a provider; the normalized amounts carry every field a choice turns on. Supports EIP-155 token identifiers.",
    inputSchema: z.toJSONSchema(getQuotesWithPlansSchema),
  },
  {
    name: "get_value_transfer_status",
    title: "Track a LayerZero or LI.FI cross-chain transfer",
    description:
      "Report where an executed LayerZero or LI.FI transfer has got to, from origin submission through delivery on the destination chain. A bridge is the one execution plan whose successful origin receipt does not mean the user has their funds, so this is how a cross-chain transfer is confirmed finished rather than merely sent. Pass source set to the executed quote's source. For layerzero, call it with that option's provider_quote_id and the origin transaction_hash, which some route types require rather than merely prefer. For lifi, the origin transaction_hash is the only key that resolves a transfer and is required; pass origin_chain_id with it to narrow the lookup. Poll every fifteen to thirty seconds while settled is false, and stop as soon as it is true: transfers settle in minutes rather than seconds, and this call draws on the same metered budget as a quote, so polling faster costs the next quote without learning anything sooner. Status UNKNOWN or NOT_FOUND immediately after submission usually means the transfer has not been indexed yet rather than that it was lost. Read substatus before reporting a settled LI.FI transfer as delivered: REFUNDED and PARTIAL are reported under status DONE. Applies to LayerZero and LI.FI options; Across transfers are not tracked here.",
    inputSchema: z.toJSONSchema(getValueTransferStatusSchema),
  },
  {
    name: "prepare_ve33_vote",
    title: "Prepare one ve(3,3) NFT vote change",
    description:
      "Compile one actively voted ve-token into multiple allocations. Unconditionally claims its current pool first, then splits and changes votes in one atomic batch of decodable VeToken steps. Prefer the portfolio reallocation workflow for complete state validation.",
    inputSchema: z.toJSONSchema(prepareVe33VoteSchema),
  },
  {
    name: "prepare_ve33_extend",
    title: "Prepare a ve-token extension",
    description:
      "Prepare a direct extension for an unvoted VeToken or an atomic claim-and-extend call when current_pool_key identifies an active vote, so pending voter fees are preserved.",
    inputSchema: z.toJSONSchema(prepareVe33ExtendSchema),
  },
  {
    name: "prepare_ve33_stake",
    title: "Prepare a new ve-token stake",
    description:
      "Create a new VeToken stake with an exact stake-token approval. Max duration is the safe default for new stakes; an explicit shorter duration is optional and no existing NFT, vote, fee balance, or ownership is changed.",
    inputSchema: z.toJSONSchema(prepareVe33StakeSchema),
  },
  {
    name: "prepare_ve33_split",
    title: "Prepare a ve-token split",
    description:
      "Split a source ve-token with an explicit salt and return the deterministic child token ID; the source vote is preserved and the child starts unvoted.",
    inputSchema: z.toJSONSchema(prepareVe33SplitSchema),
  },
  {
    name: "prepare_ve33_claim_fees",
    title: "Prepare ve-token fee claims",
    description:
      "Generate one call, or an atomic batch of decodable VeToken steps, claiming voter fees from one or more ve-tokens.",
    inputSchema: z.toJSONSchema(prepareVe33ClaimSchema),
  },
  {
    name: "prepare_ve33_reinvest",
    title: "Prepare ve-token fee reinvestment",
    description:
      "Build the safe phased workflow for 'reinvest my fees': automatically claim all active voter fees, prepare one exact-input swap per claimed non-stake token, then increase one VeToken or every existing active allocation without changing ownership or replacing votes.",
    inputSchema: z.toJSONSchema(prepareVe33ReinvestSchema),
  },
  {
    name: "prepare_ve33_claim_all_fees",
    title: "Prepare all ve-token fee claims",
    description:
      "Discover every active vote on VeTokens owned by the sender and generate one atomic batch of decodable VeToken steps claiming all indexed pool fees, with ownerOf and voteState validation calldata.",
    inputSchema: z.toJSONSchema(prepareAllVe33FeeClaimsSchema),
  },
  {
    name: "get_ve33_allocations",
    title: "Show Ekubo STONX / ve(3,3) allocations",
    description:
      "Use for requests such as 'show all my Ekubo STONX allocations'. The production Ekubo ve(3,3) deployment is the STONX voting system, so pass only owner to select its production chain and canonical VeToken automatically. Returns every pool, selected swap fee, NFT, applied vote weight, totals, state_id, and an onchain_validation request explicitly marked not_executed until the client runs its eth_call. Pass chain_id and ve_token together only for another deployment.",
    inputSchema: z.toJSONSchema(getVe33AllocationsSchema),
  },
  {
    name: "get_stonx_allocation_recommendation",
    title: "Get suggested STONX allocations",
    description:
      "Return a provider-neutral STONX allocation recommendation and an exactly 10,000-bps executable target list capped at 25 initialized canonical Ve33 pools. The upstream snapshot refreshes at most once a day: past a day old a refresh is attempted and awaited, but the existing snapshot still answers the request when that refresh does not land, and only a snapshot older than a week is refused. Read snapshot_age_seconds to see how old the answer actually is. The tool constructs no transaction; use compact_max_lock for one final voting NFT per target.",
    inputSchema: z.toJSONSchema(getStonxAllocationRecommendationSchema),
  },
  {
    name: "prepare_ve33_reallocation",
    title: "Prepare atomic ve(3,3) reallocation",
    description:
      "Compile a reviewed current allocation into at most 25 target pool-weight shares as one atomic batch of decodable VeToken steps. The optional compact_max_lock strategy fee-safely consolidates active NFTs, extends the survivor to four years, then creates exactly one voting NFT per target; it explicitly discloses burned source IDs and lock extension.",
    inputSchema: z.toJSONSchema(prepareVe33ReallocationSchema),
  },
  {
    name: "get_positions_by_owner",
    title: "Get Ekubo positions by owner",
    description:
      "Enumerate an owner's indexed Ekubo position NFTs without relying on ERC721 enumeration. Returns pool keys, bounds, liquidity, current indexed pool state, rewards, and pagination. Optionally filter by chain and opened/closed state.",
    inputSchema: z.toJSONSchema(getPositionsByOwnerSchema),
  },
  {
    name: "get_pool",
    title: "Get an Ekubo pool",
    description:
      "Resolve an exact chain/core/pool ID to its PoolKey and decoded config, verify that the key hashes back to the requested ID, and return the latest indexed pool-state snapshot plus a current_state_query read bundle: pass its read_calls_reference unchanged as wallet_batch_eth_call's reference argument for fresh on-chain sqrtRatio, tick, and liquidity.",
    inputSchema: z.toJSONSchema(getPoolSchema),
  },
  {
    name: "get_pool_liquidity",
    title: "Get Ekubo pool liquidity depth",
    description:
      "Return tick-level net liquidity deltas for one exact chain/core/pool ID. Accumulate the deltas in ascending tick order to reconstruct active liquidity depth.",
    inputSchema: z.toJSONSchema(getPoolLiquiditySchema),
  },
  {
    name: "list_pool_keys",
    title: "List Ekubo pool keys",
    description:
      "Discover initialized pools for one chain and Core deployment with keyset pagination: pools are ordered by ascending pool_id and after_pool_id fetches the next page. Filter by one token, an exact pair, or an extension (zero address means extensionless). Every returned pool_id is independently re-derived from its PoolKey, and each row carries the indexed state snapshot (null until the pool has indexed state).",
    inputSchema: z.toJSONSchema(listPoolKeysSchema),
  },
  {
    name: "derive_pool_id",
    title: "Derive an Ekubo pool ID",
    description:
      "Pack or accept an exact PoolKey config and derive pool_id = keccak256(abi.encode(PoolKey)). The uint64 Q64 fee is string-only so JavaScript cannot silently round it.",
    inputSchema: z.toJSONSchema(derivePoolIdSchema),
  },
  {
    name: "decode_pool_config",
    title: "Decode an Ekubo pool config",
    description:
      "Decode the packed bytes32 extension, exact uint64 Q64 fee, concentrated/stableswap discriminator, and tick spacing or stableswap parameters. The fee is never returned as a JSON number.",
    inputSchema: z.toJSONSchema(decodePoolConfigSchema),
  },
  {
    name: "get_position",
    title: "Get complete Ekubo position details",
    description:
      "Hydrate one indexed owner position with the same inputs used by the interface: pool key, bounds, indexed liquidity and pool state, NFT metadata, event history, campaigns and earned rewards, token metadata and USD prices, plus an exact pending Multicall3 eth_call and nested decode plan for current principal, fees or Ve33 rewards, and owner.",
    inputSchema: z.toJSONSchema(getPositionSchema),
  },
  {
    name: "get_position_pool_candidates",
    title: "Find pools for an LP position",
    description:
      "List existing indexed pools for a token pair without browsing the data API or reading contract ABIs. Returns v2/v3 Core generation, independently verified exact PoolKeys and pool IDs, pool type and extension classification, token USD metadata, 24-hour TVL/volume/fee/depth statistics, and the correct Positions or Ve33Positions manager for each candidate. Defaults to min_tvl_usd=0 so initialized low-liquidity pools remain visible.",
    inputSchema: z.toJSONSchema(getPositionPoolCandidatesSchema),
  },
  {
    name: "prepare_lp_position_deposit",
    title: "Prepare an LP position deposit",
    description:
      "Prepare a new v3 position mint or add liquidity to an existing position in one first-class workflow. Resolves and verifies an indexed pool or derives an exact supplied PoolKey, initializes a new pool at initial_tick when requested, selects Positions or Ve33Positions, computes a nonzero minimum liquidity, and returns every approval, execution, refund, and cleanup transaction. No Cast encoding is required. Ekubo ticks use base 1.000001, so tick = ln(price in base units) x 10^6 and a Uniswap-style 1.0001 calculation is 100x too small. A position's token ratio follows the range and the current pool price, not the amounts deposited, so when a target composition matters do every swap first, re-read the tick with the pool's current_state_query, and mint once against that tick: a swap after the mint moves the tick and re-skews the position immediately.",
    inputSchema: z.toJSONSchema(prepareLpPositionDepositSchema),
  },
  {
    name: "prepare_lp_position_earnings_claim",
    title: "Prepare an LP fee or reward claim",
    description:
      "Prepare collection of all currently accrued fees from an owned standard position or all currently accrued rewards from an owned Ve33 position. Resolves the indexed PoolKey and bounds, automatically chooses v2 withdraw-with-zero-liquidity, v3 collectFees, or Ve33 claimRewards, preserves all liquidity and the NFT, supplies an atomic pending ownership/earnings read, exact decoded calldata and result fields, and a signer-neutral plan delivered as execution_plan_reference. No Cast encoding is required.",
    inputSchema: z.toJSONSchema(prepareLpPositionEarningsClaimSchema),
  },
  {
    name: "prepare_lp_position_withdraw",
    title: "Prepare one or more LP position withdrawals",
    description:
      "Prepare partial or full liquidity withdrawals from one or more owned EVM positions with one complete wallet-batch-capable plan. Pass withdrawals, one entry per position. Resolves each indexed PoolKey and bounds, uses each exact requested uint128 liquidity, automatically collects standard-position fees or Ve33 rewards as the interface does, supports explicit recipients, preserves the NFTs, and supplies pending ownership/liquidity/earnings validation, and exact decoded calldata and result fields. The wallet never constructs calldata.",
    inputSchema: z.toJSONSchema(prepareLpPositionWithdrawSchema),
  },
  {
    name: "prepare_wrap_unwrap",
    title: "Prepare a direct wrapped-native wrap or unwrap",
    description:
      "Prepare the interface's direct wrapped-native deposit or withdrawal with exact calldata and native value, on any chain whose wrapped native token has been verified. The wrapped asset is not ether everywhere -- BNB Chain wraps BNB, Polygon wraps POL, Monad wraps MON -- so the response names the token being wrapped rather than assuming WETH.",
    inputSchema: z.toJSONSchema(prepareWrapUnwrapSchema),
  },
  {
    name: "prepare_transfers",
    title: "Prepare a batch of token transfers",
    description:
      "Prepare one atomic-capable execution plan containing 1 to 4,096 ordered transfers on one EVM chain. Native, ERC-20, ERC-721, and ERC-1155 entries may be mixed freely. Every amount must be a positive decimal base-unit integer. ERC-721 safe defaults to true and may be set false to use transferFrom; safe ERC-721 and ERC-1155 entries accept optional receiver callback data. ERC-1155 defines no unsafe transfer method. Returns only a compact summary plus the execution_plan_reference, so even a large batch does not re-enter agent context.",
    inputSchema: z.toJSONSchema(prepareTransfersSchema),
  },
  {
    name: "prepare_lp_position_transfer",
    title: "Prepare an LP position transfer",
    description:
      "Prepare the exact safeTransferFrom transaction for an owned LP position and include pending ownership validation. The position, liquidity, and unclaimed earnings move together.",
    inputSchema: z.toJSONSchema(prepareLpPositionTransferSchema),
  },
  {
    name: "prepare_fix_pool_price",
    title: "Prepare a pool price correction",
    description:
      "Run the interface-equivalent phased fix-price workflow: provide exact pending pool-price read calldata, then exact router quote calldata, then approvals and target-price execution calldata. The wallet never constructs a route or transaction.",
    inputSchema: z.toJSONSchema(prepareFixPoolPriceSchema),
  },
  {
    name: "prepare_twamm_order",
    title: "Prepare a TWAMM or DCA order",
    description:
      "Prepare one or many current-interface TWAMM order splits, including exact approval and per-order native value, and the complete plan as one atomic batch of decodable steps. Every order mints against a salt, so details.token_id is the id that will exist on chain and is returned before anything is sent -- keep it, because prepare_twamm_order_collection and prepare_twamm_order_stop are keyed by it and nothing here enumerates orders by owner. Omitting salt derives one from the request, which also makes a retry resolve to the same id instead of minting a second order. Start and end times must be multiples of 256 seconds near the present, widening in powers of 16 further out; an unaligned time is rejected here rather than reverting on chain.",
    inputSchema: z.toJSONSchema(prepareTwammOrderSchema),
  },
  {
    name: "prepare_twamm_order_collection",
    title: "Prepare TWAMM proceeds collection",
    description:
      "Prepare collection of every selected order key through the exact current or legacy Orders manager, as one atomic batch of decodable steps, with pending owner validation.",
    inputSchema: z.toJSONSchema(prepareTwammOrderCollectionSchema),
  },
  {
    name: "prepare_twamm_order_stop",
    title: "Prepare stopping a TWAMM order",
    description:
      "Prepare the interface's complete stop flow: collect every selected order and decrease every still-active sale rate in one atomic batch of decodable steps.",
    inputSchema: z.toJSONSchema(prepareTwammOrderStopSchema),
  },
  {
    name: "prepare_twamm_virtual_orders",
    title: "Prepare TWAMM virtual-order execution",
    description:
      "Prepare the permissionless lockAndExecuteVirtualOrders maintenance call for a current or legacy TWAMM pool.",
    inputSchema: z.toJSONSchema(prepareTwammVirtualOrdersSchema),
  },
  {
    name: "prepare_auction_create",
    title: "Prepare auction creation",
    description:
      "Pack the exact interface auction config and prepare mint plus sellAmountByAuction, including approval or native value and deterministic token ID.",
    inputSchema: z.toJSONSchema(prepareAuctionCreateSchema),
  },
  {
    name: "prepare_auction_complete",
    title: "Prepare auction completion",
    description:
      "Prepare permissionless auction completion and, when necessary, graduation-pool initialization in the same atomic batch.",
    inputSchema: z.toJSONSchema(prepareAuctionCompleteSchema),
  },
  {
    name: "prepare_auction_creator_proceeds",
    title: "Prepare auction creator proceeds collection",
    description:
      "Prepare collection of creator proceeds for an auction NFT with pending owner validation.",
    inputSchema: z.toJSONSchema(prepareAuctionCreatorProceedsSchema),
  },
  {
    name: "prepare_manual_pool_boost",
    title: "Prepare a manual pool boost",
    description:
      "Compute the exact Q32 boost rates and prepare all token approvals, native value, and boost calldata used by the interface.",
    inputSchema: z.toJSONSchema(prepareManualPoolBoostSchema),
  },
  {
    name: "prepare_oracle_capacity_expansion",
    title: "Prepare oracle capacity expansion",
    description:
      "Prepare the interface's permissionless Oracle expandCapacity call for one ERC-20 token.",
    inputSchema: z.toJSONSchema(prepareOracleCapacityExpansionSchema),
  },
  {
    name: "prepare_approval_revocations",
    title: "Prepare ERC-20 approval revocations",
    description:
      "Prepare every approve(spender,0) as an exact ordered multi-transaction execution plan. The wallet must not discover or construct the transaction list.",
    inputSchema: z.toJSONSchema(prepareApprovalRevocationsSchema),
  },
  {
    name: "prepare_old_gekubo_unwrap",
    title: "Prepare old gEKUBO unwrapping",
    description:
      "Prepare the exact Ethereum HyperRouter byte route and approval used by the interface to unwrap old gEKUBO into EKUBO.",
    inputSchema: z.toJSONSchema(prepareOldGekuboUnwrapSchema),
  },
  {
    name: "get_rewards_claims_by_owner",
    title: "Get incentive rewards claims by owner",
    description:
      "Fetch canonical reward-claim records and supply the exact per-chain isClaimed/isAvailable eth_call list used by the interface before preparing claim transactions.",
    inputSchema: z.toJSONSchema(getRewardsClaimsByOwnerSchema),
  },
  {
    name: "prepare_rewards_claim",
    title: "Prepare incentive reward claims",
    description:
      "Prepare one Incentives claim or the interface's allow-failure Multicall3 aggregate for multiple claims.",
    inputSchema: z.toJSONSchema(prepareRewardsClaimSchema),
  },
  {
    name: "prepare_revenue_buybacks",
    title: "Prepare revenue buyback maintenance",
    description:
      "Prepare the exact selected ended-order collections, protocol-fee withdrawals, and token rolls in interface order within one atomic batch of decodable steps.",
    inputSchema: z.toJSONSchema(prepareRevenueBuybacksSchema),
  },
  {
    name: "prepare_ve33_increase_stake",
    title: "Prepare increasing a ve-token stake",
    description:
      "Prepare the exact approval/native value and increaseStakeAmount call while preserving the existing vote and fee accounting.",
    inputSchema: z.toJSONSchema(prepareVe33IncreaseStakeSchema),
  },
  {
    name: "prepare_ve33_merge",
    title: "Prepare merging ve-token stakes",
    description:
      "Prepare fee-safe merging of one or more source NFTs into a destination, including required claims and the selected resulting vote in one atomic batch of decodable steps.",
    inputSchema: z.toJSONSchema(prepareVe33MergeSchema),
  },
  {
    name: "prepare_ve33_withdraw",
    title: "Prepare expired ve-token withdrawal",
    description:
      "Prepare fee-safe withdrawal of an expired ve-token stake, claiming the active pool first when voted and returning pending owner/stake validation.",
    inputSchema: z.toJSONSchema(prepareVe33WithdrawSchema),
  },
  {
    name: "get_liquidity_opportunities",
    title: "Find Ekubo liquidity opportunities",
    description:
      "Return the same boosted-fee, active-incentive, and projected ve(3,3)-emission opportunities shown by the Ekubo interface, ranked by APR with canonical token metadata, exact actionable pools or pair-level pool-discovery handoffs, source freshness, and risk context. A request whose ranking includes Ve33 projections supplies a wallet-local emission-state read; pass its locally decoded values back to complete the final ranking.",
    inputSchema: z.toJSONSchema(getLiquidityOpportunitiesSchema),
  },
  {
    name: "prepare_pool_initialization",
    title: "Prepare standalone pool initialization",
    description:
      "Prepare one exact permissionless maybeInitializePool transaction for a supplied v3 PoolKey and initial tick. This is the standalone alternative to the atomic maybeInitializePool plus mintAndDeposit batch returned by prepare_lp_position_deposit when pool_initialized=false.",
    inputSchema: z.toJSONSchema(preparePoolInitializationSchema),
  },
  {
    name: "get_aave_v3_markets",
    title: "List fixed Aave V3 markets",
    description:
      "Locally return six major Aave V3 core deployments and a bounded set of popular reserve, aToken, and variable-debt-token addresses from a pinned official Aave address-book snapshot. This tool makes no RPC, indexer, API, or other network request. For live rates, caps, pause state, liquidity, collateral settings, eMode categories, and account data, an agent may call Aave's public GraphQL API at https://api.v3.aave.com/graphql directly; this server is not in that data path. Intersect the API result with this fixed list before calling a preparation tool.",
    inputSchema: z.toJSONSchema(getAaveV3MarketsSchema),
  },
  {
    name: "prepare_aave_v3_supply",
    title: "Prepare an Aave V3 supply",
    description:
      "Prepare a fixed-market Aave V3 Pool supply with an exact ERC-20 approval, supply calldata, and allowance cleanup as one atomic wallet plan. No live balance, allowance, reserve, cap, pause, or rate data is queried.",
    inputSchema: z.toJSONSchema(prepareAaveV3SupplySchema),
  },
  {
    name: "prepare_aave_v3_withdraw",
    title: "Prepare an Aave V3 withdrawal",
    description:
      "Prepare a direct Aave V3 Pool withdrawal for a supported fixed reserve. Pass uint256 maximum as amount to request the available aToken balance. The wallet establishes balance, health-factor, collateral, and liquidity validity by exact simulation.",
    inputSchema: z.toJSONSchema(prepareAaveV3WithdrawSchema),
  },
  {
    name: "prepare_aave_v3_borrow",
    title: "Prepare an Aave V3 variable borrow",
    description:
      "Prepare a direct Aave V3 variable-rate borrow from a supported fixed reserve, including optional on-behalf-of credit delegation. This server does not query collateral, delegation, health factor, caps, or available liquidity.",
    inputSchema: z.toJSONSchema(prepareAaveV3BorrowSchema),
  },
  {
    name: "prepare_aave_v3_repay",
    title: "Prepare an Aave V3 variable-debt repayment",
    description:
      "Prepare variable-debt repayment with underlying tokens or sender-owned aTokens. Underlying repayment carries an exact ERC-20 approval and cleanup in one atomic plan; uint256 maximum requests all available debt.",
    inputSchema: z.toJSONSchema(prepareAaveV3RepaySchema),
  },
  {
    name: "prepare_aave_v3_collateral",
    title: "Prepare an Aave V3 collateral toggle",
    description:
      "Prepare setUserUseReserveAsCollateral for a supported fixed reserve. Disabling collateral can reduce health factor or revert when open debt needs it, so exact wallet simulation is mandatory.",
    inputSchema: z.toJSONSchema(prepareAaveV3CollateralSchema),
  },
  {
    name: "prepare_aave_v3_emode",
    title: "Prepare an Aave V3 eMode change",
    description:
      "Prepare setUserEMode with a caller-supplied current uint8 category ID; zero disables eMode. Discover live category configuration through Aave's public GraphQL API directly, because this server makes no data or RPC request.",
    inputSchema: z.toJSONSchema(prepareAaveV3EModeSchema),
  },
  {
    name: "get_morpho_vaults",
    title: "List fixed Morpho Vault V2 deployments",
    description:
      "Locally return a bounded, pinned catalog of listed Morpho Vault V2 deployments plus official direct-discovery guidance. This tool makes no API, RPC, indexer, or other network request. The agent must query Morpho's public GraphQL API and current onchain state directly, then intersect the result with the fixed chain, vault, and asset addresses before preparation.",
    inputSchema: z.toJSONSchema(getMorphoVaultsSchema),
  },
  {
    name: "prepare_morpho_vault_deposit",
    title: "Prepare a guarded Morpho vault deposit",
    description:
      "Prepare an exact-approval Morpho Vault V2 deposit through the official SDK's Bundler3/GeneralAdapter1 route. The caller supplies a fresh RAY-scaled max share price, which is enforced onchain against ERC-4626 share-price inflation; the server performs no data fetch.",
    inputSchema: z.toJSONSchema(prepareMorphoVaultDepositSchema),
  },
  {
    name: "prepare_morpho_vault_withdraw",
    title: "Prepare a Morpho vault withdrawal",
    description:
      "Prepare a direct Morpho Vault V2 withdrawal for an exact underlying-asset amount from a fixed vault. Current shares, liquidity, permissions, and vault state are established by direct agent discovery and exact wallet simulation.",
    inputSchema: z.toJSONSchema(prepareMorphoVaultWithdrawSchema),
  },
  {
    name: "prepare_morpho_vault_redeem",
    title: "Prepare a Morpho vault redemption",
    description:
      "Prepare a direct Morpho Vault V2 redemption for an exact share amount. Prefer redeem for full exits so the user's complete fresh share balance can be bound without asset/share rounding dust.",
    inputSchema: z.toJSONSchema(prepareMorphoVaultRedeemSchema),
  },
  {
    name: "get_sky_savings_deployment",
    title: "Get the fixed Sky savings deployment",
    description:
      "Locally return the canonical Ethereum USDS and sUSDS addresses and direct wallet-read guidance. This server does not proxy Sky, an RPC, an indexer, or any third-party API.",
    inputSchema: z.toJSONSchema(getSkySavingsDeploymentSchema),
  },
  {
    name: "prepare_sky_savings_deposit",
    title: "Prepare a Sky savings deposit",
    description:
      "Prepare an exact USDS approval, ERC-4626 sUSDS deposit, and allowance cleanup as one atomic wallet plan. The direct vault interface has no minimum-shares or deadline field, so a fresh preview and exact wallet simulation are mandatory.",
    inputSchema: z.toJSONSchema(prepareSkySavingsDepositSchema),
  },
  {
    name: "prepare_sky_savings_withdraw",
    title: "Prepare a Sky savings withdrawal",
    description:
      "Prepare a direct sUSDS ERC-4626 withdrawal for an exact USDS amount. The server does not query current exchange rate, capacity, balance, allowance, or preview state.",
    inputSchema: z.toJSONSchema(prepareSkySavingsWithdrawSchema),
  },
  {
    name: "prepare_sky_savings_redeem",
    title: "Prepare a Sky savings redemption",
    description:
      "Prepare a direct sUSDS ERC-4626 redemption for an exact share amount. Use a fresh wallet/RPC balance and preview, then require exact wallet simulation before authorization.",
    inputSchema: z.toJSONSchema(prepareSkySavingsRedeemSchema),
  },
  {
    name: "get_merkl_deployment",
    title: "Get the verified Merkl Distributor deployment",
    description:
      "Locally return the Merkl reward Distributor address, the chains it was verified on, and how Merkl's reward fields behave. This server makes no Merkl API, RPC, or indexer request. Merkl lists 67 chains but the Distributor is not at the same address on all of them — ZKsync Era has no code there — so preparation is limited to the chains listed here.",
    inputSchema: z.toJSONSchema(getMerklDeploymentSchema),
  },
  {
    name: "prepare_merkl_claim",
    title: "Prepare a Merkl reward claim",
    description:
      "Prepare one Distributor claim covering every Merkl reward token the sender holds on a chain, from amounts and proofs the agent fetched from https://api.merkl.xyz/v4/users/{address}/rewards/summary. Every proof is folded here into the Merkle root it implies, all rewards must agree on that root, and the returned read bundle asks the wallet for the root the chain is actually enforcing plus each already-claimed total and claim-recipient override — so neither this server nor the wallet has to trust Merkl's API. Amounts are cumulative, not deltas: the contract transfers the amount minus what was already claimed. Distinct from prepare_rewards_claim, which claims Ekubo's own incentive drops.",
    inputSchema: z.toJSONSchema(prepareMerklClaimSchema),
  },
  {
    name: "get_aerodrome_deployment",
    title: "Get the verified Aerodrome Base deployment",
    description:
      "Locally return Aerodrome's Base contracts — AERO, the veAERO escrow, Voter, Router, v2 pool factory, RewardsDistributor, both Slipstream generations, and the four Sugar lens contracts — plus the protocol behaviour an agent has to respect. Every address was derived on chain from the Voter outward rather than copied from Velodrome's SDKs, which publish Optimism addresses and a drifted struct layout. This server makes no Aerodrome API or RPC request. Aerodrome is Base-only; Velodrome is the same code elsewhere and is not prepared here.",
    inputSchema: z.toJSONSchema(getAerodromeDeploymentSchema),
  },
  {
    name: "prepare_aerodrome_sugar_reads",
    title: "Prepare an Aerodrome Sugar read bundle",
    description:
      "Build the exact eth_call bundle for one Sugar dataset — pools, an account's positions, veNFTs by account or id, epoch rewards, or a veNFT's claimable rewards — for the wallet to run against the user's own RPC. Sugar is Aerodrome's data pipeline: there is no API to call, the lens contracts answer eth_call, and this server stays out of the data path. Each call ships with a decode plan matching the deployed contract's struct layout, verified by decoding live responses. The addresses it returns — pool, gauge, fee, and bribe contracts, and veNFT ids — are the required inputs to the other prepare_aerodrome_* tools.",
    inputSchema: z.toJSONSchema(prepareAerodromeSugarReadsSchema),
  },
  {
    name: "prepare_aerodrome_liquidity_deposit",
    title: "Prepare an Aerodrome v2 liquidity deposit",
    description:
      "Prepare a v2 addLiquidity through Aerodrome's Router, with an exact approval per side and an allowance cleanup after. The pool takes whatever its reserve ratio demands and refunds the rest, so both minimums are required rather than defaulted. The returned read bundle quotes the actual split and resolves the pool address, so a pair that has no pool yet is caught before a deposit sets its opening price. This mints LP tokens only; they earn no AERO until staked with prepare_aerodrome_gauge_deposit.",
    inputSchema: z.toJSONSchema(prepareAerodromeLiquidityDepositSchema),
  },
  {
    name: "prepare_aerodrome_liquidity_withdraw",
    title: "Prepare an Aerodrome v2 liquidity withdrawal",
    description:
      "Prepare a v2 removeLiquidity that burns LP tokens back into the underlying pair, with the LP-token approval the router needs and an allowance cleanup after. Phased, because the token being approved is the pool and this server resolves Aerodrome addresses by reading them: call it without lp_token to get the pool read back, then again with the resolved address for the complete atomic plan. An LP balance short of the requested liquidity usually means the rest is staked in the gauge and needs unstaking first.",
    inputSchema: z.toJSONSchema(prepareAerodromeLiquidityWithdrawSchema),
  },
  {
    name: "prepare_aerodrome_gauge_deposit",
    title: "Prepare an Aerodrome gauge stake",
    description:
      "Stake v2 LP tokens into a pool's gauge to earn AERO emissions, with the LP-token approval the gauge needs and an allowance cleanup after. Phased, because which token the gauge pulls is its own stakingToken: call it without lp_token to get that read back, then again with the resolved address for the complete atomic plan. Staking redirects that position's trading fees to the pool's voters, so it trades fee income for emissions rather than adding to it. A dead gauge accepts the stake and pays nothing, so check gauge_alive. Size amount from the live LP balance, not from an earlier deposit simulation.",
    inputSchema: z.toJSONSchema(prepareAerodromeGaugeDepositSchema),
  },
  {
    name: "prepare_aerodrome_gauge_withdraw",
    title: "Prepare an Aerodrome gauge unstake",
    description:
      "Unstake v2 LP tokens from a gauge. This returns the LP token, not the underlying pair, and it does not claim AERO: the read bundle reports what is still earned so it is not silently left behind.",
    inputSchema: z.toJSONSchema(prepareAerodromeGaugeWithdrawSchema),
  },
  {
    name: "prepare_aerodrome_gauge_claim",
    title: "Prepare an Aerodrome emissions claim",
    description:
      "Claim accrued AERO from a gauge. getReward credits its account argument rather than the sender, so a claim can pay a different address than the one paying gas; the plan states which. A claim with nothing earned succeeds and transfers nothing.",
    inputSchema: z.toJSONSchema(prepareAerodromeGaugeClaimSchema),
  },
  {
    name: "prepare_aerodrome_lock",
    title: "Prepare a veAERO lock action",
    description:
      "Build one veAERO escrow action: create a lock, add AERO to one, extend it, switch permanent locking on or off, or withdraw an expired one. Durations are measured from now and floored to a week boundary, so anything under a week is refused rather than signed. The read bundle returns ownership and the lock's (amount, end, isPermanent) so an impossible action — withdrawing an unexpired or permanent lock, extending past nothing — is caught before signing.",
    inputSchema: z.toJSONSchema(prepareAerodromeLockSchema),
  },
  {
    name: "prepare_aerodrome_vote",
    title: "Prepare a veAERO vote or reset",
    description:
      "Cast one veNFT's gauge vote, or reset it. Weights are relative shares of voting power, not amounts, and the allocation replaces any previous vote entirely — a pool left out is voted zero. A veNFT may vote once per weekly epoch and reverts on a second attempt, so the read bundle returns lastVoted along with each pool's gauge and liveness. Voting also locks the NFT against withdrawal until it is reset.",
    inputSchema: z.toJSONSchema(prepareAerodromeVoteSchema),
  },
  {
    name: "prepare_aerodrome_incentive_claim",
    title: "Prepare a veAERO reward claim",
    description:
      "Claim a veNFT's voting rewards — trading fees, bribes, or both — and optionally the RewardsDistributor rebase, as one plan. The fee and bribe contract addresses are required inputs because they are per-pool contracts that only a Sugar rewards read returns; this server cannot derive them, and a wrong address claims nothing rather than failing loudly. Distinct from prepare_aerodrome_gauge_claim, which collects an LP's emissions rather than a voter's rewards.",
    inputSchema: z.toJSONSchema(prepareAerodromeIncentiveClaimSchema),
  },
  {
    name: "get_lido_deployment",
    title: "Get the fixed Lido mainnet deployment",
    description:
      "Locally return canonical Ethereum stETH, wstETH, and WithdrawalQueueERC721 addresses plus direct wallet-read guidance. This server makes no Lido API, RPC, or indexer request.",
    inputSchema: z.toJSONSchema(getLidoDeploymentSchema),
  },
  {
    name: "prepare_lido_stake",
    title: "Prepare Lido ETH staking",
    description:
      "Prepare the canonical Lido submit call with exact native ETH value and an explicit or zero referral. The agent must read current staking pause and limit state directly; the wallet then simulates the exact transaction.",
    inputSchema: z.toJSONSchema(prepareLidoStakeSchema),
  },
  {
    name: "prepare_lido_wrap",
    title: "Prepare stETH wrapping",
    description:
      "Prepare an exact stETH approval, wstETH wrap call, and allowance cleanup in one atomic wallet plan.",
    inputSchema: z.toJSONSchema(prepareLidoWrapSchema),
  },
  {
    name: "prepare_lido_unwrap",
    title: "Prepare wstETH unwrapping",
    description:
      "Prepare a direct wstETH unwrap call for an exact share amount, returning rebasing stETH to the sender.",
    inputSchema: z.toJSONSchema(prepareLidoUnwrapSchema),
  },
  {
    name: "prepare_lido_withdrawal_request",
    title: "Prepare a Lido withdrawal request",
    description:
      "Prepare one or more bounded stETH withdrawal requests with an exact queue approval and cleanup. This irreversible asynchronous action mints unstETH NFTs, stops rewards while queued, and can settle below 1:1 after extraordinary losses; wallet simulation and clear user review are required.",
    inputSchema: z.toJSONSchema(prepareLidoWithdrawalRequestSchema),
  },
  {
    name: "prepare_lido_withdrawal_claim",
    title: "Prepare a Lido withdrawal claim",
    description:
      "Prepare claimWithdrawal for one finalized, unclaimed unstETH request ID owned by the sender. The agent must verify ownership and finalization directly through the user's wallet/RPC before preparation.",
    inputSchema: z.toJSONSchema(prepareLidoWithdrawalClaimSchema),
  },
] as const;

/**
 * The HTTP discovery catalog served at /tools: registration metadata plus,
 * for handoff tools, the JSON Schema of the result shape that carries the
 * artifact-reference envelope.
 */
export const publicToolCatalogWithOutputs = publicToolCatalog.map((entry) => {
  const outputSchema = toolOutputSchema(entry.name);
  return {
    ...entry,
    annotations: toolAnnotations(entry.name),
    ...(outputSchema === undefined
      ? {}
      : { outputSchema: z.toJSONSchema(outputSchema) }),
  };
});

/**
 * One catalog entry by name.
 *
 * Registration used to index into the catalog by position, which quietly made
 * every tool's identity depend on how many tools happened to be declared above
 * it: adding or retiring one silently re-pointed every later registration at
 * the wrong entry. Names do not move when the list does.
 */
function catalogEntry(name: string) {
  const entry = publicToolCatalog.find((tool) => tool.name === name);
  if (entry === undefined) {
    throw new Error(`internal error: no tool named ${name} in the catalog`);
  }
  return entry;
}

export function createEkuboServer(
  env: Env,
  origin = "https://mcp.ekubo.org",
  country: RequestCountry = null,
) {
  const server = new McpServer(
    {
      name: "ekubo",
      title: "Ekubo Protocol",
      version: MCP_SERVER_VERSION,
      websiteUrl: "https://mcp.ekubo.org",
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // Every registration funnels through this wrapper so any execution plan a
  // handler embeds is stored server-side and travels as a short reference.
  // The agent between this server and the wallet re-emits ~100 characters
  // instead of the plan body; the wallet fetches the body itself and verifies
  // its keccak256 against the reference. Registration is the one choke point
  // every tool shares, however it was registered.
  const registerWithPlanReferences = server.registerTool.bind(
    server,
  ) as unknown as (
    name: string,
    config: Record<string, unknown>,
    callback: (...args: unknown[]) => Promise<unknown>,
  ) => void;
  server.registerTool = ((
    name: string,
    config: Record<string, unknown>,
    callback: (...args: unknown[]) => Promise<unknown>,
  ) =>
    registerWithPlanReferences(name, config, async (...args: unknown[]) => {
      const result = (await callback(...args)) as {
        isError?: boolean;
        content?: unknown;
        structuredContent?: unknown;
      };
      if (result?.isError === true || result?.structuredContent === undefined) {
        return result;
      }
      const { value, replaced } = await referenceWalletArtifacts(
        env,
        origin,
        result.structuredContent,
      );
      if (replaced === 0) return result;
      return {
        ...result,
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        structuredContent: value,
      };
    })) as typeof server.registerTool;

  const registerCatalogTool = <Schema extends z.ZodObject<z.ZodRawShape>>(
    name: string,
    inputSchema: Schema,
    handler: (input: z.infer<Schema>) => unknown | Promise<unknown>,
  ) => {
    const entry = catalogEntry(name);
    const registerTool = server.registerTool.bind(server) as unknown as (
      name: string,
      config: Record<string, unknown>,
      callback: (input: Record<string, unknown>) => Promise<unknown>,
    ) => void;
    registerTool(
      entry.name,
      {
        title: entry.title,
        description: entry.description,
        inputSchema,
        annotations: toolAnnotations(entry.name),
        ...(toolOutputSchema(entry.name) === undefined
          ? {}
          : { outputSchema: toolOutputSchema(entry.name) }),
      },
      async (input: Record<string, unknown>) =>
        toolResult(() => handler(input as unknown as z.infer<Schema>)),
    );
  };

  server.registerTool(
    catalogEntry("list_tokens").name,
    {
      title: catalogEntry("list_tokens").title,
      description: catalogEntry("list_tokens").description,
      inputSchema: listTokensSchema,
      annotations: toolAnnotations("list_tokens"),
      ...(toolOutputSchema("list_tokens") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("list_tokens") }),
    },
    async ({
      chain_id,
      search,
      min_visibility_priority,
      page_size,
      after_token,
    }) =>
      toolResult(async () => ({
        tokens: await listTokens(env, {
          chainId:
            chain_id === undefined ? undefined : canonicalChainId(chain_id),
          search,
          minVisibilityPriority: min_visibility_priority ?? 0,
          pageSize: page_size ?? DEFAULT_TOKEN_PAGE_SIZE,
          afterToken: after_token,
        }),
      })),
  );

  server.registerTool(
    catalogEntry("export_tokens").name,
    {
      title: catalogEntry("export_tokens").title,
      description: catalogEntry("export_tokens").description,
      inputSchema: exportTokensSchema,
      annotations: toolAnnotations("export_tokens"),
      ...(toolOutputSchema("export_tokens") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("export_tokens") }),
    },
    async ({ chain_id, max_tokens }) =>
      toolResult(async () => {
        const limit = max_tokens ?? DEFAULT_TOKEN_EXPORT_SIZE;
        // Ask for one past the limit so a full page can be told apart from a
        // chain that happens to end there. Without this an export of
        // Ethereum, which carries over five thousand tokens at this
        // threshold, would return the first thousand and describe them as
        // the chain's list — a truncation nothing downstream could detect,
        // since the agent never sees an entry to miss.
        const tokens = await listTokens(env, {
          chainId:
            chain_id === undefined ? undefined : canonicalChainId(chain_id),
          // Fixed at the interface's own threshold. Reaching below it is how
          // a caller asks for tokens the interface hides, and a bulk export
          // bound for the screen where an owner grants names is the last
          // place that should be reachable in one argument.
          minVisibilityPriority: 0,
          pageSize: Math.min(limit + 1, UPSTREAM_MAX_TOKEN_PAGE_SIZE),
        });
        // At the upstream ceiling there is no probe left to take, so a full
        // page cannot be proven complete and is reported as incomplete.
        const complete = tokens.length <= limit;
        const entries = tokenListEntries(tokens.slice(0, limit));
        return {
          token_list_reference: await storeArtifact(env, origin, {
            artifactType: "token_list",
            body: { name: CANONICAL_TOKEN_LIST_NAME, tokens: entries },
          }),
          count: entries.length,
          complete,
        };
      }),
  );

  server.registerTool(
    catalogEntry("get_token").name,
    {
      title: catalogEntry("get_token").title,
      description: catalogEntry("get_token").description,
      inputSchema: getTokenSchema,
      annotations: toolAnnotations("get_token"),
      ...(toolOutputSchema("get_token") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("get_token") }),
    },
    async ({ chain_id, address: tokenAddress }) =>
      toolResult(async () => ({
        token: await getToken(env, {
          chainId: canonicalChainId(chain_id),
          address: tokenAddress,
        }),
      })),
  );

  server.registerTool(
    catalogEntry("get_tokens").name,
    {
      title: catalogEntry("get_tokens").title,
      description: catalogEntry("get_tokens").description,
      inputSchema: getTokensSchema,
      annotations: toolAnnotations("get_tokens"),
      ...(toolOutputSchema("get_tokens") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("get_tokens") }),
    },
    async (input) =>
      toolResult(async () => ({
        tokens: await getTokens(env, {
          tokens: input.tokens.map((token) => ({
            chainId: canonicalChainId(token.chain_id),
            address: token.address,
          })),
        }),
      })),
  );

  registerCatalogTool(
    "get_quotes_with_plans",
    getQuotesWithPlansSchema,
    (input) => {
      const inputChainId = canonicalChainId(input.chain_id);
      const destinationChainId = canonicalChainId(
        input.destination_chain_id ?? input.chain_id,
      );
      const tokenIn = tokenAddress(input.token_in, inputChainId, "token_in");
      const tokenOut = tokenAddress(
        input.token_out,
        destinationChainId,
        "token_out",
      );
      // Both sides, each against its own chain: a bridge quote settles the
      // output on the destination chain, where a different rule may apply.
      assertAssetsTradable(
        [
          { chainId: inputChainId, token: tokenIn },
          { chainId: destinationChainId, token: tokenOut },
        ],
        country,
      );
      return getQuotesWithPlans(env, {
        chainId: inputChainId,
        destinationChainId,
        tokenIn,
        tokenOut,
        quoteType: input.quote_type,
        amount: input.amount,
        slippageBps: input.slippage_bps,
        recipient: input.recipient as Address | undefined,
        sender: input.sender as Address | undefined,
        includeRawQuotes: input.include_raw_quotes,
      });
    },
  );

  registerCatalogTool(
    "get_value_transfer_status",
    getValueTransferStatusSchema,
    (input) =>
      getValueTransferStatus(env, {
        source: input.source,
        quoteId: input.quote_id,
        transactionHash: input.transaction_hash,
        originChainId:
          input.origin_chain_id === undefined
            ? undefined
            : canonicalChainId(input.origin_chain_id),
        destinationChainId:
          input.destination_chain_id === undefined
            ? undefined
            : canonicalChainId(input.destination_chain_id),
      }),
  );

  server.registerTool(
    catalogEntry("prepare_ve33_vote").name,
    {
      title: catalogEntry("prepare_ve33_vote").title,
      description: catalogEntry("prepare_ve33_vote").description,
      inputSchema: prepareVe33VoteSchema,
      annotations: toolAnnotations("prepare_ve33_vote"),
      ...(toolOutputSchema("prepare_ve33_vote") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("prepare_ve33_vote") }),
    },
    async (input) =>
      toolResult(() =>
        prepareVe33Vote({
          chainId: canonicalChainId(input.chain_id),
          veToken: input.ve_token as Address,
          sender: input.sender as Address,
          sourceVeId: input.source_ve_id,
          sourceAmount: input.source_amount,
          currentVote: {
            poolKeyId: input.current_vote.pool_key_id,
            poolKey: mapPoolKey(input.current_vote.pool_key),
            swapFee: input.current_vote.swap_fee,
          },
          allocations: input.allocations.map((allocation) => ({
            poolKeyId: allocation.pool_key_id,
            poolKey: mapPoolKey(allocation.pool_key),
            swapFee: allocation.swap_fee,
            permille: allocation.permille,
          })),
          unallocatedPermille: input.unallocated_permille,
          saltNonce: input.salt_nonce as `0x${string}`,
        }),
      ),
  );

  server.registerTool(
    catalogEntry("prepare_ve33_extend").name,
    {
      title: catalogEntry("prepare_ve33_extend").title,
      description: catalogEntry("prepare_ve33_extend").description,
      inputSchema: prepareVe33ExtendSchema,
      annotations: toolAnnotations("prepare_ve33_extend"),
      ...(toolOutputSchema("prepare_ve33_extend") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("prepare_ve33_extend") }),
    },
    async (input) =>
      toolResult(() =>
        prepareVe33Extend({
          chainId: canonicalChainId(input.chain_id),
          veToken: input.ve_token as Address,
          sender: input.sender as Address,
          veId: input.ve_id,
          durationSeconds: input.duration_seconds,
          maxDuration: input.max_duration,
          currentPoolKey:
            input.current_pool_key === undefined
              ? undefined
              : mapPoolKey(input.current_pool_key),
        }),
      ),
  );

  server.registerTool(
    catalogEntry("prepare_ve33_stake").name,
    {
      title: catalogEntry("prepare_ve33_stake").title,
      description: catalogEntry("prepare_ve33_stake").description,
      inputSchema: prepareVe33StakeSchema,
      annotations: toolAnnotations("prepare_ve33_stake"),
      ...(toolOutputSchema("prepare_ve33_stake") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("prepare_ve33_stake") }),
    },
    async (input) =>
      toolResult(() =>
        prepareVe33Stake({
          chainId: canonicalChainId(input.chain_id),
          veToken: input.ve_token as Address,
          sender: input.sender as Address,
          stakeToken: input.stake_token as Address,
          amount: input.amount,
          salt: input.salt as `0x${string}`,
          durationSeconds: input.duration_seconds,
          maxDuration:
            input.max_duration ?? input.duration_seconds === undefined,
        }),
      ),
  );

  server.registerTool(
    catalogEntry("prepare_ve33_split").name,
    {
      title: catalogEntry("prepare_ve33_split").title,
      description: catalogEntry("prepare_ve33_split").description,
      inputSchema: prepareVe33SplitSchema,
      annotations: toolAnnotations("prepare_ve33_split"),
      ...(toolOutputSchema("prepare_ve33_split") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("prepare_ve33_split") }),
    },
    async (input) =>
      toolResult(() =>
        prepareVe33Split({
          chainId: canonicalChainId(input.chain_id),
          veToken: input.ve_token as Address,
          sender: input.sender as Address,
          veId: input.ve_id,
          amount: input.amount,
          salt: input.salt as `0x${string}`,
        }),
      ),
  );

  server.registerTool(
    catalogEntry("prepare_ve33_claim_fees").name,
    {
      title: catalogEntry("prepare_ve33_claim_fees").title,
      description: catalogEntry("prepare_ve33_claim_fees").description,
      inputSchema: prepareVe33ClaimSchema,
      annotations: toolAnnotations("prepare_ve33_claim_fees"),
      ...(toolOutputSchema("prepare_ve33_claim_fees") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("prepare_ve33_claim_fees") }),
    },
    async (input) =>
      toolResult(() =>
        prepareVe33Claim({
          chainId: canonicalChainId(input.chain_id),
          veToken: input.ve_token as Address,
          sender: input.sender as Address,
          recipient: input.recipient as Address | undefined,
          claims: input.claims.map((claim) => ({
            veId: claim.ve_id,
            poolKey: mapPoolKey(claim.pool_key),
          })),
        }),
      ),
  );

  server.registerTool(
    catalogEntry("prepare_ve33_reinvest").name,
    {
      title: catalogEntry("prepare_ve33_reinvest").title,
      description: catalogEntry("prepare_ve33_reinvest").description,
      inputSchema: prepareVe33ReinvestSchema,
      annotations: toolAnnotations("prepare_ve33_reinvest"),
      ...(toolOutputSchema("prepare_ve33_reinvest") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("prepare_ve33_reinvest") }),
    },
    async (input) =>
      toolResult(() => {
        const common = {
          chainId: canonicalChainId(input.chain_id),
          veToken: input.ve_token as Address,
          sender: input.sender as Address,
        };
        if (input.phase === "claim") {
          return prepareVe33Reinvest(env, {
            phase: "claim",
            ...common,
            claims: input.claims?.map((claim) => ({
              veId: claim.ve_id,
              poolKey: mapPoolKey(claim.pool_key),
            })),
          });
        }
        if (input.phase === "swap") {
          return prepareVe33Reinvest(env, {
            phase: "swap",
            ...common,
            stakeToken: input.stake_token as Address,
            feeBalances: (input.fee_balances ?? []).map((balance) => ({
              token: balance.token as Address,
              amount: balance.amount,
            })),
            slippageBps: input.slippage_bps,
            source: input.source as QuoteSource,
            country,
          });
        }
        if (input.phase === "stake_all") {
          return prepareVe33Reinvest(env, {
            phase: "stake_all",
            ...common,
            stakeToken: input.stake_token as Address,
            currentStateId: input.current_state_id as `0x${string}`,
            amount: input.amount as string,
          });
        }
        return prepareVe33Reinvest(env, {
          phase: "stake",
          ...common,
          stakeToken: input.stake_token as Address,
          veId: input.ve_id as string,
          amount: input.amount as string,
        });
      }),
  );

  server.registerTool(
    catalogEntry("prepare_ve33_claim_all_fees").name,
    {
      title: catalogEntry("prepare_ve33_claim_all_fees").title,
      description: catalogEntry("prepare_ve33_claim_all_fees").description,
      inputSchema: prepareAllVe33FeeClaimsSchema,
      annotations: toolAnnotations("prepare_ve33_claim_all_fees"),
      ...(toolOutputSchema("prepare_ve33_claim_all_fees") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("prepare_ve33_claim_all_fees") }),
    },
    async (input) =>
      toolResult(() =>
        prepareAllVe33FeeClaims(env, {
          chainId: canonicalChainId(input.chain_id),
          veToken: input.ve_token as Address,
          sender: input.sender as Address,
          recipient: input.recipient as Address | undefined,
        }),
      ),
  );

  server.registerTool(
    catalogEntry("get_ve33_allocations").name,
    {
      title: catalogEntry("get_ve33_allocations").title,
      description: catalogEntry("get_ve33_allocations").description,
      inputSchema: getVe33AllocationsSchema,
      annotations: toolAnnotations("get_ve33_allocations"),
      ...(toolOutputSchema("get_ve33_allocations") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("get_ve33_allocations") }),
    },
    async (input) =>
      toolResult(() =>
        getVe33Allocations(env, {
          chainId:
            input.chain_id === undefined
              ? ROBINHOOD_STONX_CHAIN_ID
              : canonicalChainId(input.chain_id),
          veToken: (input.ve_token ?? ROBINHOOD_STONX_VE_TOKEN) as Address,
          owner: input.owner as Address,
        }),
      ),
  );

  server.registerTool(
    catalogEntry("get_stonx_allocation_recommendation").name,
    {
      title: catalogEntry("get_stonx_allocation_recommendation").title,
      description: catalogEntry("get_stonx_allocation_recommendation").description,
      inputSchema: getStonxAllocationRecommendationSchema,
      annotations: toolAnnotations("get_stonx_allocation_recommendation"),
      ...(toolOutputSchema("get_stonx_allocation_recommendation") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("get_stonx_allocation_recommendation") }),
    },
    async () =>
      toolResult(() =>
        getStonxAllocationRecommendation(env, {
          chainId: ROBINHOOD_STONX_CHAIN_ID,
          veToken: ROBINHOOD_STONX_VE_TOKEN,
          ve33: ROBINHOOD_STONX_VE33,
        }),
      ),
  );

  server.registerTool(
    catalogEntry("prepare_ve33_reallocation").name,
    {
      title: catalogEntry("prepare_ve33_reallocation").title,
      description: catalogEntry("prepare_ve33_reallocation").description,
      inputSchema: prepareVe33ReallocationSchema,
      annotations: toolAnnotations("prepare_ve33_reallocation"),
      ...(toolOutputSchema("prepare_ve33_reallocation") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("prepare_ve33_reallocation") }),
    },
    async (input) =>
      toolResult(() =>
        prepareVe33Reallocation(env, {
          chainId: canonicalChainId(input.chain_id),
          veToken: input.ve_token as Address,
          sender: input.sender as Address,
          currentStateId: input.current_state_id as `0x${string}`,
          targets: input.targets.map((target) => ({
            poolKeyId: target.pool_key_id,
            swapFee: target.swap_fee,
            weightBps: target.weight_bps,
          })),
          saltNonce: input.salt_nonce as `0x${string}`,
          strategy: input.strategy,
        }),
      ),
  );

  server.registerTool(
    catalogEntry("get_positions_by_owner").name,
    {
      title: catalogEntry("get_positions_by_owner").title,
      description: catalogEntry("get_positions_by_owner").description,
      inputSchema: getPositionsByOwnerSchema,
      annotations: toolAnnotations("get_positions_by_owner"),
      ...(toolOutputSchema("get_positions_by_owner") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("get_positions_by_owner") }),
    },
    async (input) =>
      toolResult(() =>
        getPositionsByOwner(env, {
          owner: input.owner,
          chainId:
            input.chain_id === undefined
              ? undefined
              : canonicalChainId(input.chain_id),
          state: input.state,
          pageSize: input.page_size,
          page: input.page,
        }),
      ),
  );

  server.registerTool(
    catalogEntry("get_pool").name,
    {
      title: catalogEntry("get_pool").title,
      description: catalogEntry("get_pool").description,
      inputSchema: getPoolSchema,
      annotations: toolAnnotations("get_pool"),
      ...(toolOutputSchema("get_pool") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("get_pool") }),
    },
    async (input) =>
      toolResult(() =>
        getPool(env, {
          chainId: canonicalChainId(input.chain_id),
          coreAddress: input.core_address,
          poolId: input.pool_id,
        }),
      ),
  );

  server.registerTool(
    catalogEntry("get_pool_liquidity").name,
    {
      title: catalogEntry("get_pool_liquidity").title,
      description: catalogEntry("get_pool_liquidity").description,
      inputSchema: getPoolLiquiditySchema,
      annotations: toolAnnotations("get_pool_liquidity"),
      ...(toolOutputSchema("get_pool_liquidity") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("get_pool_liquidity") }),
    },
    async (input) =>
      toolResult(() =>
        getPoolLiquidity(env, {
          chainId: canonicalChainId(input.chain_id),
          coreAddress: input.core_address,
          poolId: input.pool_id,
        }),
      ),
  );

  server.registerTool(
    catalogEntry("list_pool_keys").name,
    {
      title: catalogEntry("list_pool_keys").title,
      description: catalogEntry("list_pool_keys").description,
      inputSchema: listPoolKeysSchema,
      annotations: toolAnnotations("list_pool_keys"),
      ...(toolOutputSchema("list_pool_keys") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("list_pool_keys") }),
    },
    async (input) =>
      toolResult(() =>
        listPoolKeys(env, {
          chainId: canonicalChainId(input.chain_id),
          coreAddress: input.core_address,
          tokenA: input.token_a,
          tokenB: input.token_b,
          extension: input.extension,
          pageSize: input.page_size,
          afterPoolId: input.after_pool_id,
        }),
      ),
  );

  server.registerTool(
    catalogEntry("derive_pool_id").name,
    {
      title: catalogEntry("derive_pool_id").title,
      description: catalogEntry("derive_pool_id").description,
      inputSchema: derivePoolIdSchema,
      annotations: toolAnnotations("derive_pool_id"),
      ...(toolOutputSchema("derive_pool_id") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("derive_pool_id") }),
    },
    async (input) =>
      toolResult(() => derivePoolId(mapExactPoolKey(input.pool_key))),
  );

  server.registerTool(
    catalogEntry("decode_pool_config").name,
    {
      title: catalogEntry("decode_pool_config").title,
      description: catalogEntry("decode_pool_config").description,
      inputSchema: decodePoolConfigSchema,
      annotations: toolAnnotations("decode_pool_config"),
      ...(toolOutputSchema("decode_pool_config") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("decode_pool_config") }),
    },
    async ({ config }) =>
      toolResult(() => ({ decoded_config: decodePoolConfig(config as Hex) })),
  );

  server.registerTool(
    catalogEntry("get_position").name,
    {
      title: catalogEntry("get_position").title,
      description: catalogEntry("get_position").description,
      inputSchema: getPositionSchema,
      annotations: toolAnnotations("get_position"),
      ...(toolOutputSchema("get_position") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("get_position") }),
    },
    async (input) =>
      toolResult(() =>
        getPosition(env, {
          owner: input.owner,
          chainId: canonicalChainId(input.chain_id),
          positionsAddress: input.positions_address,
          tokenId: input.token_id,
        }),
      ),
  );

  server.registerTool(
    catalogEntry("get_position_pool_candidates").name,
    {
      title: catalogEntry("get_position_pool_candidates").title,
      description: catalogEntry("get_position_pool_candidates").description,
      inputSchema: getPositionPoolCandidatesSchema,
      annotations: toolAnnotations("get_position_pool_candidates"),
      ...(toolOutputSchema("get_position_pool_candidates") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("get_position_pool_candidates") }),
    },
    async (input) =>
      toolResult(() =>
        getPositionPoolCandidates(env, {
          chainId: canonicalChainId(input.chain_id),
          tokenA: input.token_a,
          tokenB: input.token_b,
          minTvlUsd: input.min_tvl_usd,
          coreAddress: input.core_address,
          extension: input.extension,
          poolType: input.pool_type,
        }),
      ),
  );

  server.registerTool(
    catalogEntry("prepare_lp_position_deposit").name,
    {
      title: catalogEntry("prepare_lp_position_deposit").title,
      description: catalogEntry("prepare_lp_position_deposit").description,
      inputSchema: prepareLpPositionDepositSchema,
      annotations: toolAnnotations("prepare_lp_position_deposit"),
      ...(toolOutputSchema("prepare_lp_position_deposit") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("prepare_lp_position_deposit") }),
    },
    async (input) =>
      toolResult(() =>
        prepareLpPositionDeposit(env, {
          chainId: canonicalChainId(input.chain_id),
          sender: input.sender,
          coreAddress: input.core_address,
          poolId: input.pool_id,
          poolKey:
            input.pool_key === undefined
              ? undefined
              : mapEncodedPoolKey(input.pool_key),
          poolInitialized: input.pool_initialized,
          mode: input.mode,
          tokenId: input.token_id,
          tickLower: input.tick_lower,
          tickUpper: input.tick_upper,
          initialTick: input.initial_tick,
          maxAmount0: input.max_amount0,
          maxAmount1: input.max_amount1,
          slippageBps: input.slippage_bps,
          country,
        }),
      ),
  );

  server.registerTool(
    catalogEntry("prepare_lp_position_earnings_claim").name,
    {
      title: catalogEntry("prepare_lp_position_earnings_claim").title,
      description: catalogEntry("prepare_lp_position_earnings_claim").description,
      inputSchema: prepareLpPositionEarningsClaimSchema,
      annotations: toolAnnotations("prepare_lp_position_earnings_claim"),
      ...(toolOutputSchema("prepare_lp_position_earnings_claim") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("prepare_lp_position_earnings_claim") }),
    },
    async (input) =>
      toolResult(() =>
        prepareLpPositionEarningsClaim(env, {
          chainId: canonicalChainId(input.chain_id),
          sender: input.sender,
          positionsAddress: input.positions_address,
          tokenId: input.token_id,
          recipient: input.recipient,
        }),
      ),
  );

  server.registerTool(
    catalogEntry("prepare_lp_position_withdraw").name,
    {
      title: catalogEntry("prepare_lp_position_withdraw").title,
      description: catalogEntry("prepare_lp_position_withdraw").description,
      inputSchema: prepareLpPositionWithdrawSchema,
      annotations: toolAnnotations("prepare_lp_position_withdraw"),
      ...(toolOutputSchema("prepare_lp_position_withdraw") === undefined
        ? {}
        : { outputSchema: toolOutputSchema("prepare_lp_position_withdraw") }),
    },
    async (input) =>
      toolResult(() =>
        prepareLpPositionWithdraw(env, {
          chainId: canonicalChainId(input.chain_id),
          sender: input.sender,
          withdrawals: input.withdrawals.map((withdrawal) => ({
            positionsAddress: withdrawal.positions_address,
            tokenId: withdrawal.token_id,
            liquidity: withdrawal.liquidity,
            recipient: withdrawal.recipient,
          })),
        }),
      ),
  );

  registerCatalogTool("prepare_wrap_unwrap", prepareWrapUnwrapSchema, (input) =>
    prepareWrapUnwrap({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      direction: input.direction,
      amount: input.amount,
    }),
  );

  registerCatalogTool("prepare_transfers", prepareTransfersSchema, (input) =>
    prepareTransfers({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      transfers: input.transfers.map((transfer) => {
        switch (transfer.kind) {
          case "native":
            return transfer;
          case "erc20":
            return transfer;
          case "erc721":
            return {
              kind: transfer.kind,
              token: transfer.token,
              recipient: transfer.recipient,
              tokenId: transfer.token_id,
              safe: transfer.safe,
              data: transfer.data as Hex | undefined,
            };
          case "erc1155":
            return {
              kind: transfer.kind,
              token: transfer.token,
              recipient: transfer.recipient,
              tokenId: transfer.token_id,
              amount: transfer.amount,
              safe: transfer.safe,
              data: transfer.data as Hex,
            };
        }
      }),
    }),
  );

  registerCatalogTool("prepare_lp_position_transfer", prepareLpPositionTransferSchema, (input) =>
    prepareLpPositionTransfer(env, {
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      positionsAddress: input.positions_address,
      tokenId: input.token_id,
      recipient: input.recipient,
    }),
  );

  registerCatalogTool("prepare_fix_pool_price", prepareFixPoolPriceSchema, (input) =>
    prepareFixPoolPrice(env, {
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      coreAddress: input.core_address,
      poolId: input.pool_id,
      baseToken: input.base_token,
      targetPrice: input.target_price,
      pendingCurrentSqrtRatio: input.pending_current_sqrt_ratio,
      quoteResult:
        input.quote_result === undefined
          ? undefined
          : {
              specifiedToken: input.quote_result.specified_token,
              calculatedToken: input.quote_result.calculated_token,
              specifiedAmount: input.quote_result.specified_amount,
              calculatedAmount: input.quote_result.calculated_amount,
              blockNumber: input.quote_result.block_number,
              blockHash: input.quote_result.block_hash as Hex | undefined,
            },
      country,
    }),
  );

  registerCatalogTool("prepare_twamm_order", prepareTwammOrderSchema, (input) => {
    const chainId = canonicalChainId(input.chain_id);
    assertAssetsTradable(
      [
        { chainId, token: input.sell_token },
        { chainId, token: input.buy_token },
      ],
      country,
    );
    return prepareTwammOrder({
      chainId,
      sender: input.sender,
      sellToken: input.sell_token,
      buyToken: input.buy_token,
      orders: input.orders.map((order) => ({
        fee: order.fee,
        startTime: order.start_time,
        endTime: order.end_time,
        amount: order.amount,
      })),
      pendingTimestamp: input.pending_timestamp,
      deadlineSeconds: input.deadline_seconds,
      salt: input.salt as Hex | undefined,
    });
  });

  registerCatalogTool("prepare_twamm_order_collection", prepareTwammOrderCollectionSchema, (input) =>
    prepareTwammOrderCollection({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      ordersAddress: input.orders_address,
      tokenId: input.token_id,
      orderKeys: input.order_keys.map(mapEncodedPoolKey),
    }),
  );

  registerCatalogTool("prepare_twamm_order_stop", prepareTwammOrderStopSchema, (input) =>
    prepareTwammOrderStop({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      ordersAddress: input.orders_address,
      tokenId: input.token_id,
      pendingTimestamp: input.pending_timestamp,
      orders: input.orders.map((order) => ({
        orderKey: mapEncodedPoolKey(order.order_key),
        endTime: order.end_time,
        saleRate: order.sale_rate,
      })),
    }),
  );

  registerCatalogTool("prepare_twamm_virtual_orders", prepareTwammVirtualOrdersSchema, (input) =>
    prepareExecuteTwammVirtualOrders({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      poolKey: mapEncodedPoolKey(input.pool_key),
    }),
  );

  registerCatalogTool("prepare_auction_create", prepareAuctionCreateSchema, (input) => {
    const chainId = canonicalChainId(input.chain_id);
    assertAssetsTradable(
      [
        { chainId, token: input.sell_token },
        { chainId, token: input.buy_token },
      ],
      country,
    );
    return prepareAuctionCreate({
      chainId,
      sender: input.sender,
      sellToken: input.sell_token,
      buyToken: input.buy_token,
      sellAmount: input.sell_amount,
      creatorFeeQ32: input.creator_fee_q32,
      minBoostDuration: input.min_boost_duration,
      graduationPoolFeeQ64: input.graduation_pool_fee_q64,
      graduationPoolTickSpacing: input.graduation_pool_tick_spacing,
      startTime: input.start_time,
      auctionDuration: input.auction_duration,
      salt: input.salt as Hex,
    });
  });

  registerCatalogTool("prepare_auction_complete", prepareAuctionCompleteSchema, (input) =>
    prepareAuctionComplete({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      tokenId: input.token_id,
      auctionKey: mapEncodedPoolKey(input.auction_key),
      graduationPoolInitialized: input.graduation_pool_initialized,
      launchPoolTick: input.launch_pool_tick,
    }),
  );

  registerCatalogTool("prepare_auction_creator_proceeds", prepareAuctionCreatorProceedsSchema, (input) =>
    prepareAuctionCreatorProceeds({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      tokenId: input.token_id,
      auctionKey: mapEncodedPoolKey(input.auction_key),
    }),
  );

  registerCatalogTool("prepare_manual_pool_boost", prepareManualPoolBoostSchema, (input) =>
    prepareManualPoolBoost({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      poolKey: mapEncodedPoolKey(input.pool_key),
      startTime: input.start_time,
      endTime: input.end_time,
      amount0: input.amount0,
      amount1: input.amount1,
    }),
  );

  registerCatalogTool("prepare_oracle_capacity_expansion", prepareOracleCapacityExpansionSchema, (input) => {
    const chainId = canonicalChainId(input.chain_id);
    assertAssetsTradable([{ chainId, token: input.token }], country);
    return prepareOracleCapacityExpansion({
      chainId,
      sender: input.sender,
      token: input.token,
      minCapacity: input.min_capacity,
    });
  });

  registerCatalogTool("prepare_approval_revocations", prepareApprovalRevocationsSchema, (input) =>
    prepareApprovalRevocations({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      approvals: input.approvals,
    }),
  );

  registerCatalogTool("prepare_old_gekubo_unwrap", prepareOldGekuboUnwrapSchema, (input) =>
    prepareOldGekuboUnwrap({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      amount: input.amount,
    }),
  );

  registerCatalogTool("get_rewards_claims_by_owner", getRewardsClaimsByOwnerSchema, (input) =>
    getRewardsClaimsByOwner(env, { owner: input.owner }),
  );

  registerCatalogTool("prepare_rewards_claim", prepareRewardsClaimSchema, (input) =>
    prepareRewardsClaim({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      claims: input.claims.map((claim) => ({
        dropAddress: claim.drop_address,
        key: {
          owner: claim.key.owner,
          token: claim.key.token,
          root: claim.key.root as Hex,
        },
        claim: claim.claim,
        proof: claim.proof as Hex[],
      })),
    }),
  );

  registerCatalogTool("prepare_revenue_buybacks", prepareRevenueBuybacksSchema, (input) =>
    prepareRevenueBuybacks({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      endedOrderCollects: input.ended_order_collects.map((item) => ({
        sellToken: item.sell_token,
        fee: item.fee,
        endTime: item.end_time,
      })),
      protocolFeePairs: input.protocol_fee_pairs,
      rollTokens: input.roll_tokens,
    }),
  );

  registerCatalogTool("prepare_ve33_increase_stake", prepareVe33IncreaseStakeSchema, (input) =>
    prepareVe33IncreaseStake({
      chainId: canonicalChainId(input.chain_id),
      veToken: input.ve_token as Address,
      sender: input.sender as Address,
      stakeToken: input.stake_token as Address,
      veId: input.ve_id,
      amount: input.amount,
    }),
  );

  registerCatalogTool("prepare_ve33_merge", prepareVe33MergeSchema, (input) =>
    prepareVe33Merge({
      chainId: canonicalChainId(input.chain_id),
      veToken: input.ve_token as Address,
      sender: input.sender as Address,
      destinationVeId: input.destination_ve_id,
      destinationPoolKey:
        input.destination_pool_key === undefined
          ? undefined
          : mapPoolKey(input.destination_pool_key),
      sources: input.sources.map((source) => ({
        veId: source.ve_id,
        currentPoolKey:
          source.current_pool_key === undefined
            ? undefined
            : mapPoolKey(source.current_pool_key),
      })),
      resultingVote:
        input.resulting_vote === undefined
          ? undefined
          : input.resulting_vote === null
            ? null
            : {
                poolKey: mapPoolKey(input.resulting_vote.pool_key),
                swapFee: input.resulting_vote.swap_fee,
              },
    }),
  );

  registerCatalogTool("prepare_ve33_withdraw", prepareVe33WithdrawSchema, (input) =>
    prepareVe33Withdraw({
      chainId: canonicalChainId(input.chain_id),
      veToken: input.ve_token as Address,
      sender: input.sender as Address,
      veId: input.ve_id,
      currentPoolKey:
        input.current_pool_key === undefined
          ? undefined
          : mapPoolKey(input.current_pool_key),
    }),
  );

  registerCatalogTool("get_liquidity_opportunities", getLiquidityOpportunitiesSchema, (input) =>
    getLiquidityOpportunities(env, {
      chainId:
        input.chain_id === undefined
          ? undefined
          : canonicalChainId(input.chain_id),
      types: input.types as LiquidityOpportunityType[],
      token: input.token,
      minApr: input.min_apr,
      limit: input.limit,
      ve33EmissionState:
        input.ve33_emission_state === undefined
          ? undefined
          : {
              currentTimestamp: input.ve33_emission_state.current_timestamp,
              currentEmissionRate:
                input.ve33_emission_state.current_emission_rate,
              totalRemainingEmissions:
                input.ve33_emission_state.total_remaining_emissions,
            },
    }),
  );

  registerCatalogTool("prepare_pool_initialization", preparePoolInitializationSchema, (input) =>
    preparePoolInitialization({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      coreAddress: input.core_address,
      poolKey: mapEncodedPoolKey(input.pool_key),
      initialTick: input.initial_tick,
    }),
  );

  registerCatalogTool("get_aave_v3_markets", getAaveV3MarketsSchema, (input) =>
    getAaveV3Markets({
      chainId:
        input.chain_id === undefined
          ? undefined
          : canonicalChainId(input.chain_id),
    }),
  );

  registerCatalogTool(
    "prepare_aave_v3_supply",
    prepareAaveV3SupplySchema,
    (input) =>
      prepareAaveV3Supply({
        chainId: canonicalChainId(input.chain_id),
        sender: input.sender,
        asset: input.asset,
        amount: input.amount,
        onBehalfOf: input.on_behalf_of,
      }),
  );

  registerCatalogTool(
    "prepare_aave_v3_withdraw",
    prepareAaveV3WithdrawSchema,
    (input) =>
      prepareAaveV3Withdraw({
        chainId: canonicalChainId(input.chain_id),
        sender: input.sender,
        asset: input.asset,
        amount: input.amount,
        recipient: input.recipient,
      }),
  );

  registerCatalogTool(
    "prepare_aave_v3_borrow",
    prepareAaveV3BorrowSchema,
    (input) =>
      prepareAaveV3Borrow({
        chainId: canonicalChainId(input.chain_id),
        sender: input.sender,
        asset: input.asset,
        amount: input.amount,
        onBehalfOf: input.on_behalf_of,
      }),
  );

  registerCatalogTool(
    "prepare_aave_v3_repay",
    prepareAaveV3RepaySchema,
    (input) =>
      prepareAaveV3Repay({
        chainId: canonicalChainId(input.chain_id),
        sender: input.sender,
        asset: input.asset,
        amount: input.amount,
        onBehalfOf: input.on_behalf_of,
        fundingSource: input.funding_source,
      }),
  );

  registerCatalogTool(
    "prepare_aave_v3_collateral",
    prepareAaveV3CollateralSchema,
    (input) =>
      prepareAaveV3Collateral({
        chainId: canonicalChainId(input.chain_id),
        sender: input.sender,
        asset: input.asset,
        useAsCollateral: input.use_as_collateral,
      }),
  );

  registerCatalogTool(
    "prepare_aave_v3_emode",
    prepareAaveV3EModeSchema,
    (input) =>
      prepareAaveV3EMode({
        chainId: canonicalChainId(input.chain_id),
        sender: input.sender,
        categoryId: input.category_id,
      }),
  );

  registerCatalogTool("get_morpho_vaults", getMorphoVaultsSchema, (input) =>
    getMorphoVaults({
      chainId: input.chain_id === undefined ? undefined : canonicalChainId(input.chain_id),
    }),
  );
  registerCatalogTool(
    "prepare_morpho_vault_deposit",
    prepareMorphoVaultDepositSchema,
    (input) =>
      prepareMorphoVaultDeposit({
        chainId: canonicalChainId(input.chain_id),
        sender: input.sender,
        vault: input.vault,
        amount: input.amount,
        maxSharePriceRay: input.max_share_price_ray,
        recipient: input.recipient,
      }),
  );
  registerCatalogTool(
    "prepare_morpho_vault_withdraw",
    prepareMorphoVaultWithdrawSchema,
    (input) =>
      prepareMorphoVaultWithdraw({
        chainId: canonicalChainId(input.chain_id),
        sender: input.sender,
        vault: input.vault,
        amount: input.amount,
        recipient: input.recipient,
        owner: input.owner,
      }),
  );
  registerCatalogTool(
    "prepare_morpho_vault_redeem",
    prepareMorphoVaultRedeemSchema,
    (input) =>
      prepareMorphoVaultRedeem({
        chainId: canonicalChainId(input.chain_id),
        sender: input.sender,
        vault: input.vault,
        shares: input.shares,
        recipient: input.recipient,
        owner: input.owner,
      }),
  );

  registerCatalogTool("get_sky_savings_deployment", getSkySavingsDeploymentSchema, () =>
    getSkySavingsDeployment(),
  );
  registerCatalogTool(
    "prepare_sky_savings_deposit",
    prepareSkySavingsDepositSchema,
    (input) =>
      prepareSkySavingsDeposit({
        chainId: canonicalChainId(input.chain_id),
        sender: input.sender,
        amount: input.amount,
        receiver: input.receiver,
      }),
  );
  registerCatalogTool(
    "prepare_sky_savings_withdraw",
    prepareSkySavingsWithdrawSchema,
    (input) =>
      prepareSkySavingsWithdraw({
        chainId: canonicalChainId(input.chain_id),
        sender: input.sender,
        amount: input.amount,
        receiver: input.receiver,
        owner: input.owner,
      }),
  );
  registerCatalogTool(
    "prepare_sky_savings_redeem",
    prepareSkySavingsRedeemSchema,
    (input) =>
      prepareSkySavingsRedeem({
        chainId: canonicalChainId(input.chain_id),
        sender: input.sender,
        shares: input.shares,
        receiver: input.receiver,
        owner: input.owner,
      }),
  );

  registerCatalogTool("get_merkl_deployment", getMerklDeploymentSchema, (input) =>
    getMerklDeployment({
      chainId:
        input.chain_id === undefined
          ? undefined
          : canonicalChainId(input.chain_id),
    }),
  );
  registerCatalogTool("prepare_merkl_claim", prepareMerklClaimSchema, (input) =>
    prepareMerklClaim({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      rewards: input.rewards,
    }),
  );

  registerCatalogTool(
    "get_aerodrome_deployment",
    getAerodromeDeploymentSchema,
    (input) =>
      getAerodromeDeployment({
        chainId:
          input.chain_id === undefined
            ? undefined
            : canonicalChainId(input.chain_id),
      }),
  );
  registerCatalogTool(
    "prepare_aerodrome_sugar_reads",
    prepareAerodromeSugarReadsSchema,
    (input) =>
      prepareAerodromeSugarReads({
        chainId: canonicalChainId(input.chain_id),
        dataset: input.dataset,
        account: input.account,
        pool: input.pool,
        venftId: input.venft_id,
        limit: input.limit,
        offset: input.offset,
      }),
  );
  registerCatalogTool(
    "prepare_aerodrome_liquidity_deposit",
    prepareAerodromeLiquidityDepositSchema,
    (input) =>
      prepareAerodromeLiquidityDeposit({
        chainId: canonicalChainId(input.chain_id),
        sender: input.sender,
        tokenA: input.token_a,
        tokenB: input.token_b,
        stable: input.stable,
        amountADesired: input.amount_a_desired,
        amountBDesired: input.amount_b_desired,
        amountAMin: input.amount_a_min,
        amountBMin: input.amount_b_min,
        deadline: input.deadline,
        recipient: input.recipient,
      }),
  );
  registerCatalogTool(
    "prepare_aerodrome_liquidity_withdraw",
    prepareAerodromeLiquidityWithdrawSchema,
    (input) =>
      prepareAerodromeLiquidityWithdraw({
        chainId: canonicalChainId(input.chain_id),
        sender: input.sender,
        tokenA: input.token_a,
        tokenB: input.token_b,
        stable: input.stable,
        liquidity: input.liquidity,
        amountAMin: input.amount_a_min,
        amountBMin: input.amount_b_min,
        deadline: input.deadline,
        recipient: input.recipient,
        lpToken: input.lp_token,
      }),
  );
  registerCatalogTool(
    "prepare_aerodrome_gauge_deposit",
    prepareAerodromeGaugeDepositSchema,
    (input) =>
      prepareAerodromeGaugeDeposit({
        chainId: canonicalChainId(input.chain_id),
        sender: input.sender,
        gauge: input.gauge,
        amount: input.amount,
        lpToken: input.lp_token,
      }),
  );
  registerCatalogTool(
    "prepare_aerodrome_gauge_withdraw",
    prepareAerodromeGaugeWithdrawSchema,
    (input) =>
      prepareAerodromeGaugeWithdraw({
        chainId: canonicalChainId(input.chain_id),
        sender: input.sender,
        gauge: input.gauge,
        amount: input.amount,
      }),
  );
  registerCatalogTool(
    "prepare_aerodrome_gauge_claim",
    prepareAerodromeGaugeClaimSchema,
    (input) =>
      prepareAerodromeGaugeClaim({
        chainId: canonicalChainId(input.chain_id),
        sender: input.sender,
        gauge: input.gauge,
        account: input.account,
      }),
  );
  registerCatalogTool("prepare_aerodrome_lock", prepareAerodromeLockSchema, (input) =>
    prepareAerodromeLock({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      action: input.action,
      amount: input.amount,
      lockDuration: input.lock_duration,
      venftId: input.venft_id,
    }),
  );
  registerCatalogTool("prepare_aerodrome_vote", prepareAerodromeVoteSchema, (input) =>
    prepareAerodromeVote({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      venftId: input.venft_id,
      pools: input.pools,
      reset: input.reset,
    }),
  );
  registerCatalogTool(
    "prepare_aerodrome_incentive_claim",
    prepareAerodromeIncentiveClaimSchema,
    (input) =>
      prepareAerodromeIncentiveClaim({
        chainId: canonicalChainId(input.chain_id),
        sender: input.sender,
        venftId: input.venft_id,
        fees: input.fees,
        bribes: input.bribes,
        claimRebase: input.claim_rebase,
      }),
  );

  registerCatalogTool("get_lido_deployment", getLidoDeploymentSchema, () =>
    getLidoDeployment(),
  );
  registerCatalogTool("prepare_lido_stake", prepareLidoStakeSchema, (input) =>
    prepareLidoStake({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      amount: input.amount,
      referral: input.referral,
    }),
  );
  registerCatalogTool("prepare_lido_wrap", prepareLidoWrapSchema, (input) =>
    prepareLidoWrap({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      amount: input.amount,
    }),
  );
  registerCatalogTool("prepare_lido_unwrap", prepareLidoUnwrapSchema, (input) =>
    prepareLidoUnwrap({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      amount: input.amount,
    }),
  );
  registerCatalogTool(
    "prepare_lido_withdrawal_request",
    prepareLidoWithdrawalRequestSchema,
    (input) =>
      prepareLidoWithdrawalRequest({
        chainId: canonicalChainId(input.chain_id),
        sender: input.sender,
        amounts: input.amounts,
        owner: input.owner,
      }),
  );
  registerCatalogTool(
    "prepare_lido_withdrawal_claim",
    prepareLidoWithdrawalClaimSchema,
    (input) =>
      prepareLidoWithdrawalClaim({
        chainId: canonicalChainId(input.chain_id),
        sender: input.sender,
        requestId: input.request_id,
      }),
  );

  server.registerResource(
    "ekubo-agent-workflow",
    "ekubo://docs/agent-workflow",
    {
      title: "Safe Ekubo swap and bridge workflow",
      description:
        "Canonical token lookup, quote, preparation, wallet simulation, authorization, and submission sequence",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: AGENT_WORKFLOW,
        },
      ],
    }),
  );

  for (const skill of PROTOCOL_SKILLS) {
    server.registerResource(
      `protocol-skill-${skill.name}`,
      `ekubo://skills/${skill.name}`,
      {
        title: skill.title,
        description: skill.description,
        mimeType: "text/markdown",
      },
      async (uri) => ({
        contents: [
          { uri: uri.href, mimeType: "text/markdown", text: skill.skill },
        ],
      }),
    );
    server.registerResource(
      `protocol-skill-${skill.name}-discovery`,
      `ekubo://skills/${skill.name}/references/discovery.md`,
      {
        title: `${skill.title} direct discovery reference`,
        description: `Official endpoints and wallet reads used by ${skill.name}`,
        mimeType: "text/markdown",
      },
      async (uri) => ({
        contents: [
          { uri: uri.href, mimeType: "text/markdown", text: skill.reference },
        ],
      }),
    );
  }

  server.registerResource(
    "ekubo-lp-position-workflow",
    "ekubo://docs/lp-position-workflow",
    {
      title: "Ekubo LP position data and onchain state workflow",
      description:
        "How to combine indexed position data, token USD prices, position history, and atomic pending eth_call state exactly as the interface does",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: LP_POSITION_WORKFLOW,
        },
      ],
    }),
  );

  server.registerResource(
    "ekubo-quoter-contract",
    "ekubo://docs/quoter-api",
    {
      title: "Ekubo aggregated quote contract",
      description:
        "Ekubo, 0x, Across, LayerZero, and LI.FI quote semantics used by MCP tools",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: QUOTER_API,
        },
      ],
    }),
  );

  server.registerResource(
    "ekubo-execution-plan",
    "ekubo://docs/execution-plan",
    {
      title: "Ekubo execution plan handoff",
      description:
        "Signer-neutral prepared-plan execution through preferred wallet tooling, with Cast as an optional fallback",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: EXECUTION_PLAN_WORKFLOW,
        },
      ],
    }),
  );

  server.registerResource(
    "ekubo-api-openapi",
    "https://prod-api.ekubo.org/openapi.json",
    {
      title: "Ekubo data API OpenAPI",
      description: "Canonical public token and protocol-data HTTP contract",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: await fetchDocumentation(uri.href),
        },
      ],
    }),
  );

  server.registerResource(
    "ekubo-ve33-workflow",
    "ekubo://docs/ve33-workflow",
    {
      title: "Ekubo ve(3,3) call workflow",
      description:
        "STONX allocation lookup plus fee-preserving VeToken vote changes, splits, extensions, claims, and reinvestment",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: VE33_WORKFLOW,
        },
      ],
    }),
  );

  server.registerResource(
    "ekubo-evm-contract-directory",
    CONTRACT_DIRECTORY_URI,
    {
      title: "Ekubo EVM contract directory",
      description:
        "Chain-indexed deployed contract addresses for actions that are not exposed as first-class MCP tools",
      mimeType: "application/json",
    },
    async (uri) => jsonResource(uri, contractDirectory()),
  );

  server.registerResource(
    "ekubo-evm-contracts-by-chain",
    new ResourceTemplate(CONTRACT_CHAIN_TEMPLATE, {
      list: undefined,
      complete: {
        chain_id: (value) => contractChainCompletions(value),
      },
    }),
    {
      title: "Ekubo EVM deployments by chain",
      description:
        "Address-to-contract map for one EVM chain; read an address resource to obtain its ABI",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const chainId = templateValue(variables.chain_id);
      const resource =
        chainId === undefined ? undefined : contractChainResource(chainId);
      if (resource === undefined) throw new ResourceNotFoundError(uri.href);
      return jsonResource(uri, resource);
    },
  );

  server.registerResource(
    "ekubo-evm-contract-by-address",
    new ResourceTemplate(CONTRACT_ADDRESS_TEMPLATE, {
      list: undefined,
      complete: {
        chain_id: (value) => contractChainCompletions(value),
        address: (value, context) =>
          contractAddressCompletions(context?.arguments?.chain_id, value),
      },
    }),
    {
      title: "Ekubo EVM contract ABI",
      description:
        "Deployment metadata and ABI for one exact chain and contract address, including VeToken destructive-action guidance",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const chainId = templateValue(variables.chain_id);
      const contractAddress = templateValue(variables.address);
      const resource =
        chainId === undefined || contractAddress === undefined
          ? undefined
          : contractAddressResource(chainId, contractAddress);
      if (resource === undefined) throw new ResourceNotFoundError(uri.href);
      return jsonResource(uri, resource);
    },
  );

  return server;
}

function jsonResource(uri: URL, value: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function templateValue(value: string | string[]): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function toolResult(run: () => unknown | Promise<unknown>) {
  try {
    const result = await run();
    const structuredContent = asRecord(result);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(structuredContent) },
      ],
      structuredContent,
    };
  } catch (error) {
    const details = error instanceof ServiceError ? error.details : undefined;
    const structuredContent = {
      error: {
        code: error instanceof ServiceError ? error.code : "unexpected_error",
        message: error instanceof Error ? error.message : String(error),
        ...(details === undefined ? {} : { details }),
      },
    };
    return {
      isError: true,
      content: [
        { type: "text" as const, text: JSON.stringify(structuredContent) },
      ],
      structuredContent,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { result: value };
}

function tokenAddress(
  identifier: string,
  expectedChainId: string,
  label: string,
): Address {
  if (identifier.startsWith("eip155:")) {
    const [, chainId, rawAddress] = identifier.split(":");
    if (chainId !== expectedChainId) {
      throw new ServiceError(
        "chain_mismatch",
        `${label} identifies eip155:${chainId}, expected eip155:${expectedChainId}`,
      );
    }
    return normalizeAddress(rawAddress);
  }
  return normalizeAddress(identifier);
}

function normalizeAddress(value: string): Address {
  return getAddress(numberToHex(BigInt(value), { size: 20 }));
}

function mapPoolKey(poolKey: {
  token0: string;
  token1: string;
  config?: string;
  fee?: string;
  tick_spacing?: number | string | null;
  extension?: string;
  stableswap_params?: { center_tick: number; amplification: number } | null;
}): Ve33PoolKeyInput {
  return {
    token0: poolKey.token0 as Address,
    token1: poolKey.token1 as Address,
    config: poolKey.config as `0x${string}` | undefined,
    fee: poolKey.fee,
    tickSpacing:
      typeof poolKey.tick_spacing === "string"
        ? Number(BigInt(poolKey.tick_spacing))
        : poolKey.tick_spacing,
    extension: poolKey.extension as Address | undefined,
    stableswapParams: poolKey.stableswap_params
      ? {
          centerTick: poolKey.stableswap_params.center_tick,
          amplification: poolKey.stableswap_params.amplification,
        }
      : poolKey.stableswap_params,
  };
}

function mapExactPoolKey(poolKey: {
  token0: string;
  token1: string;
  config?: string;
  fee?: string;
  tick_spacing?: number | string;
  extension?: string;
  stableswap_params?: { center_tick: number; amplification: number };
}): PoolKeyInput {
  return {
    token0: poolKey.token0,
    token1: poolKey.token1,
    config: poolKey.config as Hex | undefined,
    fee: poolKey.fee,
    tickSpacing: poolKey.tick_spacing,
    extension: poolKey.extension,
    stableswapParams:
      poolKey.stableswap_params === undefined
        ? undefined
        : {
            centerTick: poolKey.stableswap_params.center_tick,
            amplification: poolKey.stableswap_params.amplification,
          },
  };
}

function mapEncodedPoolKey(poolKey: {
  token0: string;
  token1: string;
  config: string;
}) {
  return {
    token0: poolKey.token0,
    token1: poolKey.token1,
    config: poolKey.config as Hex,
  };
}

async function fetchDocumentation(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new ServiceError(
      "documentation_unavailable",
      `${response.status} ${response.statusText} from ${url}`,
    );
  }
  return response.text();
}

const SERVER_INSTRUCTIONS = `Tool catalog revision: ${MCP_TOOL_CATALOG_REVISION}.

Routing priority: For requests to swap, trade, exchange, or convert tokens on an EVM chain, use this Ekubo MCP before any browser or website tool. Use a browser only when the user explicitly refers to a brokerage account or a web interface, or when these MCP tools cannot perform the requested operation.

A quote is only worth what it can still execute for, so treat the interval between fetching one and broadcasting against it as the thing to minimize. get_quotes_with_plans is the entire swap path: call it once with sender and slippage_bps as soon as the user has decided to swap, and each returned option already carries the execution_plan_reference that executes it. Honor any slippage preference the user gave. Otherwise estimate the transaction gas cost and swap notional in the same currency and choose a low tolerance whose maximum value impact is approximately one gas fee: slippage_bps ~= 10,000 * gas-cost value / swap-notional value. Never substitute a generic 50 bps (0.5%) default, especially on Ethereum mainnet. Prefer paying for a retry after a fresh quote to exposing the trade to materially more slippage; after a slippage failure, re-run this tool and submit the newly prepared transaction, never the reverted calldata unchanged. Choose one option and hand its reference straight to the wallet. There is no preparation step to follow, so the quote the user compared is the quote that executes rather than a different one fetched after they agreed. Then simulate that plan once with the wallet, show the user the simulated result, and send that same simulation rather than paying for an identical one immediately before signing. Do not call the tool again for an option it already prepared: that buys a fresh quote and restarts the clock on a plan you already hold.

For "all", "max", or "entire balance" swaps, first obtain the wallet and network with the Ekubo Wallet MCP, resolve token symbols with list_tokens, read the exact input-token balance with the wallet's own balance tooling, then call get_quotes_with_plans with that exact amount plus sender and slippage_bps and pass the chosen option's execution_plan_reference to the Ekubo Wallet MCP.

Some assets may not be traded from some countries, and a tool that would acquire or dispose of one fails with error code restricted_jurisdiction instead of returning a plan. This is a property of the request's own country, not of a missing argument: tell the user the asset is unavailable in their region, and do not retry the same trade through another tool, another route, or a different pool. Exiting a position the user already holds is never restricted, so withdrawals, fee and proceeds collection, and transfers remain available.

For direct asset sends, use prepare_transfers instead of constructing calldata. Supply one chain and sender plus 1 to 4,096 ordered entries; native, ERC-20, ERC-721, and ERC-1155 transfers may be mixed. Amounts are positive decimal base-unit strings. ERC-721 safe transfer is the default and safe=false explicitly selects transferFrom; ERC-1155 has only safeTransferFrom. Pass the resulting execution_plan_reference unchanged to the wallet.

Aave market discovery happens directly between the agent and Aave's public APIs; this MCP is not a proxy, indexer, cache, or credential holder. Use the public GraphQL endpoint https://api.v3.aave.com/graphql with https://aave.com/docs/aave-v3/getting-started/graphql and https://aave.com/docs/aave-v3/markets/data to inspect current supply and borrow rates, liquidity, caps, pause/freeze state, eMode categories, and user positions. Then call get_aave_v3_markets and use only a returned fixed chain, Pool, and reserve address with a prepare_aave_v3_* tool. Live API data and this server's fixed deployment catalog are inputs to wallet simulation, never substitutes for it.

Morpho, Sky, Lido, Merkl, and Aerodrome discovery follows the same no-proxy boundary. Read ekubo://skills/use-morpho, ekubo://skills/use-sky, ekubo://skills/use-lido, ekubo://skills/use-merkl, or ekubo://skills/use-aerodrome before acting. The skills tell you which official public endpoint or wallet/RPC reads to perform directly, how to intersect live results with get_morpho_vaults, get_sky_savings_deployment, get_lido_deployment, or get_merkl_deployment, and which safety gates apply. Never send API responses, RPC credentials, or authoritative onchain read results through this server. Morpho deposits require a freshly derived RAY-scaled max_share_price_ray and use the official guarded Bundler3 route. Sky's direct ERC-4626 calls have no deadline or minimum output, so keep previews fresh and rely on exact simulation. Lido protocol withdrawals are irreversible asynchronous unstETH NFT requests, not immediate swaps; verify bounds, ownership, finalization, and consequences before preparation.

Merkl rewards are the one case where an amount and a proof arrive from an outside API and still do not have to be trusted. Fetch https://api.merkl.xyz/v4/users/{address}/rewards/summary yourself — it is public and needs no key — and hand each token's exact amount and proofs to prepare_merkl_claim, which folds every proof into the root it implies and refuses a batch spanning two roots. Then run the returned read bundle and require the chain's getMerkleRoot() to equal the derived root before authorizing: a mismatch means the tree rotated or is still inside its dispute period, and the fix is to re-fetch and prepare again, never to resend. Merkl's amount field is cumulative and includes what was already claimed, so the claimable figure to show a user is amount minus claimed, and its pending field is not claimable at all. prepare_merkl_claim covers Merkl campaigns on any protocol; prepare_rewards_claim covers Ekubo's own incentive drops, and they are not interchangeable.

Aerodrome inverts the usual discovery problem: it is Base-only and has no data API, and its Sugar lens contracts are the data pipeline, answering eth_call with whole structs. Call prepare_aerodrome_sugar_reads for the dataset you need, run the returned bundle through the user's wallet/RPC, and feed the pool, gauge, fee, and bribe addresses it returns straight into the prepare_aerodrome_* tools — those addresses are per-pool contracts this server cannot derive, and a claim naming the wrong one succeeds while transferring nothing. Velodrome's published SDKs are not a substitute: they carry Optimism addresses and a position struct that has drifted from the deployed Base lens, so cross-check against get_aerodrome_deployment. Three protocol rules decide what is possible: a veNFT votes once per weekly epoch and a second attempt reverts with AlreadyVotedOrDeposited, a vote replaces the entire allocation rather than adding to it, and staking an LP token into a gauge trades that position's trading fees for AERO emissions rather than adding to them. Swaps stay with get_quotes_with_plans; prepare_aerodrome_gauge_claim collects an LP's emissions while prepare_aerodrome_incentive_claim collects a voter's fees and bribes, and they are not interchangeable.

Use Ekubo preparation tools only to construct unsigned plans. Every executable preparation returns execution_plan_reference: an artifact_reference envelope standing in for the stored plan body. One rule governs every handoff: pass the envelope unchanged as the wallet tool's reference argument. The wallet fetches the body itself, verifies its integrity digest and byte count, and refuses a mismatch, so the plan never travels through the agent. Never fetch, restate, paraphrase, or reconstruct the plan body yourself. Do not ask the user for a separate agent-level confirmation before invoking the wallet; that duplicates the wallet's authorization flow. The wallet must never construct calldata, choose a contract overload, derive a route, or determine the transaction list. Never construct or request transferOwnership, ownership handover, VeToken ERC721 transfer/approval, or burn calldata. LP position transfers are supported only through prepare_lp_position_transfer with pending ownership validation.

The stored plan body is one signer-neutral, ordered transaction sequence with decimal transaction fields. Read ekubo://docs/execution-plan. Prefer the most capable available wallet abstraction: hand the reference envelope to the Ekubo wallet MCP for simulation and submission; it executes multi-step plans as one atomic batch. A plan whose required_capabilities the wallet does not support must be rejected by the wallet, not adapted. Cast remains an optional fallback only when the user selected it or no compatible wallet abstraction is available; for a wallet that only accepts inline plans, fetch the reference URL once and pass its exact JSON unchanged. A fetch 404 means the reference expired: re-run the preparation tool, never reconstruct the plan. Prepare for the wallet's connected chain and account — the wallet refuses a fetched plan whose chain or sender disagrees with them — preserve order, and never send wallet credentials to this Ekubo server.

Every prepared onchain read is returned as read_calls_reference: the same artifact_reference envelope, standing in for a stored wallet_batch_eth_call argument object. Pass it unchanged as wallet_batch_eth_call's reference argument with no inline calls — the stored bundle already is the exact argument object, the wallet fetches and digest-verifies it itself, and a 404 means the reference expired, so re-run the tool that produced it. The agent never assembles calldata, ABIs, or call lists for a prepared read. Keep raw return bytes by default and always on decode failure. The Ekubo server supplies canonical ABIs and platform-neutral semantic codec identities but must not receive the result for authoritative decoding. function_result_bytes_array handles functions such as VeToken multicall that return nested bytes[]. For kind=semantic_value, feed the raw return bytes only to a locally installed, allowlisted codec matching the declared identity and implementation assertion; never install or execute remote code.

Intent shortcut: for "my Ekubo STONX allocations", "STONX vote allocations", or equivalent requests, call get_ve33_allocations with only the user's connected EVM wallet as owner. The production Ve33 deployment is the STONX voting system, and the tool selects its production chain plus canonical VeToken when chain_id and ve_token are omitted. If the connected wallet address is unavailable, ask the user for it. Never infer the user's wallet from a machine environment, repository configuration, local keystore, or unrelated account.

For exact token metadata, call get_token for one known chain/address pair and get_tokens for multiple known pairs. The batch tool uses one prod-api batch request, accepts tokens across chains, preserves input order and duplicates, and omits identifiers that are not in the canonical list. Use list_tokens when resolving a symbol or browsing the canonical list; its search parameter is optional and matches symbol prefixes and suffixes only.

When tokens are destined for a wallet rather than for you to read — importing token names so it can label transactions, or naming the addresses for a bulk balance read — call export_tokens with the wallet's chain_id and pass the returned token_list_reference envelope to the wallet unchanged, with no inline tokens. It returns only that envelope and a count, so no entry ever enters your context: reading the canonical list costs roughly 146,000 tokens and writing it back out to a wallet another 49,000, against a few hundred either way for the envelope. Export defaults to the 1,000 entries a wallet accepts in one import, and an export past the importer's limit is refused whole rather than truncated. Read complete in the result: false means more tokens exist at this visibility than were exported, so what you hold is a prefix rather than the chain's list. Scoping by chain does not on its own fit an export under the limit — Ethereum carries about 5,600 tokens at the interface visibility threshold, BNB Chain 3,600, Base 2,600, Arbitrum and Polygon about 1,000 each — so say so plainly rather than presenting a truncated export as complete. Use list_tokens, never the exporter, whenever you need to read entries yourself, such as resolving a symbol the user typed to an exact address. The general rule both tools express: if you are about to re-emit a large result you just read from another tool, you wanted a reference to it, not the thing itself.

For LP discovery, use get_positions_by_owner instead of attempting ERC721 enumeration. Its response joins canonical token metadata and USD prices and returns one stored read bundle per chain covering every supported EVM position, with each position row linked to its aggregate call by state_call_id. For the interface-equivalent detail payload (metadata, history, campaigns, rewards, prices, and the atomic current-state query), call get_position with the same owner, chain, manager, and token ID. Read ekubo://docs/lp-position-workflow. Never split TWAMM execution or Ve33 reward accumulation from the following position read: those calls must stay in the supplied single Multicall3 eth_call and must never be broadcast.

When the user asks where to provide liquidity, call get_liquidity_opportunities before asking them to choose a pair. It mirrors the interface's boosted-fee, active-incentive, and projected Ve33-emission opportunity feed, ranks by APR, and returns exact actionable pools or a pair-level pool-candidate handoff. APR is an annualized snapshot, not guaranteed yield; show its components, denominator, data freshness, range and impermanent-loss risks. If ranking_complete=false, execute local_read_requirement through the user's wallet, decode it locally, and call the tool again with ve33_emission_state before presenting the ordering as final. Never ask this server to decode the raw onchain result; supply only the locally decoded decimal fields needed for projection.

For creating an LP position, call get_position_pool_candidates with the pair. Do not browse prod-api, manually derive pool IDs, or inspect manager ABIs. Show the candidate's Core generation, exact pool key, extension, manager, TVL, depth, volume, and fees. If the user selects a new configuration not yet indexed, normally pass its exact pool_key with pool_initialized=false and initial_tick to prepare_lp_position_deposit; the tool derives the pool ID and prepends maybeInitializePool as its own step before the deployed mintAndDeposit call, which the wallet executes as one atomic batch. Use prepare_pool_initialization only when the user explicitly needs initialization as a separate transaction. If the wallet lacks one side, prepare and execute that funding swap separately, wait for its successful receipt, measure the actual new token balance, reserve native gas, and only then prepare the deposit from the measured available amounts; never treat a quote's expected output as a settled balance. The deposit tool computes a nonzero minimum liquidity, approvals, initialization, native refund, allowance cleanup, decoded calls, and a complete plan delivered as execution_plan_reference.

For “collect my LP fees” or “claim my LP rewards”, call prepare_lp_position_earnings_claim with the connected owner wallet, manager, and token ID from get_positions_by_owner. It automatically uses v2 zero-liquidity fee withdrawal, v3 collectFees, or Ve33 claimRewards and never removes liquidity, burns, or transfers the NFT. Execute its current_state_query by passing its read_calls_reference unchanged to wallet_batch_eth_call. Require every inner call to succeed, compare the decoded owner with expected_owner, retain raw return data, and pass the decoded fees or rewards plus execution_plan_reference to the wallet for simulation and authorization. Never infer or manually encode the manager function.

For partial or full LP withdrawals, execute each position's current_state_query through its read_calls_reference, then select an exact positive liquidity amount no greater than that position's decoded liquidity. Require every inner call to succeed, compare decoded owner with expected_owner, and retain raw return data. Then call prepare_lp_position_withdraw with a withdrawals array of up to 100 positions. It automatically chooses each correct v2/v3 withdraw overload or Ve33 withdrawAndClaimRewards, collects fees or rewards exactly as the interface does, and returns the entire transaction list. Include every principal/earnings estimate and recipient in the wallet handoff, and give the unchanged execution_plan_reference envelope to the wallet MCP. The wallet may batch unrelated position calls into one transaction but must never construct calldata, choose an overload, or add a claim transaction.

Pass LP execution plans to the wallet MCP for simulation, wallet-owned authorization, and execution; never use Cast to reconstruct LP calldata. Do not insert a separate agent confirmation step. If wallet policy rejects a plan, report the wallet's exact finding verbatim and do not attempt to change wallet policy; proposing a policy change is the wallet's own tool to offer, not this server's.

For every other EVM action exposed by the interface, use its first-class prepare tool: wrap/unwrap, LP position transfer, phased pool price correction through prepare_fix_pool_price, standalone pool initialization through prepare_pool_initialization, TWAMM/DCA creation/collection/stop/virtual-order execution, auction creation/completion/creator proceeds, manual boosts, oracle capacity, approval revocation, old gEKUBO unwrap, incentive rewards, revenue buybacks, and direct VeToken increase/merge/withdraw. Phased tools return exact eth_call requests and tell the caller which decoded values to send back. Wallets must not invent calldata, append approvals, build multicalls, or choose transaction ordering.

Use get_pool for one exact chain/core/pool ID and get_pool_liquidity for tick-level depth. Use list_pool_keys to enumerate a Core deployment's initialized pools with keyset pagination (after_pool_id, ascending pool_id order) and token/pair/extension filters; every returned pool_id is re-derived locally from its PoolKey before it is reported. get_pool returns the latest indexed pool_state snapshot plus current_state_query, whose read_calls_reference the wallet executes for fresh on-chain sqrtRatio, tick, and liquidity. Use derive_pool_id and decode_pool_config for PoolKey construction and inspection. A pool fee is an exact uint64 Q64 integer: accept and return it only as a decimal or hexadecimal string, never a JSON number.

For VeToken vote reorganization, first call get_ve33_allocations and show the owner, state_id, total applied vote weight, every pool allocation, and contributing ve_ids. Pass that exact state_id to prepare_ve33_reallocation. Never construct raw vote, clearVote, extendStake, mergeStakes, withdrawStake, or burn calldata from the ABI resource when a first-class safe workflow exists.

For "update my STONX allocations to the suggested allocations", call get_stonx_allocation_recommendation, require execution_ready=true, at most 25 targets, and an exact 10,000-bps target total, then call get_ve33_allocations for the connected wallet. Validate its onchain request and pass its exact state_id, recommendation targets, and strategy=compact_max_lock to prepare_ve33_reallocation. Pass the surviving NFT, every source NFT burned by a compound merge, the maximum four-year extension, exactly one final voting NFT per target, every decoded call, and the complete plan to the wallet.

For "reinvest my fees", call prepare_ve33_reinvest with phase=claim and omit claims so it discovers and claims every active allocation. Take the supplied pre-claim balance snapshots, then use phase=swap with only the exact claimed deltas so it prepares one exact-input swap per non-stake token. After receipts confirm, refresh allocations and use phase=stake_all with its exact state_id and the measured STONX output. Never swap a wallet's pre-existing balance.

For a new stake, use prepare_ve33_stake; max duration is the default when no duration is supplied. For an existing stake, pass current_pool_key when it is voted so prepare_ve33_extend uses a compound fee claim before extension; omit it only for an unvoted VeToken. max_duration=true must be an explicit choice.

Every active source vote must be claimed unconditionally before that vote is cleared or moved, even when claimable fees are currently zero. Preserve the returned compact claim-and-extend, claim-and-merge, split, and vote order across the plan's steps, which the wallet executes as one atomic batch. Execute onchain_validation's read_calls_reference through wallet_batch_eth_call immediately before signing, simulate the exact transaction from sender, and discard the plan after any state change or failed expectation.`;

const AGENT_WORKFLOW = `# Safe Ekubo swap and bridge workflow

1. Search the token list when resolving a name or symbol. For exact identifiers, use get_token for one chain/address pair or get_tokens for up to 1,000 pairs in one batch. Show the chosen chains and addresses to the user.
2. Convert the user amount to base units without floating-point arithmetic.
3. Set destination_chain_id explicitly for a bridge. Raw addresses and eip155:<chain>:<address> token IDs are accepted.
4. Request an exact-input or exact-output quote. Once the user has decided to swap, pass sender and slippage_bps so every option arrives with the calldata that executes it; omit both only for an indicative "what would I get" comparison. Honor the user's explicit slippage preference. If none was given, estimate gas cost and swap notional in the same currency and use slippage_bps approximately equal to 10,000 * gas-cost value / swap-notional value, so the maximum tolerated slippage loss is near one gas fee. Do not default to 50 bps (0.5%), especially on Ethereum mainnet; prefer re-quoting and preparing a new transaction after failure to widening the bound. For same-chain requests, inspect every entry in quotes and choose a source; the tool does not accept or select one. The normalized amounts expose amount_out for exact input and amount_in for exact output. Cross-chain requests return Across, LayerZero, and LI.FI options where each is configured; compare them as you would any other options. After executing a LayerZero or LI.FI option, poll get_value_transfer_status with source set to that option's source until settled is true, because a successful origin receipt does not mean the transfer was delivered: LayerZero is polled with the quote's provider_quote_id and the origin transaction hash, LI.FI with the origin transaction hash and origin_chain_id. unavailable_sources reports individual provider failures without invalidating successful quote options, and a single option that could not be made executable reports its own execution_unavailable while the rest stand.
5. Take the chosen option's execution.execution_plan_reference as it is. Do not call the tool again to obtain a plan you were already given: it fetches fresh quotes, which spends a round trip and an agent turn inside the window where the plan in hand is still good, and leaves the user having approved a quote that is not the one executed. Call it again only after an expiry, a revert, or a change to the amount, tokens, sender, recipient, or slippage.
6. Include the provider, exact plan ID, token amounts, chains, slippage bound, recipient, approvals, execution transaction, and any allowance reset in the wallet handoff.
7. Pass the execution_plan_reference envelope unchanged as the wallet's reference argument and let its own simulation establish balances, allowances, policy, and the exact transaction outcome. The wallet fetches and verifies the plan body itself; never restate it. Do not read allowances or validate the transaction separately first, and do not ask for separate agent-level confirmation; both only spend the quote's remaining life.
8. Simulate once. Let the wallet present that simulated result, collect authorization or signature, and submit that same simulation rather than simulating the identical plan again immediately before signing. A wallet that re-simulates to show a human the current state at approval time is a different matter and is expected. Never send credentials to this server.
9. Inspect a wallet simulation's structured failure. Retry identical calldata only when recommended_action=retry_same_plan, normally for a transient RPC failure. For reprepare_plan, including slippage or any execution revert, request a fresh quote and calldata. Re-quote and revalidate after any change, expiry, or stale block.
`;

const LP_POSITION_WORKFLOW = `# Ekubo LP position data and onchain state

Ekubo position NFTs are not ERC721-enumerable. Start with \`get_positions_by_owner\`; do not scan \`tokenOfOwnerByIndex\`. The owner response includes the interface's indexed portfolio-row inputs (PoolKey, bounds, position liquidity, pool state, incentive rewards), current canonical token metadata and USD prices, and one exact pending state query per supported EVM position.

For a detail view, call \`get_position\` with the owner, chain, positions manager, and token ID from that list. It returns:

- the exact indexed position snapshot;
- NFT metadata, including its salt and mint transaction;
- position history events used for fee/reward APR;
- active incentive campaigns and indexed earned rewards;
- pool, reward, and STONX token metadata with \`decimals\` and \`usd_price\`;
- the pending onchain state query used by the interface.

## Execute the current-state query

Pass \`current_state_query.read_calls_reference\` unchanged as \`wallet_batch_eth_call\`'s reference argument. The stored bundle is a single Multicall3 \`eth_call\` at \`pending\` whose decode plan contains the canonical outer and child ABIs, expected result count, and required success flags. The surrounding query metadata contains the expected owner for comparison after decoding, and each position's \`state_call_id\` names its call in the results. The wallet uses fixed JSON-safe serialization, includes raw return bytes by default, and must preserve them on decode failure. The remote Ekubo MCP server does not receive or decode the onchain result.

ABI decoding and semantic decoding are separate. A semantic codec on an ABI \`bytes\`, \`bytesN\`, or integer output preserves that ABI value and adds the interpreted value. For a custom payload with no ABI envelope, \`kind=semantic_value\` feeds the raw result directly to an allowlisted local codec while the wallet preserves the raw bytes. Codec IDs are platform-neutral; implementation entries explicitly identify npm, package URL, export, version, and integrity when npm is the implementation ecosystem. Treat those entries as compatibility assertions only. Wallet tooling must never install, fetch, dynamically import, or evaluate code named by a remote decode plan.

Standard Positions return \`liquidity, principal0, principal1, fees0, fees1\`. Ve33Positions return \`liquidity, principal0, principal1, rewardAmount\`; ordinary swap fees are zero for that manager. \`ownerOf\` is included in the same aggregate so the caller can reject stale indexed ownership.

TWAMM positions prepend \`lockAndExecuteVirtualOrders\`. Ve33 positions prepend \`maybeAccumulateRewards\`. Those are state-changing functions run only inside the read-only EVM simulation. Keep the refresh and state read inside the supplied ordered aggregate: separate eth_calls would discard the simulated refresh before the state read. Never broadcast the Multicall3 payload.

## USD values and historical APR

For each raw amount, divide by \`10^token.decimals\`, multiply by the matching \`token.usd_price\`, and sum token0 and token1. Current principal USD uses \`principal0\` and \`principal1\`; current fee USD uses \`fees0\` and \`fees1\`. Missing prices make USD values unavailable.

To reproduce all-time APR, find the latest \`update\` event in \`position_history\` and replay \`current_state_query.aggregate_call\` (its to/data are kept inline by \`get_position\` for exactly this purpose) at event block + 1. For 1-day or 7-day APR, resolve the block closest to pending timestamp minus the interval, then replay at that block. Reuse the identical aggregate \`to\` and \`data\`; replace only the executed JSON-RPC block parameter with a hexadecimal block quantity. Decode locally and retain each historical raw result. Add any \`collect_fees\` amounts (or \`claim_rewards\` for Ve33) since the start snapshot, value them using the current token prices as the interface does, divide earnings by current principal USD, and annualize by elapsed seconds. Do not report APR when liquidity changed between snapshots or required price/history data is unavailable.

The indexed \`pool_state\` is appropriate for portfolio range math and discovery. The pending contract simulation is authoritative for immediately withdrawable principal, uncollected fees or accumulated Ve33 rewards, and current ownership.

## Discover and prepare a deposit

Call \`get_position_pool_candidates\` with the chain and token pair. It replaces direct data-API browsing and ABI inspection by returning every indexed candidate above the requested TVL floor, including verified PoolKey/config, Core generation, extension type, exact statistics, and the correct Positions manager. The default zero TVL floor is intentional for position creation because it keeps initialized pools with negligible liquidity visible.

Once the user selects a v3 pool configuration, range, maximum token amounts, and slippage, call \`prepare_lp_position_deposit\`. For an indexed pool, provide pool_id. For a new pool, provide the exact pool_key, pool_initialized=false, and initial_tick; the tool derives the ID and emits \`maybeInitializePool\` as its own step before the deployed \`mintAndDeposit\` call, which the wallet executes as one atomic batch. It calculates expected liquidity with shared SDK math, derives a nonzero minimum liquidity, selects Positions or Ve33Positions, and returns exact approvals, initialization/deposit/refund calldata, optional allowance cleanup, owner validation, decoded intent, and \`execution_plan_reference\`.

When initialization must be its own transaction, call \`prepare_pool_initialization\` with the exact PoolKey and initial tick. It selects Positions or Ve33Positions from the pool extension and returns one complete \`maybeInitializePool\` execution plan. The function is idempotent for an already initialized pool, but the first successful initializer fixes the pool's initial price, so simulate against pending state and verify the tick immediately before submission. Pool initialization does not correct an existing pool's price; use the phased \`prepare_fix_pool_price\` workflow for that.

If the wallet needs a preliminary swap to acquire one side, use \`get_quotes_with_plans\` and take one option's plan as a separate step. Pass it to the wallet MCP so the wallet simulates it, presents the simulated result, collects authorization or signature, submits it, and returns a successful receipt. Then read the actual resulting balance or balance delta, preserve enough native token for gas, and call the LP preparer with the measured maxima. Do not combine the deposit with an unsettled swap or size it from quoted output alone.

Do not encode \`mintAndDeposit\`, \`deposit\`, or \`refundNativeToken\` with Cast. Give the returned execution plan unchanged to the user's wallet MCP for exact-plan simulation, wallet-owned authorization, and submission. Do not insert a separate agent confirmation step. The wallet remains authoritative for what may be signed, the connected account, and the chain. This server states no policy requirements of its own and cannot loosen wallet policy.

## Collect fees or claim rewards

Call \`prepare_lp_position_earnings_claim\` with the connected owner wallet, chain, positions manager, and token ID returned by \`get_positions_by_owner\`. Standard v3 Positions use \`collectFees\`; legacy v2 Positions use the explicit \`withdraw\` overload with liquidity zero and \`withFees=true\`; Ve33Positions use \`claimRewards\`. The recipient defaults to the sender and may be supplied explicitly. None of these paths withdraws principal, burns the NFT, or transfers it.

Execute the returned \`onchain_validation.current_state_query\` by passing its \`read_calls_reference\` unchanged to \`wallet_batch_eth_call\`; for Ve33 the same stored bundle also reads \`stakeToken\`. Require every inner call to succeed, compare decoded owner with \`expected_owner\`, retain raw bytes, and pass \`fees0/fees1\` for standard positions or \`rewardAmount\` for Ve33 to the wallet with the unchanged \`execution_plan_reference\`. The wallet performs exact simulation, presents the result, collects authorization or signature, and submits. Do not reconstruct or decode calldata with Cast, and do not infer a manager function from an ABI resource.

## Withdraw liquidity

Execute each position's current-state query and choose an exact positive uint128 liquidity amount, then call \`prepare_lp_position_withdraw\` once with either one position or a withdrawals array for up to 100 positions. The preparer resolves every PoolKey and bounds from the owner index and mirrors the interface: standard v2/v3 withdrawals collect fees, while Ve33 uses \`withdrawAndClaimRewards\`. The wallet may atomically batch unrelated position calls. Compare every requested liquidity with its decoded pending liquidity, not only the informational indexed snapshot.

The returned execution plan contains the complete transaction list. The wallet must not select a function overload, reconstruct calldata, append a separate fee/reward claim, or burn the NFT. Use the locally decoded result to verify the owner equals \`expected_owner\`, sufficient liquidity, principal, and earnings; include the recipient and exact manager call, then pass the complete context and plan to the wallet for simulation and authorization. Discard and rebuild the plan after any position-state change.
`;

const EXECUTION_PLAN_WORKFLOW = `# Ekubo execution plan handoff

Every executable preparation result includes execution_plan_reference: an artifact_reference envelope naming where this server stored the plan body plus an integrity block (keccak256 of the exact stored bytes plus their byte count). The envelope describes none of the plan's contents — the integrity-verified body is the only source of truth. Prepared onchain reads travel identically as read_calls_reference envelopes whose stored body is an exact wallet_batch_eth_call argument object. The stored body is the canonical boundary between this non-custodial Ekubo MCP server and a signing wallet. No timestamps travel in the envelope: a plan's validity is expressed by the deadline inside its calldata and enforced by the wallet's simulation against current chain state, and storage expiry surfaces as a fetch 404.

## Relay the reference, not the body

The agent between this server and a wallet passes only the reference, and passes it whole: give the entire envelope unchanged as the wallet tool's reference argument — never rename, edit, or restate any of its fields. The wallet fetches the body over HTTPS, recomputes the integrity digest over the fetched bytes, checks the byte count, refuses a mismatch, and validates the plan exactly as it would an inline one. Never fetch, restate, summarize, or reconstruct the body yourself. A fetch 404 means the reference expired — re-run the preparation tool for fresh state and calldata. For a wallet that accepts only inline plans, fetch the reference URL once and hand over its exact JSON unchanged; an inline plan can also travel as a minimal envelope whose url is a data:application/json;base64 URI of those exact bytes (integrity optional there: the bytes are the reference).

## Bind the sender first

Choose the actual signing account before calling a preparation tool and pass that exact address as sender. Prefer the connected account exposed by wallet tooling. Use a local Cast account only when the user explicitly selected Cast execution and the account. Never infer "my wallet" from a local keystore or environment without that direction.

The wallet refuses a fetched plan whose chain or sender disagrees with its connected chain and account, so a mismatch means re-preparing with the right sender; do not rewrite the sender or silently switch networks.

## Execute ordered_steps

These semantics govern the stored plan body, which only the wallet reads. Each step's transaction has decimal chain_id, value, and optional gas with exact from, to, and data fields for wallet APIs that accept transaction objects.

Preserve ordered_steps exactly. The Ekubo wallet MCP simulates and executes multi-step plans as one atomic EIP-7702 batch. A plan may declare required_capabilities (currently {"atomic_batch"}): a wallet that does not implement a required capability must reject the plan rather than adapt it. Stop on any rejection, revert, failed receipt, chain/account change, expired quote, or changed plan.

Every plan includes simulation_failure_policy. Follow the wallet's returned simulation.failure.recommended_action: retry the identical plan only for retry_same_plan; for reprepare_plan, return to the originating Ekubo preparation tool for fresh state and calldata. Swap and bridge reverts, including slippage, always require a fresh quote. The wallet may atomically batch multiple related or unrelated ordered calls.

Execution steps may include a portable revert_decode plan with kind=error_result and the target contract's canonical custom-error ABI. Pass it through unchanged. The wallet owns any batch-wrapper decoding, recursively unwraps its own execution-layer errors, preserves outer and innermost revert bytes, and applies the step error ABI locally. The Ekubo MCP does not know or describe wallet-specific wrappers.

## Wallet tooling adapter

Treat wallet tooling as a separate trust boundary from this public Ekubo server. When a wallet MCP or wallet API exposes call, simulation, authorization, and submission abstractions, use those directly and pass the exact reference envelope unchanged. Do not translate the plan into Cast or manually issue RPC calls when the wallet already wraps those operations. Do not ask the user for a separate agent-level confirmation; the wallet must simulate the exact plan, present the simulated result, collect authorization or signature, and submit it. Never provide a private key, mnemonic, or wallet credential to either MCP server.

## Optional Cast fallback

Use Cast only when the user explicitly selected it or no compatible wallet abstraction is available. Fetch the reference URL once, verify integrity.value (keccak256) over the exact fetched bytes, and execute from that body. For each step, verify the RPC chain ID. Simulate with cast call TO --data DATA --from SENDER --value VALUE. Estimate the identical bytes with cast estimate TO DATA --from SENDER --value VALUE. Submit those same bytes with cast send TO DATA plus the user's selected --account, --keystore, or hardware-wallet option and --value VALUE; rely on that wallet/signing interface for authorization. Recheck chain ID immediately before every send and independently fetch each receipt. Raw calldata is passed differently by Cast subcommands: call uses --data, while estimate and send use DATA as the positional signature argument. Do not reconstruct calldata from a displayed function description.
`;

const QUOTER_API = `# Ekubo aggregated quote contract

get_quotes_with_plans returns every Ekubo and 0x quote for same-chain
requests without selecting one, each already carrying the execution plan that
executes it. Each entry includes normalized amounts for the agent or user to
compare; set include_raw_quotes to add the untouched provider responses. There is
no second preparation call, so no quote is fetched twice and the compared quote is
the executed one. If either requested
provider fails, the result marks the set incomplete and instructs the user to retry.
Cross-chain requests use the Across Swap API, LayerZero's Value Transfer API,
and the LI.FI API, each included where it is configured. Provider API keys are server-side
and are never accepted as tool arguments.

Ekubo base URL: https://prod-api-quoter.ekubo.org

Canonical Ekubo route:

GET /{chainId}/{signedAmount}/{specifiedToken}/{otherToken}

- Exact input X to Y for positive amount A: /{chainId}/{A}/{X}/{Y}
- Exact output X to Y for positive amount B: /{chainId}/-{B}/{Y}/{X}
- Amounts are integer token base units.
- The response contains block_number, block_hash, total_calculated,
  estimated_gas_cost, price_impact, and signed executable route splits.

0x:
- Uses /swap/allowance-holder/price for indicative requests and /quote when a sender is supplied.
- exact_input maps to sellAmount; exact_output maps to buyAmount.
- Exact-output approval uses maxSellAmount; when the plan creates an allowance, it clears the leftover after execution.

Across:
- Requires different origin and destination chain IDs.
- exact_input maps to tradeType=exactInput; exact_output maps to tradeType=exactOutput.
- Returned approvalTxns and swapTx are preserved as unsigned transactions.

LayerZero (Value Transfer API, https://transfer.layerzero-api.com/v1):
- Requires different origin and destination chain IDs.
- Quotes an exact source amount only: POST /quotes accepts amountType
  EXACT_SRC_AMOUNT, so exact_output requests report unsupported_quote_type and
  are served by Across instead.
- Chains are addressed by string key, so GET /chains is read and cached to map
  EIP-155 chain IDs onto them. A chain LayerZero does not list as EVM reports
  unsupported_chain.
- slippage_bps maps onto options.feeTolerance as a percentage; dstAmountMin
  becomes minimum_amount_out and duration.estimated becomes
  expected_fill_time_seconds.
- LayerZero returns several routes (OFT, Stargate taxi/bus, CCTP, Aori). The
  executable route with the largest destination amount is taken. Routes whose
  userSteps include an EIP-712 signature step, which needs a mid-execution
  /submit-signature round trip, cannot be expressed as an execution plan and
  are skipped.
- The approval spender is decoded out of the step LayerZero built and re-issued
  for an exact amount, which is what keeps the transfer's approval on the
  TransferDelegate rather than the LZMulticall wrapper.
- Each quote's id is returned as provider_quote_id and is the transfer id that
  get_value_transfer_status polls.

LI.FI (https://li.quest/v1):
- Requires different origin and destination chain IDs.
- Chains are addressed by EIP-155 id and a chain's native currency by the zero
  address, so neither needs translating.
- exact_input maps to GET /quote with fromAmount; exact_output maps to GET
  /quote/toAmount with toAmount, which solves for the source amount that lands
  the requested output. That endpoint over-solves, so amount_out and
  minimum_amount_out both exceed the requested output and maximum_amount_in
  carries the source amount the approval must cover.
- slippage_bps maps onto slippage as a decimal fraction; estimate.toAmountMin
  becomes minimum_amount_out and estimate.executionDuration, already in
  seconds, becomes expected_fill_time_seconds.
- LI.FI selects the route itself and answers with one step. Its
  transactionRequest is the transfer, and its chainId is checked against the
  origin rather than trusted.
- estimate.approvalAddress is re-issued as an exact-amount approval, as on the
  Across and LayerZero paths.
- LI.FI states no quote expiry, so quote_expiry_timestamp is null.
- get_value_transfer_status resolves a LI.FI transfer by origin transaction
  hash only; the quote id is not a key it accepts. A 404 for a hash LI.FI has
  not yet observed is reported as status NOT_FOUND rather than raised, so a
  poll loop survives the window before the origin transaction is indexed.
- status DONE covers substatus REFUNDED and PARTIAL, so substatus decides
  whether the funds actually arrived.

MCP callers should use get_quotes_with_plans instead of constructing
provider URLs themselves.
`;

const VE33_WORKFLOW = `# Ekubo ve(3,3) call workflow

- For "my Ekubo STONX allocations", call get_ve33_allocations with only the connected wallet address as owner. The production Ve33 deployment is for STONX, so it selects the right chain and the canonical VeToken automatically. If the client does not expose a connected address, ask the user; never infer ownership from a local keystore or environment.
- The VeToken ERC721 owns the canonical Ve33 stake. The wallet must own or be approved for each ve_id.
- splitStake must move a positive amount smaller than the source stake. The source keeps its vote with reduced weight; the new child starts unvoted.
- Replacing or clearing a vote discards pending fee accounting unless fees are claimed first. Every compiler claims each active source unconditionally before that source vote is cleared or moved, including when claimable fees are zero.
- Extending moves the stake to a new end time and clears its vote. For a voted token, provide current_pool_key so the extension tool uses a compound claim-and-extend method. Omit it only for an unvoted token, where direct extension cannot discard voter fees.
- Pool keys may use an exact bytes32 config or data-API fields: fee, tick_spacing, extension, and optional stableswap_params.
- For claim-all, use prepare_ve33_claim_all_fees to discover the owner's indexed active votes and obtain one atomic batch of decodable VeToken steps plus ownerOf/voteState validation calldata. Revalidate those calls through the user's provider before signing.
- For any vote reorganization, first use get_ve33_allocations and show the complete allocation plus state_id. Pass that exact state_id and target weight_bps values totaling 10,000 to prepare_ve33_reallocation.
- preserve_existing_locks allocates every distinct expiry cohort proportionally across every target so pool weights decay together; it may require more voting NFTs than target pools and does not guarantee a 25-NFT portfolio.
- For a suggested STONX update, first call get_stonx_allocation_recommendation. Use its at-most-25 executable targets only when execution_ready is true and target_total_weight_bps is exactly 10,000, then pass strategy=compact_max_lock to the normal state-validated reallocation workflow.
- compact_max_lock selects one surviving active NFT, claims its fees and extends it to the maximum four-year duration, then fee-safely claims and merges every other active NFT into it, splits once per additional target, and applies exactly one NFT vote per target. Never detach or reorder those calls.
- Compound merges burn their source NFT IDs after moving the stake. Pass every burned ID, the survivor, the lock extension, final NFT count, decoded calls, and complete plan to the wallet. Unvoted NFTs remain outside the reallocation scope; withdrawals and direct burn calldata remain forbidden.
- Raw VeToken vote, clearVote, extendStake*, and full-source mergeStakes calls can discard pending voter fees. Prefer the fee-preserving tools or compound claim methods. Never call burn on a stake-bearing NFT; it can orphan the underlying stake. Withdraw only an expired stake, claim its active-pool fees first, and verify the recipient.
- Reinvestment takes three sequential wallet phases: snapshot balances and automatically claim all active allocations, swap each complete post-claim delta exact-input into the stake token, then refresh portfolio state and use stake_all to apportion the complete output across every existing active allocation without replacing its vote. Each executable phase is passed to the wallet, which owns simulation and authorization.
- New stakes default to stakeMaxDuration and affect no existing NFT. Existing lock extension is intentionally explicit because it clears the vote; the extension tool uses a compound fee claim before either max-duration or custom-duration extension.
- transferOwnership, ownership handover, ERC721 transfer/approval, safe transfer, and burn are forbidden in every first-class workflow.
- Re-read ownership, stake amount, active vote, fee balances, allowances, and contract code before signing every plan.
`;
