import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  stringToHex,
  type Abi,
  type AbiEvent,
} from "viem";
import {
  coreEvents,
  erc20Events,
  launchRouterEvents,
  lockedLaunchLiquidityEvents,
  scheduledLaunchEvents,
} from "../../src/launchpad/analytics/abi.js";
import type { FixtureBundle } from "../../src/launchpad/analytics/fixture-source.js";
import type {
  Address,
  BlockHeader,
  Hex,
  LaunchpadManifest,
  MissingRange,
  PinnedPrice,
  RawLog,
  TransactionInfo,
} from "../../src/launchpad/analytics/types.js";

export const addr = (n: number | bigint, prefix = "a"): Address =>
  `0x${prefix}${BigInt(n).toString(16).padStart(39, "0")}` as Address;

export const MANIFEST: LaunchpadManifest = {
  chain_id: 31337,
  revision: "fixture-revision",
  deployment_block: 100,
  contracts: {
    core: { address: addr(1, "c"), code_hash: `0x${"11".repeat(32)}` },
    scheduled_launch: { address: addr(3, "c"), code_hash: `0x${"33".repeat(32)}` },
    locked_launch_liquidity: { address: addr(4, "c"), code_hash: `0x${"44".repeat(32)}` },
    launch_router: { address: addr(5, "c"), code_hash: `0x${"55".repeat(32)}` },
    router: { address: addr(6, "c"), code_hash: `0x${"66".repeat(32)}` },
  },
  twamm: { address: addr(2, "c"), code_hash: `0x${"22".repeat(32)}` },
};

export const TWAMM = addr(2, "c");

export const ZERO = "0x0000000000000000000000000000000000000000" as Address;
export const NATIVE = ZERO;
export const C = MANIFEST.contracts;

const UINT128 = (1n << 128n) - 1n;

function word(value: bigint, bits: bigint): bigint {
  return value < 0n ? (1n << bits) + value : value;
}

export function packBalanceUpdate(delta0: bigint, delta1: bigint): Hex {
  const packed = (word(delta0, 128n) << 128n) | word(delta1, 128n);
  return `0x${packed.toString(16).padStart(64, "0")}`;
}

function packState(tick: number, liquidity: bigint): string {
  const tickWord = BigInt(tick < 0 ? 0x100000000 + tick : tick);
  const state = (1n << 200n) | (tickWord << 128n) | (liquidity & UINT128);
  return state.toString(16).padStart(64, "0");
}

function eventLog(abi: Abi, eventName: string, args: Record<string, unknown>): { topics: Hex[]; data: Hex } {
  const event = abi.find((item) => item.type === "event" && item.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [event], eventName, args } as never) as Hex[];
  const body = event.inputs.filter((input) => !input.indexed);
  const data = encodeAbiParameters(body, body.map((input) => args[input.name as string]) as never);
  return { topics, data };
}

export interface ConfigInput {
  owner: Address;
  quoteToken?: Address;
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: bigint;
  quoteAmount?: bigint;
  startTime: number;
  endTime: number;
  targetTick?: number;
  upperTick?: number;
  tickSpacing?: number;
  initialFee?: bigint;
  finalFee?: bigint;
}

const CONFIG_DEFAULTS = {
  quoteToken: NATIVE,
  name: "Fixture Token",
  symbol: "FIX",
  decimals: 18,
  totalSupply: 1_000_000n * 10n ** 18n,
  quoteAmount: 0n,
  targetTick: -1000,
  upperTick: 1000,
  tickSpacing: 100,
  initialFee: (1n << 64n) / 10n,
  finalFee: (1n << 64n) / 100n,
};

export function config(input: ConfigInput) {
  const defined = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  const merged = { ...CONFIG_DEFAULTS, ...defined } as typeof CONFIG_DEFAULTS & ConfigInput;
  return {
    owner: merged.owner,
    quoteToken: merged.quoteToken,
    name: merged.name,
    symbol: merged.symbol,
    decimals: merged.decimals,
    totalSupply: merged.totalSupply,
    quoteAmount: merged.quoteAmount,
    startTime: BigInt(merged.startTime),
    endTime: BigInt(merged.endTime),
    targetTick: merged.targetTick,
    upperTick: merged.upperTick,
    tickSpacing: merged.tickSpacing,
    initialFee: merged.initialFee,
    finalFee: merged.finalFee,
    migrationTickLower: -2000,
    migrationTickUpper: 2000,
  };
}

export class Tx {
  private logIndex: () => number;
  constructor(
    readonly builder: ChainBuilder,
    readonly block: { number: number; hash: Hex },
    readonly hash: Hex,
    logIndex: () => number,
  ) {
    this.logIndex = logIndex;
  }

