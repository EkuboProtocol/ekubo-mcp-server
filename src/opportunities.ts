import {
  type Abi,
  encodeFunctionData,
  getAddress,
  numberToHex,
  type Address,
} from "viem";
import {
  functionResultDecodePlan,
  localWalletDecoderHandoff,
} from "./abi-decode.js";
import {
  type Env,
  getTokens,
  getVe33Pools,
  ServiceError,
} from "./core.js";
import {
  canonicalChainId,
  derivePoolId,
  normalizeChainIdFields,
} from "./pools.js";

export type LiquidityOpportunityType =
  | "boosted_fees"
  | "incentive"
  | "ve33_emissions";

export interface Ve33EmissionStateInput {
  currentTimestamp: string;
  currentEmissionRate: string;
  totalRemainingEmissions: string;
}

export interface LiquidityOpportunityInput {
  chainId?: string;
  types: LiquidityOpportunityType[];
  token?: string;
  minApr?: number;
  limit: number;
  ve33EmissionState?: Ve33EmissionStateInput;
}

type Fetcher = typeof fetch;
type JsonRecord = Record<string, unknown>;

const PRODUCTION_OPPORTUNITY_CHAIN_IDS = new Set([
  "1",
  "42161",
  "8453",
  "4663",
  BigInt("0x534e5f4d41494e").toString(),
]);
const EVM_OPPORTUNITY_CHAIN_IDS = new Set(["1", "42161", "8453", "4663"]);
const ROBINHOOD_CHAIN_ID = "4663";
const ROBINHOOD_TESTNET_CHAIN_ID = "46630";
const ROBINHOOD_VE33 = getAddress(
  "0xD18685a514E59b06d59824e16Db07e73345d9953",
);
const ROBINHOOD_VE33_DATA_FETCHER = getAddress(
  "0x61F03754b1c7A7F0E584FD8869c00Ba898ab888d",
);
const ROBINHOOD_STONX = getAddress(
  "0x570C5aa79c798E7A418412cC8399ae5bcCe570C5",
);
const Q32 = 1n << 32n;
const SECONDS_PER_DAY = 86_400n;

