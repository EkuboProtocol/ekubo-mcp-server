import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { numberToHex, zeroAddress } from "viem";
import worker from "../src/index.js";
import { storeArtifact, loadArtifact } from "../src/artifact-store.js";
import { PROTOCOLS } from "../src/protocols.js";
import {
  JURISDICTION_POLICY_DIGEST,
  nonTradingJurisdiction,
  quoteJurisdiction,
} from "../src/token-restrictions.js";
import { v4PoolId } from "../src/uniswap/reads.js";
import { walletExecutionPlanSchema } from "../src/wallet-compatibility.js";
import { fakeArtifactStore } from "./fake-r2.js";

/**
 * CTO decision EKU-873 (contract §4.1): every execution plan this server
 * stores carries `extensions["ekubo.jurisdiction"]`, and its `scope` says
 * whether the plan trades. A plan is `trade` iff the tool that produced it
 * gates its assets (test/jurisdiction-gate-sites.test.ts), plus wrap/unwrap;
 * every other plan is `non_trading` with no assets and complete coverage.
 */

type Scope = "trade" | "non_trading";

/**
 * Every tool in the catalog: the scope of the plans it produces, or null for a
 * tool that produces no execution plan (reads, quotes without plans, typed-data
 * signature requests). `prepare_ve33_reinvest` produces a non-trading claim
 * phase and trading swap/stake phases. `prepare_transfers` is a trade only
 * when it sends a Stock Token to another address (CLO ruling EKU-878).
 */
export const TOOL_PLAN_SCOPE: Record<string, Scope | "by_phase" | "by_recipient" | null> = {
  // Ekubo
  list_tokens: null,
  export_tokens: null,
  get_token: null,
  get_tokens: null,
  get_quotes_with_plans: "trade",
  get_value_transfer_status: null,
  prepare_ve33_vote: "non_trading",
  prepare_ve33_extend: "non_trading",
  prepare_ve33_stake: "trade",
  prepare_ve33_split: "non_trading",
  prepare_ve33_claim_fees: "non_trading",
  prepare_ve33_reinvest: "by_phase",
  prepare_ve33_claim_all_fees: "non_trading",
  prepare_ve33_clear_vote: "non_trading",
  get_ve33_allocations: null,
  get_stonx_allocation_recommendation: null,
  prepare_ve33_reallocation: "non_trading",
  get_positions_by_owner: null,
  get_pool: null,
  get_pool_liquidity: null,
  list_pool_keys: null,
  derive_pool_id: null,
  decode_pool_config: null,
  get_position: null,
  get_position_pool_candidates: null,
  prepare_lp_position_deposit: "trade",
  prepare_lp_position_earnings_claim: "non_trading",
  prepare_lp_position_withdraw: "non_trading",
  prepare_wrap_unwrap: "trade",
  prepare_transfers: "by_recipient",
  prepare_lp_position_transfer: "non_trading",
  prepare_fix_pool_price: "trade",
  prepare_twamm_order: "trade",
  prepare_twamm_order_collection: "non_trading",
  prepare_twamm_order_stop: "non_trading",
  prepare_twamm_virtual_orders: "non_trading",
  prepare_auction_create: "trade",
  prepare_auction_complete: "non_trading",
  prepare_auction_creator_proceeds: "non_trading",
  prepare_manual_pool_boost: "trade",
  prepare_oracle_capacity_expansion: "trade",
  prepare_approval_revocations: "non_trading",
  prepare_old_gekubo_unwrap: "non_trading",
  get_rewards_claims_by_owner: null,
  prepare_rewards_claim: "non_trading",
  prepare_revenue_buybacks: "non_trading",
  prepare_ve33_increase_stake: "trade",
  prepare_ve33_merge: "non_trading",
  prepare_ve33_withdraw: "non_trading",
  get_liquidity_opportunities: null,
  prepare_pool_initialization: "non_trading",
  // Aave
  get_aave_v3_markets: null,
  prepare_aave_v3_supply: "non_trading",
  prepare_aave_v3_withdraw: "non_trading",
  prepare_aave_v3_borrow: "non_trading",
  prepare_aave_v3_repay: "non_trading",
  prepare_aave_v3_collateral: "non_trading",
  prepare_aave_v3_emode: "non_trading",
  // Aerodrome
  get_aerodrome_deployment: null,
  prepare_aerodrome_sugar_reads: null,
  prepare_aerodrome_liquidity_deposit: "non_trading",
  prepare_aerodrome_liquidity_withdraw: "non_trading",
  prepare_aerodrome_gauge_deposit: "non_trading",
  prepare_aerodrome_gauge_withdraw: "non_trading",
  prepare_aerodrome_gauge_claim: "non_trading",
  prepare_aerodrome_lock: "non_trading",
  prepare_aerodrome_vote: "non_trading",
  prepare_aerodrome_incentive_claim: "non_trading",
  // Lido
  get_lido_deployment: null,
  prepare_lido_stake: "non_trading",
  prepare_lido_wrap: "non_trading",
  prepare_lido_unwrap: "non_trading",
  prepare_lido_withdrawal_request: "non_trading",
  prepare_lido_withdrawal_claim: "non_trading",
  // Merkl
  get_merkl_deployment: null,
  prepare_merkl_claim: "non_trading",
  // Morpho
  get_morpho_vaults: null,
  prepare_morpho_vault_deposit: "non_trading",
  prepare_morpho_vault_withdraw: "non_trading",
  prepare_morpho_vault_redeem: "non_trading",
  // Sky
  get_sky_savings_deployment: null,
  prepare_sky_savings_deposit: "non_trading",
  prepare_sky_savings_withdraw: "non_trading",
  prepare_sky_savings_redeem: "non_trading",
  // Uniswap
  decode_uniswap_v4_position_info: null,
  quote_uniswap_liquidity: null,
  get_uniswap_deployments: null,
  discover_uniswap_pools: null,
  get_uniswap_pool: null,
  get_uniswap_pool_ticks: null,
  get_uniswap_charts: null,
  prepare_uniswap_reads: null,
  prepare_uniswap_v2_add_liquidity: "trade",
  prepare_uniswap_v2_remove_liquidity: "non_trading",
  prepare_uniswap_v3_add_liquidity: "trade",
  prepare_uniswap_v3_remove_liquidity: "non_trading",
  prepare_uniswap_v3_collect_fees: "non_trading",
  prepare_uniswap_v4_add_liquidity: "trade",
  prepare_uniswap_v4_remove_liquidity: "non_trading",
  prepare_uniswap_v4_collect_fees: "non_trading",
  // Safe
  prepare_safe_reads: null,
  prepare_safe_transaction_signature: null,
  prepare_safe_message_signature: null,
  prepare_safe_approve_hash: "non_trading",
  prepare_safe_execution: "non_trading",
  prepare_safe_owner_change: null,
};

