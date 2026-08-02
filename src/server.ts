import {
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import { type Address, getAddress, numberToHex } from "viem";
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
  getVe33Allocations,
  prepareAllVe33FeeClaims,
  prepareVe33Claim,
  prepareVe33Extend,
  prepareVe33Reallocation,
  prepareVe33Reinvest,
  prepareVe33Split,
  prepareVe33Stake,
  prepareVe33Vote,
  type Ve33PoolKeyInput,
} from "./ve33.js";
import { getStonxAllocationRecommendation } from "./recommendations.js";
import {
  MCP_SERVER_VERSION,
  MCP_TOOL_CATALOG_REVISION,
} from "./version.js";

export const ROBINHOOD_STONX_CHAIN_ID = "4663";
export const ROBINHOOD_STONX_VE_TOKEN = getAddress(
  "0x9d7008E169D040B6c0140eb92E7cA82B12643497",
);
export const ROBINHOOD_STONX_VE33 = getAddress(
  "0xD18685a514E59b06d59824e16Db07e73345d9953",
);

const chainId = z
  .string()
  .regex(/^[0-9]+$/, "chain_id must contain decimal digits")
  .describe("Decimal EVM chain ID, matching the Ekubo token list");
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
    current_pool_key: poolKeySchema.describe(
      "Required active pool key; extension is available only through the atomic claim-and-extend methods",
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
  sender: address.describe("VeToken owner that will execute the atomic multicall"),
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
      "Fetch a firm Ekubo, 0x, or Across quote and generate unsigned approval plus execution calldata. The client uses the user's connected wallet or provider to validate, sign, and submit.",
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
      "Generate only a compound claim-and-extend VeToken call. An active current_pool_key is required so extension cannot discard pending voter fees.",
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
          chainId: chain_id,
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
          chainId: chain_id,
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
            chainId: token.chain_id,
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
        const destinationChainId = input.destination_chain_id ?? input.chain_id;
        return getQuote(env, {
          chainId: input.chain_id,
          destinationChainId,
          tokenIn: tokenAddress(input.token_in, input.chain_id, "token_in"),
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
        const destinationChainId = input.destination_chain_id ?? input.chain_id;
        return prepareSwap(env, {
          chainId: input.chain_id,
          destinationChainId,
          tokenIn: tokenAddress(input.token_in, input.chain_id, "token_in"),
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
          chainId: input.chain_id,
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
          chainId: input.chain_id,
          veToken: input.ve_token as Address,
          sender: input.sender as Address,
          veId: input.ve_id,
          durationSeconds: input.duration_seconds,
          maxDuration: input.max_duration,
          currentPoolKey: mapPoolKey(input.current_pool_key),
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
          chainId: input.chain_id,
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
          chainId: input.chain_id,
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
          chainId: input.chain_id,
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
          chainId: input.chain_id,
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
          chainId: input.chain_id,
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
          chainId: input.chain_id ?? ROBINHOOD_STONX_CHAIN_ID,
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
          chainId: input.chain_id,
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

  server.registerResource(
    "ekubo-agent-workflow",
    "ekubo://docs/agent-workflow",
    {
      title: "Safe Ekubo swap and bridge workflow",
      description:
        "Canonical token lookup, quote, preparation, wallet validation, and confirmation sequence",
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

const SERVER_INSTRUCTIONS = `Use Ekubo preparation tools only to construct unsigned plans. Never sign or submit without showing the exact plan_id and receiving explicit user confirmation. Never construct or request transferOwnership, ownership handover, ERC721 transfer/approval, or burn calldata. Ownership and NFT transfer actions are outside this server's safe workflows.

Intent shortcut: for "my Ekubo STONX allocations", "STONX vote allocations", or equivalent requests, call ekubo_get_ve33_allocations with only the user's connected EVM wallet as owner. The production Ve33 deployment is the STONX voting system, and the tool selects Robinhood Chain 4663 plus its canonical VeToken when chain_id and ve_token are omitted. If the connected wallet address is unavailable, ask the user for it. Never infer the user's wallet from a machine environment, repository configuration, local keystore, or unrelated account.

For exact token metadata, call ekubo_get_token for one known chain/address pair and ekubo_get_tokens for multiple known pairs. The batch tool uses one prod-api batch request, accepts tokens across chains, preserves input order and duplicates, and omits identifiers that are not in the canonical list. Use ekubo_search_tokens only when resolving a name, symbol, or address fragment.

For VeToken vote reorganization, first call ekubo_get_ve33_allocations and show the owner, state_id, total applied vote weight, every pool allocation, and contributing ve_ids. Pass that exact state_id to ekubo_prepare_ve33_reallocation. Never construct raw vote, clearVote, extendStake, mergeStakes, withdrawStake, or burn calldata from the ABI resource when a first-class safe workflow exists.

For "update my STONX allocations to the suggested allocations", call ekubo_get_stonx_allocation_recommendation, require execution_ready=true, at most 25 targets, and an exact 10,000-bps target total, then call ekubo_get_ve33_allocations for the connected wallet. Validate its onchain request and pass its exact state_id, recommendation targets, and strategy=compact_max_lock to ekubo_prepare_ve33_reallocation. Before confirmation, show the surviving NFT, every source NFT burned by a compound merge, the maximum four-year extension, exactly one final voting NFT per target, and every decoded call.

For "reinvest my fees", call ekubo_prepare_ve33_reinvest with phase=claim and omit claims so it discovers and claims every active allocation. Take the supplied pre-claim balance snapshots, then use phase=swap with only the exact claimed deltas so it prepares one exact-input swap per non-stake token. After receipts confirm, refresh allocations and use phase=stake_all with its exact state_id and the measured STONX output. Never swap a wallet's pre-existing balance.

For a new stake, use ekubo_prepare_ve33_stake; max duration is the default when no duration is supplied. Extending an existing stake is destructive to its vote, so use ekubo_prepare_ve33_extend only with the current pool key; its compound call claims fees first, and max_duration=true must be an explicit choice.

Every active source vote must be claimed unconditionally before that vote is cleared or moved, even when claimable fees are currently zero. Preserve the returned compact claim-and-extend, claim-and-merge, split, and vote order in one VeToken multicall. Execute and decode onchain_validation.eth_call immediately before signing, simulate the exact transaction from sender, and discard the plan after any state change or failed expectation.`;

const AGENT_WORKFLOW = `# Safe Ekubo swap and bridge workflow

1. Search the token list when resolving a name or symbol. For exact identifiers, use ekubo_get_token for one chain/address pair or ekubo_get_tokens for up to 1,000 pairs in one batch. Show the chosen chains and addresses to the user.
2. Convert the user amount to base units without floating-point arithmetic.
3. Set destination_chain_id explicitly for a bridge. Raw addresses and eip155:<chain>:<address> token IDs are accepted.
4. Request an exact-input or exact-output quote. source=auto compares Ekubo and 0x on one chain and selects Across across chains.
5. Prepare executable calldata with the user's chosen slippage tolerance and sender.
6. Present the provider, exact plan ID, token amounts, chains, slippage bound, recipient, approvals, execution transaction, and any allowance reset.
7. Validate balances, allowances, contract targets, and the exact transaction through the user's connected wallet or provider.
8. Require explicit user confirmation before signing.
9. Ask the user's wallet or signature tooling to sign and submit. Never send credentials to this server.
10. Re-quote and revalidate after any change, expiry, or stale block.
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
- Extending moves the stake to a new end time and clears its vote. The extension tool requires current_pool_key and exposes only compound claim-and-extend methods.
- Pool keys may use an exact bytes32 config or data-API fields: fee, tick_spacing, extension, and optional stableswap_params.
- For claim-all, use ekubo_prepare_ve33_claim_all_fees to discover the owner's indexed active votes and obtain one VeToken multicall plus ownerOf/voteState validation calldata. Revalidate those calls through the user's provider before signing.
- For any vote reorganization, first use ekubo_get_ve33_allocations and show the complete allocation plus state_id. Pass that exact state_id and target weight_bps values totaling 10,000 to ekubo_prepare_ve33_reallocation.
- preserve_existing_locks allocates every distinct expiry cohort proportionally across every target so pool weights decay together; it may require more voting NFTs than target pools and does not guarantee a 25-NFT portfolio.
- For a suggested STONX update, first call ekubo_get_stonx_allocation_recommendation. Use its at-most-25 executable targets only when execution_ready is true and target_total_weight_bps is exactly 10,000, then pass strategy=compact_max_lock to the normal state-validated reallocation workflow.
- compact_max_lock selects one surviving active NFT, claims its fees and extends it to the maximum four-year duration, then fee-safely claims and merges every other active NFT into it, splits once per additional target, and applies exactly one NFT vote per target. Never detach or reorder those calls.
- Compound merges burn their source NFT IDs after moving the stake. Show every burned ID, the survivor, the lock extension, final NFT count, and decoded calls before requesting confirmation. Unvoted NFTs remain outside the reallocation scope; withdrawals and direct burn calldata remain forbidden.
- Raw VeToken vote, clearVote, extendStake*, and full-source mergeStakes calls can discard pending voter fees. Prefer the fee-preserving tools or compound claim methods. Never call burn on a stake-bearing NFT; it can orphan the underlying stake. Withdraw only an expired stake, claim its active-pool fees first, and verify the recipient.
- Reinvestment takes three confirmations: snapshot balances and automatically claim all active allocations, swap each complete post-claim delta exact-input into the stake token, then refresh portfolio state and use stake_all to apportion the complete output across every existing active allocation without replacing its vote.
- New stakes default to stakeMaxDuration and affect no existing NFT. Existing lock extension is intentionally explicit because it clears the vote; the extension tool uses a compound fee claim before either max-duration or custom-duration extension.
- transferOwnership, ownership handover, ERC721 transfer/approval, safe transfer, and burn are forbidden in every first-class workflow.
- Re-read ownership, stake amount, active vote, fee balances, allowances, and contract code before signing every plan.
`;
