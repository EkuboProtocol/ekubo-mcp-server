import { type Address, getAddress, numberToHex } from "viem";
import { type Env, getTokens, ServiceError } from "./core.js";
import {
  buildPositionStateReadPlan,
  positionStateQuery,
  type IndexedPosition,
  positionTokenIdentifiers,
} from "./position-state.js";
import { canonicalChainId, normalizeChainIdFields } from "./pools.js";

type Fetcher = typeof fetch;

const VE33_POSITIONS_ADDRESS = getAddress(
  "0xdA38ac72CE7220c4dd7719d114ef94eDadb8f068",
);
const ROBINHOOD_STONX_ADDRESS = getAddress(
  "0x570C5aa79c798E7A418412cC8399ae5bcCe570C5",
);
const PAGE_SIZE = 200;
const MAX_PAGES = 25;

export async function getPosition(
  env: Env,
  input: {
    owner: string;
    chainId: string;
    positionsAddress: string;
    tokenId: string;
  },
  fetcher: Fetcher = fetch,
) {
  const owned = await getOwnedIndexedPosition(env, input, fetcher);
  const { owner, chainId, positionsAddress, tokenId, indexedPosition } = owned;
  const base = normalizedBase(env.EKUBO_API_URL);

  const metadataUrl = new URL(
    `/positions/${encodeURIComponent(chainId)}/${BigInt(positionsAddress)}/${tokenId}`,
    base,
  );
  const historyUrl = new URL(
    `/positions/${encodeURIComponent(chainId)}/${encodeURIComponent(positionsAddress)}/${tokenId}/history`,
    base,
  );
  const campaignsUrl = new URL("/campaigns", base);
  campaignsUrl.searchParams.set("chainId", chainId);

  const [metadata, history, campaignsResponse] = await Promise.all([
    fetchJson<Record<string, unknown>>(metadataUrl, fetcher),
    fetchJson<Record<string, unknown>>(historyUrl, fetcher),
    fetchJson<Record<string, unknown>>(campaignsUrl, fetcher),
  ]);
  const salt = metadataSalt(metadata);
  const rewardsUrl =
    salt === undefined
      ? undefined
      : new URL(
          `/rewards/${encodeURIComponent(chainId)}/${encodeURIComponent(positionsAddress)}/${encodeURIComponent(salt)}`,
          base,
        );
  const rewards =
    rewardsUrl === undefined
      ? { rewards: [] }
      : await fetchJson<Record<string, unknown>>(rewardsUrl, fetcher);

  const campaigns = Array.isArray(campaignsResponse.campaigns)
    ? campaignsResponse.campaigns
    : [];
  const tokenIdentifiers = uniqueTokenIdentifiers([
    ...positionTokenIdentifiers(indexedPosition),
    ...campaigns.flatMap((campaign) => {
      if (
        !isRecord(campaign) ||
        (typeof campaign.chain_id !== "string" &&
          typeof campaign.chain_id !== "number") ||
        typeof campaign.rewardToken !== "string"
      ) {
        return [];
      }
      return [
        {
          chainId: canonicalChainId(campaign.chain_id),
          address: campaign.rewardToken,
        },
      ];
    }),
    ...(positionsAddress === VE33_POSITIONS_ADDRESS && chainId === "4663"
      ? [{ chainId, address: ROBINHOOD_STONX_ADDRESS }]
      : []),
  ]);
  const tokens = await getTokens(
    env,
    { tokens: tokenIdentifiers },
    fetcher,
  );
  const currentStateQuery = positionStateQuery(
    buildPositionStateReadPlan(indexedPosition, owner),
    // Keep the aggregate's to/data inline here only: the interface-parity APR
    // guidance has the agent replay the identical read at historical blocks,
    // which a stored-bundle reference alone cannot support.
    { includeAggregateCall: true },
  );

  return {
    owner,
    chain_id: chainId,
    positions_address: positionsAddress,
    token_id: tokenId.toString(),
    indexed_position: indexedPosition,
    metadata: normalizeChainIdFields(metadata),
    position_history: normalizeChainIdFields(history),
    incentive_campaigns: normalizeChainIdFields(campaignsResponse),
    earned_rewards: normalizeChainIdFields(rewards),
    tokens,
    current_state_query: currentStateQuery,
    interface_parity: {
      current_values:
        "Pass current_state_query.read_calls_reference unchanged as wallet_batch_eth_call's reference argument. The wallet decodes on the user's device; retain raw return data, require every inner call to succeed, and compare the decoded owner with expected_owner.",
      usd_values:
        "Divide token amounts by 10^decimals, multiply by the matching token usd_price, and sum token0 plus token1. The interface treats missing or zero prices as unavailable.",
      apr_history:
        "position_history supplies update, collect_fees, and claim_rewards events. For all-time APR, replay current_state_query.aggregate_call at one block after the latest update. For 1d/7d APR, resolve the block at the target timestamp and replay there. Add fees collected or rewards claimed since that point before annualizing against current principal USD value.",
      indexed_vs_onchain:
        "indexed_position.liquidity and pool_state power the portfolio row and range math. The pending aggregate call powers the detail view and includes uncollected fees or current Ve33 rewards.",
    },
    sources: {
      indexed_owner_positions:
        `${base}positions/${encodeURIComponent(owner)}?chainId=${encodeURIComponent(chainId)}`,
      metadata: metadataUrl.toString(),
      history: historyUrl.toString(),
      campaigns: campaignsUrl.toString(),
      rewards: rewardsUrl?.toString() ?? null,
      token_metadata:
        `${base}tokens/batch (exact identifiers are included in this response)`,
      onchain:
        "User-selected EIP-155 RPC endpoint via the stored current_state_query read bundle",
    },
    cache: {
      mcp_result_storage: "wallet_read_bundles_only",
      owner_positions_upstream_cache_control: "no-cache",
      token_prices_interface_refetch_seconds: 30,
      onchain_block_parameter: "pending",
    },
  };
}