/**
 * The tools whose plans are `trade`: each gated path in
 * test/jurisdiction-gate-sites.test.ts, by the tool that reaches it, plus
 * wrap/unwrap. Reinvest's swap, stake and stake_all phases are gated.
 */
export const TRADE_TOOLS = [
  "get_quotes_with_plans",
  "prepare_auction_create",
  "prepare_fix_pool_price",
  "prepare_lp_position_deposit",
  "prepare_manual_pool_boost",
  "prepare_oracle_capacity_expansion",
  "prepare_transfers",
  "prepare_twamm_order",
  "prepare_uniswap_v2_add_liquidity",
  "prepare_uniswap_v3_add_liquidity",
  "prepare_uniswap_v4_add_liquidity",
  "prepare_ve33_increase_stake",
  "prepare_ve33_reinvest",
  "prepare_ve33_stake",
  "prepare_wrap_unwrap",
];

const env = {
  ARTIFACT_STORE: fakeArtifactStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused",
  ACROSS_API_KEY: "unused",
  ACROSS_INTEGRATOR_ID: "unused",
  LAYER_ZERO_API_KEY: "unused",
  LI_FI_API_KEY: "unused",
  DUNE_API_KEY: "unused",
  ALLOWED_ORIGINS: "https://mcp.ekubo.org",
};
const context = {} as unknown as ExecutionContext;

const SENDER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const VE_TOKEN = "0x9d7008E169D040B6c0140eb92E7cA82B12643497";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const STONX = "0x570c5aa79c798e7a418412cc8399ae5bcce570c5";
/** Not classified by the policy: a non-trading plan must not hold on it. */
const UNKNOWN = "0x3333333333333333333333333333333333333333";
const BOOSTED_FEES = "0x948b9C2C99718034954110cB61a6e08e107745f9";
const CORE = "0x00000000000014aA86C5d3c41765bb24e11bd701";
const deadline = String(Math.floor(Date.now() / 1000) + 3600);
const v3Range = { tick_lower: -120, tick_upper: 120, tick_spacing: 60, fee: 3000 };
/** A ve33 pool whose token1 the policy has not classified. */
const unknownVe33Pool = {
  token0: zeroAddress,
  token1: UNKNOWN,
  fee: "0",
  tick_spacing: 4,
  extension: "0x4444444444444444444444444444444444444444",
};
const TWAMM = "0xd47f1b1edcfeabb08f6ebd8fc337c27e636c75ba";
const ORDERS = "0x3325428adB409c239E88ca472F50b0efe00E98B4";
/** A TWAMM pool whose token1 the policy has not classified. */
const encodedKey = {
  token0: zeroAddress,
  token1: UNKNOWN,
  config: numberToHex((BigInt(TWAMM) << 96n) | (1n << 31n) | 4n, { size: 32 }),
};

