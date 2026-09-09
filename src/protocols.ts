import { uniswapTools } from "./uniswap/tools.js";
/**
 * The protocol partition behind the per-protocol MCP endpoints.
 *
 * `/mcp` serves every tool and stays the backwards-compatible endpoint. Each
 * `/mcp/<slug>` serves exactly the tools of one protocol, so an agent that only
 * ever stakes with Lido carries six tool definitions in its context instead of
 * eighty-four.
 *
 * The partition is exhaustive and disjoint by construction: `protocols.test.ts`
 * checks the union of every list here against `publicToolCatalog`, so a tool
 * added to the catalog without a protocol fails the build rather than quietly
 * appearing on no endpoint.
 */

export const PROTOCOL_SLUGS = [
  "ekubo",
  "aave",
  "aerodrome",
  "lido",
  "merkl",
  "morpho",
  "sky",
  "uniswap",
] as const;

export type ProtocolSlug = (typeof PROTOCOL_SLUGS)[number];

export type ProtocolDescriptor = {
  readonly slug: ProtocolSlug;
  /** Server title reported over MCP and in the discovery documents. */
  readonly title: string;
  readonly description: string;
  /** The `use-<name>` skill this protocol ships, where it has one. */
  readonly skill: string | null;
  readonly tools: readonly string[];
};

/**
 * Everything the catalog carries that is not one of the six satellite
 * protocols: Ekubo's own pools, positions, TWAMM, auctions, ve(3,3), and the
 * token, quote, transfer, and approval tools that are Ekubo-native rather than
 * shared infrastructure.
 *
 * Token lookup is deliberately not duplicated onto the satellite endpoints.
 * Each of those protocols discovers its own assets — `get_aave_v3_markets`,
 * `get_morpho_vaults`, `get_sky_savings_deployment`, `get_lido_deployment` and
 * the Aerodrome Sugar reads all return symbols and decimals — so a
 * single-protocol server stays self-contained without importing the canonical
 * token list's tools alongside it.
 */
const EKUBO_TOOLS = [
  "list_tokens",
  "export_tokens",
  "get_token",
  "get_tokens",
  "get_quotes_with_plans",
  "get_value_transfer_status",
  "prepare_ve33_vote",
  "prepare_ve33_extend",
  "prepare_ve33_stake",
  "prepare_ve33_split",
  "prepare_ve33_claim_fees",
  "prepare_ve33_reinvest",
  "prepare_ve33_claim_all_fees",
  "prepare_ve33_clear_vote",
  "get_ve33_allocations",
  "get_stonx_allocation_recommendation",
  "prepare_ve33_reallocation",
  "get_positions_by_owner",
  "get_pool",
  "get_pool_liquidity",
  "list_pool_keys",
  "derive_pool_id",
  "decode_pool_config",
  "get_position",
  "get_position_pool_candidates",
  "prepare_lp_position_deposit",
  "prepare_lp_position_earnings_claim",
  "prepare_lp_position_withdraw",
  "prepare_wrap_unwrap",
  "prepare_transfers",
  "prepare_lp_position_transfer",
  "prepare_fix_pool_price",
  "prepare_twamm_order",
  "prepare_twamm_order_collection",
  "prepare_twamm_order_stop",
  "prepare_twamm_virtual_orders",
  "prepare_auction_create",
  "prepare_auction_complete",
  "prepare_auction_creator_proceeds",
  "prepare_manual_pool_boost",
  "prepare_oracle_capacity_expansion",
  "prepare_approval_revocations",
  "prepare_old_gekubo_unwrap",
  "get_rewards_claims_by_owner",
  "prepare_rewards_claim",
  "prepare_revenue_buybacks",
  "prepare_ve33_increase_stake",
  "prepare_ve33_merge",
  "prepare_ve33_withdraw",
  "get_liquidity_opportunities",
  "prepare_pool_initialization",
] as const;

