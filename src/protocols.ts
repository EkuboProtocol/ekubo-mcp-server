import { uniswapTools } from "./uniswap/tools.js";
import { safeTools } from "./safe.js";

export const PROTOCOL_SLUGS = [
  "ekubo",
  "ekubo-advanced",
  "aave",
  "aerodrome",
  "lido",
  "merkl",
  "morpho",
  "sky",
  "uniswap",
  "safe",
  "moonpay",
] as const;

export type ProtocolSlug = (typeof PROTOCOL_SLUGS)[number];

/** Served only at their own /mcp/<slug>; never bundled into /mcp or combinable in a facet. */
export const STANDALONE_PROTOCOLS: ReadonlySet<ProtocolSlug> = new Set(["safe", "moonpay"]);

export type ProtocolDescriptor = {
  readonly slug: ProtocolSlug;
  readonly title: string;
  readonly description: string;
  readonly skill: string | null;
  readonly tools: readonly string[];
};

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
  "get_position",
  "get_position_pool_candidates",
  "prepare_lp_position_deposit",
  "prepare_lp_position_earnings_claim",
  "prepare_lp_position_withdraw",
  "prepare_wrap_unwrap",
  "prepare_transfers",
  "prepare_lp_position_transfer",
  "get_rewards_claims_by_owner",
  "prepare_rewards_claim",
  "prepare_ve33_increase_stake",
  "prepare_ve33_merge",
  "prepare_ve33_withdraw",
  "get_liquidity_opportunities",
] as const;

const EKUBO_ADVANCED_TOOLS = [
  "list_pool_keys",
  "derive_pool_id",
  "decode_pool_config",
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
  "prepare_revenue_buybacks",
  "prepare_pool_initialization",
] as const;

export const PROTOCOLS: readonly ProtocolDescriptor[] = [
  {
    slug: "ekubo",
    title: "Ekubo Protocol",
    description:
      "Ekubo swaps and bridges, tokens, pools, LP positions, transfers, rewards, and ve(3,3) STONX voting",
    skill: null,
    tools: EKUBO_TOOLS,
  },
  {
    slug: "ekubo-advanced",
    title: "Ekubo Protocol advanced",
    description:
      "Ekubo auctions, TWAMM orders, pool initialization and price fixes, oracle capacity, manual boosts, revenue buybacks, old gEKUBO unwrap, approval revocations, and pool-key enumeration",
    skill: null,
    tools: EKUBO_ADVANCED_TOOLS,
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
      "Morpho Vault V2 discovery and signer-neutral deposit, withdraw, and redeem preparation through the guarded VaultBundlesV1 route",
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
      "Uniswap V2/V3/V4 pools, charts, positions, liquidity and fee claims across six EVM chains",
    skill: null,
    tools: uniswapTools.map((tool) => tool.name),
  },
  {
    slug: "safe",
    title: "Safe",
    description: "Safe owner typed-data signatures and signer actions; separate endpoint only, excluded from /mcp",
    skill: null,
    tools: safeTools.map((tool) => tool.name),
  },
  {
    slug: "moonpay",
    title: "MoonPay (sandbox)",
    description: "Signed MoonPay sandbox checkout links to buy ETH or USDC with a card; test mode only, no real payments; separate endpoint only, excluded from /mcp",
    skill: null,
    tools: ["create_moonpay_buy_link"],
  },
];

export const ALL_PROTOCOLS: ReadonlySet<ProtocolSlug> = new Set(PROTOCOL_SLUGS.filter((slug) => !STANDALONE_PROTOCOLS.has(slug)));

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

export function toolEnabled(
  name: string,
  protocols: ReadonlySet<ProtocolSlug>,
): boolean {
  const protocol = toolProtocol(name);
  return protocol !== undefined && protocols.has(protocol);
}

export function enabledSkillNames(
  protocols: ReadonlySet<ProtocolSlug>,
): ReadonlySet<string> {
  return new Set(
    PROTOCOLS.filter(
      (protocol) => protocol.skill !== null && protocols.has(protocol.slug),
    ).map((protocol) => protocol.skill as string),
  );
}

export function protocolMcpPath(slug: ProtocolSlug): string {
  return `/mcp/${slug}`;
}

export const ALL_PROTOCOLS_MCP_PATH = "/mcp";

export const FACET_QUERY_PARAMETER = "protocols";

export function isAllProtocols(protocols: ReadonlySet<ProtocolSlug>): boolean {
  return (
    protocols.size === ALL_PROTOCOLS.size &&
    [...ALL_PROTOCOLS].every((slug) => protocols.has(slug))
  );
}

export function canonicalProtocols(
  protocols: ReadonlySet<ProtocolSlug>,
): ProtocolSlug[] {
  return PROTOCOL_SLUGS.filter((slug) => protocols.has(slug));
}

export function facetMcpUrl(
  origin: string,
  protocols: ReadonlySet<ProtocolSlug>,
): string {
  const slugs = canonicalProtocols(protocols);
  if (slugs.length === 1) return `${origin}${protocolMcpPath(slugs[0]!)}`;
  if (isAllProtocols(protocols)) return `${origin}${ALL_PROTOCOLS_MCP_PATH}`;
  return `${origin}${ALL_PROTOCOLS_MCP_PATH}?${FACET_QUERY_PARAMETER}=${slugs.join("+")}`;
}

export type FacetSelection =
  | { readonly protocols: ReadonlySet<ProtocolSlug> }
  | { readonly error: string };

export function parseProtocolFacet(query: URLSearchParams): FacetSelection | null {
  if (!query.has(FACET_QUERY_PARAMETER)) return null;
  const names = query
    .getAll(FACET_QUERY_PARAMETER)
    .flatMap((value) => value.split(/[+\s,]+/))
    .filter((name) => name.length > 0);
  const bundled = [...ALL_PROTOCOLS].join(", ");
  if (names.length === 0) {
    return { error: `Name at least one protocol. Known protocols: ${bundled}.` };
  }
  if (names.length > PROTOCOL_SLUGS.length * 2) {
    return { error: "Too many protocol names." };
  }
  const protocols = new Set<ProtocolSlug>();
  for (const name of names) {
    const protocol = protocolBySlug(name);
    if (protocol !== undefined && STANDALONE_PROTOCOLS.has(protocol.slug)) {
      return { error: `${protocol.title} is served only at /mcp/${protocol.slug} and cannot be combined with other protocols.` };
    }
    if (protocol === undefined) {
      return { error: `Unknown protocol. Known protocols: ${bundled}.` };
    }
    protocols.add(protocol.slug);
  }
  return { protocols: isAllProtocols(protocols) ? ALL_PROTOCOLS : protocols };
}

export function matchMcpRoute(
  pathname: string,
  query: URLSearchParams = new URLSearchParams(),
):
  | { route: string; protocols: ReadonlySet<ProtocolSlug> }
  | { route: string; error: string }
  | null {
  if (pathname === ALL_PROTOCOLS_MCP_PATH) {
    const facet = parseProtocolFacet(query);
    if (facet === null) {
      return { route: ALL_PROTOCOLS_MCP_PATH, protocols: ALL_PROTOCOLS };
    }
    return { route: ALL_PROTOCOLS_MCP_PATH, ...facet };
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