type Case = { tool: string; args: Record<string, unknown>; label?: string; path?: string };

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
/** Off the policy chains a Safe approval or execution is non-trading. */
const SAFE_TX = {
  chain_id: "1", safe: "0x4444444444444444444444444444444444444444", safe_version: "1.4.1", sender: SENDER,
  transaction: {
    to: UNKNOWN, value: "0", data: "0x1234", operation: "0", safeTxGas: "0", baseGas: "0", gasPrice: "0",
    gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: "3",
  },
};
const mainnet = { chain_id: "1", sender: SENDER };

/**
 * Tools exercised end to end through MCP on chain 4663 with no network. The
 * remaining plan tools read the indexer or a quote provider; their plan bodies
 * are checked in the module test named in COVERED_ELSEWHERE.
 */
const RUNTIME_CASES: Case[] = [
  { tool: "prepare_wrap_unwrap", label: "wrap", args: { chain_id: "4663", sender: SENDER, direction: "wrap", amount: "100" } },
  { tool: "prepare_wrap_unwrap", label: "unwrap", args: { chain_id: "4663", sender: SENDER, direction: "unwrap", amount: "100" } },
  {
    tool: "prepare_transfers",
    args: {
      chain_id: "4663",
      sender: SENDER,
      transfers: [
        { kind: "native", recipient: RECIPIENT, amount: "1" },
        { kind: "erc20", token: USDG, recipient: RECIPIENT, amount: "5" },
        // Sending an unclassified token to oneself is not a disposal.
        { kind: "erc20", token: UNKNOWN, recipient: SENDER, amount: "5" },
      ],
    },
  },
  {
    tool: "prepare_approval_revocations",
    args: { chain_id: "4663", sender: SENDER, approvals: [{ token: UNKNOWN, spender: RECIPIENT }] },
  },
  {
    tool: "prepare_pool_initialization",
    args: { chain_id: "4663", sender: SENDER, core_address: CORE, pool_key: encodedKey, initial_tick: 0 },
  },
  {
    tool: "prepare_twamm_order_collection",
    args: { chain_id: "4663", sender: SENDER, orders_address: ORDERS, token_id: "7", order_keys: [encodedKey] },
  },
  {
    tool: "prepare_twamm_order_stop",
    args: {
      chain_id: "4663", sender: SENDER, orders_address: ORDERS, token_id: "7", pending_timestamp: "1000",
      orders: [{ order_key: encodedKey, end_time: "2000", sale_rate: "5" }],
    },
  },
  { tool: "prepare_twamm_virtual_orders", args: { chain_id: "4663", sender: SENDER, pool_key: encodedKey } },
  {
    tool: "prepare_ve33_clear_vote",
    args: { chain_id: "4663", ve_token: VE_TOKEN, sender: SENDER, votes: [{ ve_id: "10", current_pool_key: unknownVe33Pool }] },
  },
  {
    tool: "prepare_ve33_claim_fees",
    args: { chain_id: "4663", ve_token: VE_TOKEN, sender: SENDER, claims: [{ ve_id: "10", pool_key: unknownVe33Pool }] },
  },
  {
    tool: "prepare_ve33_extend",
    args: { chain_id: "4663", ve_token: VE_TOKEN, sender: SENDER, ve_id: "10", max_duration: true, current_pool_key: unknownVe33Pool },
  },
  {
    tool: "prepare_ve33_withdraw",
    args: { chain_id: "4663", ve_token: VE_TOKEN, sender: SENDER, ve_id: "10", current_pool_key: unknownVe33Pool },
  },
  {
    tool: "prepare_ve33_split",
    args: { chain_id: "4663", ve_token: VE_TOKEN, sender: SENDER, ve_id: "10", amount: "5", salt: `0x${"12".repeat(32)}` },
  },
  {
    tool: "prepare_ve33_merge",
    args: {
      chain_id: "4663", ve_token: VE_TOKEN, sender: SENDER, destination_ve_id: "10",
      sources: [{ ve_id: "11", current_pool_key: unknownVe33Pool }],
    },
  },
  {
    tool: "prepare_ve33_stake",
    args: { chain_id: "4663", ve_token: VE_TOKEN, sender: SENDER, stake_token: STONX, amount: "100", salt: `0x${"12".repeat(32)}` },
  },
  {
    tool: "prepare_ve33_increase_stake",
    args: { chain_id: "4663", ve_token: VE_TOKEN, sender: SENDER, stake_token: STONX, ve_id: "10", amount: "100" },
  },
  {
    tool: "prepare_ve33_reinvest",
    label: "phase=stake",
    args: { phase: "stake", chain_id: "4663", ve_token: VE_TOKEN, sender: SENDER, stake_token: STONX, ve_id: "10", amount: "100" },
  },
  {
    tool: "prepare_manual_pool_boost",
    args: {
      chain_id: 4663, sender: SENDER,
      pool_key: {
        token0: WETH, token1: USDG,
        config: numberToHex((BigInt(BOOSTED_FEES) << 96n) | (1n << 31n) | 4n, { size: 32 }),
      },
      start_time: "1000", end_time: "1100", amount0: "100", amount1: "200",
    },
  },
  {
    tool: "prepare_oracle_capacity_expansion",
    args: { chain_id: "4663", sender: SENDER, token: USDG, min_capacity: 10 },
  },
  {
    tool: "prepare_twamm_order",
    args: {
      chain_id: "4663", sender: SENDER, sell_token: USDG, buy_token: WETH, pending_timestamp: "1000",
      orders: [{ fee: "1", start_time: "1024", end_time: "2048", amount: "10000" }],
    },
  },
  {
    tool: "prepare_auction_create",
    args: {
      chain_id: "4663", sender: SENDER, sell_token: STONX, buy_token: USDG, sell_amount: "1000",
      creator_fee_q32: "100", min_boost_duration: 3600, graduation_pool_fee_q64: "1000",
      graduation_pool_tick_spacing: 4, start_time: "1000", auction_duration: 7200, salt: `0x${"56".repeat(32)}`,
    },
  },
  {
    tool: "prepare_uniswap_v2_add_liquidity",
    args: {
      chain_id: "4663", sender: SENDER, deadline, token0: WETH, token1: USDG,
      amount0: "1000", amount1: "2000", amount0_min: "900", amount1_min: "1900",
    },
  },
  {
    tool: "prepare_uniswap_v3_add_liquidity",
    args: {
      chain_id: "4663", sender: SENDER, deadline, token0: WETH, token1: USDG, ...v3Range,
      amount0: "1000", amount1: "2000", amount0_min: "900", amount1_min: "1900",
    },
  },
  {
    tool: "prepare_uniswap_v4_add_liquidity",
    args: {
      chain_id: "4663", sender: SENDER, deadline, token0: zeroAddress, token1: USDG, ...v3Range,
      pool_id: v4PoolId({ token0: zeroAddress, token1: USDG as `0x${string}`, fee: 3000, tick_spacing: 60, hooks: zeroAddress }),
      liquidity: "1234", amount0_max: "1000", amount1_max: "2000",
    },
  },
  // Exits from a pair the policy has not classified stay available.
  {
    tool: "prepare_uniswap_v2_remove_liquidity",
    args: {
      chain_id: "4663", sender: SENDER, deadline, token0: RECIPIENT, token1: UNKNOWN,
      liquidity: "100", amount0_min: "1", amount1_min: "1",
    },
  },
  {
    tool: "prepare_uniswap_v3_remove_liquidity",
    args: {
      chain_id: "4663", sender: SENDER, deadline, token0: RECIPIENT, token1: UNKNOWN,
      token_id: "42", liquidity: "100", amount0_min: "1", amount1_min: "1",
    },
  },
  {
    tool: "prepare_uniswap_v3_collect_fees",
    args: { chain_id: "4663", sender: SENDER, deadline, token0: RECIPIENT, token1: UNKNOWN, token_id: "42" },
  },
  {
    tool: "prepare_uniswap_v4_remove_liquidity",
    args: {
      chain_id: "4663", sender: SENDER, deadline, token0: zeroAddress, token1: UNKNOWN, fee: 3000, tick_spacing: 60,
      pool_id: v4PoolId({ token0: zeroAddress, token1: UNKNOWN, fee: 3000, tick_spacing: 60, hooks: zeroAddress }),
      token_id: "42", liquidity: "100", amount0_min: "1", amount1_min: "1",
    },
  },
  {
    tool: "prepare_uniswap_v4_collect_fees",
    args: {
      chain_id: "4663", sender: SENDER, deadline, token0: zeroAddress, token1: UNKNOWN, fee: 3000, tick_spacing: 60,
      pool_id: v4PoolId({ token0: zeroAddress, token1: UNKNOWN, fee: 3000, tick_spacing: 60, hooks: zeroAddress }),
      token_id: "42",
    },
  },
  // Satellite protocols and mainnet-only Ekubo tools: non-trading on every chain.
  { tool: "prepare_aave_v3_supply", args: { ...mainnet, asset: USDC, amount: "1000000" } },
  { tool: "prepare_aave_v3_withdraw", args: { ...mainnet, asset: USDC, amount: "1000000" } },
  { tool: "prepare_aave_v3_borrow", args: { ...mainnet, asset: USDC, amount: "1000000" } },
  { tool: "prepare_aave_v3_repay", args: { ...mainnet, asset: USDC, amount: "1000000" } },
  { tool: "prepare_aave_v3_collateral", args: { ...mainnet, asset: USDC, use_as_collateral: true } },
  { tool: "prepare_aave_v3_emode", args: { ...mainnet, category_id: 0 } },
  { tool: "prepare_lido_stake", args: { ...mainnet, amount: "1000" } },
  { tool: "prepare_lido_wrap", args: { ...mainnet, amount: "1000" } },
  { tool: "prepare_lido_unwrap", args: { ...mainnet, amount: "1000" } },
  { tool: "prepare_lido_withdrawal_request", args: { ...mainnet, amounts: ["1000"] } },
  { tool: "prepare_lido_withdrawal_claim", args: { ...mainnet, request_id: "7" } },
  { tool: "prepare_sky_savings_deposit", args: { ...mainnet, amount: "1000" } },
  { tool: "prepare_sky_savings_withdraw", args: { ...mainnet, amount: "1000" } },
  { tool: "prepare_sky_savings_redeem", args: { ...mainnet, shares: "1000" } },
  { tool: "prepare_old_gekubo_unwrap", args: { ...mainnet, amount: "1" } },
  {
    tool: "prepare_revenue_buybacks",
    args: {
      ...mainnet,
      ended_order_collects: [{ sell_token: UNKNOWN, fee: "1", end_time: "1000" }],
      protocol_fee_pairs: [{ token0: RECIPIENT, token1: UNKNOWN }],
      roll_tokens: [UNKNOWN],
    },
  },
  { tool: "prepare_safe_approve_hash", path: "/mcp/safe", args: SAFE_TX },
  { tool: "prepare_safe_execution", path: "/mcp/safe", args: { ...SAFE_TX, signatures: `0x${"11".repeat(65)}` } },
];

