import {
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import { type Address, getAddress, type Hex, numberToHex } from "viem";
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
  type Env,
  getQuote,
  getToken,
  getTokens,
  prepareSwap,
  type QuoteSource,
  searchTokens,
  ServiceError,
} from "./core.js";
import {
  canonicalChainId,
  decodePoolConfig,
  derivePoolId,
  getPool,
  getPoolLiquidity,
  getPositionPoolCandidates,
  getPositionsByOwner,
  type PoolKeyInput,
} from "./pools.js";
import { getPosition } from "./positions.js";
import {
  prepareLpPositionDeposit,
  prepareLpPositionEarningsClaim,
  prepareLpPositionWithdraw,
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
  prepareRecoveryFundClaim,
  prepareRevenueBuybacks,
  prepareRewardsClaim,
} from "./claims.js";
import { getStonxAllocationRecommendation } from "./recommendations.js";
import { MCP_SERVER_VERSION, MCP_TOOL_CATALOG_REVISION } from "./version.js";

export const ROBINHOOD_STONX_CHAIN_ID = "4663";
export const ROBINHOOD_STONX_VE_TOKEN = getAddress(
  "0x9d7008E169D040B6c0140eb92E7cA82B12643497",
);
export const ROBINHOOD_STONX_VE33 = getAddress(
  "0xD18685a514E59b06d59824e16Db07e73345d9953",
);

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
  .refine((value) => BigInt(value) > 0n, "chain_id must be positive")
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
const quoteSource = z.enum(["auto", "ekubo", "0x", "across"]);
const amount = z
  .string()
  .regex(/^[0-9]*[1-9][0-9]*$/, "amount must be a positive base-unit integer")
  .describe("Positive exact-input or exact-output token amount in base units");

