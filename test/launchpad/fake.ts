import {
  type Abi,
  type Address,
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  type Hex,
  keccak256,
  numberToHex,
  pad,
  zeroAddress,
} from "viem";
import { MAX_SQRT_RATIO, MIN_SQRT_RATIO } from "@ekubo/yul-router-sdk";
import type { CallResult, PinnedBlock, PrepareChain } from "../../src/launchpad/prepare/chain.js";
import type { Deps } from "../../src/launchpad/prepare/context.js";
import {
  ABI_REVISION,
  CONTRACT_NAMES,
  type ContractName,
  launchRouterAbi,
  lockedLaunchLiquidityAbi,
  scheduledLaunchAbi,
} from "../../src/launchpad/prepare/contracts.js";
import { concentratedPoolConfig, type PoolKey, poolId } from "../../src/launchpad/prepare/encoding.js";
import { savedBalancesSlot } from "../../src/launchpad/prepare/launch.js";
import type { EvmQuoterQuote } from "../../src/yul-router.js";

// Tests index into plain JSON results freely.
export type Json = any;

export const E18 = 10n ** 18n;
export const SENDER = getAddress("0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e");
export const OTHER = getAddress("0xbebebebebebebebebebebebebebebebebebebebe");
export const TOKEN = getAddress("0x7070707070707070707070707070707070707070");
export const BLOCK: PinnedBlock = {
  number: 26_106_200n,
  hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
  timestamp: 1_800_000_000n,
};

export const RPC_URL = "http://launchpad-node.test/";
export const API_URL = "https://api.launchpad.test";
export const QUOTER_URL = "https://quoter.launchpad.test";

/** The proposed Base addresses for the launchpad contracts; Core, TWAMM and the Yul router as deployed. */
export const C: Record<ContractName, Address> = {
  core: getAddress("0x00000000000014aA86C5d3c41765bb24e11bd701"),
  twamm: getAddress("0xd47f1B1eDCfEaBb08F6eBd8FC337c27E636C75BA"),
  router: getAddress("0x7B2aA7Ecc0B5936b7C52E6259A19C3BA557d0748"),
  scheduled_launch: getAddress("0x5184f618B2d6cE625d9fDB9770E151a9B84EdB81"),
  locked_launch_liquidity: getAddress("0x4B4e88581110396a09E3Bc313199b96Ab1D8ADEA"),
  launch_router: getAddress("0x9dae609a75Ac80BB84448a14823199faC514aeDb"),
};

/** Stand-in runtime code, one distinct byte string per contract. */
export const CODE = Object.fromEntries(CONTRACT_NAMES.map((name, index) => [name, numberToHex(0x6000 + index, { size: 8 })])) as Record<ContractName, Hex>;

export const MANIFEST = {
  chain_id: 1,
  git_revision: ABI_REVISION,
  contracts: Object.fromEntries(CONTRACT_NAMES.map((name) => [name, { address: C[name], code_hash: keccak256(CODE[name]) }])),
};

export function env(manifestExtra: Record<string, unknown> = {}) {
  return {
    LAUNCHPAD_MANIFEST: JSON.stringify({ ...MANIFEST, ...manifestExtra }),
    LAUNCHPAD_RPC_URL: RPC_URL,
    LAUNCHPAD_API_URL: API_URL,
    LAUNCHPAD_QUOTER_URL: QUOTER_URL,
  };
}

export interface LaunchFixture {
  startTime: bigint;
  endTime: bigint;
  complete: boolean;
  targetTick: number;
  upperTick: number;
  tickSpacing: number;
  initialFee: bigint;
  finalFee: bigint;
  feeAt: bigint;
  decimals: number;
  name: string;
  symbol: string;
  creator: Address;
}

export function launchFixture(overrides: Partial<LaunchFixture> = {}): LaunchFixture {
  return {
    startTime: BLOCK.timestamp - 100n,
    endTime: BLOCK.timestamp + 3_500n,
    complete: false,
    targetTick: -27_631_000,
    upperTick: -18_420_000,
    tickSpacing: 1000,
    initialFee: (1n << 64n) / 20n,
    finalFee: (1n << 64n) / 200n,
    feeAt: (1n << 64n) / 25n,
    decimals: 18,
    name: "Untrusted",
    symbol: "UNT",
    creator: SENDER,
    ...overrides,
  };
}