  private push(address: Address, topics: Hex[], data: Hex): RawLog {
    const log: RawLog = {
      address,
      topics,
      data,
      block_number: this.block.number,
      block_hash: this.block.hash,
      transaction_hash: this.hash,
      log_index: this.logIndex(),
    };
    this.builder.logs.push(log);
    return log;
  }

  private emit(address: Address, abi: Abi, name: string, args: Record<string, unknown>): RawLog {
    const { topics, data } = eventLog(abi, name, args);
    return this.push(address, topics, data);
  }

  transfer(token: Address, from: Address, to: Address, value: bigint) {
    return this.emit(token, erc20Events as Abi, "Transfer", { from, to, value });
  }

  launchCreated(poolId: Hex, token: Address, cfg: ReturnType<typeof config>) {
    return this.emit(C.scheduled_launch.address, scheduledLaunchEvents as Abi, "LaunchCreated", {
      poolId,
      token,
      owner: cfg.owner,
      config: cfg,
    });
  }

  advanced(poolId: Hex, deployed: bigint, complete: boolean) {
    return this.emit(C.scheduled_launch.address, scheduledLaunchEvents as Abi, "LaunchAdvanced", { poolId, deployed, complete });
  }

  creatorFeesClaimed(poolId: Hex, recipient: Address, amount0: bigint, amount1: bigint) {
    return this.emit(C.scheduled_launch.address, scheduledLaunchEvents as Abi, "CreatorFeesClaimed", { poolId, recipient, amount0, amount1 });
  }

  launchSwapped(poolId: Hex, locker: Address, delta0: bigint, delta1: bigint, feeAmount: bigint, feeIsToken1: boolean) {
    return this.emit(C.scheduled_launch.address, scheduledLaunchEvents as Abi, "LaunchSwapped", {
      poolId,
      locker,
      delta0,
      delta1,
      feeAmount,
      feeIsToken1,
    });
  }

  principal(launchId: Hex, amount0: bigint, amount1: bigint) {
    return this.emit(C.locked_launch_liquidity.address, lockedLaunchLiquidityEvents as Abi, "PrincipalReceived", { launchId, amount0, amount1 });
  }

  locked(launchId: Hex, terminalPoolId: Hex, liquidity: bigint) {
    return this.emit(C.locked_launch_liquidity.address, lockedLaunchLiquidityEvents as Abi, "LiquidityLocked", { launchId, terminalPoolId, liquidity });
  }

  feesClaimed(launchId: Hex, recipient: Address, amount0: bigint, amount1: bigint) {
    return this.emit(C.locked_launch_liquidity.address, lockedLaunchLiquidityEvents as Abi, "FeesClaimed", { launchId, recipient, amount0, amount1 });
  }

  routed(poolId: Hex, payer: Address, recipient: Address) {
    return this.emit(C.launch_router.address, launchRouterEvents as Abi, "LaunchRouted", { poolId, payer, recipient });
  }

  positionUpdated(locker: Address, poolId: Hex, liquidityDelta: bigint, delta0: bigint, delta1: bigint) {
    return this.emit(C.core.address, coreEvents as Abi, "PositionUpdated", {
      locker,
      poolId,
      positionId: `0x${"00".repeat(32)}`,
      liquidityDelta,
      balanceUpdate: packBalanceUpdate(delta0, delta1),
      stateAfter: `0x${"00".repeat(32)}`,
    });
  }

  feesCollected(locker: Address, poolId: Hex, amount0: bigint, amount1: bigint) {
    return this.emit(C.core.address, coreEvents as Abi, "PositionFeesCollected", {
      locker,
      poolId,
      positionId: `0x${"00".repeat(32)}`,
      amount0,
      amount1,
    });
  }

  coreSwap(locker: Address, poolId: Hex, delta0: bigint, delta1: bigint, tick = 0, liquidity = 1n) {
    const body =
      locker.slice(2) +
      poolId.slice(2) +
      packBalanceUpdate(delta0, delta1).slice(2) +
      packState(tick, liquidity);
    return this.push(C.core.address, [], `0x${body}`);
  }
}

export interface BuilderOptions {
  chain_id?: number;
  first_block?: number;
  first_timestamp?: number;
  block_time?: number;
  branch?: string;
}

/** A synthetic chain: contiguous blocks with deterministic hashes, plus their logs. */
export class ChainBuilder {
  readonly blocks: BlockHeader[] = [];
  readonly logs: RawLog[] = [];
  readonly transactions: TransactionInfo[] = [];
  readonly options: Required<BuilderOptions>;
  private txCount = 0;

  constructor(options: BuilderOptions = {}) {
    this.options = {
      chain_id: options.chain_id ?? MANIFEST.chain_id,
      first_block: options.first_block ?? 100,
      first_timestamp: options.first_timestamp ?? 1_800_000_000,
      block_time: options.block_time ?? 12,
      branch: options.branch ?? "main",
    };
  }