/**
 * Plan tools whose bodies need the indexer, a quote provider, or fixtures that
 * live with their module test; each named test calls `expectPlanScope`.
 */
const COVERED_ELSEWHERE: Record<string, string> = {
  get_quotes_with_plans: "quote-jurisdiction.test.ts (and reinvest-jurisdiction.test.ts for phase=swap children)",
  prepare_ve33_vote: "ve33.test.ts",
  prepare_ve33_claim_all_fees: "ve33.test.ts (also reinvest phase=claim)",
  prepare_ve33_reallocation: "reallocation.test.ts",
  prepare_lp_position_deposit: "liquidity.test.ts",
  prepare_lp_position_earnings_claim: "liquidity.test.ts",
  prepare_lp_position_withdraw: "liquidity.test.ts",
  prepare_lp_position_transfer: "ui-actions.test.ts",
  prepare_fix_pool_price: "ui-actions.test.ts",
  prepare_auction_complete: "ui-actions.test.ts",
  prepare_auction_creator_proceeds: "ui-actions.test.ts",
  prepare_rewards_claim: "claims.test.ts, ui-actions.test.ts",
  prepare_aerodrome_liquidity_deposit: "aerodrome.test.ts",
  prepare_aerodrome_liquidity_withdraw: "aerodrome.test.ts",
  prepare_aerodrome_gauge_deposit: "aerodrome.test.ts",
  prepare_aerodrome_gauge_withdraw: "aerodrome.test.ts",
  prepare_aerodrome_gauge_claim: "aerodrome.test.ts",
  prepare_aerodrome_lock: "aerodrome.test.ts",
  prepare_aerodrome_vote: "aerodrome.test.ts",
  prepare_aerodrome_incentive_claim: "aerodrome.test.ts",
  prepare_merkl_claim: "merkl.test.ts",
  prepare_morpho_vault_deposit: "morpho.test.ts",
  prepare_morpho_vault_withdraw: "morpho.test.ts",
  prepare_morpho_vault_redeem: "morpho.test.ts",
};