/** Native ETH sorts first, so the launch token is token1. */
export function launchKey(launch: Pick<LaunchFixture, "tickSpacing">): PoolKey {
  return { token0: zeroAddress, token1: TOKEN, config: concentratedPoolConfig(0n, launch.tickSpacing, C.scheduled_launch) };
}

export function launchPoolId(launch: LaunchFixture = launchFixture()): Hex {
  return poolId(launchKey(launch));
}

const hex = (value: string) => value.toLowerCase();

/** The api's JSON for this launch, as `GET /launches/{chainId}/{poolId}` returns it. */
export function apiDetail(launch: LaunchFixture, overrides: Record<string, unknown> = {}): Json {
  return {
    chain_id: "1",
    pool_key_id: "7",
    pool_id: launchPoolId(launch),
    pool_key: {
      core_address: hex(C.core),
      token0: "0x0",
      token1: hex(TOKEN),
      fee: "0x0",
      tick_spacing: launch.tickSpacing,
      extension: hex(C.scheduled_launch),
    },
    launch_token: { address: hex(TOKEN), name: launch.name, symbol: launch.symbol, decimals: launch.decimals, total_supply: (10n ** 27n).toString() },
    quote_token: { address: "0x0", name: "Ether", symbol: "ETH", decimals: 18 },
    launch_token_is_token1: true,
    start_time: Number(launch.startTime),
    end_time: Number(launch.endTime),
    target_tick: launch.targetTick,
    upper_tick: launch.upperTick,
    tick_spacing: launch.tickSpacing,
    initial_fee: launch.initialFee.toString(),
    final_fee: launch.finalFee.toString(),
    migration_tick_lower: -20_000_000,
    migration_tick_upper: -19_500_000,
    deployed: "0",
    reserve0: "0",
    reserve1: "0",
    complete: launch.complete,
    status: launch.complete ? "migrated" : BLOCK.timestamp < launch.startTime ? "upcoming" : BLOCK.timestamp < launch.endTime ? "live" : "ended",
    status_as_of: Number(BLOCK.timestamp),
    owner: hex(C.launch_router),
    creator: hex(launch.creator),
    created_block_number: (BLOCK.number - 10n).toString(),
    created_transaction_hash: pad("0xc0ffee", { size: 32 }),
    created_time: Number(BLOCK.timestamp - 7200n),
    pool_state: { sqrt_ratio: "1", tick: launch.targetTick, liquidity: "0" },
    latest_advance: null,
    terminal: null,
    creator_fees_claimed: { amount0: "0", amount1: "0" },
    ...overrides,
  };
}

function result(abi: Abi, functionName: string, value: unknown): CallResult {
  return { ok: true, data: encodeFunctionResult({ abi, functionName, result: value } as never) };
}

/**
 * A chain with one launch of TOKEN, answering exactly the point reads the
 * launchpad tools make and counting them by JSON-RPC method.
 */
export class FakeChain implements PrepareChain {
  readonly calls: { to: Address; data: Hex; block: PinnedBlock; from: Address }[] = [];
  readonly methods: Record<string, number> = {};
  codes: Record<string, Hex> = Object.fromEntries(CONTRACT_NAMES.map((name) => [C[name], CODE[name]]));
  /** Overrides for the immutable link reads, by `${contract}.${function}`. */
  links: Record<string, Address> = {};
  /** Undeposited principal LockedLaunchLiquidity holds in Core for the launch. */
  pending = { amount0: 0n, amount1: 0n };
  claimable = { amount0: 0n, amount1: 0n };
  claimRevert: Hex | null = null;

  constructor(readonly launch: LaunchFixture | null = launchFixture()) {}

  private count(method: string) {
    this.methods[method] = (this.methods[method] ?? 0) + 1;
  }

  async latest() {
    this.count("eth_getBlockByNumber");
    return BLOCK;
  }

  async code(address: Address) {
    this.count("eth_getCode");
    return this.codes[getAddress(address)] ?? "0x";
  }

  async storage(address: Address, slot: Hex) {
    this.count("eth_getStorageAt");
    if (getAddress(address) !== C.core || this.launch === null) return pad("0x0", { size: 32 });
    const key = launchKey(this.launch);
    const expected = savedBalancesSlot(C.locked_launch_liquidity, key.token0, key.token1, launchPoolId(this.launch));
    if (slot !== expected) return pad("0x0", { size: 32 });
    return numberToHex((this.pending.amount0 << 128n) | this.pending.amount1, { size: 32 });
  }