const VE33_DATA_FETCHER_ABI = [
  {
    type: "function",
    name: "getEmissionState",
    inputs: [],
    outputs: [
      {
        name: "state",
        type: "tuple",
        internalType: "struct Ve33EmissionState",
        components: [
          { name: "currentTimestamp", type: "uint64", internalType: "uint64" },
          {
            name: "currentEmissionRate",
            type: "uint160",
            internalType: "uint160",
          },
          {
            name: "totalRemainingEmissions",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "futureEmissionRateChanges",
            type: "tuple[]",
            internalType: "struct Ve33EmissionRateChange[]",
            components: [
              { name: "time", type: "uint64", internalType: "uint64" },
              {
                name: "emissionRateDelta",
                type: "int256",
                internalType: "int256",
              },
              {
                name: "emissionRateAfter",
                type: "uint160",
                internalType: "uint160",
              },
            ],
          },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const satisfies Abi;

export async function getLiquidityOpportunities(
  env: Env,
  input: LiquidityOpportunityInput,
  fetcher: Fetcher = fetch,
  nowMs = Date.now(),
) {
  const selectedTypes = new Set(input.types);
  const chainId = input.chainId;
  if (
    chainId !== undefined &&
    !PRODUCTION_OPPORTUNITY_CHAIN_IDS.has(chainId)
  ) {
    throw new ServiceError(
      "unsupported_opportunity_chain",
      "Liquidity opportunities match the production chains shown by the Ekubo interface",
      {
        requested_chain_id: chainId,
        supported_chain_ids: [...PRODUCTION_OPPORTUNITY_CHAIN_IDS],
      },
    );
  }
  const tokenFilter =
    input.token === undefined ? undefined : canonicalNumericHex(input.token);
  const base = normalizedBase(env.EKUBO_API_URL);
  const pairsUrl = apiUrl(base, "/overview/pairs", chainId);
  const boostedUrl = apiUrl(base, "/overview/boosted-fees-pools", chainId);
  const campaignsUrl = apiUrl(base, "/campaigns", chainId);
  const includesRobinhood = chainId === undefined || chainId === ROBINHOOD_CHAIN_ID;

  const [pairsResponse, boostedResponse, campaignsResponse, ve33Response] =
    await Promise.all([
      selectedTypes.has("incentive")
        ? fetchJson<JsonRecord>(pairsUrl, fetcher)
        : Promise.resolve({ topPairs: [] }),
      selectedTypes.has("boosted_fees")
        ? fetchJson<JsonRecord>(boostedUrl, fetcher)
        : Promise.resolve({ pools: [] }),
      selectedTypes.has("incentive")
        ? fetchJson<JsonRecord>(campaignsUrl, fetcher)
        : Promise.resolve({ campaigns: [] }),
      includesRobinhood &&
      (selectedTypes.has("ve33_emissions") || selectedTypes.has("incentive"))
        ? getVe33Pools(
            env,
            { chainId: ROBINHOOD_CHAIN_ID, ve33: ROBINHOOD_VE33 },
            fetcher,
          )
        : Promise.resolve({
            sourceUrl: null,
            pools: [] as JsonRecord[],
            totalItems: 0,
            totalVoteWeight: "0",
          }),
    ]);

  const topPairs = recordArray(pairsResponse, "topPairs", "top pair").filter(
    (pair) => isIncludedChain(pair.chain_id, chainId),
  );
  const boostedPools = recordArray(
    boostedResponse,
    "pools",
    "boosted pool",
  ).filter((pool) => isIncludedEvmChain(pool.chain_id, chainId));
  const campaigns = recordArray(
    campaignsResponse,
    "campaigns",
    "campaign",
  ).filter(
    (campaign) =>
      isIncludedChain(campaign.chain_id, chainId) &&
      campaignIsActive(campaign, nowMs),
  );
  const ve33Pools = ve33Response.pools.map((pool) =>
    normalizeChainIdFields(pool),
  );
  const totalVoteWeight = unsigned(
    ve33Response.totalVoteWeight ?? "0",
    "total_vote_weight",
  );
  const hasRobinhoodIncentivePair =
    selectedTypes.has("incentive") &&
    topPairs.some(
      (pair) =>
        chainField(pair) === ROBINHOOD_CHAIN_ID &&
        campaigns.some(
          (campaign) =>
            chainField(campaign) === ROBINHOOD_CHAIN_ID &&
            campaignContainsPair(campaign, pair),
        ),
    );
  const needsEmissionState =
    includesRobinhood &&
    (selectedTypes.has("ve33_emissions") || hasRobinhoodIncentivePair) &&
    totalVoteWeight > 0n &&
    ve33Pools.some(
      (pool) => unsignedField(pool, "pool_total_vote_weight") > 0n,
    );

  const tokenIdentifiers = uniqueTokens([
    ...boostedPools.flatMap((pool) => poolTokens(pool)),
    ...campaigns.flatMap((campaign) => campaignTokens(campaign)),
    ...ve33Pools.flatMap((pool) => poolTokens(pool)),
    ...(ve33Pools.length === 0
      ? []
      : [{ chainId: ROBINHOOD_CHAIN_ID, address: ROBINHOOD_STONX }]),
  ]);
  const tokens =
    tokenIdentifiers.length === 0
      ? []
      : await getTokens(env, { tokens: tokenIdentifiers }, fetcher);
  const tokenMap = new Map(
    tokens
      .filter(isRecord)
      .map((token) => [tokenIdentity(token), normalizeChainIdFields(token)]),
  );

  const emissionState =
    input.ve33EmissionState === undefined
      ? undefined
      : validateEmissionState(input.ve33EmissionState);
  const projections = projectVe33Emissions(
    ve33Pools,
    totalVoteWeight,
    emissionState?.currentEmissionRate,
  );
  const opportunities: JsonRecord[] = [];

  if (selectedTypes.has("boosted_fees")) {
    for (const pool of boostedPools) {
      const boosts = recordField(pool, "boosts", true);
      if (
        boosts === null ||
        (unsignedField(boosts, "donate_rate0") === 0n &&
          unsignedField(boosts, "donate_rate1") === 0n)
      ) {
        continue;
      }
      if (!matchesTokenFilter(pool, tokenFilter)) continue;
      const chain = chainField(pool);
      const token0 = findToken(tokenMap, chain, stringField(pool, "token0"));
      const token1 = findToken(tokenMap, chain, stringField(pool, "token1"));
      const denominatorUsd = poolAprDenominator(pool, token0, token1);
      const feesUsd24h = tokenPairUsd(
        stringField(pool, "fees0_24h"),
        stringField(pool, "fees1_24h"),
        token0,
        token1,
      );
      const apr =
        feesUsd24h === null || denominatorUsd <= 0
          ? null
          : (feesUsd24h * 365) / denominatorUsd;
      const exactPool = exactEvmPool(pool, chain);
      opportunities.push({
        type: "boosted_fees",
        id: `boosted:${chain}:${exactPool.core_address}:${exactPool.pool_id}`,
        apr,
        apr_percent: percent(apr),
        apr_complete: true,
        apr_components: { observed_pool_fees_apr: apr },
        apr_denominator_usd: denominatorUsd,
        fees_usd_24h: feesUsd24h,
        tokens: { token0, token1 },
        pool: { ...exactPool, stats: normalizeChainIdFields(pool), boosts },
        next_step: exactPoolNextStep(exactPool),
      });
    }
  }

  if (selectedTypes.has("ve33_emissions")) {
    const rewardToken = findToken(
      tokenMap,
      ROBINHOOD_CHAIN_ID,
      ROBINHOOD_STONX,
    );
    for (const pool of ve33Pools) {
      const voteWeight = unsignedField(pool, "pool_total_vote_weight");
      const projectedAmount = projections.byPool.get(poolIdentity(pool));
      if (
        (projectedAmount !== undefined && projectedAmount === 0n) ||
        (projectedAmount === undefined && voteWeight === 0n)
      ) {
        continue;
      }
      if (!matchesTokenFilter(pool, tokenFilter)) continue;
      const chain = chainField(pool);
      const token0 = findToken(tokenMap, chain, stringField(pool, "token0"));
      const token1 = findToken(tokenMap, chain, stringField(pool, "token1"));
      const denominatorUsd = poolAprDenominator(pool, token0, token1);
      const projectedUsd =
        projectedAmount === undefined
          ? null
          : tokenAmountUsd(projectedAmount.toString(), rewardToken);
      const apr =
        projectedUsd === null || denominatorUsd <= 0
          ? null
          : (projectedUsd * 365) / denominatorUsd;
      const exactPool = exactEvmPool(pool, chain);
      opportunities.push({
        type: "ve33_emissions",
        id: `ve33:${chain}:${stringField(pool, "pool_key_id")}`,
        apr,
        apr_percent: percent(apr),
        apr_complete: projectedAmount !== undefined,
        apr_components: { projected_stonx_emissions_apr: apr },
        apr_denominator_usd: denominatorUsd,
        projected_emissions_24h:
          projectedAmount === undefined ? null : projectedAmount.toString(),
        projected_emissions_usd_24h: projectedUsd,
        pool_total_vote_weight: voteWeight.toString(),
        tokens: { token0, token1, reward: rewardToken },
        pool: { ...exactPool, stats: normalizeChainIdFields(pool) },
        next_step: exactPoolNextStep(exactPool),
      });
    }
  }

  if (selectedTypes.has("incentive")) {
    for (const pair of topPairs) {
      if (!matchesTokenFilter(pair, tokenFilter)) continue;
      const chain = chainField(pair);
      const token0 = findToken(tokenMap, chain, stringField(pair, "token0"));
      const token1 = findToken(tokenMap, chain, stringField(pair, "token1"));
      if (token0 === undefined || token1 === undefined) continue;
      const denominatorUsd = pairAprDenominator(pair, token0, token1);
      const matchingCampaigns = campaignAprs(
        campaigns,
        chain,
        token0,
        token1,
        tokenMap,
        denominatorUsd,
      );
      const incentiveApr = matchingCampaigns.reduce(
        (total, campaign) => total + campaign.apr,
        0,
      );
      if (incentiveApr === 0) continue;
      const feesUsd24h = tokenPairUsd(
        stringField(pair, "fees0_24h"),
        stringField(pair, "fees1_24h"),
        token0,
        token1,
      );
      const pairProjection = projections.byPair.get(
        pairIdentity(chain, token0.address as string, token1.address as string),
      );
      const rewardToken = findToken(
        tokenMap,
        ROBINHOOD_CHAIN_ID,
        ROBINHOOD_STONX,
      );
      const projectedUsd =
        chain !== ROBINHOOD_CHAIN_ID
          ? 0
          : pairProjection === undefined
            ? null
            : tokenAmountUsd(pairProjection.toString(), rewardToken);
      const pairApr =
        feesUsd24h === null ||
        denominatorUsd <= 0 ||
        projectedUsd === null
          ? null
          : ((feesUsd24h + projectedUsd) * 365) / denominatorUsd;
      const totalApr = pairApr === null ? incentiveApr : pairApr + incentiveApr;
      opportunities.push({
        type: "incentive",
        id: `incentive:${chain}:${token0.address}:${token1.address}`,
        chain_family: EVM_OPPORTUNITY_CHAIN_IDS.has(chain) ? "evm" : "starknet",
        apr: totalApr,
        apr_percent: percent(totalApr),
        apr_complete:
          chain !== ROBINHOOD_CHAIN_ID || pairProjection !== undefined,
        apr_components: {
          pair_fees_and_ve33_emissions_apr: pairApr,
          active_incentives_apr: incentiveApr,
          ve33_emissions_usd_24h: projectedUsd,
        },
        apr_denominator_usd: denominatorUsd,
        fees_usd_24h: feesUsd24h,
        tokens: { token0, token1 },
        pair: normalizeChainIdFields(pair),
        active_campaigns: matchingCampaigns,
        next_step: incentiveNextStep(chain, token0, token1),
      });
    }
  }

  opportunities.sort(compareOpportunityApr);
  const filtered = opportunities.filter((opportunity) => {
    if (input.minApr === undefined) return true;
    const apr = opportunity.apr;
    return typeof apr === "number" && apr >= input.minApr;
  });
  const rankingComplete = !needsEmissionState || emissionState !== undefined;
  const readRequirement =
    needsEmissionState && emissionState === undefined
      ? ve33EmissionStateReadRequirement()
      : null;

  return {
    status: rankingComplete ? "complete" : "provisional_local_read_required",
    ranking_complete: rankingComplete,
    interface_parity:
      rankingComplete
        ? "complete"
        : "Ve33 opportunity APRs and Robinhood incentive pair APRs require the supplied wallet-local emission-state read before ranking is final.",
    evaluated_at: new Date(nowMs).toISOString(),
    filters: {
      chain_id: chainId ?? null,
      types: input.types,
      token: input.token ?? null,
      min_apr: input.minApr ?? null,
      limit: input.limit,
    },
    opportunities: filtered.slice(0, input.limit),
    opportunity_count_before_limit: filtered.length,
    local_read_requirement: readRequirement,
    ve33_projection_input:
      emissionState === undefined
        ? null
        : {
            source: "wallet_locally_decoded_getEmissionState",
            current_timestamp: emissionState.currentTimestamp.toString(),
            current_emission_rate: emissionState.currentEmissionRate.toString(),
            total_remaining_emissions:
              emissionState.totalRemainingEmissions.toString(),
            observed_timestamp_iso: timestampIso(emissionState.currentTimestamp),
            age_seconds:
              nowMs / 1_000 - Number(emissionState.currentTimestamp),
          },
    methodology: {
      parity_source:
        "Ekubo interface useLiquidityOpportunities: boostedFees, incentive, and ve33 opportunity calculations",
      sorting: "Descending APR; unavailable APR sorts last.",
      apr_units: "APR is a ratio: 1.0 means 100%. apr_percent is APR multiplied by 100.",
      boosted_fees:
        "Annualizes the pool's observed 24-hour fees over the interface APR denominator and includes only pools with a nonzero current donation rate.",
      incentives:
        "Adds active campaign rewards to pair fees and, on Robinhood Chain, projected pair-level STONX emissions.",
      ve33_emissions:
        "Projects 24-hour STONX emissions from current Q32 emission rate and indexed vote weights, then annualizes over the interface APR denominator.",
      denominator:
        "Robinhood Chain uses TVL; other chains use quoted depth. Missing token prices make the affected APR unavailable.",
      risk:
        "These are annualized snapshots, not guaranteed returns. Fees, prices, vote weights, incentives, liquidity concentration, range selection, and impermanent loss can change materially.",
    },
    sources: {
      pairs: selectedTypes.has("incentive") ? pairsUrl.toString() : null,
      boosted_fees: selectedTypes.has("boosted_fees")
        ? boostedUrl.toString()
        : null,
      campaigns: selectedTypes.has("incentive")
        ? campaignsUrl.toString()
        : null,
      ve33_pools: ve33Response.sourceUrl,
      token_metadata: `${base}tokens/batch`,
    },
    cache: {
      mcp_result_storage: "none",
      upstream_max_age_seconds: {
        pairs: 600,
        boosted_fees: 600,
        campaigns: 300,
        ve33_pools: 30,
      },
    },
  };
}

function ve33EmissionStateReadRequirement() {
  const data = encodeFunctionData({
    abi: VE33_DATA_FETCHER_ABI,
    functionName: "getEmissionState",
  });
  const decode = functionResultDecodePlan(
    VE33_DATA_FETCHER_ABI,
    "getEmissionState",
  );
  return {
    purpose:
      "Complete the interface-equivalent ve33 emission projection and final opportunity ranking using data decoded on the user's device.",
    status: "not_executed",
    chain_id: ROBINHOOD_CHAIN_ID,
    caip2_chain_id: `eip155:${ROBINHOOD_CHAIN_ID}`,
    contract: {
      address: ROBINHOOD_VE33_DATA_FETCHER,
      name: "Ve33DataFetcher",
      resource_uri: `ekubo://contracts/evm/${ROBINHOOD_CHAIN_ID}/${ROBINHOOD_VE33_DATA_FETCHER}`,
    },
    block_parameter: "pending",
    rpc_request: {
      method: "eth_call",
      params: [{ to: ROBINHOOD_VE33_DATA_FETCHER, data }, "pending"],
    },
    local_decode_plan: decode,
    result_decoder: localWalletDecoderHandoff({
      chainId: ROBINHOOD_CHAIN_ID,
      id: "ve33-emission-state",
      to: ROBINHOOD_VE33_DATA_FETCHER,
      data,
      decode,
    }),
    resume:
      {
        tool: "ekubo_get_liquidity_opportunities",
        preserve_original_arguments: true,
        arguments: {
          ve33_emission_state: {
            current_timestamp:
              "<preferred_tool.results[0].decoded.currentTimestamp>",
            current_emission_rate:
              "<preferred_tool.results[0].decoded.currentEmissionRate>",
            total_remaining_emissions:
              "<preferred_tool.results[0].decoded.totalRemainingEmissions>",
          },
        },
      },
  };
}

function projectVe33Emissions(
  pools: JsonRecord[],
  totalVoteWeight: bigint,
  currentEmissionRate: bigint | undefined,
) {
  const byPool = new Map<string, bigint>();
  const pairWeights = new Map<string, bigint>();
  const byPair = new Map<string, bigint>();
  for (const pool of pools) {
    const chain = chainField(pool);
    const weight = unsignedField(pool, "pool_total_vote_weight");
    const pair = pairIdentity(
      chain,
      stringField(pool, "token0"),
      stringField(pool, "token1"),
    );
    pairWeights.set(pair, (pairWeights.get(pair) ?? 0n) + weight);
    if (currentEmissionRate !== undefined) {
      byPool.set(
        poolIdentity(pool),
        totalVoteWeight === 0n
          ? 0n
          : (currentEmissionRate * SECONDS_PER_DAY * weight) /
              (Q32 * totalVoteWeight),
      );
    }
  }
  if (currentEmissionRate !== undefined) {
    for (const [pair, weight] of pairWeights) {
      byPair.set(
        pair,
        totalVoteWeight === 0n
          ? 0n
          : (currentEmissionRate * SECONDS_PER_DAY * weight) /
              (Q32 * totalVoteWeight),
      );
    }
  }
  return { byPool, byPair };
}

function exactEvmPool(pool: JsonRecord, chainId: string) {
  const token0 = evmAddress(stringField(pool, "token0"));
  const token1 = evmAddress(stringField(pool, "token1"));
  const extension = evmAddress(stringField(pool, "extension"));
  const indexedPoolKey = isRecord(pool.pool_key) ? pool.pool_key : undefined;
  const stable =
    pool.stableswap_params !== undefined
      ? recordField(pool, "stableswap_params", true)
      : indexedPoolKey !== undefined
        ? recordField(indexedPoolKey, "stableswap_params", true)
        : invalidField("stableswap_params");
  const tickSpacing = pool.tick_spacing;
  const derived = derivePoolId({
    token0,
    token1,
    fee: stringField(pool, "fee"),
    extension,
    tickSpacing:
      tickSpacing === null || tickSpacing === undefined
        ? null
        : typeof tickSpacing === "number" || typeof tickSpacing === "string"
          ? tickSpacing
          : invalidField("tick_spacing"),
    stableswapParams:
      stable === null
        ? null
        : {
            centerTick: numberField(stable, "center_tick"),
            amplification: numberField(stable, "amplification"),
          },
  });
  const indexedPoolId = unsignedField(pool, "pool_id");
  if (BigInt(derived.pool_id) !== indexedPoolId) {
    throw new ServiceError(
      "invalid_upstream_response",
      "Opportunity pool key does not derive to its indexed pool_id",
      {
        chain_id: chainId,
        indexed_pool_id: indexedPoolId.toString(),
        derived_pool_id: derived.pool_id,
      },
    );
  }
  const coreAddress = evmAddress(stringField(pool, "core_address"));
  return {
    chain_id: chainId,
    core_address: coreAddress,
    core_resource_uri: `ekubo://contracts/evm/${chainId}/${coreAddress}`,
    pool_id: derived.pool_id,
    pool_id_decimal: indexedPoolId.toString(),
    pool_key: derived.pool_key,
    decoded_config: derived.decoded_config,
  };
}

function exactPoolNextStep(pool: ReturnType<typeof exactEvmPool>) {
  return {
    inspect: {
      tool: "ekubo_get_pool",
      arguments: {
        chain_id: pool.chain_id,
        core_address: pool.core_address,
        pool_id: pool.pool_id,
      },
    },
    prepare_deposit: {
      tool: "ekubo_prepare_lp_position_deposit",
      arguments_template: {
        chain_id: pool.chain_id,
        sender: "<connected wallet address>",
        core_address: pool.core_address,
        pool_id: pool.pool_id,
        pool_initialized: true,
        mode: "mint",
        tick_lower: "<selected aligned lower tick>",
        tick_upper: "<selected aligned upper tick>",
        max_amount0: "<token0 base units>",
        max_amount1: "<token1 base units>",
        slippage_bps: "<user-selected basis points>",
      },
    },
  };
}

function incentiveNextStep(
  chainId: string,
  token0: JsonRecord,
  token1: JsonRecord,
) {
  if (!EVM_OPPORTUNITY_CHAIN_IDS.has(chainId)) {
    return {
      tool: null,
      execution_support: "discovery_only",
      reason:
        "This is a Starknet pair-level opportunity. The current MCP pool-candidate and deposit preparers are EVM-only; select an eligible exact Starknet pool through an interface or Starknet-capable protocol client.",
    };
  }
  return {
    tool: "ekubo_get_position_pool_candidates",
    arguments: {
      chain_id: chainId,
      token_a: token0.address,
      token_b: token1.address,
      min_tvl_usd: 0,
    },
    reason:
      "Incentives are pair-level. Select an eligible exact pool and extension before preparing a deposit.",
  };
}

function campaignAprs(
  campaigns: JsonRecord[],
  chainId: string,
  token0: JsonRecord,
  token1: JsonRecord,
  tokenMap: Map<string, JsonRecord>,
  pairDenominatorUsd: number,
): Array<JsonRecord & { apr: number }> {
  const matches: Array<JsonRecord & { apr: number }> = [];
  for (const campaign of campaigns) {
    if (chainField(campaign) !== chainId) continue;
    const pairs = recordArray(campaign, "pairs", "campaign pair");
    const pair = pairs.find(
      (candidate) =>
        sameNumericHex(stringField(candidate, "token0"), token0.address) &&
        sameNumericHex(stringField(candidate, "token1"), token1.address),
    );
    if (pair === undefined) continue;
    if (
      pair.daily_rewards_token0 === null &&
      pair.daily_rewards_token1 === null
    ) {
      continue;
    }
    if (pair.depth0 === null && pair.depth1 === null) continue;
    const rewardToken = findToken(
      tokenMap,
      chainId,
      stringField(campaign, "rewardToken"),
    );
    const rewardPrice = tokenUsdPrice(rewardToken);
    if (rewardToken === undefined || rewardPrice === null || rewardPrice === 0) {
      continue;
    }
    const dailyReward =
      unsigned(pair.daily_rewards_token0 ?? "0", "daily_rewards_token0") +
      unsigned(pair.daily_rewards_token1 ?? "0", "daily_rewards_token1");
    if (dailyReward === 0n) continue;
    const dailyRewardUsd = tokenAmountUsd(dailyReward.toString(), rewardToken);
    if (dailyRewardUsd === null) continue;
    const denominatorUsd = usesTvlForApr(chainId)
      ? pairDenominatorUsd
      : tokenPairDepthUsd(pair.depth0, pair.depth1, token0, token1);
    if (denominatorUsd <= 0) continue;
    const apr = (dailyRewardUsd * 365) / denominatorUsd;
    matches.push({
      slug: stringField(campaign, "slug"),
      name: stringField(campaign, "name"),
      start_time: stringField(campaign, "startTime"),
      end_time:
        campaign.endTime === null ? null : stringField(campaign, "endTime"),
      core_address: campaign.coreAddress,
      allowed_extensions: campaign.allowedExtensions,
      reward_token: rewardToken,
      daily_reward: dailyReward.toString(),
      daily_reward_usd: dailyRewardUsd,
      apr,
      apr_percent: percent(apr),
      campaign_pair: pair,
    });
  }
  return matches;
}

function validateEmissionState(input: Ve33EmissionStateInput) {
  const state = {
    currentTimestamp: unsigned(input.currentTimestamp, "current_timestamp"),
    currentEmissionRate: unsigned(
      input.currentEmissionRate,
      "current_emission_rate",
    ),
    totalRemainingEmissions: unsigned(
      input.totalRemainingEmissions,
      "total_remaining_emissions",
    ),
  };
  if (state.currentTimestamp > (1n << 64n) - 1n) {
    throw new ServiceError("invalid_input", "current_timestamp exceeds uint64");
  }
  if (state.currentEmissionRate > (1n << 160n) - 1n) {
    throw new ServiceError(
      "invalid_input",
      "current_emission_rate exceeds uint160",
    );
  }
  if (state.totalRemainingEmissions > (1n << 256n) - 1n) {
    throw new ServiceError(
      "invalid_input",
      "total_remaining_emissions exceeds uint256",
    );
  }
  return state;
}

function poolAprDenominator(
  pool: JsonRecord,
  token0: JsonRecord | undefined,
  token1: JsonRecord | undefined,
) {
  const stableswap = pool.tick_spacing === null || pool.tick_spacing === 0;
  return aprDenominator(
    chainField(pool),
    stableswap ? pool.tvl0_total : pool.depth0,
    stableswap ? pool.tvl1_total : pool.depth1,
    pool.tvl0_total,
    pool.tvl1_total,
    token0,
    token1,
  );
}

function pairAprDenominator(
  pair: JsonRecord,
  token0: JsonRecord,
  token1: JsonRecord,
) {
  return aprDenominator(
    chainField(pair),
    pair.depth0,
    pair.depth1,
    pair.tvl0_total,
    pair.tvl1_total,
    token0,
    token1,
  );
}

function aprDenominator(
  chainId: string,
  depth0: unknown,
  depth1: unknown,
  tvl0: unknown,
  tvl1: unknown,
  token0: JsonRecord | undefined,
  token1: JsonRecord | undefined,
) {
  return usesTvlForApr(chainId)
    ? tokenPairDepthUsd(tvl0, tvl1, token0, token1)
    : tokenPairDepthUsd(depth0, depth1, token0, token1);
}

function usesTvlForApr(chainId: string) {
  return (
    chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID
  );
}

function tokenPairUsd(
  amount0: string,
  amount1: string,
  token0: JsonRecord | undefined,
  token1: JsonRecord | undefined,
) {
  const usd0 = tokenAmountUsd(amount0, token0);
  const usd1 = tokenAmountUsd(amount1, token1);
  return usd0 === null || usd1 === null ? null : usd0 + usd1;
}

function tokenPairDepthUsd(
  amount0: unknown,
  amount1: unknown,
  token0: JsonRecord | undefined,
  token1: JsonRecord | undefined,
) {
  const usd0 = tokenAmountUsd(amount0 ?? "0", token0, true);
  const usd1 = tokenAmountUsd(amount1 ?? "0", token1, true);
  return (usd0 ?? 0) + (usd1 ?? 0);
}

function tokenAmountUsd(
  amount: unknown,
  token: JsonRecord | undefined,
  missingPriceAsZero = false,
) {
  if (token === undefined) return missingPriceAsZero ? 0 : null;
  const decimals = token.decimals;
  const price = tokenUsdPrice(token);
  if (
    typeof decimals !== "number" ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    price === null
  ) {
    return missingPriceAsZero ? 0 : null;
  }
  return baseUnitNumber(unsigned(amount, "token amount"), decimals) * price;
}

function tokenUsdPrice(token: JsonRecord | undefined) {
  if (token === undefined) return null;
  return token.usd_price === null
    ? null
    : typeof token.usd_price === "number" && Number.isFinite(token.usd_price)
      ? token.usd_price
      : null;
}

function baseUnitNumber(value: bigint, decimals: number) {
  const digits = value.toString().padStart(decimals + 1, "0");
  const decimal =
    decimals === 0
      ? digits
      : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
  return Number(decimal);
}

function poolTokens(pool: JsonRecord) {
  const chainId = chainField(pool);
  return [
    { chainId, address: stringField(pool, "token0") },
    { chainId, address: stringField(pool, "token1") },
  ];
}

function campaignTokens(campaign: JsonRecord) {
  const chainId = chainField(campaign);
  return [
    { chainId, address: stringField(campaign, "rewardToken") },
    ...recordArray(campaign, "pairs", "campaign pair").flatMap((pair) => [
      { chainId, address: stringField(pair, "token0") },
      { chainId, address: stringField(pair, "token1") },
    ]),
  ];
}

function uniqueTokens(tokens: { chainId: string; address: string }[]) {
  const seen = new Set<string>();
  return tokens.filter((token) => {
    const key = `${token.chainId}:${canonicalNumericHex(token.address)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findToken(
  tokenMap: Map<string, JsonRecord>,
  chainId: string,
  address: string,
) {
  return tokenMap.get(`${chainId}:${canonicalNumericHex(address)}`);
}

function tokenIdentity(token: JsonRecord) {
  return `${chainField(token)}:${canonicalNumericHex(stringField(token, "address"))}`;
}

function poolIdentity(pool: JsonRecord) {
  return `${chainField(pool)}:${unsignedField(pool, "pool_id")}`;
}

function pairIdentity(chainId: string, token0: unknown, token1: unknown) {
  if (typeof token0 !== "string" || typeof token1 !== "string") {
    return invalidField("pair token");
  }
  const a = BigInt(token0);
  const b = BigInt(token1);
  return a < b ? `${chainId}:${a}:${b}` : `${chainId}:${b}:${a}`;
}

function matchesTokenFilter(poolOrPair: JsonRecord, token: string | undefined) {
  return (
    token === undefined ||
    canonicalNumericHex(stringField(poolOrPair, "token0")) === token ||
    canonicalNumericHex(stringField(poolOrPair, "token1")) === token
  );
}

function campaignIsActive(campaign: JsonRecord, nowMs: number) {
  const start = Date.parse(stringField(campaign, "startTime"));
  const end =
    campaign.endTime === null
      ? null
      : Date.parse(stringField(campaign, "endTime"));
  if (!Number.isFinite(start) || (end !== null && !Number.isFinite(end))) {
    throw new ServiceError(
      "invalid_upstream_response",
      "Campaign has an invalid startTime or endTime",
    );
  }
  return nowMs >= start && (end === null || nowMs <= end);
}

function campaignContainsPair(campaign: JsonRecord, pair: JsonRecord) {
  return recordArray(campaign, "pairs", "campaign pair").some(
    (campaignPair) =>
      sameNumericHex(
        stringField(campaignPair, "token0"),
        stringField(pair, "token0"),
      ) &&
      sameNumericHex(
        stringField(campaignPair, "token1"),
        stringField(pair, "token1"),
      ),
  );
}

function isIncludedChain(value: unknown, requested: string | undefined) {
  const chainId = canonicalResponseChainId(value);
  return requested === undefined
    ? PRODUCTION_OPPORTUNITY_CHAIN_IDS.has(chainId)
    : chainId === requested;
}

function isIncludedEvmChain(value: unknown, requested: string | undefined) {
  const chainId = canonicalResponseChainId(value);
  return (
    EVM_OPPORTUNITY_CHAIN_IDS.has(chainId) &&
    (requested === undefined || chainId === requested)
  );
}

function chainField(value: JsonRecord) {
  return canonicalResponseChainId(value.chain_id);
}

function canonicalResponseChainId(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") {
    return invalidField("chain_id");
  }
  return canonicalChainId(value);
}

function canonicalNumericHex(value: string) {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new ServiceError("invalid_address", "token address must be hexadecimal");
  }
  return `0x${BigInt(value).toString(16)}`;
}

function sameNumericHex(left: string, right: unknown) {
  return typeof right === "string" && BigInt(left) === BigInt(right);
}

function evmAddress(value: string): Address {
  try {
    return getAddress(numberToHex(BigInt(value), { size: 20 }));
  } catch {
    throw new ServiceError(
      "invalid_upstream_response",
      `Opportunity EVM address does not fit 20 bytes: ${value}`,
    );
  }
}

function compareOpportunityApr(left: JsonRecord, right: JsonRecord) {
  const leftApr = typeof left.apr === "number" ? left.apr : -1;
  const rightApr = typeof right.apr === "number" ? right.apr : -1;
  return rightApr - leftApr;
}

function percent(apr: number | null) {
  return apr === null ? null : apr * 100;
}

function timestampIso(timestamp: bigint) {
  const milliseconds = Number(timestamp) * 1_000;
  return Number.isSafeInteger(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}

function apiUrl(base: string, path: string, chainId: string | undefined) {
  const url = new URL(path, base);
  if (chainId !== undefined) url.searchParams.set("chainId", chainId);
  return url;
}

async function fetchJson<T>(url: URL, fetcher: Fetcher): Promise<T> {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  let body: unknown;
  try {
    body = await response.json();
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

function recordArray(value: JsonRecord, key: string, label: string) {
  const field = value[key];
  if (!Array.isArray(field) || !field.every(isRecord)) {
    throw new ServiceError(
      "invalid_upstream_response",
      `Upstream ${key} must be an array of ${label} objects`,
    );
  }
  return field;
}

function recordField(value: JsonRecord, key: string, nullable = false) {
  const field = value[key];
  if (nullable && field === null) return null;
  if (!isRecord(field)) return invalidField(key);
  return field;
}

function stringField(value: JsonRecord, key: string) {
  const field = value[key];
  if (typeof field !== "string") return invalidField(key);
  return field;
}

function numberField(value: JsonRecord, key: string) {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    return invalidField(key);
  }
  return field;
}

function unsignedField(value: JsonRecord, key: string) {
  return unsigned(value[key], key);
}

function unsigned(value: unknown, label: string) {
  if (
    (typeof value === "string" &&
      !/^(?:(?:0|[1-9][0-9]*)|0x[0-9a-fA-F]+)$/.test(value)) ||
    (typeof value === "number" &&
      (!Number.isSafeInteger(value) || value < 0)) ||
    (typeof value !== "string" && typeof value !== "number")
  ) {
    throw new ServiceError(
      "invalid_upstream_response",
      `${label} must be an unsigned integer string`,
    );
  }
  return BigInt(value);
}

function invalidField(field: string): never {
  throw new ServiceError(
    "invalid_upstream_response",
    `Opportunity upstream field ${field} is invalid`,
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedBase(url: string) {
  return `${url.replace(/\/+$/, "")}/`;
}