export const PROTOCOLS: readonly ProtocolDescriptor[] = [
  {
    slug: "ekubo",
    title: "Ekubo Protocol",
    description:
      "Ekubo swaps and bridges, pools, LP positions, TWAMM, auctions, incentives, and ve(3,3) STONX voting",
    skill: null,
    tools: EKUBO_TOOLS,
  },
  {
    slug: "aave",
    title: "Aave V3",
    description:
      "Aave V3 core market discovery and signer-neutral supply, withdraw, borrow, repay, collateral, and eMode preparation",
    skill: null,
    tools: [
      "get_aave_v3_markets",
      "prepare_aave_v3_supply",
      "prepare_aave_v3_withdraw",
      "prepare_aave_v3_borrow",
      "prepare_aave_v3_repay",
      "prepare_aave_v3_collateral",
      "prepare_aave_v3_emode",
    ],
  },
  {
    slug: "aerodrome",
    title: "Aerodrome",
    description:
      "Aerodrome Sugar lens reads and signer-neutral liquidity, gauge, lock, vote, and incentive-claim preparation on Base",
    skill: "use-aerodrome",
    tools: [
      "get_aerodrome_deployment",
      "prepare_aerodrome_sugar_reads",
      "prepare_aerodrome_liquidity_deposit",
      "prepare_aerodrome_liquidity_withdraw",
      "prepare_aerodrome_gauge_deposit",
      "prepare_aerodrome_gauge_withdraw",
      "prepare_aerodrome_gauge_claim",
      "prepare_aerodrome_lock",
      "prepare_aerodrome_vote",
      "prepare_aerodrome_incentive_claim",
    ],
  },
  {
    slug: "lido",
    title: "Lido",
    description:
      "Lido deployment discovery and signer-neutral staking, wrapping, and unstETH withdrawal preparation",
    skill: "use-lido",
    tools: [
      "get_lido_deployment",
      "prepare_lido_stake",
      "prepare_lido_wrap",
      "prepare_lido_unwrap",
      "prepare_lido_withdrawal_request",
      "prepare_lido_withdrawal_claim",
    ],
  },
  {
    slug: "merkl",
    title: "Merkl",
    description:
      "Merkl deployment discovery and proof-verified reward claim preparation",
    skill: "use-merkl",
    tools: ["get_merkl_deployment", "prepare_merkl_claim"],
  },
  {
    slug: "morpho",
    title: "Morpho",
    description:
      "Morpho Vault V2 discovery and signer-neutral deposit, withdraw, and redeem preparation through the guarded Bundler3 route",
    skill: "use-morpho",
    tools: [
      "get_morpho_vaults",
      "prepare_morpho_vault_deposit",
      "prepare_morpho_vault_withdraw",
      "prepare_morpho_vault_redeem",
    ],
  },
  {
    slug: "sky",
    title: "Sky",
    description:
      "Sky savings deployment discovery and signer-neutral sUSDS deposit, withdraw, and redeem preparation",
    skill: "use-sky",
    tools: [
      "get_sky_savings_deployment",
      "prepare_sky_savings_deposit",
      "prepare_sky_savings_withdraw",
      "prepare_sky_savings_redeem",
    ],
  },
  {
    slug: "uniswap",
    title: "Uniswap",
    description:
      "Uniswap V2/V3/V4 pools, charts, positions, liquidity and fee claims across five EVM chains",
    skill: null,
    tools: uniswapTools.map((tool) => tool.name),
  },
];

/** Every protocol, which is what `/mcp` serves. */
export const ALL_PROTOCOLS: ReadonlySet<ProtocolSlug> = new Set(PROTOCOL_SLUGS);

const TOOL_PROTOCOLS: ReadonlyMap<string, ProtocolSlug> = new Map(
  PROTOCOLS.flatMap((protocol) =>
    protocol.tools.map((tool) => [tool, protocol.slug] as const),
  ),
);

/**
 * The protocol a tool belongs to, or `undefined` for a name the partition does
 * not cover. Registration treats `undefined` as "not on this endpoint" so a
 * catalog entry can never leak onto a single-protocol server by accident; the
 * partition test is what stops it from vanishing from `/mcp` too.
 */
export function toolProtocol(name: string): ProtocolSlug | undefined {
  return TOOL_PROTOCOLS.get(name);
}

export function protocolBySlug(
  slug: string,
): ProtocolDescriptor | undefined {
  return PROTOCOLS.find((protocol) => protocol.slug === slug);
}

/** Whether a tool should be registered on a server serving `protocols`. */
export function toolEnabled(
  name: string,
  protocols: ReadonlySet<ProtocolSlug>,
): boolean {
  const protocol = toolProtocol(name);
  return protocol !== undefined && protocols.has(protocol);
}

/** The `use-<name>` skills reachable from a server serving `protocols`. */
export function enabledSkillNames(
  protocols: ReadonlySet<ProtocolSlug>,
): ReadonlySet<string> {
  return new Set(
    PROTOCOLS.filter(
      (protocol) => protocol.skill !== null && protocols.has(protocol.slug),
    ).map((protocol) => protocol.skill as string),
  );
}

/**
 * The MCP path a protocol is served at. `/mcp` is not derived from a slug: it
 * is the pre-existing endpoint that serves every protocol, and it keeps that
 * meaning whatever the partition grows into.
 */
export function protocolMcpPath(slug: ProtocolSlug): string {
  return `/mcp/${slug}`;
}

export const ALL_PROTOCOLS_MCP_PATH = "/mcp";

/**
 * Resolve a request path to the protocol set its MCP server should serve.
 *
 * `/mcp` is every protocol, for the clients configured before the split.
 * `/mcp/<slug>` is exactly one. Anything else is not an MCP route, and the
 * caller falls through to the discovery handlers.
 */
export function matchMcpRoute(
  pathname: string,
): { route: string; protocols: ReadonlySet<ProtocolSlug> } | null {
  if (pathname === ALL_PROTOCOLS_MCP_PATH) {
    return { route: ALL_PROTOCOLS_MCP_PATH, protocols: ALL_PROTOCOLS };
  }
  const slug = pathname.startsWith("/mcp/")
    ? pathname.slice("/mcp/".length)
    : null;
  const protocol = slug === null ? undefined : protocolBySlug(slug);
  if (protocol === undefined) return null;
  return {
    route: protocolMcpPath(protocol.slug),
    protocols: new Set([protocol.slug]),
  };
}