  get head(): BlockHeader {
    const head = this.blocks.at(-1);
    if (head === undefined) throw new Error("no blocks");
    return head;
  }

  /** Append one block, optionally with transactions. */
  block(build?: (block: BlockBuild) => void, options: { timestamp?: number } = {}): BlockHeader {
    const previous = this.blocks.at(-1);
    const number = previous === undefined ? this.options.first_block : previous.number + 1;
    const timestamp =
      options.timestamp ??
      (previous === undefined ? this.options.first_timestamp : previous.timestamp + this.options.block_time);
    const hash = keccak256(stringToHex(`${this.options.branch}:${number}:${timestamp}`));
    const header: BlockHeader = {
      number,
      hash,
      parent_hash: previous?.hash ?? (`0x${"00".repeat(32)}` as Hex),
      timestamp,
    };
    this.blocks.push(header);
    let index = 0;
    build?.(new BlockBuild(this, header, () => index++));
    return header;
  }

  blocksUntil(number: number): void {
    while (this.blocks.length === 0 || this.head.number < number) this.block();
  }

  nextTxHash(): Hex {
    this.txCount += 1;
    return keccak256(stringToHex(`${this.options.branch}:tx:${this.txCount}`));
  }

  /** A copy sharing every block below `number`, to grow a competing branch. */
  fork(number: number, branch: string): ChainBuilder {
    const fork = new ChainBuilder({ ...this.options, branch });
    fork.blocks.push(...this.blocks.filter((b) => b.number < number));
    fork.logs.push(...this.logs.filter((l) => l.block_number < number));
    fork.transactions.push(...this.transactions);
    fork.txCount = this.txCount + 1000;
    return fork;
  }

  /** An eth_getLogs-shaped bundle (the EKU-662 v2 format) for this chain. */
  bundle(options: BundleOptions = {}): FixtureBundle {
    const chain = String(this.options.chain_id);
    const contracts = manifestContracts(options);
    return {
      bundle: "chain-builder",
      ...retrievedAt(options),
      manifest: { revision: options.revision ?? MANIFEST.revision, contracts: { [chain]: contracts } },
      index: { [chain]: this.indexEntry(options) },
      as_of: { [chain]: this.asOfEntry(options) },
      reorgs: options.reorgs ?? [],
      pinned_prices: options.prices ?? [],
      ...this.chainData(options, chain),
      transactions: [...this.transactions],
      code_hashes: { [chain]: options.code_hashes ?? codeHashes(contracts) },
      token_decimals: {},
    };
  }

  private indexEntry(options: BundleOptions) {
    const head = options.head ?? this.head.number;
    return {
      indexed_range: { from_block: this.options.first_block, to_block: options.indexed_to ?? head },
      missing_ranges: options.missing_ranges ?? [],
      head_block: head,
    };
  }

  private asOfEntry(options: BundleOptions) {
    const wanted = options.as_of ?? options.head ?? this.head.number;
    const asOf = this.blocks.find((b) => b.number === wanted) ?? this.head;
    return { block_number: asOf.number, block_hash: asOf.hash, block_timestamp: asOf.timestamp, finality: options.finality ?? "latest" };
  }

  private chainData(options: BundleOptions, chain: string) {
    return {
      blocks: (options.blocks ?? this.blocks).map((b) => ({ chain_id: chain, ...b })),
      logs: (options.logs ?? this.logs).map((l) => ({ chain_id: chain, transaction_index: 0, ...l })),
    };
  }
}

type ContractEntries = Record<string, { address: string; code_hash: string | null }>;

function manifestContracts(options: BundleOptions): ContractEntries {
  const contracts: ContractEntries = { ...MANIFEST.contracts };
  if (options.without_twamm !== true && MANIFEST.twamm !== null) contracts.twamm = MANIFEST.twamm;
  return contracts;
}

function codeHashes(contracts: ContractEntries): Record<string, string> {
  return Object.fromEntries(Object.values(contracts).map((c) => [c.address, c.code_hash ?? ""]));
}

function retrievedAt(options: BundleOptions): { retrieved_at?: string } {
  if (options.retrieved_at === null) return {};
  return { retrieved_at: options.retrieved_at ?? "2026-10-02T12:00:00.000Z" };
}

export interface BundleOptions {
  head?: number;
  as_of?: number;
  indexed_to?: number;
  missing_ranges?: MissingRange[];
  logs?: RawLog[];
  blocks?: BlockHeader[];
  reorgs?: FixtureBundle["reorgs"];
  prices?: PinnedPrice[];
  code_hashes?: Record<string, string>;
  finality?: "finalized" | "safe" | "latest";
  revision?: string;
  retrieved_at?: string | null;
  without_twamm?: boolean;
}