  async call(request: { from: Address; to: Address; data: Hex; block: PinnedBlock }): Promise<CallResult> {
    this.count("eth_call");
    this.calls.push(request);
    const to = getAddress(request.to);
    if (to === C.scheduled_launch) return this.scheduledLaunch(request.data);
    if (to === C.launch_router) return this.launchRouter(request.data, request.from);
    if (to === C.locked_launch_liquidity) {
      return result(lockedLaunchLiquidityAbi, "EXTENSION", this.links["locked_launch_liquidity.EXTENSION"] ?? C.scheduled_launch);
    }
    return { ok: false, revert: "0x" };
  }

  private scheduledLaunch(data: Hex): CallResult {
    const { functionName } = decodeFunctionData({ abi: scheduledLaunchAbi, data });
    if (functionName === "LIQUIDITY") return result(scheduledLaunchAbi, "LIQUIDITY", this.links["scheduled_launch.LIQUIDITY"] ?? C.locked_launch_liquidity);
    if (functionName === "TWAMM") return result(scheduledLaunchAbi, "TWAMM", this.links["scheduled_launch.TWAMM"] ?? C.twamm);
    const launch = this.launch;
    if (functionName === "feeAt") return launch === null ? { ok: false, revert: "0x" } : result(scheduledLaunchAbi, "feeAt", launch.feeAt);
    if (launch === null) return result(scheduledLaunchAbi, "getLaunch", emptyLaunch());
    return result(scheduledLaunchAbi, "getLaunch", {
      ...emptyLaunch(),
      owner: C.launch_router,
      token: TOKEN,
      startTime: launch.startTime,
      endTime: launch.endTime,
      complete: launch.complete,
      initialFee: launch.initialFee,
      finalFee: launch.finalFee,
    });
  }

  private launchRouter(data: Hex, from: Address): CallResult {
    const { functionName } = decodeFunctionData({ abi: launchRouterAbi, data });
    if (functionName === "EXTENSION") return result(launchRouterAbi, "EXTENSION", this.links["launch_router.EXTENSION"] ?? C.scheduled_launch);
    if (functionName === "LIQUIDITY") return result(launchRouterAbi, "LIQUIDITY", this.links["launch_router.LIQUIDITY"] ?? C.locked_launch_liquidity);
    if (functionName === "creator") return result(launchRouterAbi, "creator", this.launch?.creator ?? zeroAddress);
    return functionName === "claimFees" ? this.claim(from) : { ok: false, revert: "0x" };
  }

  private claim(from: Address): CallResult {
    if (this.claimRevert !== null) return { ok: false, revert: this.claimRevert };
    if (getAddress(from) !== this.launch?.creator) return { ok: false, revert: "0x" };
    return result(launchRouterAbi, "claimFees", [this.claimable.amount0, this.claimable.amount1]);
  }
}

function emptyLaunch() {
  return {
    owner: zeroAddress,
    token: zeroAddress,
    startTime: 0n,
    endTime: 0n,
    totalSupply: 0n,
    deployed: 0n,
    targetTick: 0,
    positionId: pad("0x0", { size: 32 }),
    complete: false,
    initialFee: 0n,
    finalFee: 0n,
    migrationLower: 0n,
    migrationUpper: 0n,
  };
}

/**
 * A quoter-service answer for one launch-pool hop, in the documented shape
 * (openapi.json at quoter-service#84): a forwarded hop to the extension, with
 * allow_partial only on a partial fill.
 */
