import {
  type Abi,
  type Address,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  erc20Abi,
  getAbiItem,
  getAddress,
  type Hex,
  pad,
  zeroAddress,
} from "viem";
import type { CallResult, ChainLog, PinnedBlock, PrepareChain } from "../../../src/launchpad/prepare/chain.js";
import {
  launchRouterAbi,
  lockedLaunchLiquidityAbi,
  routerAbi,
  scheduledLaunchAbi,
} from "../../../src/launchpad/prepare/contracts.js";
import { concentratedPoolConfig, type PoolKey, poolId } from "../../../src/launchpad/prepare/encoding.js";
import manifestJson from "./manifest.json";

export const MANIFEST = manifestJson;
export const C = {
  launchRouter: getAddress(MANIFEST.contracts.launch_router.address),
  router: getAddress(MANIFEST.contracts.router.address),
  scheduledLaunch: getAddress(MANIFEST.contracts.scheduled_launch.address),
  locked: getAddress(MANIFEST.contracts.locked_launch_liquidity.address),
  twamm: getAddress(MANIFEST.contracts.twamm.address),
};

/** Sorts above every launch token used here, so the launch token is token0. */
export const TEST_QUOTE_HIGH = getAddress("0xfffffffffffffffffffffffffffffffffffffff1");
export const SENDER = getAddress("0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e");
export const OTHER = getAddress("0xbebebebebebebebebebebebebebebebebebebebe");
export const TOKEN = getAddress("0x7070707070707070707070707070707070707070");
export const BLOCK: PinnedBlock = {
  number: 26_106_200n,
  hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
  timestamp: 1_800_000_000n,
};

export function env(extra: Record<string, unknown> = {}) {
  return { LAUNCHPAD_MANIFEST: JSON.stringify({ ...MANIFEST, ...extra }), LAUNCHPAD_RPC_URL: "http://127.0.0.1:1" };
}

export interface LaunchFixture {
  quoteToken: Address;
  owner: Address;
  startTime: bigint;
  endTime: bigint;
  complete: boolean;
  targetTick: number;
  upperTick: number;
  tickSpacing: number;
  initialFee: bigint;
  finalFee: bigint;
  decimals: number;
  name: string;
  symbol: string;
}

export function launchFixture(overrides: Partial<LaunchFixture> = {}): LaunchFixture {
  return {
    quoteToken: zeroAddress,
    owner: SENDER,
    startTime: BLOCK.timestamp - 100n,
    endTime: BLOCK.timestamp + 3_500n,
    complete: false,
    targetTick: -27_631_000,
    upperTick: -18_420_000,
    tickSpacing: 1000,
    initialFee: (1n << 64n) / 20n,
    finalFee: (1n << 64n) / 200n,
    decimals: 18,
    name: "Untrusted",
    symbol: "UNT",
    ...overrides,
  };
}

export function launchKey(launch: LaunchFixture): PoolKey {
  const tokenIs0 = BigInt(TOKEN) < BigInt(launch.quoteToken);
  return {
    token0: tokenIs0 ? TOKEN : launch.quoteToken,
    token1: tokenIs0 ? launch.quoteToken : TOKEN,
    config: concentratedPoolConfig(0n, launch.tickSpacing, C.scheduledLaunch),
  };
}

type Update = { delta0: bigint; delta1: bigint };

export function packUpdate({ delta0, delta1 }: Update): Hex {
  const mask = (1n << 128n) - 1n;
  return pad(`0x${(((delta0 & mask) << 128n) | (delta1 & mask)).toString(16)}`, { size: 32 });
}

/**
 * A chain with one launch of TOKEN, answering exactly the reads the
 * preparation tools make and recording every call.
 */
export class FakeChain implements PrepareChain {
  readonly calls: { to: Address; data: Hex; block: PinnedBlock; from: Address }[] = [];
  launchQuote: { update: Update; fee: bigint } = { update: { delta0: 0n, delta1: 0n }, fee: 0n };
  routerQuote: Update = { delta0: 0n, delta1: 0n };
  /** Revert bytes both routers' quotes answer with instead, when set. */
  quoteRevert: Hex | null = null;
  principalReceived: ChainLog[] = [];
  liquidityLocked: ChainLog[] = [];
  quoteDecimals = 6;