export class BlockBuild {
  constructor(
    readonly builder: ChainBuilder,
    readonly header: BlockHeader,
    private readonly nextIndex: () => number,
  ) {}

  tx(from: Address, to: Address | null = C.launch_router.address): Tx {
    const hash = this.builder.nextTxHash();
    this.builder.transactions.push({ hash, from, to });
    return new Tx(this.builder, this.header, hash, this.nextIndex);
  }
}

export function poolIdFor(token: Address): Hex {
  return keccak256(stringToHex(`pool:${token}`));
}

export function terminalIdFor(token: Address): Hex {
  return keccak256(stringToHex(`terminal:${token}`));
}

/**
 * Launch lifecycle helpers that emit the same log sequence as the contracts:
 * creation mints to the extension and pays Core; a routed buy releases
 * inventory, swaps in Core, charges the fee on the launch token and pays the
 * recipient out of Core.
 */
export class LaunchSim {
  readonly poolId: Hex;
  readonly terminalId: Hex;
  readonly tokenIs0: boolean;
  deployed = 0n;
  readonly cfg: ReturnType<typeof config>;

  constructor(
    readonly builder: ChainBuilder,
    readonly token: Address,
    input: ConfigInput,
  ) {
    this.cfg = config(input);
    this.poolId = poolIdFor(token);
    this.terminalId = terminalIdFor(token);
    this.tokenIs0 = BigInt(token) < BigInt(this.cfg.quoteToken);
  }

  pair(token: bigint, quote: bigint): [bigint, bigint] {
    return this.tokenIs0 ? [token, quote] : [quote, token];
  }

  create(block: BlockBuild, sender: Address, payer: Address = sender): void {
    const tx = block.tx(sender);
    tx.transfer(this.token, ZERO, C.scheduled_launch.address, this.cfg.totalSupply);
    tx.transfer(this.token, C.scheduled_launch.address, C.core.address, this.cfg.totalSupply);
    tx.launchCreated(this.poolId, this.token, this.cfg);
    tx.routed(this.poolId, payer, sender);
  }

  /** Deploy `amount` more inventory as launch liquidity inside `tx`. */
  deploy(tx: Tx, amount: bigint): void {
    if (amount === 0n) return;
    this.deployed += amount;
    const [d0, d1] = this.pair(amount, 0n);
    tx.positionUpdated(C.scheduled_launch.address, this.poolId, 1n, d0, d1);
    tx.advanced(this.poolId, this.deployed, false);
  }

  /** Exact-input buy paid in quote; fee is charged on the launch token output. */
  buy(
    block: BlockBuild,
    options: {
      payer: Address;
      recipient?: Address;
      quoteIn: bigint;
      tokenOut: bigint;
      fee: bigint;
      deploy?: bigint;
      tick?: number;
      liquidity?: bigint;
      locker?: Address;
    },
  ): Tx {
    const tx = block.tx(options.payer);
    const recipient = options.recipient ?? options.payer;
    this.deploy(tx, options.deploy ?? 0n);
    const [c0, c1] = this.pair(-options.tokenOut, options.quoteIn);
    tx.coreSwap(C.scheduled_launch.address, this.poolId, c0, c1, options.tick ?? 0, options.liquidity ?? 1n);
    const [l0, l1] = this.pair(-(options.tokenOut - options.fee), options.quoteIn);
    const locker = options.locker ?? C.launch_router.address;
    tx.launchSwapped(this.poolId, locker, l0, l1, options.fee, !this.tokenIs0);
    if (locker === C.launch_router.address) tx.routed(this.poolId, options.payer, recipient);
    tx.transfer(this.token, C.core.address, recipient, options.tokenOut - options.fee);
    return tx;
  }

  /** Exact-input sell of launch tokens; fee is charged on the quote output. */
  sell(
    block: BlockBuild,
    options: { payer: Address; tokenIn: bigint; quoteOut: bigint; fee: bigint; from?: Address },
  ): Tx {
    const tx = block.tx(options.payer);
    tx.transfer(this.token, options.from ?? options.payer, C.core.address, options.tokenIn);
    const [c0, c1] = this.pair(options.tokenIn, -options.quoteOut);
    tx.coreSwap(C.scheduled_launch.address, this.poolId, c0, c1);
    const [l0, l1] = this.pair(options.tokenIn, -(options.quoteOut - options.fee));
    tx.launchSwapped(this.poolId, C.launch_router.address, l0, l1, options.fee, this.tokenIs0);
    tx.routed(this.poolId, options.payer, options.payer);
    return tx;
  }
}