export async function getOwnedIndexedPosition(
  env: Env,
  input: {
    owner: string;
    chainId: string;
    positionsAddress: string;
    tokenId: string;
  },
  fetcher: Fetcher = fetch,
) {
  const owner = normalizeAddress(input.owner);
  const chainId = canonicalChainId(input.chainId);
  const positionsAddress = normalizeAddress(input.positionsAddress);
  const tokenId = unsigned(input.tokenId, "token_id");
  const indexedPosition = await findIndexedPosition(
    normalizedBase(env.EKUBO_API_URL),
    { owner, chainId, positionsAddress, tokenId },
    fetcher,
  );
  return { owner, chainId, positionsAddress, tokenId, indexedPosition };
}

async function findIndexedPosition(
  base: string,
  input: {
    owner: Address;
    chainId: string;
    positionsAddress: Address;
    tokenId: bigint;
  },
  fetcher: Fetcher,
): Promise<IndexedPosition> {
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page += 1) {
    if (page > MAX_PAGES) {
      throw new ServiceError(
        "too_many_positions",
        `Position lookup supports at most ${PAGE_SIZE * MAX_PAGES} indexed owner positions`,
      );
    }
    const url = new URL(`/positions/${encodeURIComponent(input.owner)}`, base);
    url.searchParams.set("chainId", input.chainId);
    url.searchParams.set("pageSize", PAGE_SIZE.toString());
    url.searchParams.set("page", page.toString());
    const response = await fetchJson<Record<string, unknown>>(url, fetcher);
    if (!Array.isArray(response.data) || !isRecord(response.pagination)) {
      throw new ServiceError(
        "invalid_upstream_response",
        "Position ownership response must contain data and pagination",
      );
    }
    const normalized = normalizeChainIdFields(response.data);
    const found = normalized.find(
      (position): position is IndexedPosition =>
        isIndexedPosition(position) &&
        BigInt(position.positions_address) === BigInt(input.positionsAddress) &&
        BigInt(position.id) === input.tokenId,
    );
    if (found !== undefined) return found;

    const upstreamTotalPages = response.pagination.totalPages;
    if (
      typeof upstreamTotalPages !== "number" ||
      !Number.isInteger(upstreamTotalPages) ||
      upstreamTotalPages < 0
    ) {
      throw new ServiceError(
        "invalid_upstream_response",
        "Position ownership response has invalid totalPages",
      );
    }
    totalPages = upstreamTotalPages;
  }
  throw new ServiceError(
    "position_not_found",
    "No indexed position matched owner, chain, positions contract, and token ID",
  );
}

function metadataSalt(metadata: Record<string, unknown>) {
  if (!Array.isArray(metadata.attributes)) return undefined;
  for (const attribute of metadata.attributes) {
    if (
      isRecord(attribute) &&
      attribute.trait_type === "salt" &&
      typeof attribute.value === "string"
    ) {
      return attribute.value;
    }
  }
  return undefined;
}

function isIndexedPosition(value: unknown): value is IndexedPosition {
  if (!isRecord(value) || !isRecord(value.pool_key) || !isRecord(value.bounds)) {
    return false;
  }
  return (
    (typeof value.chain_id === "string" || typeof value.chain_id === "number") &&
    typeof value.id === "string" &&
    typeof value.positions_address === "string" &&
    typeof value.pool_key.token0 === "string" &&
    typeof value.pool_key.token1 === "string" &&
    typeof value.pool_key.fee === "string" &&
    typeof value.pool_key.extension === "string" &&
    typeof value.bounds.lower === "number" &&
    typeof value.bounds.upper === "number"
  );
}

function normalizeAddress(value: string): Address {
  try {
    return getAddress(numberToHex(BigInt(value), { size: 20 }));
  } catch {
    throw new ServiceError(
      "invalid_address",
      `address must fit in 20 bytes: ${value}`,
    );
  }
}

function unsigned(value: string, label: string) {
  if (!/^(?:(?:0|[1-9][0-9]*)|0x[0-9a-fA-F]+)$/.test(value)) {
    throw new ServiceError(
      "invalid_input",
      `${label} must be an unsigned decimal or hexadecimal integer`,
    );
  }
  return BigInt(value);
}

function uniqueTokenIdentifiers(
  tokens: { chainId: string; address: string }[],
) {
  const seen = new Set<string>();
  return tokens.filter((token) => {
    const key = `${BigInt(token.chainId)}:${BigInt(token.address)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchJson<T>(url: URL, fetcher: Fetcher): Promise<T> {
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
    throw new ServiceError(
      "upstream_error",
      `${response.status} ${response.statusText} from ${url}`,
      body,
    );
  }
  return body as T;
}

function normalizedBase(url: string): string {
  return `${url.replace(/\/+$/, "")}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