function edgeRequest(body: unknown, country: string, path: string): Request {
  const request = new Request(`https://mcp.ekubo.org${path}`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      host: "mcp.ekubo.org",
      origin: "https://mcp.ekubo.org",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify(body),
  });
  Object.defineProperty(request, "cf", { value: { country } });
  return request;
}

async function callTool(name: string, args: Record<string, unknown>, path = "/mcp", country = "FR") {
  const response = await worker.fetch(
    edgeRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, country, path),
    env,
    context,
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  const data = body.includes("data:")
    ? body.split("\n").find((line) => line.startsWith("data:"))!.slice(5).trim()
    : body;
  return (JSON.parse(data) as { result: { isError?: boolean; structuredContent: Record<string, unknown> } }).result;
}

function references(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(references);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
    key === "execution_plan_reference"
      ? [(entry as { url: string }).url.split("/artifact/")[1]!]
      : references(entry),
  );
}

async function storedPlans(result: { structuredContent: Record<string, unknown> }) {
  const ids = references(result.structuredContent);
  return Promise.all(
    ids.map(async (id) => JSON.parse((await loadArtifact(env, id))!) as Record<string, unknown> & {
      extensions: Record<string, Record<string, unknown>>;
    }),
  );
}

let mockedFetch: ReturnType<typeof spyOn>;
beforeAll(() => {
  mockedFetch = spyOn(globalThis, "fetch").mockImplementation((async () =>
    new Response("unexpected network call", { status: 500 })) as unknown as typeof fetch);
});
afterAll(() => mockedFetch.mockRestore());