  constructor(readonly launch: LaunchFixture | null = launchFixture()) {}

  async latest() {
    return BLOCK;
  }

  async call(request: { from: Address; to: Address; data: Hex; block: PinnedBlock }): Promise<CallResult> {
    this.calls.push(request);
    const to = getAddress(request.to);
    if (to === C.scheduledLaunch) return this.scheduledLaunch(request.data);
    if ((to === C.launchRouter || to === C.router) && this.quoteRevert !== null) return { ok: false, revert: this.quoteRevert };
    if (to === C.launchRouter) return this.result(launchRouterAbi, "quote", [packUpdate(this.launchQuote.update), this.launchQuote.fee]);
    if (to === C.router) return this.result(routerAbi, "quote", [packUpdate(this.routerQuote), pad("0x0", { size: 32 })]);
    return this.result(erc20Abi, "decimals", this.quoteDecimals);
  }

  private result(abi: Abi, functionName: string, result: unknown): CallResult {
    return { ok: true, data: encodeFunctionResult({ abi, functionName, result } as never) };
  }

  private scheduledLaunch(data: Hex): CallResult {
    const { functionName } = decodeFunctionData({ abi: scheduledLaunchAbi, data });
    const launch = this.launch;
    if (launch === null) return this.result(scheduledLaunchAbi, "getLaunch", emptyLaunch());
    if (functionName === "terminalPool") {
      const key = launchKey(launch);
      const config = pad(`0x${((BigInt(C.twamm) << 96n) | (launch.finalFee << 32n)).toString(16)}`, { size: 32 });
      return this.result(scheduledLaunchAbi, "terminalPool", { ...key, config });
    }
    return this.result(scheduledLaunchAbi, "getLaunch", {
      ...emptyLaunch(),
      owner: launch.owner,
      token: TOKEN,
      startTime: launch.startTime,
      endTime: launch.endTime,
      complete: launch.complete,
      initialFee: launch.initialFee,
      finalFee: launch.finalFee,
    });
  }

  async logs(filter: { address: Address; topics: (Hex | null)[] }): Promise<ChainLog[]> {
    const address = getAddress(filter.address);
    if (address === C.locked) {
      const principal = encodeEventTopics({ abi: lockedLaunchLiquidityAbi, eventName: "PrincipalReceived" })[0];
      return filter.topics[0] === principal ? this.principalReceived : this.liquidityLocked;
    }
    if (this.launch === null || filter.topics[2] !== pad(TOKEN)) return [];
    return [createdLog(this.launch)];
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

function createdLog(launch: LaunchFixture): ChainLog {
  const key = launchKey(launch);
  const event = getAbiItem({ abi: scheduledLaunchAbi, name: "LaunchCreated" }) as unknown as { inputs: { indexed?: boolean }[] };
  const topics = encodeEventTopics({
    abi: scheduledLaunchAbi,
    eventName: "LaunchCreated",
    args: { poolId: poolId(key), token: TOKEN, owner: launch.owner },
  } as never) as Hex[];
  const data = encodeAbiParameters(event.inputs.filter((input) => input.indexed !== true) as never, [
    {
      owner: launch.owner,
      quoteToken: launch.quoteToken,
      name: launch.name,
      symbol: launch.symbol,
      decimals: launch.decimals,
      totalSupply: 10n ** 27n,
      quoteAmount: 0n,
      startTime: launch.startTime,
      endTime: launch.endTime,
      targetTick: launch.targetTick,
      upperTick: launch.upperTick,
      tickSpacing: launch.tickSpacing,
      initialFee: launch.initialFee,
      finalFee: launch.finalFee,
      migrationTickLower: launch.targetTick,
      migrationTickUpper: launch.upperTick,
    },
  ] as never);
  return { topics, data, blockNumber: BLOCK.number - 10n, logIndex: 0 };
}

export function log(blockNumber: bigint, logIndex: number): ChainLog {
  return { topics: [], data: "0x", blockNumber, logIndex };
}