export function launchQuote(input: {
  launch?: LaunchFixture;
  buy?: boolean;
  exactOutput?: boolean;
  specified: bigint;
  calculated: bigint;
  partial?: boolean;
  forwardee?: Address | null;
  type?: "forwarded" | "core";
}): EvmQuoterQuote {
  const launch = input.launch ?? launchFixture();
  const key = launchKey(launch);
  const buy = input.buy ?? true;
  // A buy pays native token0 in, which moves the price (token1 per token0) down.
  const limit = buy ? MIN_SQRT_RATIO : MAX_SQRT_RATIO;
  return {
    block_number: (BLOCK.number - 1n).toString(),
    block_hash: pad("0xb1", { size: 32 }),
    total_calculated: input.calculated.toString(),
    estimated_gas_cost: 307_150,
    price_impact: null,
    splits: [
      {
        amount_specified: input.specified.toString(),
        amount_calculated: input.calculated.toString(),
        route: [
          {
            swap: {
              type: input.type ?? "forwarded",
              pool_key: { token0: key.token0, token1: key.token1, config: key.config },
              sqrt_ratio_limit: numberToHex(limit),
              skip_ahead: 0,
              ...(input.forwardee === null ? {} : { forwardee: input.forwardee ?? C.scheduled_launch }),
              ...(input.partial ? { allow_partial: true } : {}),
            },
          },
        ],
      },
    ],
  };
}

/** The data API and quoter-service over HTTP, recording every URL requested. */
export class FakeServices {
  readonly requests: string[] = [];
  details = new Map<string, Json>();
  quote: { status: number; body: unknown } | null = null;

  constructor(launch: LaunchFixture | null = launchFixture()) {
    if (launch !== null) this.details.set(launchPoolId(launch), apiDetail(launch));
  }

  get apiRequests() {
    return this.requests.filter((url) => url.startsWith(API_URL)).length;
  }

  get quoterRequests() {
    return this.requests.filter((url) => url.startsWith(QUOTER_URL)).length;
  }

  readonly fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    this.requests.push(url.toString());
    if (url.origin === QUOTER_URL) {
      if (this.quote === null) return Response.json({ error: "insufficient_liquidity" }, { status: 400 });
      return Response.json(this.quote.body, { status: this.quote.status });
    }
    if (url.origin !== API_URL) throw new Error(`unexpected fetch ${url}`);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "launches") return new Response("not found", { status: 404 });
    return parts.length === 1 ? this.list(url.searchParams) : this.launch(parts);
  }) as typeof fetch;

  private list(params: URLSearchParams) {
    const page = Number(params.get("page") ?? "1");
    const size = Number(params.get("pageSize") ?? "50");
    const creator = params.get("creator");
    const filtered = [...this.details.values()].filter((row) => creator === null || row.creator === creator.toLowerCase());
    return Response.json({
      data: filtered.slice((page - 1) * size, page * size),
      pagination: { page, pageSize: size, totalPages: Math.ceil(filtered.length / size), totalItems: filtered.length },
    });
  }

  private launch(parts: string[]) {
    const id = pad(parts[2] as Hex, { size: 32 });
    const detail = this.details.get(id);
    if (detail === undefined) return Response.json({ error: "not found" }, { status: 404 });
    if (parts[3] === "stats") return Response.json(statsFor(detail));
    if (parts[3] === "swaps") return Response.json({ chain_id: "1", pool_id: id, swaps: [], next_cursor: null, has_more: false });
    return Response.json(detail);
  }
}

function statsFor(detail: Json) {
  return {
    chain_id: "1",
    pool_id: detail.pool_id,
    swaps: { count: 2, buy_count: 2, sell_count: 0, distinct_transactions: 2, distinct_lockers: 1, distinct_transaction_senders: null },
    volume: { buy: { quote_in: "2000", launch_token_out: "1000000" }, sell: { launch_token_in: "0", quote_out: "0" } },
    creator_fees: { accrued: { launch_token: "0", quote_token: "80" }, claimed: { launch_token: "0", quote_token: "0" }, claim_count: 0 },
    funding: { received: { launch_token: "0", quote_token: "0" }, count: 0, migrated_principal: { launch_token: "0", quote_token: "0" } },
    attribution: { counts: "LaunchSwapped events", lockers: "LaunchSwapped.locker", senders: "not indexed" },
  };
}

export function deps(chain: FakeChain, services: FakeServices): Partial<Deps> {
  return { chain: () => chain, fetch: services.fetch };
}

export function harness(launch: LaunchFixture | null = launchFixture()) {
  const chain = new FakeChain(launch);
  const services = new FakeServices(launch);
  return { chain, services, deps: deps(chain, services) };
}

export async function failure(run: () => Promise<unknown>): Promise<{ code: string; message: string; details: Json }> {
  try {
    await run();
  } catch (error) {
    const e = error as { code?: string; message: string; details?: unknown };
    return { code: e.code ?? "schema", message: e.message, details: e.details };
  }
  throw new Error("expected a rejection");
}