describe("plan jurisdiction scope catalog", () => {
  it("classifies every tool in the catalog", () => {
    const catalog = PROTOCOLS.flatMap((protocol) => protocol.tools).sort();
    expect(Object.keys(TOOL_PLAN_SCOPE).sort()).toEqual(catalog);
  });

  it("marks exactly the gated tools plus wrap/unwrap as trading", () => {
    const trading = Object.entries(TOOL_PLAN_SCOPE)
      .filter(([, scope]) => scope === "trade" || scope === "by_phase" || scope === "by_recipient")
      .map(([tool]) => tool)
      .sort();
    expect(trading).toEqual([...TRADE_TOOLS].sort());
  });

  it("exercises or names the test for every plan-producing tool", () => {
    const planTools = Object.entries(TOOL_PLAN_SCOPE)
      .filter(([, scope]) => scope !== null)
      .map(([tool]) => tool);
    const exercised = new Set([...RUNTIME_CASES.map(({ tool }) => tool), ...Object.keys(COVERED_ELSEWHERE)]);
    expect(planTools.filter((tool) => !exercised.has(tool))).toEqual([]);
  });
});

describe("every stored plan carries extensions[\"ekubo.jurisdiction\"] with its tool's scope", () => {
  for (const { tool, args, label, path } of RUNTIME_CASES) {
    it(`${tool}${label === undefined ? "" : ` ${label}`}`, async () => {
      const result = await callTool(tool, args, path);
      expect(result.structuredContent).not.toHaveProperty("error");
      const plans = await storedPlans(result);
      expect(plans.length).toBeGreaterThan(0);
      const expected = {
        by_phase: "trade",
        by_recipient: "non_trading",
      }[TOOL_PLAN_SCOPE[tool] as string] ?? TOOL_PLAN_SCOPE[tool];
      for (const plan of plans) {
        expect(walletExecutionPlanSchema.safeParse(plan).success).toBe(true);
        const metadata = plan.extensions["ekubo.jurisdiction"]!;
        expect(metadata.scope).toBe(expected!);
        expect(metadata.policy_digest).toBe(JURISDICTION_POLICY_DIGEST);
        if (expected === "non_trading") {
          expect(metadata).toEqual(nonTradingJurisdiction());
        } else {
          expect(metadata.coverage).toBe("complete");
          expect((metadata.assets as unknown[]).length).toBeGreaterThan(0);
        }
      }
    });
  }
});