export const searchTokensSchema = z.object({
  chain_id: chainId,
  query: z
    .string()
    .min(1)
    .max(32)
    .describe("Token symbol, name, or address fragment"),
  page_size: z.number().int().min(1).max(100).default(20),
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

export const getQuoteSchema = z.object({
  chain_id: chainId,
  destination_chain_id: chainId
    .optional()
    .describe("Destination chain; defaults to chain_id for a same-chain swap"),
  token_in: tokenIdentifier,
  token_out: tokenIdentifier,
  quote_type: quoteType,
  amount,
  source: quoteSource.default("auto"),
  slippage_bps: z.number().int().min(0).max(10_000).default(50),
  sender: address
    .optional()
    .describe("Optional taker/depositor; makes 0x or Across quotes firm"),
  recipient: address
    .optional()
    .describe("Optional output recipient; defaults to sender when preparing"),
});

export const prepareSwapSchema = getQuoteSchema.extend({
  slippage_bps: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .describe("User-selected slippage tolerance in basis points"),
  sender: address.describe(
    "Transaction sender/taker/depositor used for firm quotes and validation",
  ),
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

export const prepareLpPositionWithdrawSchema = z.object({
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
  liquidity: amount.describe(
    "Exact positive uint128 liquidity to withdraw, normally selected from the decoded pending current-state query",
  ),
  recipient: address
    .optional()
    .describe("Principal and earnings recipient; defaults to sender"),
});

export const prepareWrapUnwrapSchema = z.object({
  chain_id: chainId,
  sender: address,
  direction: z.enum(["wrap", "unwrap"]),
  amount,
});

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
  salt: bytes32.optional(),
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

export const prepareRecoveryFundClaimSchema = z.object({
  chain_id: chainId,
  sender: address,
  claims: z
    .array(z.object({ token: address, amount }))
    .min(1)
    .max(50),
  has_signed_conditions: z.boolean(),
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]{130}$/, "must be a 65-byte signature")
    .optional(),
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
        `Optional with ve_token; omit both for the production Ekubo STONX deployment on Robinhood Chain ${ROBINHOOD_STONX_CHAIN_ID}`,
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
    "VeToken owner that will execute the atomic multicall",
  ),
  current_state_id: bytes32.describe(
    "Exact state_id returned by ekubo_get_ve33_allocations; preparation fails if indexed state changed",
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
    source: quoteSource.default("auto"),
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

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const toolCatalogMetadata = {
  "com.ekubo/catalogRevision": MCP_TOOL_CATALOG_REVISION,
} as const;

export const publicToolCatalog = [
  {
    name: "ekubo_search_tokens",
    title: "Search Ekubo tokens",
    description:
      "Search the canonical Ekubo token list, ordered by descending visibility_priority so the preferred token wins ambiguous symbol matches.",
    inputSchema: z.toJSONSchema(searchTokensSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_get_token",
    title: "Get an Ekubo token",
    description:
      "Fetch canonical token metadata for an exact chain and address.",
    inputSchema: z.toJSONSchema(getTokenSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_get_tokens",
    title: "Get multiple Ekubo tokens",
    description:
      "Fetch canonical metadata for 1 to 1,000 exact token identifiers in one batch request. Tokens may span chains. Results preserve input order and duplicates; identifiers absent from the canonical token list are omitted.",
    inputSchema: z.toJSONSchema(getTokensSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_get_quote",
    title: "Get a swap or bridge quote",
    description:
      "Compare Ekubo and 0x for same-chain swaps or use Across for cross-chain swaps. Supports exact input/output and EIP-155 token identifiers.",
    inputSchema: z.toJSONSchema(getQuoteSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_swap",
    title: "Prepare a swap or bridge",
    description:
      "Fetch a firm Ekubo, 0x, or Across quote and generate unsigned approval plus execution calldata. Returns one ordered execution_plan for a connected wallet or provider, preferably through a separately trusted compatible wallet MCP; Cast remains an optional fallback.",
    inputSchema: z.toJSONSchema(prepareSwapSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_ve33_vote",
    title: "Prepare one ve(3,3) NFT vote change",
    description:
      "Compile one actively voted ve-token into multiple allocations. Unconditionally claims its current pool first, then splits and changes votes in one VeToken multicall. Prefer the portfolio reallocation workflow for complete state validation.",
    inputSchema: z.toJSONSchema(prepareVe33VoteSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_ve33_extend",
    title: "Prepare a ve-token extension",
    description:
      "Prepare a direct extension for an unvoted VeToken or an atomic claim-and-extend call when current_pool_key identifies an active vote, so pending voter fees are preserved.",
    inputSchema: z.toJSONSchema(prepareVe33ExtendSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_ve33_stake",
    title: "Prepare a new ve-token stake",
    description:
      "Create a new VeToken stake with an exact stake-token approval. Max duration is the safe default for new stakes; an explicit shorter duration is optional and no existing NFT, vote, fee balance, or ownership is changed.",
    inputSchema: z.toJSONSchema(prepareVe33StakeSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_ve33_split",
    title: "Prepare a ve-token split",
    description:
      "Split a source ve-token with an explicit salt and return the deterministic child token ID; the source vote is preserved and the child starts unvoted.",
    inputSchema: z.toJSONSchema(prepareVe33SplitSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_ve33_claim_fees",
    title: "Prepare ve-token fee claims",
    description:
      "Generate one call or a VeToken multicall that claims voter fees from one or more ve-tokens.",
    inputSchema: z.toJSONSchema(prepareVe33ClaimSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_ve33_reinvest",
    title: "Prepare ve-token fee reinvestment",
    description:
      "Build the safe phased workflow for 'reinvest my fees': automatically claim all active voter fees, prepare one exact-input swap per claimed non-stake token, then increase one VeToken or every existing active allocation without changing ownership or replacing votes.",
    inputSchema: z.toJSONSchema(prepareVe33ReinvestSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_ve33_claim_all_fees",
    title: "Prepare all ve-token fee claims",
    description:
      "Discover every active vote on VeTokens owned by the sender and generate one native VeToken multicall claiming all indexed pool fees, with ownerOf and voteState validation calldata.",
    inputSchema: z.toJSONSchema(prepareAllVe33FeeClaimsSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_get_ve33_allocations",
    title: "Show Ekubo STONX / ve(3,3) allocations",
    description:
      "Use for requests such as 'show all my Ekubo STONX allocations'. The production Ekubo ve(3,3) deployment is the STONX voting system, so pass only owner to select Robinhood Chain 4663 and its canonical VeToken automatically. Returns every pool, selected swap fee, NFT, applied vote weight, totals, state_id, and an onchain_validation request explicitly marked not_executed until the client runs its eth_call. Pass chain_id and ve_token together only for another deployment such as testnet.",
    inputSchema: z.toJSONSchema(getVe33AllocationsSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_get_stonx_allocation_recommendation",
    title: "Get suggested STONX allocations",
    description:
      "Return a provider-neutral STONX allocation recommendation no more than one day old and an exactly 10,000-bps executable target list capped at 25 initialized canonical Robinhood Ve33 pools. A stale snapshot is refreshed and awaited before use; refresh failures fail closed. The tool constructs no transaction; use compact_max_lock for one final voting NFT per target.",
    inputSchema: z.toJSONSchema(getStonxAllocationRecommendationSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_ve33_reallocation",
    title: "Prepare atomic ve(3,3) reallocation",
    description:
      "Compile a reviewed current allocation into at most 25 target pool-weight shares using one VeToken multicall. The optional compact_max_lock strategy fee-safely consolidates active NFTs, extends the survivor to four years, then creates exactly one voting NFT per target; it explicitly discloses burned source IDs and lock extension.",
    inputSchema: z.toJSONSchema(prepareVe33ReallocationSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_get_positions_by_owner",
    title: "Get Ekubo positions by owner",
    description:
      "Enumerate an owner's indexed Ekubo position NFTs without relying on ERC721 enumeration. Returns pool keys, bounds, liquidity, current indexed pool state, rewards, and pagination. Optionally filter by chain and opened/closed state.",
    inputSchema: z.toJSONSchema(getPositionsByOwnerSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_get_pool",
    title: "Get an Ekubo pool",
    description:
      "Resolve an exact chain/core/pool ID to its PoolKey and decoded config, verify that the key hashes back to the requested ID, and return the indexed pool-state snapshot when one is available.",
    inputSchema: z.toJSONSchema(getPoolSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_get_pool_liquidity",
    title: "Get Ekubo pool liquidity depth",
    description:
      "Return tick-level net liquidity deltas for one exact chain/core/pool ID. Accumulate the deltas in ascending tick order to reconstruct active liquidity depth.",
    inputSchema: z.toJSONSchema(getPoolLiquiditySchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_derive_pool_id",
    title: "Derive an Ekubo pool ID",
    description:
      "Pack or accept an exact PoolKey config and derive pool_id = keccak256(abi.encode(PoolKey)). The uint64 Q64 fee is string-only so JavaScript cannot silently round it.",
    inputSchema: z.toJSONSchema(derivePoolIdSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_decode_pool_config",
    title: "Decode an Ekubo pool config",
    description:
      "Decode the packed bytes32 extension, exact uint64 Q64 fee, concentrated/stableswap discriminator, and tick spacing or stableswap parameters. The fee is never returned as a JSON number.",
    inputSchema: z.toJSONSchema(decodePoolConfigSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_get_position",
    title: "Get complete Ekubo position details",
    description:
      "Hydrate one indexed owner position with the same inputs used by the interface: pool key, bounds, indexed liquidity and pool state, NFT metadata, event history, campaigns and earned rewards, token metadata and USD prices, plus an exact pending Multicall3 eth_call and nested decode plan for current principal, fees or Ve33 rewards, and owner.",
    inputSchema: z.toJSONSchema(getPositionSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_get_position_pool_candidates",
    title: "Find pools for an LP position",
    description:
      "List existing indexed pools for a token pair without browsing the data API or reading contract ABIs. Returns v2/v3 Core generation, independently verified exact PoolKeys and pool IDs, pool type and extension classification, token USD metadata, 24-hour TVL/volume/fee/depth statistics, and the correct Positions or Ve33Positions manager for each candidate. Defaults to min_tvl_usd=0 so initialized low-liquidity pools remain visible.",
    inputSchema: z.toJSONSchema(getPositionPoolCandidatesSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_lp_position_deposit",
    title: "Prepare an LP position deposit",
    description:
      "Prepare a new v3 position mint or add liquidity to an existing position in one first-class workflow. Resolves and verifies an indexed pool or derives an exact supplied PoolKey, initializes a new pool at initial_tick when requested, selects Positions or Ve33Positions, computes a nonzero minimum liquidity, and returns every approval, execution, refund, and cleanup transaction. No Cast encoding is required.",
    inputSchema: z.toJSONSchema(prepareLpPositionDepositSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_lp_position_earnings_claim",
    title: "Prepare an LP fee or reward claim",
    description:
      "Prepare collection of all currently accrued fees from an owned standard position or all currently accrued rewards from an owned Ve33 position. Resolves the indexed PoolKey and bounds, automatically chooses v2 withdraw-with-zero-liquidity, v3 collectFees, or Ve33 claimRewards, preserves all liquidity and the NFT, supplies an atomic pending ownership/earnings read, exact decoded calldata and result fields, wallet-policy requirements, and a signer-neutral execution_plan. No Cast encoding is required.",
    inputSchema: z.toJSONSchema(prepareLpPositionEarningsClaimSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_lp_position_withdraw",
    title: "Prepare an LP position withdrawal",
    description:
      "Prepare a partial or full liquidity withdrawal from an owned EVM position with one complete wallet plan. Resolves the indexed PoolKey and bounds, uses the exact requested uint128 liquidity, automatically collects standard-position fees or Ve33 rewards as the interface does, supports an explicit recipient, preserves the NFT, and supplies pending ownership/liquidity/earnings validation, exact decoded calldata and result fields, and wallet-policy requirements. The wallet never constructs calldata or adds transactions.",
    inputSchema: z.toJSONSchema(prepareLpPositionWithdrawSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_wrap_unwrap",
    title: "Prepare direct WETH wrap or unwrap",
    description:
      "Prepare the Ethereum interface's direct WETH deposit or withdrawal with exact calldata and native value.",
    inputSchema: z.toJSONSchema(prepareWrapUnwrapSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_lp_position_transfer",
    title: "Prepare an LP position transfer",
    description:
      "Prepare the exact safeTransferFrom transaction for an owned LP position and include pending ownership validation. The position, liquidity, and unclaimed earnings move together.",
    inputSchema: z.toJSONSchema(prepareLpPositionTransferSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_fix_pool_price",
    title: "Prepare a pool price correction",
    description:
      "Run the interface-equivalent phased fix-price workflow: provide exact pending pool-price read calldata, then exact router quote calldata, then approvals and target-price execution calldata. The wallet never constructs a route or transaction.",
    inputSchema: z.toJSONSchema(prepareFixPoolPriceSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_twamm_order",
    title: "Prepare a TWAMM or DCA order",
    description:
      "Prepare one or many current-interface TWAMM order splits, including deterministic minting, exact approval/native value, and the complete manager multicall.",
    inputSchema: z.toJSONSchema(prepareTwammOrderSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_twamm_order_collection",
    title: "Prepare TWAMM proceeds collection",
    description:
      "Prepare collection of every selected order key through the exact current or legacy Orders manager multicall, with pending owner validation.",
    inputSchema: z.toJSONSchema(prepareTwammOrderCollectionSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_twamm_order_stop",
    title: "Prepare stopping a TWAMM order",
    description:
      "Prepare the interface's complete stop flow: collect every selected order and decrease every still-active sale rate in one manager multicall.",
    inputSchema: z.toJSONSchema(prepareTwammOrderStopSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_twamm_virtual_orders",
    title: "Prepare TWAMM virtual-order execution",
    description:
      "Prepare the permissionless lockAndExecuteVirtualOrders maintenance call for a current or legacy TWAMM pool.",
    inputSchema: z.toJSONSchema(prepareTwammVirtualOrdersSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_auction_create",
    title: "Prepare auction creation",
    description:
      "Pack the exact interface auction config and prepare mint plus sellAmountByAuction, including approval or native value and deterministic token ID.",
    inputSchema: z.toJSONSchema(prepareAuctionCreateSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_auction_complete",
    title: "Prepare auction completion",
    description:
      "Prepare permissionless auction completion and, when necessary, graduation-pool initialization in the same manager multicall.",
    inputSchema: z.toJSONSchema(prepareAuctionCompleteSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_auction_creator_proceeds",
    title: "Prepare auction creator proceeds collection",
    description:
      "Prepare collection of creator proceeds for an auction NFT with pending owner validation.",
    inputSchema: z.toJSONSchema(prepareAuctionCreatorProceedsSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_manual_pool_boost",
    title: "Prepare a manual pool boost",
    description:
      "Compute the exact Q32 boost rates and prepare all token approvals, native value, and boost calldata used by the interface.",
    inputSchema: z.toJSONSchema(prepareManualPoolBoostSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_oracle_capacity_expansion",
    title: "Prepare oracle capacity expansion",
    description:
      "Prepare the interface's permissionless Oracle expandCapacity call for one ERC-20 token.",
    inputSchema: z.toJSONSchema(prepareOracleCapacityExpansionSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_approval_revocations",
    title: "Prepare ERC-20 approval revocations",
    description:
      "Prepare every approve(spender,0) as an exact ordered multi-transaction execution plan. The wallet must not discover or construct the transaction list.",
    inputSchema: z.toJSONSchema(prepareApprovalRevocationsSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_old_gekubo_unwrap",
    title: "Prepare old gEKUBO unwrapping",
    description:
      "Prepare the exact Ethereum HyperRouter byte route and approval used by the interface to unwrap old gEKUBO into EKUBO.",
    inputSchema: z.toJSONSchema(prepareOldGekuboUnwrapSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_get_rewards_claims_by_owner",
    title: "Get incentive rewards claims by owner",
    description:
      "Fetch canonical reward-claim records and supply the exact per-chain isClaimed/isAvailable eth_call list used by the interface before preparing claim transactions.",
    inputSchema: z.toJSONSchema(getRewardsClaimsByOwnerSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_rewards_claim",
    title: "Prepare incentive reward claims",
    description:
      "Prepare one Incentives claim or the interface's allow-failure Multicall3 aggregate for multiple claims.",
    inputSchema: z.toJSONSchema(prepareRewardsClaimSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_recovery_fund_claim",
    title: "Prepare a Recovery Fund claim",
    description:
      "Return the exact EIP-712 signature request when needed, then prepare agreement and all selected recovery claims in one multicall.",
    inputSchema: z.toJSONSchema(prepareRecoveryFundClaimSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_revenue_buybacks",
    title: "Prepare revenue buyback maintenance",
    description:
      "Prepare the exact selected ended-order collections, protocol-fee withdrawals, and token rolls in interface order within one multicall.",
    inputSchema: z.toJSONSchema(prepareRevenueBuybacksSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_ve33_increase_stake",
    title: "Prepare increasing a ve-token stake",
    description:
      "Prepare the exact approval/native value and increaseStakeAmount call while preserving the existing vote and fee accounting.",
    inputSchema: z.toJSONSchema(prepareVe33IncreaseStakeSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_ve33_merge",
    title: "Prepare merging ve-token stakes",
    description:
      "Prepare fee-safe merging of one or more source NFTs into a destination, including required claims and the selected resulting vote in one multicall.",
    inputSchema: z.toJSONSchema(prepareVe33MergeSchema),
    _meta: toolCatalogMetadata,
  },
  {
    name: "ekubo_prepare_ve33_withdraw",
    title: "Prepare expired ve-token withdrawal",
    description:
      "Prepare fee-safe withdrawal of an expired ve-token stake, claiming the active pool first when voted and returning pending owner/stake validation.",
    inputSchema: z.toJSONSchema(prepareVe33WithdrawSchema),
    _meta: toolCatalogMetadata,
  },
] as const;

export function createEkuboServer(env: Env) {
  const server = new McpServer(
    {
      name: "ekubo",
      title: "Ekubo Protocol",
      version: MCP_SERVER_VERSION,
      websiteUrl: "https://mcp.ekubo.org",
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  const registerCatalogTool = <Schema extends z.ZodObject<z.ZodRawShape>>(
    index: number,
    inputSchema: Schema,
    handler: (input: z.infer<Schema>) => unknown | Promise<unknown>,
  ) => {
    const entry = publicToolCatalog[index];
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
        annotations,
        _meta: entry._meta,
      },
      async (input: Record<string, unknown>) =>
        toolResult(() => handler(input as unknown as z.infer<Schema>)),
    );
  };

  server.registerTool(
    publicToolCatalog[0].name,
    {
      title: publicToolCatalog[0].title,
      description: publicToolCatalog[0].description,
      inputSchema: searchTokensSchema,
      annotations,
      _meta: publicToolCatalog[0]._meta,
    },
    async ({ chain_id, query, page_size }) =>
      toolResult(async () => ({
        tokens: await searchTokens(env, {
          chainId: canonicalChainId(chain_id),
          query,
          pageSize: page_size,
        }),
      })),
  );

  server.registerTool(
    publicToolCatalog[1].name,
    {
      title: publicToolCatalog[1].title,
      description: publicToolCatalog[1].description,
      inputSchema: getTokenSchema,
      annotations,
      _meta: publicToolCatalog[1]._meta,
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
    publicToolCatalog[2].name,
    {
      title: publicToolCatalog[2].title,
      description: publicToolCatalog[2].description,
      inputSchema: getTokensSchema,
      annotations,
      _meta: publicToolCatalog[2]._meta,
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

  server.registerTool(
    publicToolCatalog[3].name,
    {
      title: publicToolCatalog[3].title,
      description: publicToolCatalog[3].description,
      inputSchema: getQuoteSchema,
      annotations,
      _meta: publicToolCatalog[3]._meta,
    },
    async (input) =>
      toolResult(() => {
        const inputChainId = canonicalChainId(input.chain_id);
        const destinationChainId = canonicalChainId(
          input.destination_chain_id ?? input.chain_id,
        );
        return getQuote(env, {
          chainId: inputChainId,
          destinationChainId,
          tokenIn: tokenAddress(input.token_in, inputChainId, "token_in"),
          tokenOut: tokenAddress(
            input.token_out,
            destinationChainId,
            "token_out",
          ),
          quoteType: input.quote_type,
          amount: input.amount,
          source: input.source,
          slippageBps: input.slippage_bps,
          sender: input.sender as Address | undefined,
          recipient: input.recipient as Address | undefined,
        });
      }),
  );

  server.registerTool(
    publicToolCatalog[4].name,
    {
      title: publicToolCatalog[4].title,
      description: publicToolCatalog[4].description,
      inputSchema: prepareSwapSchema,
      annotations,
      _meta: publicToolCatalog[4]._meta,
    },
    async (input) =>
      toolResult(() => {
        const inputChainId = canonicalChainId(input.chain_id);
        const destinationChainId = canonicalChainId(
          input.destination_chain_id ?? input.chain_id,
        );
        return prepareSwap(env, {
          chainId: inputChainId,
          destinationChainId,
          tokenIn: tokenAddress(input.token_in, inputChainId, "token_in"),
          tokenOut: tokenAddress(
            input.token_out,
            destinationChainId,
            "token_out",
          ),
          quoteType: input.quote_type,
          amount: input.amount,
          source: input.source,
          slippageBps: input.slippage_bps,
          recipient: input.recipient as Address | undefined,
          sender: input.sender as Address,
        });
      }),
  );

  server.registerTool(
    publicToolCatalog[5].name,
    {
      title: publicToolCatalog[5].title,
      description: publicToolCatalog[5].description,
      inputSchema: prepareVe33VoteSchema,
      annotations,
      _meta: publicToolCatalog[5]._meta,
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
    publicToolCatalog[6].name,
    {
      title: publicToolCatalog[6].title,
      description: publicToolCatalog[6].description,
      inputSchema: prepareVe33ExtendSchema,
      annotations,
      _meta: publicToolCatalog[6]._meta,
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
    publicToolCatalog[7].name,
    {
      title: publicToolCatalog[7].title,
      description: publicToolCatalog[7].description,
      inputSchema: prepareVe33StakeSchema,
      annotations,
      _meta: publicToolCatalog[7]._meta,
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
    publicToolCatalog[8].name,
    {
      title: publicToolCatalog[8].title,
      description: publicToolCatalog[8].description,
      inputSchema: prepareVe33SplitSchema,
      annotations,
      _meta: publicToolCatalog[8]._meta,
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
    publicToolCatalog[9].name,
    {
      title: publicToolCatalog[9].title,
      description: publicToolCatalog[9].description,
      inputSchema: prepareVe33ClaimSchema,
      annotations,
      _meta: publicToolCatalog[9]._meta,
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
    publicToolCatalog[10].name,
    {
      title: publicToolCatalog[10].title,
      description: publicToolCatalog[10].description,
      inputSchema: prepareVe33ReinvestSchema,
      annotations,
      _meta: publicToolCatalog[10]._meta,
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
    publicToolCatalog[11].name,
    {
      title: publicToolCatalog[11].title,
      description: publicToolCatalog[11].description,
      inputSchema: prepareAllVe33FeeClaimsSchema,
      annotations,
      _meta: publicToolCatalog[11]._meta,
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
    publicToolCatalog[12].name,
    {
      title: publicToolCatalog[12].title,
      description: publicToolCatalog[12].description,
      inputSchema: getVe33AllocationsSchema,
      annotations,
      _meta: publicToolCatalog[12]._meta,
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
    publicToolCatalog[13].name,
    {
      title: publicToolCatalog[13].title,
      description: publicToolCatalog[13].description,
      inputSchema: getStonxAllocationRecommendationSchema,
      annotations,
      _meta: publicToolCatalog[13]._meta,
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
    publicToolCatalog[14].name,
    {
      title: publicToolCatalog[14].title,
      description: publicToolCatalog[14].description,
      inputSchema: prepareVe33ReallocationSchema,
      annotations,
      _meta: publicToolCatalog[14]._meta,
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
    publicToolCatalog[15].name,
    {
      title: publicToolCatalog[15].title,
      description: publicToolCatalog[15].description,
      inputSchema: getPositionsByOwnerSchema,
      annotations,
      _meta: publicToolCatalog[15]._meta,
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
    publicToolCatalog[16].name,
    {
      title: publicToolCatalog[16].title,
      description: publicToolCatalog[16].description,
      inputSchema: getPoolSchema,
      annotations,
      _meta: publicToolCatalog[16]._meta,
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
    publicToolCatalog[17].name,
    {
      title: publicToolCatalog[17].title,
      description: publicToolCatalog[17].description,
      inputSchema: getPoolLiquiditySchema,
      annotations,
      _meta: publicToolCatalog[17]._meta,
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
    publicToolCatalog[18].name,
    {
      title: publicToolCatalog[18].title,
      description: publicToolCatalog[18].description,
      inputSchema: derivePoolIdSchema,
      annotations,
      _meta: publicToolCatalog[18]._meta,
    },
    async (input) =>
      toolResult(() => derivePoolId(mapExactPoolKey(input.pool_key))),
  );

  server.registerTool(
    publicToolCatalog[19].name,
    {
      title: publicToolCatalog[19].title,
      description: publicToolCatalog[19].description,
      inputSchema: decodePoolConfigSchema,
      annotations,
      _meta: publicToolCatalog[19]._meta,
    },
    async ({ config }) =>
      toolResult(() => ({ decoded_config: decodePoolConfig(config as Hex) })),
  );

  server.registerTool(
    publicToolCatalog[20].name,
    {
      title: publicToolCatalog[20].title,
      description: publicToolCatalog[20].description,
      inputSchema: getPositionSchema,
      annotations,
      _meta: publicToolCatalog[20]._meta,
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
    publicToolCatalog[21].name,
    {
      title: publicToolCatalog[21].title,
      description: publicToolCatalog[21].description,
      inputSchema: getPositionPoolCandidatesSchema,
      annotations,
      _meta: publicToolCatalog[21]._meta,
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
    publicToolCatalog[22].name,
    {
      title: publicToolCatalog[22].title,
      description: publicToolCatalog[22].description,
      inputSchema: prepareLpPositionDepositSchema,
      annotations,
      _meta: publicToolCatalog[22]._meta,
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
        }),
      ),
  );

  server.registerTool(
    publicToolCatalog[23].name,
    {
      title: publicToolCatalog[23].title,
      description: publicToolCatalog[23].description,
      inputSchema: prepareLpPositionEarningsClaimSchema,
      annotations,
      _meta: publicToolCatalog[23]._meta,
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
    publicToolCatalog[24].name,
    {
      title: publicToolCatalog[24].title,
      description: publicToolCatalog[24].description,
      inputSchema: prepareLpPositionWithdrawSchema,
      annotations,
      _meta: publicToolCatalog[24]._meta,
    },
    async (input) =>
      toolResult(() =>
        prepareLpPositionWithdraw(env, {
          chainId: canonicalChainId(input.chain_id),
          sender: input.sender,
          positionsAddress: input.positions_address,
          tokenId: input.token_id,
          liquidity: input.liquidity,
          recipient: input.recipient,
        }),
      ),
  );

  registerCatalogTool(25, prepareWrapUnwrapSchema, (input) =>
    prepareWrapUnwrap({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      direction: input.direction,
      amount: input.amount,
    }),
  );

  registerCatalogTool(26, prepareLpPositionTransferSchema, (input) =>
    prepareLpPositionTransfer(env, {
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      positionsAddress: input.positions_address,
      tokenId: input.token_id,
      recipient: input.recipient,
    }),
  );

  registerCatalogTool(27, prepareFixPoolPriceSchema, (input) =>
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
    }),
  );

  registerCatalogTool(28, prepareTwammOrderSchema, (input) =>
    prepareTwammOrder({
      chainId: canonicalChainId(input.chain_id),
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
    }),
  );

  registerCatalogTool(29, prepareTwammOrderCollectionSchema, (input) =>
    prepareTwammOrderCollection({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      ordersAddress: input.orders_address,
      tokenId: input.token_id,
      orderKeys: input.order_keys.map(mapEncodedPoolKey),
    }),
  );

  registerCatalogTool(30, prepareTwammOrderStopSchema, (input) =>
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

  registerCatalogTool(31, prepareTwammVirtualOrdersSchema, (input) =>
    prepareExecuteTwammVirtualOrders({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      poolKey: mapEncodedPoolKey(input.pool_key),
    }),
  );

  registerCatalogTool(32, prepareAuctionCreateSchema, (input) =>
    prepareAuctionCreate({
      chainId: canonicalChainId(input.chain_id),
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
    }),
  );

  registerCatalogTool(33, prepareAuctionCompleteSchema, (input) =>
    prepareAuctionComplete({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      tokenId: input.token_id,
      auctionKey: mapEncodedPoolKey(input.auction_key),
      graduationPoolInitialized: input.graduation_pool_initialized,
      launchPoolTick: input.launch_pool_tick,
    }),
  );

  registerCatalogTool(34, prepareAuctionCreatorProceedsSchema, (input) =>
    prepareAuctionCreatorProceeds({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      tokenId: input.token_id,
      auctionKey: mapEncodedPoolKey(input.auction_key),
    }),
  );

  registerCatalogTool(35, prepareManualPoolBoostSchema, (input) =>
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

  registerCatalogTool(36, prepareOracleCapacityExpansionSchema, (input) =>
    prepareOracleCapacityExpansion({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      token: input.token,
      minCapacity: input.min_capacity,
    }),
  );

  registerCatalogTool(37, prepareApprovalRevocationsSchema, (input) =>
    prepareApprovalRevocations({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      approvals: input.approvals,
    }),
  );

  registerCatalogTool(38, prepareOldGekuboUnwrapSchema, (input) =>
    prepareOldGekuboUnwrap({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      amount: input.amount,
    }),
  );

  registerCatalogTool(39, getRewardsClaimsByOwnerSchema, (input) =>
    getRewardsClaimsByOwner(env, { owner: input.owner }),
  );

  registerCatalogTool(40, prepareRewardsClaimSchema, (input) =>
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

  registerCatalogTool(41, prepareRecoveryFundClaimSchema, (input) =>
    prepareRecoveryFundClaim({
      chainId: canonicalChainId(input.chain_id),
      sender: input.sender,
      claims: input.claims,
      hasSignedConditions: input.has_signed_conditions,
      signature: input.signature as Hex | undefined,
    }),
  );

  registerCatalogTool(42, prepareRevenueBuybacksSchema, (input) =>
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

  registerCatalogTool(43, prepareVe33IncreaseStakeSchema, (input) =>
    prepareVe33IncreaseStake({
      chainId: canonicalChainId(input.chain_id),
      veToken: input.ve_token as Address,
      sender: input.sender as Address,
      stakeToken: input.stake_token as Address,
      veId: input.ve_id,
      amount: input.amount,
    }),
  );

  registerCatalogTool(44, prepareVe33MergeSchema, (input) =>
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

  registerCatalogTool(45, prepareVe33WithdrawSchema, (input) =>
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
      description: "Ekubo, 0x, and Across quote semantics used by MCP tools",
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

const SERVER_INSTRUCTIONS = `Use Ekubo preparation tools only to construct unsigned plans. Pass the preparation tool's exact execution_plan unchanged to the user's wallet for simulation, presentation, authorization or signature, and submission. Do not ask the user for a separate agent-level confirmation before invoking the wallet; that duplicates the wallet's authorization flow. The wallet must never construct calldata, choose a contract overload, derive a route, or determine the transaction list. Never construct or request transferOwnership, ownership handover, VeToken ERC721 transfer/approval, or burn calldata. LP position transfers are supported only through ekubo_prepare_lp_position_transfer with pending ownership validation.

Prepared plans expose execution_plan: one signer-neutral, ordered transaction sequence with decimal transaction fields plus exact EIP-1193 eth_call, eth_estimateGas, and eth_sendTransaction requests. Read ekubo://docs/execution-plan. Prefer the most capable available wallet abstraction: when a wallet MCP or wallet API exposes call, simulation, authorization, and submission methods, pass it the execution_plan instead of translating the plan to Cast or manually issuing RPC calls. Cast remains an optional fallback only when the user selected it or no compatible wallet abstraction is available. Verify the connected chain and account exactly match execution_plan.chain_id and sender, revalidate each step immediately before submission, preserve order, wait for each receipt, and never send wallet credentials to this Ekubo server. The plan_id commits to the chain, sender, destination, calldata, and native value of every approval, execution, and cleanup transaction.

Intent shortcut: for "my Ekubo STONX allocations", "STONX vote allocations", or equivalent requests, call ekubo_get_ve33_allocations with only the user's connected EVM wallet as owner. The production Ve33 deployment is the STONX voting system, and the tool selects Robinhood Chain 4663 plus its canonical VeToken when chain_id and ve_token are omitted. If the connected wallet address is unavailable, ask the user for it. Never infer the user's wallet from a machine environment, repository configuration, local keystore, or unrelated account.

For exact token metadata, call ekubo_get_token for one known chain/address pair and ekubo_get_tokens for multiple known pairs. The batch tool uses one prod-api batch request, accepts tokens across chains, preserves input order and duplicates, and omits identifiers that are not in the canonical list. Use ekubo_search_tokens only when resolving a name, symbol, or address fragment.

For LP discovery, use ekubo_get_positions_by_owner instead of attempting ERC721 enumeration. Its response joins canonical token metadata and USD prices and attaches an exact pending eth_call to each supported EVM position. For the interface-equivalent detail payload (metadata, history, campaigns, rewards, prices, and the atomic current-state query), call ekubo_get_position with the same owner, chain, manager, and token ID. Read ekubo://docs/lp-position-workflow. Never split TWAMM execution or Ve33 reward accumulation from the following position read: those calls must stay in the supplied single Multicall3 eth_call and must never be broadcast.

For creating an LP position, call ekubo_get_position_pool_candidates with the pair. Do not browse prod-api, manually derive pool IDs, or inspect manager ABIs. Show the candidate's Core generation, exact pool key, extension, manager, TVL, depth, volume, and fees. If the user selects a new configuration not yet indexed, pass its exact pool_key with pool_initialized=false and initial_tick to ekubo_prepare_lp_position_deposit; the tool derives the pool ID and prepends maybeInitializePool. If the wallet lacks one side, prepare and execute that funding swap separately, wait for its successful receipt, measure the actual new token balance, reserve native gas, and only then prepare the deposit from the measured available amounts; never treat a quote's expected output as a settled balance. The deposit tool computes a nonzero minimum liquidity, approvals, initialization, native refund, allowance cleanup, decoded calls, wallet-policy requirements, and a complete execution_plan.

For “collect my LP fees” or “claim my LP rewards”, call ekubo_prepare_lp_position_earnings_claim with the connected owner wallet, manager, and token ID from ekubo_get_positions_by_owner. It automatically uses v2 zero-liquidity fee withdrawal, v3 collectFees, or Ve33 claimRewards and never removes liquidity, burns, or transfers the NFT. Execute its current_state_query through available wallet call tooling, verify the pending owner, then pass the decoded fees or rewards and execution_plan to the wallet for simulation and authorization. Never infer or manually encode the manager function.

For a partial or full LP withdrawal, first execute the position's current_state_query and select an exact positive liquidity amount, then call ekubo_prepare_lp_position_withdraw. It automatically chooses the correct v2/v3 withdraw overload or Ve33 withdrawAndClaimRewards, collects fees or rewards exactly as the interface does, and returns the entire transaction list. Verify pending ownership and sufficient liquidity, include principal plus earnings and recipient in the wallet handoff, and give the unchanged execution_plan to the wallet MCP. The wallet must never construct calldata, choose an overload, or add a claim transaction.

Pass LP execution plans to the wallet MCP for simulation, wallet-owned authorization, and execution; never use Cast to reconstruct LP calldata. Do not insert a separate agent confirmation step. If wallet policy rejects a plan, report its exact target, spender, recipient, selector, or native-value finding and do not attempt to change wallet policy.

For every other EVM action exposed by the interface, use its first-class prepare tool: wrap/unwrap, LP position transfer, pool price correction, TWAMM/DCA creation/collection/stop/virtual-order execution, auction creation/completion/creator proceeds, manual boosts, oracle capacity, approval revocation, old gEKUBO unwrap, incentive rewards, Recovery Fund claims, revenue buybacks, and direct VeToken increase/merge/withdraw. Phased tools return exact eth_call or EIP-712 requests and tell the caller which decoded values to send back. The wallet performs those reads or signatures but must not invent calldata, append approvals, build multicalls, or choose transaction ordering.

Use ekubo_get_pool for one exact chain/core/pool ID and ekubo_get_pool_liquidity for tick-level depth. Use ekubo_derive_pool_id and ekubo_decode_pool_config for PoolKey construction and inspection. A pool fee is an exact uint64 Q64 integer: accept and return it only as a decimal or hexadecimal string, never a JSON number.

For VeToken vote reorganization, first call ekubo_get_ve33_allocations and show the owner, state_id, total applied vote weight, every pool allocation, and contributing ve_ids. Pass that exact state_id to ekubo_prepare_ve33_reallocation. Never construct raw vote, clearVote, extendStake, mergeStakes, withdrawStake, or burn calldata from the ABI resource when a first-class safe workflow exists.

For "update my STONX allocations to the suggested allocations", call ekubo_get_stonx_allocation_recommendation, require execution_ready=true, at most 25 targets, and an exact 10,000-bps target total, then call ekubo_get_ve33_allocations for the connected wallet. Validate its onchain request and pass its exact state_id, recommendation targets, and strategy=compact_max_lock to ekubo_prepare_ve33_reallocation. Pass the surviving NFT, every source NFT burned by a compound merge, the maximum four-year extension, exactly one final voting NFT per target, every decoded call, and the complete plan to the wallet.

For "reinvest my fees", call ekubo_prepare_ve33_reinvest with phase=claim and omit claims so it discovers and claims every active allocation. Take the supplied pre-claim balance snapshots, then use phase=swap with only the exact claimed deltas so it prepares one exact-input swap per non-stake token. After receipts confirm, refresh allocations and use phase=stake_all with its exact state_id and the measured STONX output. Never swap a wallet's pre-existing balance.

For a new stake, use ekubo_prepare_ve33_stake; max duration is the default when no duration is supplied. For an existing stake, pass current_pool_key when it is voted so ekubo_prepare_ve33_extend uses a compound fee claim before extension; omit it only for an unvoted VeToken. max_duration=true must be an explicit choice.

Every active source vote must be claimed unconditionally before that vote is cleared or moved, even when claimable fees are currently zero. Preserve the returned compact claim-and-extend, claim-and-merge, split, and vote order in one VeToken multicall. Execute and decode onchain_validation.eth_call immediately before signing, simulate the exact transaction from sender, and discard the plan after any state change or failed expectation.`;

const AGENT_WORKFLOW = `# Safe Ekubo swap and bridge workflow

1. Search the token list when resolving a name or symbol. For exact identifiers, use ekubo_get_token for one chain/address pair or ekubo_get_tokens for up to 1,000 pairs in one batch. Show the chosen chains and addresses to the user.
2. Convert the user amount to base units without floating-point arithmetic.
3. Set destination_chain_id explicitly for a bridge. Raw addresses and eip155:<chain>:<address> token IDs are accepted.
4. Request an exact-input or exact-output quote. source=auto compares Ekubo and 0x on one chain and selects Across across chains.
5. Prepare executable calldata with the user's chosen slippage tolerance and sender.
6. Include the provider, exact plan ID, token amounts, chains, slippage bound, recipient, approvals, execution transaction, and any allowance reset in the wallet handoff.
7. Pass the complete plan to the user's wallet tooling for balance, allowance, policy, and exact-transaction simulation. Do not ask for separate agent-level confirmation.
8. Let the wallet present the simulated result, collect authorization or signature, and submit. Never send credentials to this server.
9. Re-quote and revalidate after any change, expiry, or stale block.
`;

const LP_POSITION_WORKFLOW = `# Ekubo LP position data and onchain state

Ekubo position NFTs are not ERC721-enumerable. Start with \`ekubo_get_positions_by_owner\`; do not scan \`tokenOfOwnerByIndex\`. The owner response includes the interface's indexed portfolio-row inputs (PoolKey, bounds, position liquidity, pool state, incentive rewards), current canonical token metadata and USD prices, and one exact pending state query per supported EVM position.

For a detail view, call \`ekubo_get_position\` with the owner, chain, positions manager, and token ID from that list. It returns:

- the exact indexed position snapshot;
- NFT metadata, including its salt and mint transaction;
- position history events used for fee/reward APR;
- active incentive campaigns and indexed earned rewards;
- pool, reward, and STONX token metadata with \`decimals\` and \`usd_price\`;
- the pending onchain state query used by the interface.

## Execute the current-state query

Send \`current_state_query.rpc_request\` unchanged to an EIP-155 JSON-RPC endpoint for \`chain_id\`. It is a single Multicall3 \`eth_call\` at \`pending\`. Decode the outer \`aggregate3\` result as \`(bool success, bytes returnData)[]\`, then decode the indicated nested result indexes using the listed result fields. Serialize decoded integers as decimal strings in JSON.

Standard Positions return \`liquidity, principal0, principal1, fees0, fees1\`. Ve33Positions return \`liquidity, principal0, principal1, rewardAmount\`; ordinary swap fees are zero for that manager. \`ownerOf\` is included in the same aggregate so the caller can reject stale indexed ownership.

TWAMM positions prepend \`lockAndExecuteVirtualOrders\`. Ve33 positions prepend \`maybeAccumulateRewards\`. Those are state-changing functions run only inside the read-only EVM simulation. Keep the refresh and state read inside the supplied ordered aggregate: separate eth_calls would discard the simulated refresh before the state read. Never broadcast the Multicall3 payload.

## USD values and historical APR

For each raw amount, divide by \`10^token.decimals\`, multiply by the matching \`token.usd_price\`, and sum token0 and token1. Current principal USD uses \`principal0\` and \`principal1\`; current fee USD uses \`fees0\` and \`fees1\`. Missing prices make USD values unavailable.

To reproduce all-time APR, find the latest \`update\` event in \`position_history\` and replay the identical aggregate at event block + 1. For 1-day or 7-day APR, resolve the block closest to pending timestamp minus the interval, then replay at that block. Reuse the same aggregate \`to\` and \`data\`; replace only the JSON-RPC block parameter with a hexadecimal block quantity. Add any \`collect_fees\` amounts (or \`claim_rewards\` for Ve33) since the start snapshot, value them using the current token prices as the interface does, divide earnings by current principal USD, and annualize by elapsed seconds. Do not report APR when liquidity changed between snapshots or required price/history data is unavailable.

The indexed \`pool_state\` is appropriate for portfolio range math and discovery. The pending contract simulation is authoritative for immediately withdrawable principal, uncollected fees or accumulated Ve33 rewards, and current ownership.

## Discover and prepare a deposit

Call \`ekubo_get_position_pool_candidates\` with the chain and token pair. It replaces direct data-API browsing and ABI inspection by returning every indexed candidate above the requested TVL floor, including verified PoolKey/config, Core generation, extension type, exact statistics, and the correct Positions manager. The default zero TVL floor is intentional for position creation because it keeps initialized pools with negligible liquidity visible.

Once the user selects a v3 pool configuration, range, maximum token amounts, and slippage, call \`ekubo_prepare_lp_position_deposit\`. For an indexed pool, provide pool_id. For a new pool, provide the exact pool_key, pool_initialized=false, and initial_tick; the tool derives the ID and prepends \`maybeInitializePool\` before minting. It calculates expected liquidity with shared SDK math, derives a nonzero minimum liquidity, selects Positions or Ve33Positions, and returns exact approvals, initialization/deposit/refund calldata, optional allowance cleanup, owner validation, decoded intent, wallet-policy requirements, and \`execution_plan\`.

If the wallet needs a preliminary swap to acquire one side, use \`ekubo_prepare_swap\` as a separate plan. Pass it to the wallet MCP so the wallet simulates it, presents the simulated result, collects authorization or signature, submits it, and returns a successful receipt. Then read the actual resulting balance or balance delta, preserve enough native token for gas, and call the LP preparer with the measured maxima. Do not combine the deposit with an unsettled swap or size it from quoted output alone.

Do not encode \`mintAndDeposit\`, \`deposit\`, \`multicall\`, or \`refundNativeToken\` with Cast. Give the returned execution plan unchanged to the user's wallet MCP for sequential simulation, wallet-owned authorization, and submission. Do not insert a separate agent confirmation step. The wallet remains authoritative for allowed targets, approval spenders, native-value limits, known selectors, connected account, and chain. This server cannot loosen wallet policy.

## Collect fees or claim rewards

Call \`ekubo_prepare_lp_position_earnings_claim\` with the connected owner wallet, chain, positions manager, and token ID returned by \`ekubo_get_positions_by_owner\`. Standard v3 Positions use \`collectFees\`; legacy v2 Positions use the explicit \`withdraw\` overload with liquidity zero and \`withFees=true\`; Ve33Positions use \`claimRewards\`. The recipient defaults to the sender and may be supplied explicitly. None of these paths withdraws principal, burns the NFT, or transfers it.

Execute the returned \`onchain_validation.current_state_query\` exactly as supplied at \`pending\`, preferably through the wallet's call API. Verify its decoded owner is the sender and pass \`fees0/fees1\` for standard positions or \`rewardAmount\` for Ve33 to the wallet with the unchanged \`execution_plan\`. The wallet performs exact simulation, presents the result, collects authorization or signature, and submits. Do not reconstruct the calldata with Cast or infer a manager function from an ABI resource.

## Withdraw liquidity

Execute the position's current-state query and choose an exact positive uint128 liquidity amount, then call \`ekubo_prepare_lp_position_withdraw\`. The preparer resolves PoolKey and bounds from the owner index and mirrors the interface: standard v2/v3 withdrawals collect fees, while Ve33 uses \`withdrawAndClaimRewards\`. Partial and full withdrawals use the same tool; compare the requested liquidity with the decoded pending liquidity, not only the informational indexed snapshot.

The returned execution plan contains the complete transaction list. The wallet must not select a function overload, reconstruct calldata, append a separate fee/reward claim, or burn the NFT. Verify the pending owner, sufficient liquidity, decoded principal and earnings, recipient, and exact manager call, then pass the complete context and plan to the wallet for simulation and authorization. Discard and rebuild the plan after any position-state change.
`;

const EXECUTION_PLAN_WORKFLOW = `# Ekubo execution plan handoff

Every executable preparation result includes an execution_plan object. It is the canonical boundary between this non-custodial Ekubo MCP server and a signing wallet.

## Bind the sender first

Choose the actual signing account before calling a preparation tool and pass that exact address as sender. Prefer the connected account exposed by wallet tooling. Use a local Cast account only when the user explicitly selected Cast execution and the account. Never infer "my wallet" from a local keystore or environment without that direction.

After preparation, require execution_plan.chain_id and sender to match the wallet's observed chain and account. A mismatch invalidates the plan; do not rewrite the sender or silently switch networks.

## Execute ordered_steps

Each step contains the same unsigned call in two encodings:

- transaction has decimal chain_id, value, and optional gas with exact from, to, and data fields for wallet APIs that accept transaction objects.
- eip1193 contains ready-to-forward eth_call, eth_estimateGas, and eth_sendTransaction requests with hexadecimal JSON-RPC quantities for compatible providers or separately trusted wallet MCP servers.

Process steps sequentially. Check whether an approval is still required from current allowance; if submitted, wait for its successful receipt. Revalidate and estimate the execution immediately before signing it. Submit allowance_cleanup only after the main execution receipt succeeds. Stop on any rejection, revert, failed receipt, chain/account change, expired quote, or changed plan.

## Wallet tooling adapter

Treat wallet tooling as a separate trust boundary from this public Ekubo server. When a wallet MCP or wallet API exposes call, simulation, authorization, and submission abstractions, use those directly and pass the exact execution_plan unchanged. Do not translate the plan into Cast or manually issue RPC calls when the wallet already wraps those operations. Do not ask the user for a separate agent-level confirmation; the wallet must simulate the exact plan, present the simulated result, collect authorization or signature, and submit it. Never provide a private key, mnemonic, or wallet credential to either MCP server.

## Optional Cast fallback

Use Cast only when the user explicitly selected it or no compatible wallet abstraction is available. For each step, verify the RPC chain ID. Simulate with cast call TO --data DATA --from SENDER --value VALUE. Estimate the identical bytes with cast estimate TO DATA --from SENDER --value VALUE. Submit those same bytes with cast send TO DATA plus the user's selected --account, --keystore, or hardware-wallet option and --value VALUE; rely on that wallet/signing interface for authorization. Recheck chain ID immediately before every send and independently fetch each receipt. Raw calldata is passed differently by Cast subcommands: call uses --data, while estimate and send use DATA as the positional signature argument. Do not reconstruct calldata from a displayed function description.
`;

const QUOTER_API = `# Ekubo aggregated quote contract

Same-chain source=auto requests compare the Ekubo quoter and 0x Swap API v2.
Cross-chain requests use Across Swap API /swap/approval. Provider API keys are
server-side and are never accepted as tool arguments.

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

MCP callers should use ekubo_get_quote or ekubo_prepare_swap instead of
constructing provider URLs themselves.
`;

const VE33_WORKFLOW = `# Ekubo ve(3,3) call workflow

- For "my Ekubo STONX allocations" on Robinhood Chain, call ekubo_get_ve33_allocations with only the connected wallet address as owner. The production Ve33 deployment is for STONX, so it selects chain 4663 and the canonical VeToken automatically. If the client does not expose a connected address, ask the user; never infer ownership from a local keystore or environment.
- The VeToken ERC721 owns the canonical Ve33 stake. The wallet must own or be approved for each ve_id.
- splitStake must move a positive amount smaller than the source stake. The source keeps its vote with reduced weight; the new child starts unvoted.
- Replacing or clearing a vote discards pending fee accounting unless fees are claimed first. Every compiler claims each active source unconditionally before that source vote is cleared or moved, including when claimable fees are zero.
- Extending moves the stake to a new end time and clears its vote. For a voted token, provide current_pool_key so the extension tool uses a compound claim-and-extend method. Omit it only for an unvoted token, where direct extension cannot discard voter fees.
- Pool keys may use an exact bytes32 config or data-API fields: fee, tick_spacing, extension, and optional stableswap_params.
- For claim-all, use ekubo_prepare_ve33_claim_all_fees to discover the owner's indexed active votes and obtain one VeToken multicall plus ownerOf/voteState validation calldata. Revalidate those calls through the user's provider before signing.
- For any vote reorganization, first use ekubo_get_ve33_allocations and show the complete allocation plus state_id. Pass that exact state_id and target weight_bps values totaling 10,000 to ekubo_prepare_ve33_reallocation.
- preserve_existing_locks allocates every distinct expiry cohort proportionally across every target so pool weights decay together; it may require more voting NFTs than target pools and does not guarantee a 25-NFT portfolio.
- For a suggested STONX update, first call ekubo_get_stonx_allocation_recommendation. Use its at-most-25 executable targets only when execution_ready is true and target_total_weight_bps is exactly 10,000, then pass strategy=compact_max_lock to the normal state-validated reallocation workflow.
- compact_max_lock selects one surviving active NFT, claims its fees and extends it to the maximum four-year duration, then fee-safely claims and merges every other active NFT into it, splits once per additional target, and applies exactly one NFT vote per target. Never detach or reorder those calls.
- Compound merges burn their source NFT IDs after moving the stake. Pass every burned ID, the survivor, the lock extension, final NFT count, decoded calls, and complete plan to the wallet. Unvoted NFTs remain outside the reallocation scope; withdrawals and direct burn calldata remain forbidden.
- Raw VeToken vote, clearVote, extendStake*, and full-source mergeStakes calls can discard pending voter fees. Prefer the fee-preserving tools or compound claim methods. Never call burn on a stake-bearing NFT; it can orphan the underlying stake. Withdraw only an expired stake, claim its active-pool fees first, and verify the recipient.
- Reinvestment takes three sequential wallet phases: snapshot balances and automatically claim all active allocations, swap each complete post-claim delta exact-input into the stake token, then refresh portfolio state and use stake_all to apportion the complete output across every existing active allocation without replacing its vote. Each executable phase is passed to the wallet, which owns simulation and authorization.
- New stakes default to stakeMaxDuration and affect no existing NFT. Existing lock extension is intentionally explicit because it clears the vote; the extension tool uses a compound fee claim before either max-duration or custom-duration extension.
- transferOwnership, ownership handover, ERC721 transfer/approval, safe transfer, and burn are forbidden in every first-class workflow.
- Re-read ownership, stake amount, active vote, fee balances, allowances, and contract code before signing every plan.
`;