describe("the artifact store refuses a plan on a policy chain without valid jurisdiction metadata", () => {
  const plan = (chainId: string, extensions?: Record<string, unknown>) => ({
    schema_version: "1",
    chain_id: chainId,
    caip2_chain_id: `eip155:${chainId}`,
    sender: SENDER,
    ordered_steps: [
      { step: 1, kind: "execution", transaction: { chain_id: chainId, from: SENDER, to: RECIPIENT, data: "0x", value: "0" } },
    ],
    ...(extensions === undefined ? {} : { extensions }),
  });
  const store = (body: ReturnType<typeof plan>) =>
    storeArtifact(env, "https://mcp.ekubo.org", { artifactType: "execution_plan", body });

  it("refuses a 4663 plan with no extension and stores nothing", async () => {
    const before = env.ARTIFACT_STORE.entries.size;
    await expect(store(plan("4663"))).rejects.toMatchObject({ code: "internal_plan_jurisdiction_missing" });
    await expect(store(plan("4663", {}))).rejects.toMatchObject({ code: "internal_plan_jurisdiction_missing" });
    expect(env.ARTIFACT_STORE.entries.size).toBe(before);
  });

  it("refuses malformed metadata on 4663", async () => {
    const { scope: _scope, ...unscoped } = nonTradingJurisdiction();
    const malformed = [
      unscoped,
      { ...nonTradingJurisdiction(), scope: "unknown" },
      { ...nonTradingJurisdiction(), policy_digest: "0".repeat(64) },
      { ...nonTradingJurisdiction(), extra: true },
      // A non-trading plan reports no traded assets with complete coverage.
      { ...nonTradingJurisdiction(), assets: quoteJurisdiction([{ chainId: "4663", token: UNKNOWN, side: "sell" }]).assets },
      { ...nonTradingJurisdiction(), coverage: "unknown" },
      null,
      "non_trading",
    ];
    for (const metadata of malformed) {
      await expect(store(plan("4663", { "ekubo.jurisdiction": metadata }))).rejects.toMatchObject({
        code: "internal_plan_jurisdiction_missing",
      });
    }
  });

  it("stores a 4663 plan carrying either scope", async () => {
    await expect(store(plan("4663", { "ekubo.jurisdiction": nonTradingJurisdiction() }))).resolves.toMatchObject({
      kind: "artifact_reference",
    });
    const trade = quoteJurisdiction([{ chainId: "4663", token: USDG, side: "sell" }, { chainId: "4663", token: STONX, side: "buy" }]);
    await expect(store(plan("4663", { "ekubo.jurisdiction": trade }))).resolves.toMatchObject({
      kind: "artifact_reference",
    });
  });

  it("stores a plan on a chain outside the policy without the extension", async () => {
    await expect(store(plan("1"))).resolves.toMatchObject({ kind: "artifact_reference" });
  });

  it("fails the whole result walk, so no reference to a refused plan is returned", async () => {
    const { referenceWalletArtifacts } = await import("../src/artifact-store.js");
    await expect(
      referenceWalletArtifacts(env, "https://mcp.ekubo.org", { execution_plan: plan("4663") }),
    ).rejects.toMatchObject({ code: "internal_plan_jurisdiction_missing" });
  });
});

describe("a refused plan fails the MCP tool call", () => {
  it("returns an error result and no reference", async () => {
    const restrictions = await import("../src/token-restrictions.js");
    const refuse = spyOn(restrictions, "isValidPlanJurisdiction").mockReturnValue(false);
    try {
      const before = env.ARTIFACT_STORE.entries.size;
      const result = await callTool("prepare_wrap_unwrap", { chain_id: "4663", sender: SENDER, direction: "wrap", amount: "1" });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: "internal_plan_jurisdiction_missing" } });
      expect(JSON.stringify(result)).not.toContain("/artifact/");
      expect(env.ARTIFACT_STORE.entries.size).toBe(before);
    } finally {
      refuse.mockRestore();
    }
  });
});

describe("prepare_transfers: a Stock Token sent to another address is a gated disposal (CLO EKU-878)", () => {
  /** NVDA, a Robinhood Stock Token. */
  const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
  const transfer = (token: string, recipient: string) => ({ kind: "erc20", token, recipient, amount: "5" });
  const call = (transfers: unknown[], country: string | undefined, sender = SENDER) =>
    callTool("prepare_transfers", { chain_id: "4663", sender, transfers }, "/mcp", country as string);

  it("refuses a Stock Token sent to a third party from a listed or unresolved country", async () => {
    const before = env.ARTIFACT_STORE.entries.size;
    for (const [country, code] of [["US", "US"], ["SG", "SG"], ["XX", null]] as const) {
      const result = await call([transfer(NVDA, RECIPIENT)], country);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: "restricted_jurisdiction",
          details: { country: code, restricted_assets: [{ chain_id: "4663", token: NVDA, side: "sell", classification: "rhj_stock_token" }] },
        },
      });
      expect(JSON.stringify(result)).not.toContain("/artifact/");
    }
    expect(env.ARTIFACT_STORE.entries.size).toBe(before);
  });

  it("refuses with no own-contract exemption: any address other than the sender is gated", async () => {
    const result = await call([transfer(NVDA, "0x4444444444444444444444444444444444444444")], "US");
    expect(result.structuredContent).toMatchObject({ error: { code: "restricted_jurisdiction" } });
  });

  it("prepares a trade plan with the entry as a sell from a permitted country", async () => {
    const result = await call([transfer(NVDA, RECIPIENT)], "FR");
    const [plan] = await storedPlans(result);
    const metadata = plan!.extensions["ekubo.jurisdiction"]!;
    expect(metadata).toEqual(quoteJurisdiction([{ chainId: "4663", token: NVDA, side: "sell" }]));
    expect(metadata.scope).toBe("trade");
    expect(metadata.restricted_jurisdictions).toContain("US");
  });

  it("leaves a Stock Token sent to the sender itself non-trading, checksum-insensitively", async () => {
    for (const country of ["US", "XX"]) {
      const result = await call([transfer(NVDA, SENDER.toUpperCase().replace("0X", "0x"))], country);
      const [plan] = await storedPlans(result);
      expect(plan!.extensions["ekubo.jurisdiction"]).toEqual(nonTradingJurisdiction());
    }
  });

  it("makes a mixed USDG + Stock Token batch a trade listing only the disposal", async () => {
    const result = await call([transfer(USDG, RECIPIENT), transfer(NVDA, RECIPIENT)], "FR");
    const [plan] = await storedPlans(result);
    const metadata = plan!.extensions["ekubo.jurisdiction"]!;
    expect(metadata.scope).toBe("trade");
    expect(metadata.assets).toEqual(quoteJurisdiction([{ chainId: "4663", token: NVDA, side: "sell" }]).assets);
  });

  it("refuses an unclassified 4663 token sent to another address from every country", async () => {
    for (const country of ["FR", "US", undefined]) {
      const result = await call([transfer(USDG, RECIPIENT), transfer(UNKNOWN, RECIPIENT)], country as string);
      expect(result.structuredContent).toMatchObject({
        error: { code: "unclassified_asset", details: { assets: [{ token: UNKNOWN, classification: "unknown" }] } },
      });
    }
  });

  it("keeps a USDG-only batch, and NFTs, non-trading from a listed country", async () => {
    const result = await call(
      [
        transfer(USDG, RECIPIENT),
        { kind: "erc721", token: UNKNOWN, recipient: RECIPIENT, token_id: "1" },
        { kind: "native", recipient: RECIPIENT, amount: "1" },
      ],
      "US",
    );
    const [plan] = await storedPlans(result);
    expect(plan!.extensions["ekubo.jurisdiction"]).toEqual(nonTradingJurisdiction());
  });

  it("leaves chains outside the policy non-trading", async () => {
    const result = await callTool(
      "prepare_transfers",
      { chain_id: "1", sender: SENDER, transfers: [transfer(NVDA, RECIPIENT), transfer(UNKNOWN, RECIPIENT)] },
      "/mcp",
      "US",
    );
    const [plan] = await storedPlans(result);
    expect(plan!.extensions["ekubo.jurisdiction"]).toEqual(nonTradingJurisdiction());
  });
});

describe("Safe approve_hash and execution refuse on a policy chain (CSO EKU-876 B-2)", () => {
  const SIGNATURES = `0x${"11".repeat(65)}`;
  /** NVDA, a Robinhood Stock Token. */
  const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
  // ERC-20 transfer(RECIPIENT, 5) of a Stock Token: a disposal the server never sees.
  const transferData = `0xa9059cbb${RECIPIENT.slice(2).padStart(64, "0")}${"5".padStart(64, "0")}`;
  const inner = [
    { to: UNKNOWN, data: "0x1234", operation: "0" },
    { to: NVDA, data: transferData, operation: "0" },
    { to: USDG, data: "0x", operation: "0" },
    { to: UNKNOWN, data: "0x1234", operation: "1" },
  ];

  for (const tool of ["prepare_safe_approve_hash", "prepare_safe_execution"]) {
    it(`${tool} on 4663 returns uninspected_calldata from every country and stores nothing`, async () => {
      const before = env.ARTIFACT_STORE.entries.size;
      for (const transaction of inner) {
        for (const country of ["FR", "US", "XX"]) {
          const args = {
            ...SAFE_TX,
            chain_id: "4663",
            transaction: { ...SAFE_TX.transaction, ...transaction },
            ...(tool === "prepare_safe_execution" ? { signatures: SIGNATURES } : {}),
          };
          const result = await callTool(tool, args, "/mcp/safe", country);
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({
            error: {
              code: "uninspected_calldata",
              details: { policy_digest: JURISDICTION_POLICY_DIGEST, chain_id: "4663", tool },
            },
          });
          expect(JSON.stringify(result)).not.toContain("/artifact/");
          expect(JSON.stringify(result)).not.toContain("non_trading");
        }
      }
      expect(env.ARTIFACT_STORE.entries.size).toBe(before);
    });

    it(`${tool} off the policy chains still prepares a non-trading plan`, async () => {
      const args = tool === "prepare_safe_execution" ? { ...SAFE_TX, signatures: SIGNATURES } : SAFE_TX;
      const [plan] = await storedPlans(await callTool(tool, args, "/mcp/safe"));
      expect(plan!.chain_id).toBe("1");
      expect(plan!.extensions["ekubo.jurisdiction"]).toEqual(nonTradingJurisdiction());
    });
  }
});
