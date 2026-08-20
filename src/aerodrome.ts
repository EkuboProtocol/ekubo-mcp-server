import {
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { errorResultDecodePlan, functionReadCall, readCallsBundle } from "./abi-decode.js";
import { ServiceError } from "./core.js";
import type { ExecutionPlanStepInput } from "./execution-plan.js";
import {
  erc20ApprovalTransaction,
  preparedTransaction,
  preparedUiAction,
} from "./ui-actions.js";

/**
 * Aerodrome is Base-only, so unlike Merkl there is no chain set to verify —
 * there is one chain and a plan for any other is a mistake, not a gap.
 *
 * Velodrome is the same codebase on Optimism and the Superchain leaves under a
 * different brand and different addresses. Nothing here is shared with it: a
 * second deployment would be a sibling constant, not extra entries in this one.
 */
export const AERODROME_CHAIN_ID = "8453";

/**
 * Every address below was derived on chain from `AERODROME_VOTER` outward on
 * 2026-08-20, not copied from the SDKs.
 *
 * That distinction earned its keep twice. `sugar-sdk`'s config and `sdk.js`'s
 * ABI bundle disagreed about the position manager, and `sdk.js` turned out to
 * be an Optimism snapshot whose `Position` struct is missing two fields the
 * deployed Base lens returns. Reading the graph settles both: the entry that
 * survives is the one the chain points at.
 */
export const AERODROME_DEPLOYMENT = {
  chain_id: AERODROME_CHAIN_ID,
  network: "Base",
  /** ve.token(), symbol() = "AERO". */
  aero: getAddress("0x940181a94A35A4569E4529A3CDfB74e38FD98631"),
  /** Voter.ve(), symbol() = "veNFT". */
  voting_escrow: getAddress("0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4"),
  /** Router.voter() and ve.voter() both return this. */
  voter: getAddress("0x16613524e02ad97eDfeF371bC883F2F5d6C480A5"),
  router: getAddress("0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43"),
  /** Router.defaultFactory(); the v2 (stable/volatile) pool factory. */
  pool_factory: getAddress("0x420DD381b31aEf6683db6B902084cB0FFECe40Da"),
  /** Voter.factoryRegistry() and Router.factoryRegistry() agree on this. */
  factory_registry: getAddress("0x5C3F18F06CC09CA1910767A34a20F771039E37C0"),
  /** Voter.minter(). */
  minter: getAddress("0xeB018363F0a9Af8f91F06FEe6613a751b2A33FE5"),
  /** RewardsDistributor; its ve() returns the escrow above. Pays the rebase. */
  rewards_distributor: getAddress("0x227f65131A261548b057215bB1D5Ab2997964C7d"),
  /** Router.weth(). */
  weth: getAddress("0x4200000000000000000000000000000000000006"),
  concentrated: {
    /** The current Slipstream factory, from position_manager.factory(). */
    factory: getAddress("0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef"),
    position_manager: getAddress("0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53"),
    /** Still holds live positions; its own NFPM reports it as factory(). */
    legacy_factory: getAddress("0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A"),
    legacy_position_manager: getAddress("0x827922686190790b37229fd06084350E74485b72"),
  },
  /** The Sugar lens contracts: Velodrome's onchain data pipeline. */
  sugar: {
    lp: getAddress("0x69dD9db6d8f8E7d83887A704f447b1a584b599A1"),
    rewards: getAddress("0x1b121EfDaF4ABb8785a315C51D29BCE0552A7678"),
    ve: getAddress("0x4d6A741cEE6A8cC5632B2d948C050303F6246D24"),
    relay: getAddress("0x3dd0849D66DBd63D06f11442502e200601c50790"),
  },
} as const;

/** LpSugar.MAX_LPS(), read on chain. A full page is a 560KB response. */
const MAX_POOLS_PER_READ = 500;
/** LpSugar.MAX_POSITIONS(), read on chain. */
const MAX_POSITIONS_PER_READ = 200;
/** Voter.vote() weights are relative, and the array is bounded here. */
const MAX_VOTE_POOLS = 32;
/** One claim call per bribe/fee contract, bounded so a plan stays reviewable. */
const MAX_CLAIM_SOURCES = 32;
const MAX_CLAIM_TOKENS_PER_SOURCE = 16;
/** Aerodrome's epoch, and the escrow's maximum lock. */
const WEEK_SECONDS = 604_800;
const MAX_LOCK_SECONDS = 4 * 365 * 24 * 60 * 60;

export const AERODROME_ROUTER_ABI = parseAbi([
  "function addLiquidity(address tokenA,address tokenB,bool stable,uint256 amountADesired,uint256 amountBDesired,uint256 amountAMin,uint256 amountBMin,address to,uint256 deadline) returns (uint256 amountA,uint256 amountB,uint256 liquidity)",
  "function removeLiquidity(address tokenA,address tokenB,bool stable,uint256 liquidity,uint256 amountAMin,uint256 amountBMin,address to,uint256 deadline) returns (uint256 amountA,uint256 amountB)",
  "function poolFor(address tokenA,address tokenB,bool stable,address _factory) view returns (address pool)",
  "function quoteAddLiquidity(address tokenA,address tokenB,bool stable,address _factory,uint256 amountADesired,uint256 amountBDesired) view returns (uint256 amountA,uint256 amountB,uint256 liquidity)",
  "function quoteRemoveLiquidity(address tokenA,address tokenB,bool stable,address _factory,uint256 liquidity) view returns (uint256 amountA,uint256 amountB)",
]);

export const AERODROME_GAUGE_ABI = parseAbi([
  "function deposit(uint256 _amount)",
  "function withdraw(uint256 _amount)",
  "function getReward(address _account)",
  "function earned(address _account) view returns (uint256)",
  "function balanceOf(address _account) view returns (uint256)",
  "function stakingToken() view returns (address)",
  "function rewardToken() view returns (address)",
]);

export const AERODROME_VOTER_ABI = parseAbi([
  "function vote(uint256 _tokenId,address[] _poolVote,uint256[] _weights)",
  "function reset(uint256 _tokenId)",
  "function poke(uint256 _tokenId)",
  "function claimBribes(address[] _bribes,address[][] _tokens,uint256 _tokenId)",
  "function claimFees(address[] _fees,address[][] _tokens,uint256 _tokenId)",
  "function gauges(address _pool) view returns (address)",
  "function isAlive(address _gauge) view returns (bool)",
  "function lastVoted(uint256 _tokenId) view returns (uint256)",
  "function epochVoteEnd(uint256 _timestamp) view returns (uint256)",
]);

export const AERODROME_VOTING_ESCROW_ABI = parseAbi([
  "function createLock(uint256 _value,uint256 _lockDuration) returns (uint256)",
  "function increaseAmount(uint256 _tokenId,uint256 _value)",
  "function increaseUnlockTime(uint256 _tokenId,uint256 _lockDuration)",
  "function lockPermanent(uint256 _tokenId)",
  "function unlockPermanent(uint256 _tokenId)",
  "function withdraw(uint256 _tokenId)",
  "function locked(uint256 _tokenId) view returns (int128 amount,uint256 end,bool isPermanent)",
  "function ownerOf(uint256 _tokenId) view returns (address)",
  "function balanceOfNFT(uint256 _tokenId) view returns (uint256)",
  "function voted(uint256 _tokenId) view returns (bool)",
  "function escrowType(uint256 _tokenId) view returns (uint8)",
]);

export const AERODROME_REWARDS_DISTRIBUTOR_ABI = parseAbi([
  "function claim(uint256 _tokenId) returns (uint256)",
  "function claimable(uint256 _tokenId) view returns (uint256)",
]);

export const AERODROME_ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
]);

/**
 * The reverts these contracts raise by name, so a failed simulation says what
 * went wrong instead of showing four bytes. The ve(3,3) ones are the whole
 * reason this list exists: `AlreadyVotedOrDeposited` and `DistributeWindow`
 * are epoch-timing failures, and an agent that cannot read them will retry
 * inside the same window and fail identically.
 */
export const AERODROME_ERRORS_ABI = parseAbi([
  "error AlreadyVotedOrDeposited()",
  "error DistributeWindow()",
  "error NotWhitelistedNFT()",
  "error NotApprovedOrOwner()",
  "error InactiveManagedNFT()",
  "error TooManyPools()",
  "error UnequalLengths()",
  "error ZeroBalance()",
  "error NonExistentToken()",
  "error PermanentLock()",
  "error LockExpired()",
  "error LockNotExpired()",
  "error NoVotingPowerAtEpoch()",
  "error GaugeNotAlive()",
  "error SameEpoch()",
]);

/** The struct LpSugar returns from `all`, verified by decoding a live pool. */
const LP_STRUCT = {
  name: "",
  type: "tuple[]",
  components: [
    { name: "lp", type: "address" },
    { name: "symbol", type: "string" },
    { name: "decimals", type: "uint8" },
    { name: "liquidity", type: "uint256" },
    { name: "type", type: "int24" },
    { name: "tick", type: "int24" },
    { name: "sqrt_ratio", type: "uint160" },
    { name: "token0", type: "address" },
    { name: "reserve0", type: "uint256" },
    { name: "staked0", type: "uint256" },
    { name: "token1", type: "address" },
    { name: "reserve1", type: "uint256" },
    { name: "staked1", type: "uint256" },
    { name: "gauge", type: "address" },
    { name: "gauge_liquidity", type: "uint256" },
    { name: "gauge_alive", type: "bool" },
    { name: "fee", type: "address" },
    { name: "bribe", type: "address" },
    { name: "factory", type: "address" },
    { name: "emissions", type: "uint256" },
    { name: "emissions_token", type: "address" },
    { name: "emissions_cap", type: "uint256" },
    { name: "pool_fee", type: "uint256" },
    { name: "unstaked_fee", type: "uint256" },
    { name: "token0_fees", type: "uint256" },
    { name: "token1_fees", type: "uint256" },
    { name: "locked", type: "uint256" },
    { name: "emerging", type: "uint256" },
    { name: "created_at", type: "uint32" },
    { name: "nfpm", type: "address" },
    { name: "alm", type: "address" },
    { name: "root", type: "address" },
  ],
} as const;

/**
 * The struct LpSugar returns from `positions`.
 *
 * `locker` and `unlocks_at` are the two fields `sdk.js` omits. Decoding a live
 * response with its shape silently misreads every field after `sqrt_ratio_upper`,
 * which is why this is transcribed from the deployed contract's Vyper source
 * rather than from the JS bundle.
 */
const POSITION_STRUCT = {
  name: "",
  type: "tuple[]",
  components: [
    { name: "id", type: "uint256" },
    { name: "lp", type: "address" },
    { name: "liquidity", type: "uint256" },
    { name: "staked", type: "uint256" },
    { name: "amount0", type: "uint256" },
    { name: "amount1", type: "uint256" },
    { name: "staked0", type: "uint256" },
    { name: "staked1", type: "uint256" },
    { name: "unstaked_earned0", type: "uint256" },
    { name: "unstaked_earned1", type: "uint256" },
    { name: "emissions_earned", type: "uint256" },
    { name: "tick_lower", type: "int24" },
    { name: "tick_upper", type: "int24" },
    { name: "sqrt_ratio_lower", type: "uint160" },
    { name: "sqrt_ratio_upper", type: "uint160" },
    { name: "locker", type: "address" },
    { name: "unlocks_at", type: "uint32" },
    { name: "alm", type: "address" },
  ],
} as const;

/** The veNFT struct, including the trailing `managed_id` the deployed lens returns. */
const VENFT_COMPONENTS = [
  { name: "id", type: "uint256" },
  { name: "account", type: "address" },
  { name: "decimals", type: "uint8" },
  { name: "amount", type: "uint128" },
  { name: "voting_amount", type: "uint256" },
  { name: "governance_amount", type: "uint256" },
  { name: "rebase_amount", type: "uint256" },
  { name: "expires_at", type: "uint256" },
  { name: "voted_at", type: "uint256" },
  {
    name: "votes",
    type: "tuple[]",
    components: [
      { name: "lp", type: "address" },
      { name: "weight", type: "uint256" },
    ],
  },
  { name: "token", type: "address" },
  { name: "permanent", type: "bool" },
  { name: "delegate_id", type: "uint256" },
  { name: "managed_id", type: "uint256" },
] as const;

const LP_EPOCH_STRUCT = {
  name: "",
  type: "tuple[]",
  components: [
    { name: "ts", type: "uint256" },
    { name: "lp", type: "address" },
    { name: "votes", type: "uint256" },
    { name: "emissions", type: "uint256" },
    {
      name: "bribes",
      type: "tuple[]",
      components: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
    {
      name: "fees",
      type: "tuple[]",
      components: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
  ],
} as const;

const REWARD_STRUCT = {
  name: "",
  type: "tuple[]",
  components: [
    { name: "venft_id", type: "uint256" },
    { name: "lp", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "token", type: "address" },
    { name: "fee", type: "address" },
    { name: "bribe", type: "address" },
  ],
} as const;

const SUGAR_ABI = [
  {
    type: "function",
    name: "all",
    stateMutability: "view",
    inputs: [
      { name: "_limit", type: "uint256" },
      { name: "_offset", type: "uint256" },
      { name: "_filter", type: "uint256" },
    ],
    outputs: [LP_STRUCT],
  },
  {
    type: "function",
    name: "positions",
    stateMutability: "view",
    inputs: [
      { name: "_limit", type: "uint256" },
      { name: "_offset", type: "uint256" },
      { name: "_account", type: "address" },
    ],
    outputs: [POSITION_STRUCT],
  },
  {
    type: "function",
    name: "count",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "byAccount",
    stateMutability: "view",
    inputs: [{ name: "_account", type: "address" }],
    outputs: [{ name: "", type: "tuple[]", components: VENFT_COMPONENTS }],
  },
  {
    type: "function",
    name: "byId",
    stateMutability: "view",
    inputs: [{ name: "_id", type: "uint256" }],
    outputs: [{ name: "", type: "tuple", components: VENFT_COMPONENTS }],
  },
  {
    type: "function",
    name: "epochsLatest",
    stateMutability: "view",
    inputs: [
      { name: "_limit", type: "uint256" },
      { name: "_offset", type: "uint256" },
    ],
    outputs: [LP_EPOCH_STRUCT],
  },
  {
    type: "function",
    name: "epochsByAddress",
    stateMutability: "view",
    inputs: [
      { name: "_limit", type: "uint256" },
      { name: "_offset", type: "uint256" },
      { name: "_address", type: "address" },
    ],
    outputs: [LP_EPOCH_STRUCT],
  },
  {
    type: "function",
    name: "rewards",
    stateMutability: "view",
    inputs: [
      { name: "_limit", type: "uint256" },
      { name: "_offset", type: "uint256" },
      { name: "_venft_id", type: "uint256" },
    ],
    outputs: [REWARD_STRUCT],
  },
  {
    type: "function",
    name: "rewardsByAddress",
    stateMutability: "view",
    inputs: [
      { name: "_venft_id", type: "uint256" },
      { name: "_pool", type: "address" },
    ],
    outputs: [REWARD_STRUCT],
  },
] as const;

export type AerodromeSugarDataset =
  | "pools"
  | "positions"
  | "venfts_by_account"
  | "venft_by_id"
  | "latest_epochs"
  | "pool_epochs"
  | "venft_rewards"
  | "venft_pool_rewards";

export function getAerodromeDeployment(input: { chainId?: string } = {}) {
  if (input.chainId !== undefined) requireBase(input.chainId);
  return {
    protocol: "aerodrome",
    network_access: "none",
    source: {
      documentation: "https://aerodrome.finance/docs",
      sugar_contracts: "https://github.com/velodrome-finance/sugar",
      python_sdk: "https://github.com/velodrome-finance/sugar-sdk",
      js_sdk: "https://github.com/velodrome-finance/sdk.js",
      snapshot_date: "2026-08-20",
    },
    agent_market_data_discovery: {
      server_involvement: "none",
      skill_resource: "ekubo://skills/use-aerodrome",
      method:
        "Aerodrome has no data API to call: the Sugar lens contracts are the data pipeline, and they answer eth_call. Use prepare_aerodrome_sugar_reads to get a read bundle and run it through the user's own wallet/RPC.",
      handoff:
        "Sugar output is the input to preparation. Pool addresses, gauge addresses, LP balances, veNFT ids, and the fee/bribe contracts a claim needs all come from a Sugar read, never from this server.",
    },
    deployment: AERODROME_DEPLOYMENT,
    verification: {
      verified_on: "2026-08-20",
      method:
        "Derived on chain from the Voter outward rather than copied from the SDKs: Voter.ve() gives the escrow, ve.token() gives AERO, Router.defaultFactory() gives the v2 pool factory, Voter.factoryRegistry() and Router.factoryRegistry() agree, position_manager.factory() distinguishes the current Slipstream factory from the legacy one, and every Sugar lens answered a live read.",
      why_not_the_sdks:
        "sdk.js ships Optimism/Velodrome addresses and an Optimism ABI snapshot whose Position struct is missing locker and unlocks_at, which silently misreads every later field. Its addresses and struct layouts are not usable for Base.",
    },
    properties: {
      pool_types:
        "v2 pools are stable or volatile and hold fungible LP ERC-20 tokens; Slipstream pools are concentrated and hold ERC-721 positions. The Lp struct's type field is 0 for stable, -1 for volatile, and a positive tick spacing on concentrated pools",
      emissions_require_staking:
        "LP tokens earn AERO emissions only while staked in the pool's gauge; simply holding the LP token earns trading fees on v2 and no emissions at all",
      staked_positions_earn_no_trading_fees:
        "Staking a v2 LP token into its gauge redirects that position's trading fees to voters and pays AERO instead, so staking is a swap of fee income for emissions rather than an addition to it",
      one_vote_per_epoch:
        "A veNFT may vote once per weekly epoch, and voting again in the same epoch reverts with AlreadyVotedOrDeposited. A vote persists into later epochs until it is changed or reset",
      votes_lock_the_nft:
        "A veNFT that has voted this epoch cannot be withdrawn or merged until it is reset, and reset is itself blocked during the distribute window at the epoch boundary",
      weights_are_relative:
        "Voter.vote weights are proportions of the NFT's voting power, not absolute amounts, so [1,1] and [50,50] cast the same vote",
      rebase_is_separate:
        "The RewardsDistributor rebase is claimed per veNFT and is distinct from voting rewards; claiming it compounds into the lock rather than paying out",
    },
    limitations: {
      chains: `Aerodrome exists only on Base (chain ${AERODROME_CHAIN_ID}). Velodrome is the same codebase on Optimism and the Superchain under different addresses and is not prepared here.`,
      live_state:
        "No Aerodrome API, RPC, Sugar, pool, gauge, veNFT, or reward state is queried by this server; it only builds the reads and the calldata",
      swaps:
        "Swaps are deliberately absent. get_quotes_with_plans is this server's single swap path, and it compares sources and returns a firm plan per option; a route-supplied Aerodrome swap with no quote behind it would bypass that comparison",
      concentrated_liquidity:
        "Slipstream positions are surfaced by the Sugar reads but minting, burning, and CL gauge staking are not prepared yet; those need tick and slippage handling and are the natural next step",
      relays:
        "Relay deposits and withdrawals are deliberately not prepared, and this is a product decision rather than a missing feature. Depositing a veNFT into a relay hands its voting to that relay's manager, which is the thing recurring agent voting through the wallet already does without giving up control of the NFT. Relay state stays readable, so a relay's votes can still be inspected; only the delegation is out of scope.",
    },
  };
}

/**
 * Build the read bundle for one Sugar dataset.
 *
 * This is the tool the rest of the integration hangs off. Aerodrome publishes
 * no data API — Sugar is the data pipeline, and it answers `eth_call` — so the
 * server's no-proxy boundary costs nothing here: handing the wallet a verified
 * bundle to run against its own RPC is simply how Sugar is meant to be used.
 *
 * `byIndex` and `byAddress` are deliberately not offered. Both revert on the
 * deployed Base lens, including for the canonical AERO/USDC pool, and `all`
 * with an offset covers the same ground.
 */
export function prepareAerodromeSugarReads(input: {
  chainId: string;
  dataset: AerodromeSugarDataset;
  account?: string;
  pool?: string;
  venftId?: string;
  limit?: number;
  offset?: number;
}) {
  requireBase(input.chainId);
  const offset = boundedIndex(input.offset ?? 0, "offset");

  const { calls, request, note } = sugarDatasetCalls(input, offset);
  return {
    schema_version: "1",
    action: "aerodrome_sugar_reads",
    protocol: "aerodrome",
    server_network_access: "none",
    request: { chain_id: input.chainId, dataset: input.dataset, ...request },
    dataset_note: note,
    read_calls: readCallsBundle({
      chainId: input.chainId,
      blockParameter: "latest",
      ...(input.account === undefined ? {} : { from: getAddress(input.account) }),
      calls,
    }),
    instruction:
      "Pass read_calls_reference unchanged as wallet_batch_eth_call's reference argument. The decoded result is authoritative Aerodrome state read from the user's own RPC; this server never saw it. Feed the addresses it returns — pool, gauge, fee, and bribe contracts, and veNFT ids — into the prepare_aerodrome_* tools rather than inferring them.",
    pagination:
      "Sugar paginates by limit and offset against a fixed ordering. Read count first when walking every pool: there are tens of thousands, and a full 500-pool page is a 560KB response.",
  };
}

function sugarDatasetCalls(
  input: {
    dataset: AerodromeSugarDataset;
    account?: string;
    pool?: string;
    venftId?: string;
    limit?: number;
  },
  offset: number,
): { calls: ReturnType<typeof sugarRead>[]; request: Record<string, unknown>; note: string } {
  switch (input.dataset) {
    case "pools": {
      const limit = boundedLimit(input.limit ?? 50, MAX_POOLS_PER_READ, "limit");
      return {
        calls: [
          sugarRead(AERODROME_DEPLOYMENT.sugar.lp, "pool_count", "count", []),
          sugarRead(AERODROME_DEPLOYMENT.sugar.lp, "pools", "all", [
            BigInt(limit),
            BigInt(offset),
            0n,
          ]),
        ],
        request: { limit, offset },
        note: "Lp.type is 0 for stable, -1 for volatile, and a positive tick spacing on concentrated pools. A pool with gauge_alive false still trades but no longer earns emissions.",
      };
    }
    case "positions": {
      const account = requireAddress(input.account, "account");
      const limit = boundedLimit(input.limit ?? 50, MAX_POSITIONS_PER_READ, "limit");
      return {
        calls: [
          sugarRead(AERODROME_DEPLOYMENT.sugar.lp, "positions", "positions", [
            BigInt(limit),
            BigInt(offset),
            account,
          ]),
        ],
        request: { account, limit, offset },
        note: "staked is the gauge-staked portion and liquidity the total, so an unstaked position has emissions_earned 0. On v2 the amounts are LP tokens; on concentrated pools id is the ERC-721 position.",
      };
    }
    case "venfts_by_account": {
      const account = requireAddress(input.account, "account");
      return {
        calls: [sugarRead(AERODROME_DEPLOYMENT.sugar.ve, "venfts", "byAccount", [account])],
        request: { account },
        note: "votes carries the pools this NFT currently votes for and their weights. A non-zero managed_id means the NFT is deposited into a managed veNFT and cannot be voted or withdrawn directly.",
      };
    }
    case "venft_by_id": {
      const venftId = requireUint(input.venftId, "venft_id");
      return {
        calls: [sugarRead(AERODROME_DEPLOYMENT.sugar.ve, "venft", "byId", [venftId])],
        request: { venft_id: venftId.toString() },
        note: "voted_at is the timestamp of the last vote; compare it with the current epoch start to know whether this NFT has already voted and would revert on another vote.",
      };
    }
    case "latest_epochs": {
      const limit = boundedLimit(input.limit ?? 20, MAX_POOLS_PER_READ, "limit");
      return {
        calls: [
          sugarRead(AERODROME_DEPLOYMENT.sugar.rewards, "epochs", "epochsLatest", [
            BigInt(limit),
            BigInt(offset),
          ]),
        ],
        request: { limit, offset },
        note: "Each entry is one pool's current epoch: votes cast, emissions per second, and the bribes and fees a voter would share in.",
      };
    }
    case "pool_epochs": {
      const pool = requireAddress(input.pool, "pool");
      const limit = boundedLimit(input.limit ?? 10, MAX_POOLS_PER_READ, "limit");
      return {
        calls: [
          sugarRead(AERODROME_DEPLOYMENT.sugar.rewards, "epochs", "epochsByAddress", [
            BigInt(limit),
            BigInt(offset),
            pool,
          ]),
        ],
        request: { pool, limit, offset },
        note: "Epochs are returned most recent first, so the first entry is the epoch currently being voted on and its rewards are not final.",
      };
    }
    case "venft_rewards": {
      const venftId = requireUint(input.venftId, "venft_id");
      const limit = boundedLimit(input.limit ?? 50, MAX_POOLS_PER_READ, "limit");
      return {
        calls: [
          sugarRead(AERODROME_DEPLOYMENT.sugar.rewards, "rewards", "rewards", [
            BigInt(limit),
            BigInt(offset),
            venftId,
          ]),
        ],
        request: { venft_id: venftId.toString(), limit, offset },
        note: "Each Reward names the fee or bribe contract it came from. Those exact addresses are what prepare_aerodrome_incentive_claim needs; a claim cannot be built without this read.",
      };
    }
    case "venft_pool_rewards": {
      const venftId = requireUint(input.venftId, "venft_id");
      const pool = requireAddress(input.pool, "pool");
      return {
        calls: [
          sugarRead(AERODROME_DEPLOYMENT.sugar.rewards, "rewards", "rewardsByAddress", [
            venftId,
            pool,
          ]),
        ],
        request: { venft_id: venftId.toString(), pool },
        note: "The same Reward shape as venft_rewards, narrowed to one pool.",
      };
    }
  }
}

function sugarRead(
  to: Address,
  id: string,
  functionName: string,
  args: readonly unknown[],
) {
  return functionReadCall({
    id,
    to,
    data: encodeFunctionData({
      abi: SUGAR_ABI,
      // biome-ignore lint/suspicious/noExplicitAny: one helper over nine read shapes
      functionName: functionName as any,
      // biome-ignore lint/suspicious/noExplicitAny: argument tuples differ per dataset
      args: args as any,
    }),
    abi: SUGAR_ABI as never,
    functionName,
  });
}

/**
 * Add liquidity to a v2 pool.
 *
 * Both minimums are required rather than defaulted. `addLiquidity` consumes
 * whatever ratio the reserves demand and refunds the rest, so a caller who
 * passes zero minimums is not accepting slippage on a price — they are
 * accepting any split at all, which on a pool that has just moved is how a
 * deposit lands lopsided and immediately loses value on rebalance.
 */
export function prepareAerodromeLiquidityDeposit(input: {
  chainId: string;
  sender: string;
  tokenA: string;
  tokenB: string;
  stable: boolean;
  amountADesired: string;
  amountBDesired: string;
  amountAMin: string;
  amountBMin: string;
  deadline: string;
  recipient?: string;
}) {
  requireBase(input.chainId);
  const sender = getAddress(input.sender);
  const recipient = getAddress(input.recipient ?? input.sender);
  const tokenA = getAddress(input.tokenA);
  const tokenB = getAddress(input.tokenB);
  requireDistinctTokens(tokenA, tokenB);

  const amountADesired = positiveUint256(input.amountADesired, "amount_a_desired");
  const amountBDesired = positiveUint256(input.amountBDesired, "amount_b_desired");
  const amountAMin = uint256(input.amountAMin, "amount_a_min");
  const amountBMin = uint256(input.amountBMin, "amount_b_min");
  requireAtMost(amountAMin, amountADesired, "amount_a_min", "amount_a_desired");
  requireAtMost(amountBMin, amountBDesired, "amount_b_min", "amount_b_desired");
  const deadline = futureDeadline(input.deadline);

  const router = AERODROME_DEPLOYMENT.router;
  const steps: ExecutionPlanStepInput[] = [
    approvalStep(input.chainId, tokenA, router, amountADesired),
    approvalStep(input.chainId, tokenB, router, amountBDesired),
    {
      kind: "execution",
      transaction: preparedTransaction(
        input.chainId,
        router,
        encodeFunctionData({
          abi: AERODROME_ROUTER_ABI,
          functionName: "addLiquidity",
          args: [
            tokenA,
            tokenB,
            input.stable,
            amountADesired,
            amountBDesired,
            amountAMin,
            amountBMin,
            recipient,
            deadline,
          ],
        }),
        0n,
      ),
      revertDecode: errorResultDecodePlan(AERODROME_ERRORS_ABI),
    },
    // addLiquidity refunds the unused side, so an exact approval can be left
    // partly unspent. Zeroing both is what keeps a stale allowance from
    // outliving the deposit that justified it.
    approvalStep(input.chainId, tokenA, router, 0n, "allowance_cleanup"),
    approvalStep(input.chainId, tokenB, router, 0n, "allowance_cleanup"),
  ];

  return preparedUiAction({
    action: "aerodrome_liquidity_deposit",
    chainId: input.chainId,
    sender,
    request: {
      chain_id: input.chainId,
      sender,
      token_a: tokenA,
      token_b: tokenB,
      stable: input.stable,
      amount_a_desired: amountADesired.toString(),
      amount_b_desired: amountBDesired.toString(),
      amount_a_min: amountAMin.toString(),
      amount_b_min: amountBMin.toString(),
      recipient,
      deadline: deadline.toString(),
    },
    steps,
    atomicBatchRequired: true,
    details: {
      ...aerodromeDetails(),
      pool_kind: input.stable ? "v2_stable" : "v2_volatile",
      router,
      factory: AERODROME_DEPLOYMENT.pool_factory,
      unused_amounts_are_refunded: true,
      lp_tokens_are_not_staked:
        "This mints LP tokens only. They earn trading fees but no AERO until they are staked with prepare_aerodrome_gauge_deposit.",
      native_eth_not_supported:
        "Wrap ETH to WETH first; the ETH entrypoints are not prepared here.",
    },
    onchainValidation: {
      status: "not_executed",
      instruction:
        "Pass onchain_validation.read_calls_reference unchanged as wallet_batch_eth_call's reference argument. Compare quote_add_liquidity against the desired amounts: it is the split the pool will actually take, and the difference is what gets refunded. If either minimum exceeds the quoted amount the deposit reverts, so re-quote rather than sending. Confirm pool is not the zero address; a zero pool means this token pair and stable flag have no pool yet and addLiquidity would create one at a price you set.",
      read_calls: readCallsBundle({
        chainId: input.chainId,
        from: sender,
        calls: [
          routerRead("pool", "poolFor", [
            tokenA,
            tokenB,
            input.stable,
            AERODROME_DEPLOYMENT.pool_factory,
          ]),
          routerRead("quote_add_liquidity", "quoteAddLiquidity", [
            tokenA,
            tokenB,
            input.stable,
            AERODROME_DEPLOYMENT.pool_factory,
            amountADesired,
            amountBDesired,
          ]),
          erc20Read("balance_a", tokenA, "balanceOf", [sender]),
          erc20Read("balance_b", tokenB, "balanceOf", [sender]),
        ],
      }),
    },
  });
}

/** Burn v2 LP tokens back into their underlying pair. */
export function prepareAerodromeLiquidityWithdraw(input: {
  chainId: string;
  sender: string;
  tokenA: string;
  tokenB: string;
  stable: boolean;
  liquidity: string;
  amountAMin: string;
  amountBMin: string;
  deadline: string;
  recipient?: string;
}) {
  requireBase(input.chainId);
  const sender = getAddress(input.sender);
  const recipient = getAddress(input.recipient ?? input.sender);
  const tokenA = getAddress(input.tokenA);
  const tokenB = getAddress(input.tokenB);
  requireDistinctTokens(tokenA, tokenB);

  const liquidity = positiveUint256(input.liquidity, "liquidity");
  const amountAMin = uint256(input.amountAMin, "amount_a_min");
  const amountBMin = uint256(input.amountBMin, "amount_b_min");
  const deadline = futureDeadline(input.deadline);
  const router = AERODROME_DEPLOYMENT.router;

  return preparedUiAction({
    action: "aerodrome_liquidity_withdraw",
    chainId: input.chainId,
    sender,
    request: {
      chain_id: input.chainId,
      sender,
      token_a: tokenA,
      token_b: tokenB,
      stable: input.stable,
      liquidity: liquidity.toString(),
      amount_a_min: amountAMin.toString(),
      amount_b_min: amountBMin.toString(),
      recipient,
      deadline: deadline.toString(),
    },
    steps: [
      // The LP token itself is the approval subject here, and its address is
      // whatever poolFor returns; the read bundle below is how the agent
      // confirms the approval target it just authorized.
      {
        kind: "execution",
        transaction: preparedTransaction(
          input.chainId,
          router,
          encodeFunctionData({
            abi: AERODROME_ROUTER_ABI,
            functionName: "removeLiquidity",
            args: [
              tokenA,
              tokenB,
              input.stable,
              liquidity,
              amountAMin,
              amountBMin,
              recipient,
              deadline,
            ],
          }),
          0n,
        ),
        revertDecode: errorResultDecodePlan(AERODROME_ERRORS_ABI),
      },
    ],
    details: {
      ...aerodromeDetails(),
      pool_kind: input.stable ? "v2_stable" : "v2_volatile",
      router,
      lp_token_approval_required:
        "removeLiquidity pulls the LP token, so the pool address returned by the read below must already have approved the router for at least this liquidity. Staked LP tokens are held by the gauge and must be withdrawn from it first.",
      returns_both_underlying_tokens: true,
    },
    onchainValidation: {
      status: "not_executed",
      instruction:
        "Pass onchain_validation.read_calls_reference unchanged as wallet_batch_eth_call's reference argument. Require lp_balance to be at least liquidity — if it is short, the missing amount is probably staked in the gauge and needs prepare_aerodrome_gauge_withdraw first. Require lp_allowance to cover liquidity, and compare quote_remove_liquidity with the minimums before authorizing.",
      read_calls: readCallsBundle({
        chainId: input.chainId,
        from: sender,
        calls: [
          routerRead("pool", "poolFor", [
            tokenA,
            tokenB,
            input.stable,
            AERODROME_DEPLOYMENT.pool_factory,
          ]),
          routerRead("quote_remove_liquidity", "quoteRemoveLiquidity", [
            tokenA,
            tokenB,
            input.stable,
            AERODROME_DEPLOYMENT.pool_factory,
            liquidity,
          ]),
        ],
      }),
    },
  });
}

/** Stake v2 LP tokens into a pool's gauge to start earning AERO. */
export function prepareAerodromeGaugeDeposit(input: {
  chainId: string;
  sender: string;
  gauge: string;
  amount: string;
}) {
  requireBase(input.chainId);
  const sender = getAddress(input.sender);
  const gauge = getAddress(input.gauge);
  const amount = positiveUint256(input.amount, "amount");

  return preparedUiAction({
    action: "aerodrome_gauge_deposit",
    chainId: input.chainId,
    sender,
    request: { chain_id: input.chainId, sender, gauge, amount: amount.toString() },
    steps: [
      // The staking token is read, not assumed: the approval below is written
      // against the gauge's own stakingToken(), which the validation read
      // confirms before anything is signed.
      {
        kind: "execution",
        transaction: preparedTransaction(
          input.chainId,
          gauge,
          encodeFunctionData({
            abi: AERODROME_GAUGE_ABI,
            functionName: "deposit",
            args: [amount],
          }),
          0n,
        ),
        revertDecode: errorResultDecodePlan(AERODROME_ERRORS_ABI),
      },
    ],
    details: {
      ...aerodromeDetails(),
      gauge,
      lp_approval_required:
        "The gauge pulls the LP token, so staking_token from the read below must have approved this gauge for at least amount before this plan is sent.",
      staking_redirects_trading_fees:
        "While staked, this position's share of trading fees goes to the pool's voters and the position earns AERO emissions instead.",
      concentrated_gauges_not_supported:
        "This is the v2 gauge interface, which stakes a fungible amount. A Slipstream gauge stakes an ERC-721 position id instead and is not prepared here.",
    },
    onchainValidation: {
      status: "not_executed",
      instruction:
        "Pass onchain_validation.read_calls_reference unchanged as wallet_batch_eth_call's reference argument. Confirm staking_token is the LP token the user means to stake and that its balance and allowance for this gauge both cover amount. If gauge_alive is false the gauge no longer receives emissions and staking into it earns nothing — say so before authorizing.",
      read_calls: readCallsBundle({
        chainId: input.chainId,
        from: sender,
        calls: [
          gaugeRead("staking_token", gauge, "stakingToken", []),
          gaugeRead("reward_token", gauge, "rewardToken", []),
          gaugeRead("staked_balance", gauge, "balanceOf", [sender]),
          voterRead("gauge_alive", "isAlive", [gauge]),
        ],
      }),
    },
  });
}

/** Unstake v2 LP tokens from a gauge. Emissions already earned stay claimable. */
export function prepareAerodromeGaugeWithdraw(input: {
  chainId: string;
  sender: string;
  gauge: string;
  amount: string;
}) {
  requireBase(input.chainId);
  const sender = getAddress(input.sender);
  const gauge = getAddress(input.gauge);
  const amount = positiveUint256(input.amount, "amount");

  return preparedUiAction({
    action: "aerodrome_gauge_withdraw",
    chainId: input.chainId,
    sender,
    request: { chain_id: input.chainId, sender, gauge, amount: amount.toString() },
    steps: [
      {
        kind: "execution",
        transaction: preparedTransaction(
          input.chainId,
          gauge,
          encodeFunctionData({
            abi: AERODROME_GAUGE_ABI,
            functionName: "withdraw",
            args: [amount],
          }),
          0n,
        ),
        revertDecode: errorResultDecodePlan(AERODROME_ERRORS_ABI),
      },
    ],
    details: {
      ...aerodromeDetails(),
      gauge,
      returns_lp_tokens_not_underlying:
        "This returns the LP token to the sender. Converting it back to the underlying pair is a separate prepare_aerodrome_liquidity_withdraw.",
      earned_emissions_are_not_swept:
        "Withdrawing does not claim AERO. Accrued emissions stay claimable with prepare_aerodrome_gauge_claim, but claim them rather than leaving them behind.",
    },
    onchainValidation: {
      status: "not_executed",
      instruction:
        "Pass onchain_validation.read_calls_reference unchanged as wallet_batch_eth_call's reference argument. Require staked_balance to be at least amount. If earned is non-zero, tell the user that unstaking alone leaves it unclaimed.",
      read_calls: readCallsBundle({
        chainId: input.chainId,
        from: sender,
        calls: [
          gaugeRead("staked_balance", gauge, "balanceOf", [sender]),
          gaugeRead("earned", gauge, "earned", [sender]),
          gaugeRead("staking_token", gauge, "stakingToken", []),
        ],
      }),
    },
  });
}

/** Claim accrued AERO emissions from a gauge. */
export function prepareAerodromeGaugeClaim(input: {
  chainId: string;
  sender: string;
  gauge: string;
  account?: string;
}) {
  requireBase(input.chainId);
  const sender = getAddress(input.sender);
  const account = getAddress(input.account ?? input.sender);

  return preparedUiAction({
    action: "aerodrome_gauge_claim",
    chainId: input.chainId,
    sender,
    request: { chain_id: input.chainId, sender, gauge: getAddress(input.gauge), account },
    steps: [
      {
        kind: "execution",
        transaction: preparedTransaction(
          input.chainId,
          getAddress(input.gauge),
          encodeFunctionData({
            abi: AERODROME_GAUGE_ABI,
            functionName: "getReward",
            args: [account],
          }),
          0n,
        ),
        revertDecode: errorResultDecodePlan(AERODROME_ERRORS_ABI),
      },
    ],
    details: {
      ...aerodromeDetails(),
      gauge: getAddress(input.gauge),
      pays_the_account_not_the_sender:
        account === sender
          ? false
          : "getReward credits the account argument, so this plan pays that address while the sender only pays gas.",
      rewards_are_aero_emissions: true,
    },
    onchainValidation: {
      status: "not_executed",
      instruction:
        "Pass onchain_validation.read_calls_reference unchanged as wallet_batch_eth_call's reference argument. If earned is zero the claim succeeds and transfers nothing, so there is no reason to spend gas on it.",
      read_calls: readCallsBundle({
        chainId: input.chainId,
        from: sender,
        calls: [
          gaugeRead("earned", getAddress(input.gauge), "earned", [account]),
          gaugeRead("reward_token", getAddress(input.gauge), "rewardToken", []),
        ],
      }),
    },
  });
}

export type AerodromeLockAction =
  | "create"
  | "increase_amount"
  | "extend"
  | "lock_permanent"
  | "unlock_permanent"
  | "withdraw";

/**
 * Build one veAERO lock action.
 *
 * These are one tool rather than six because they are one decision with a
 * mode: every branch targets the same escrow and the same balance, and the
 * validation reads that matter — is it locked, has it voted, is it permanent —
 * are identical across them.
 */
export function prepareAerodromeLock(input: {
  chainId: string;
  sender: string;
  action: AerodromeLockAction;
  amount?: string;
  lockDuration?: string;
  venftId?: string;
}) {
  requireBase(input.chainId);
  const sender = getAddress(input.sender);
  const escrow = AERODROME_DEPLOYMENT.voting_escrow;
  const steps: ExecutionPlanStepInput[] = [];
  const request: Record<string, unknown> = { chain_id: input.chainId, sender, action: input.action };
  const details: Record<string, unknown> = { ...aerodromeDetails(), voting_escrow: escrow };
  const reads: ReturnType<typeof escrowRead>[] = [];

  if (input.action === "create") {
    const amount = positiveUint256(requireDefined(input.amount, "amount"), "amount");
    const lockDuration = lockDurationSeconds(
      requireDefined(input.lockDuration, "lock_duration"),
    );
    steps.push(
      approvalStep(input.chainId, AERODROME_DEPLOYMENT.aero, escrow, amount),
      escrowStep(input.chainId, "createLock", [amount, lockDuration]),
      approvalStep(input.chainId, AERODROME_DEPLOYMENT.aero, escrow, 0n, "allowance_cleanup"),
    );
    request.amount = amount.toString();
    request.lock_duration = lockDuration.toString();
    details.mints_a_new_venft =
      "createLock mints a new veNFT and returns its id; the id is not known until the transaction executes, so read it from the receipt rather than guessing.";
    details.duration_is_rounded_down =
      "The escrow floors the unlock time to a week boundary, so the realised lock is up to one week shorter than the duration requested.";
    reads.push(
      erc20Read("aero_balance", AERODROME_DEPLOYMENT.aero, "balanceOf", [sender]),
      erc20Read("aero_allowance", AERODROME_DEPLOYMENT.aero, "allowance", [sender, escrow]),
    );
  } else {
    const venftId = requireUint(input.venftId, "venft_id");
    request.venft_id = venftId.toString();
    reads.push(
      escrowRead("locked", "locked", [venftId]),
      escrowRead("owner", "ownerOf", [venftId]),
      escrowRead("voting_power", "balanceOfNFT", [venftId]),
      escrowRead("voted", "voted", [venftId]),
      escrowRead("escrow_type", "escrowType", [venftId]),
    );

    switch (input.action) {
      case "increase_amount": {
        const amount = positiveUint256(requireDefined(input.amount, "amount"), "amount");
        steps.push(
          approvalStep(input.chainId, AERODROME_DEPLOYMENT.aero, escrow, amount),
          escrowStep(input.chainId, "increaseAmount", [venftId, amount]),
          approvalStep(input.chainId, AERODROME_DEPLOYMENT.aero, escrow, 0n, "allowance_cleanup"),
        );
        request.amount = amount.toString();
        details.does_not_extend_the_lock =
          "Adding AERO leaves the unlock time where it was, so voting power still decays toward the same date.";
        reads.push(
          erc20Read("aero_balance", AERODROME_DEPLOYMENT.aero, "balanceOf", [sender]),
          erc20Read("aero_allowance", AERODROME_DEPLOYMENT.aero, "allowance", [sender, escrow]),
        );
        break;
      }
      case "extend": {
        const lockDuration = lockDurationSeconds(
          requireDefined(input.lockDuration, "lock_duration"),
        );
        steps.push(escrowStep(input.chainId, "increaseUnlockTime", [venftId, lockDuration]));
        request.lock_duration = lockDuration.toString();
        details.duration_is_from_now =
          "lock_duration is measured from now, not added to the remaining lock, and it must land strictly later than the current unlock time or the call reverts.";
        details.permanent_locks_cannot_be_extended =
          "A permanently locked NFT has no unlock time to move; unlock it first if the intent is a decaying lock.";
        break;
      }
      case "lock_permanent": {
        steps.push(escrowStep(input.chainId, "lockPermanent", [venftId]));
        details.stops_decay =
          "A permanent lock holds voting power at its maximum instead of decaying, and the AERO cannot be withdrawn until it is unlocked, which restarts a normal decaying lock.";
        break;
      }
      case "unlock_permanent": {
        steps.push(escrowStep(input.chainId, "unlockPermanent", [venftId]));
        details.restarts_decay =
          "Unlocking converts the NFT back to a maximum-duration decaying lock; the AERO is still not withdrawable until that lock expires.";
        break;
      }
      case "withdraw": {
        steps.push(escrowStep(input.chainId, "withdraw", [venftId]));
        details.burns_the_venft =
          "withdraw burns the veNFT and returns its AERO. It requires an expired, non-permanent lock that has not voted this epoch.";
        details.reset_first_if_voted =
          "If this NFT voted in the current epoch, reset it with prepare_aerodrome_vote before withdrawing.";
        break;
      }
    }
  }

  return preparedUiAction({
    action: `aerodrome_lock_${input.action}`,
    chainId: input.chainId,
    sender,
    request,
    steps,
    ...(steps.length > 1 ? { atomicBatchRequired: true } : {}),
    details,
    onchainValidation: {
      status: "not_executed",
      instruction:
        "Pass onchain_validation.read_calls_reference unchanged as wallet_batch_eth_call's reference argument. Where an existing veNFT is involved, require owner to equal the sender, and read locked as (amount, end, isPermanent): a withdraw needs end in the past and isPermanent false, an extend needs a new unlock time strictly beyond end, and a non-zero escrow_type means the NFT is managed or locked into a relay and these calls will revert.",
      read_calls: readCallsBundle({ chainId: input.chainId, from: sender, calls: reads }),
    },
  });
}

/**
 * Cast or reset one veNFT's vote.
 *
 * Weights are proportional, so they are passed through as given rather than
 * normalized here: rescaling them would change the numbers a user reviews in
 * their wallet without changing the vote, which is a worse trade than leaving
 * them exactly as supplied.
 */
export function prepareAerodromeVote(input: {
  chainId: string;
  sender: string;
  venftId: string;
  pools?: readonly { pool: string; weight: string }[];
  reset?: boolean;
}) {
  requireBase(input.chainId);
  const sender = getAddress(input.sender);
  const venftId = requireUint(input.venftId, "venft_id");
  const voter = AERODROME_DEPLOYMENT.voter;
  const isReset = input.reset === true;

  if (isReset && (input.pools?.length ?? 0) > 0) {
    throw new ServiceError(
      "conflicting_vote_input",
      "A reset clears every vote, so it cannot be combined with pool weights. Send one or the other.",
    );
  }

  let data: Hex;
  const request: Record<string, unknown> = {
    chain_id: input.chainId,
    sender,
    venft_id: venftId.toString(),
  };
  const reads = [
    escrowRead("owner", "ownerOf", [venftId]),
    escrowRead("voting_power", "balanceOfNFT", [venftId]),
    escrowRead("escrow_type", "escrowType", [venftId]),
    voterRead("last_voted", "lastVoted", [venftId]),
  ];

  if (isReset) {
    data = encodeFunctionData({
      abi: AERODROME_VOTER_ABI,
      functionName: "reset",
      args: [venftId],
    });
    request.reset = true;
  } else {
    const pools = input.pools ?? [];
    if (pools.length === 0) {
      throw new ServiceError(
        "invalid_vote",
        "Supply at least one pool weight, or set reset to clear this NFT's votes",
      );
    }
    if (pools.length > MAX_VOTE_POOLS) {
      throw new ServiceError(
        "too_many_pools",
        `At most ${MAX_VOTE_POOLS} pools can be voted in one plan`,
      );
    }
    const seen = new Set<Address>();
    const entries = pools.map((entry) => {
      const pool = getAddress(entry.pool);
      if (seen.has(pool)) {
        throw new ServiceError(
          "duplicate_pool",
          `Pool ${pool} appears more than once; combine its weight into a single entry`,
        );
      }
      seen.add(pool);
      return { pool, weight: positiveUint256(entry.weight, "weight") };
    });
    data = encodeFunctionData({
      abi: AERODROME_VOTER_ABI,
      functionName: "vote",
      args: [
        venftId,
        entries.map((entry) => entry.pool),
        entries.map((entry) => entry.weight),
      ],
    });
    request.pools = entries.map((entry) => ({
      pool: entry.pool,
      weight: entry.weight.toString(),
    }));
    for (const [index, entry] of entries.entries()) {
      reads.push(voterRead(`gauge_${index}`, "gauges", [entry.pool]));
      reads.push(voterRead(`gauge_alive_${index}`, "isAlive", [entry.pool]));
    }
  }

  return preparedUiAction({
    action: isReset ? "aerodrome_vote_reset" : "aerodrome_vote",
    chainId: input.chainId,
    sender,
    request,
    // A vote is the one action whose likely failure is a named epoch-timing
    // revert rather than a balance, so the plan carries the decode that turns
    // AlreadyVotedOrDeposited into something an agent can act on.
    steps: [
      {
        kind: "execution",
        transaction: preparedTransaction(input.chainId, voter, data, 0n),
        revertDecode: errorResultDecodePlan(AERODROME_ERRORS_ABI),
      },
    ],
    details: {
      ...aerodromeDetails(),
      voter,
      weights_are_relative:
        "Weights are shares of this NFT's voting power, not token amounts. Their absolute size is irrelevant; only their ratio is.",
      replaces_the_previous_vote:
        "A vote overwrites this NFT's entire allocation. Pools left out of the list are voted 0, not left as they were.",
      one_vote_per_epoch:
        "The Voter allows one vote per veNFT per weekly epoch. A second attempt in the same epoch reverts with AlreadyVotedOrDeposited, and the fix is to wait for the next epoch, not to retry.",
      voting_locks_the_nft:
        "After voting, this NFT cannot be withdrawn or merged until it is reset in a later epoch.",
    },
    onchainValidation: {
      status: "not_executed",
      instruction:
        "Pass onchain_validation.read_calls_reference unchanged as wallet_batch_eth_call's reference argument. Require owner to equal the sender and voting_power to be non-zero. Compare last_voted against the current epoch start — if it falls inside the current epoch this NFT has already voted and the call will revert. Every gauge_* read must be a non-zero address with gauge_alive true: a pool with no live gauge cannot be voted for.",
      read_calls: readCallsBundle({ chainId: input.chainId, from: sender, calls: reads }),
    },
  });
}

/**
 * Claim a veNFT's voting rewards, its rebase, or both.
 *
 * The fee and bribe contract addresses are required inputs because there is no
 * honest way to derive them here: they are per-pool contracts that a Sugar
 * `rewards` read returns alongside the amounts. Guessing them would produce a
 * plan that silently claims nothing.
 */
export function prepareAerodromeIncentiveClaim(input: {
  chainId: string;
  sender: string;
  venftId: string;
  fees?: readonly { contract: string; tokens: readonly string[] }[];
  bribes?: readonly { contract: string; tokens: readonly string[] }[];
  claimRebase?: boolean;
}) {
  requireBase(input.chainId);
  const sender = getAddress(input.sender);
  const venftId = requireUint(input.venftId, "venft_id");
  const fees = normalizeClaimSources(input.fees ?? [], "fees");
  const bribes = normalizeClaimSources(input.bribes ?? [], "bribes");
  const claimRebase = input.claimRebase === true;

  if (fees.length === 0 && bribes.length === 0 && !claimRebase) {
    throw new ServiceError(
      "empty_claim",
      "Supply at least one fee or bribe source, or set claim_rebase. A Sugar venft_rewards read is where those contract addresses come from.",
    );
  }

  const voter = AERODROME_DEPLOYMENT.voter;
  const steps: ExecutionPlanStepInput[] = [];
  const reads = [escrowRead("owner", "ownerOf", [venftId])];

  if (fees.length > 0) {
    steps.push({
      kind: "execution",
      transaction: preparedTransaction(
        input.chainId,
        voter,
        encodeFunctionData({
          abi: AERODROME_VOTER_ABI,
          functionName: "claimFees",
          args: [
            fees.map((source) => source.contract),
            fees.map((source) => source.tokens),
            venftId,
          ],
        }),
        0n,
      ),
      revertDecode: errorResultDecodePlan(AERODROME_ERRORS_ABI),
    });
  }
  if (bribes.length > 0) {
    steps.push({
      kind: "execution",
      transaction: preparedTransaction(
        input.chainId,
        voter,
        encodeFunctionData({
          abi: AERODROME_VOTER_ABI,
          functionName: "claimBribes",
          args: [
            bribes.map((source) => source.contract),
            bribes.map((source) => source.tokens),
            venftId,
          ],
        }),
        0n,
      ),
      revertDecode: errorResultDecodePlan(AERODROME_ERRORS_ABI),
    });
  }
  if (claimRebase) {
    steps.push({
      kind: "execution",
      transaction: preparedTransaction(
        input.chainId,
        AERODROME_DEPLOYMENT.rewards_distributor,
        encodeFunctionData({
          abi: AERODROME_REWARDS_DISTRIBUTOR_ABI,
          functionName: "claim",
          args: [venftId],
        }),
        0n,
      ),
      revertDecode: errorResultDecodePlan(AERODROME_ERRORS_ABI),
    });
    reads.push(distributorRead("claimable_rebase", "claimable", [venftId]));
  }

  return preparedUiAction({
    action: "aerodrome_incentive_claim",
    chainId: input.chainId,
    sender,
    request: {
      chain_id: input.chainId,
      sender,
      venft_id: venftId.toString(),
      fees: fees.map((source) => ({ contract: source.contract, tokens: source.tokens })),
      bribes: bribes.map((source) => ({ contract: source.contract, tokens: source.tokens })),
      claim_rebase: claimRebase,
    },
    steps,
    ...(steps.length > 1 ? { atomicBatchRequired: true } : {}),
    details: {
      ...aerodromeDetails(),
      voter,
      rewards_distributor: AERODROME_DEPLOYMENT.rewards_distributor,
      fee_source_count: fees.length,
      bribe_source_count: bribes.length,
      addresses_come_from_sugar:
        "Each fee and bribe contract here was supplied by the caller from a Sugar rewards read. This server did not derive or verify them, so a wrong address claims nothing rather than failing loudly.",
      claims_pay_the_nft_owner:
        "Rewards go to the veNFT's owner regardless of who sends the transaction.",
      rebase_compounds_into_the_lock: claimRebase
        ? "The RewardsDistributor claim adds AERO to the lock itself rather than paying out to the wallet."
        : false,
    },
    onchainValidation: {
      status: "not_executed",
      instruction:
        "Pass onchain_validation.read_calls_reference unchanged as wallet_batch_eth_call's reference argument. Require owner to equal the sender, or explain that the rewards will go to that other address. Where a rebase is included, a zero claimable_rebase means the call transfers nothing and the step is not worth its gas. Claims for a reward the NFT is not owed succeed and move nothing, so a successful simulation is not by itself evidence the amounts were right — check them against the Sugar read they came from.",
      read_calls: readCallsBundle({ chainId: input.chainId, from: sender, calls: reads }),
    },
  });
}

function normalizeClaimSources(
  sources: readonly { contract: string; tokens: readonly string[] }[],
  label: string,
): { contract: Address; tokens: Address[] }[] {
  if (sources.length > MAX_CLAIM_SOURCES) {
    throw new ServiceError(
      "too_many_claim_sources",
      `At most ${MAX_CLAIM_SOURCES} ${label} contracts can be claimed in one plan`,
    );
  }
  const seen = new Set<Address>();
  return sources.map((source) => {
    const contract = getAddress(source.contract);
    if (seen.has(contract)) {
      throw new ServiceError(
        "duplicate_claim_source",
        `${label} contract ${contract} appears more than once; list each one once with all of its tokens`,
      );
    }
    seen.add(contract);
    if (source.tokens.length === 0) {
      throw new ServiceError(
        "empty_claim_tokens",
        `${label} contract ${contract} has no tokens; a claim with no token list transfers nothing`,
      );
    }
    if (source.tokens.length > MAX_CLAIM_TOKENS_PER_SOURCE) {
      throw new ServiceError(
        "too_many_claim_tokens",
        `At most ${MAX_CLAIM_TOKENS_PER_SOURCE} tokens can be claimed from one ${label} contract`,
      );
    }
    const seenTokens = new Set<Address>();
    const tokens = source.tokens.map((token) => {
      const normalized = getAddress(token);
      if (seenTokens.has(normalized)) {
        throw new ServiceError(
          "duplicate_claim_token",
          `Token ${normalized} appears more than once for ${label} contract ${contract}`,
        );
      }
      seenTokens.add(normalized);
      return normalized;
    });
    return { contract, tokens };
  });
}

function aerodromeDetails() {
  return {
    protocol: "aerodrome",
    deployment_chain_id: AERODROME_CHAIN_ID,
    server_network_access: "none",
    live_state_not_queried: true,
    exact_wallet_simulation_required: true,
  };
}

function escrowStep(
  chainId: string,
  functionName: "createLock" | "increaseAmount" | "increaseUnlockTime" | "lockPermanent" | "unlockPermanent" | "withdraw",
  args: readonly unknown[],
): ExecutionPlanStepInput {
  return {
    kind: "execution",
    transaction: preparedTransaction(
      chainId,
      AERODROME_DEPLOYMENT.voting_escrow,
      encodeFunctionData({
        abi: AERODROME_VOTING_ESCROW_ABI,
        functionName,
        // biome-ignore lint/suspicious/noExplicitAny: one helper over six lock shapes
        args: args as any,
      }),
      0n,
    ),
    revertDecode: errorResultDecodePlan(AERODROME_ERRORS_ABI),
  };
}

function approvalStep(
  chainId: string,
  token: Address,
  spender: Address,
  amount: bigint,
  kind: "approval" | "allowance_cleanup" = "approval",
): ExecutionPlanStepInput {
  return {
    kind,
    transaction: erc20ApprovalTransaction(chainId, token, spender, amount),
  };
}

function routerRead(id: string, functionName: string, args: readonly unknown[]) {
  return functionReadCall({
    id,
    to: AERODROME_DEPLOYMENT.router,
    data: encodeFunctionData({
      abi: AERODROME_ROUTER_ABI,
      // biome-ignore lint/suspicious/noExplicitAny: one helper over three router reads
      functionName: functionName as any,
      // biome-ignore lint/suspicious/noExplicitAny: argument tuples differ per read
      args: args as any,
    }),
    abi: AERODROME_ROUTER_ABI,
    functionName,
  });
}

function voterRead(id: string, functionName: string, args: readonly unknown[]) {
  return functionReadCall({
    id,
    to: AERODROME_DEPLOYMENT.voter,
    data: encodeFunctionData({
      abi: AERODROME_VOTER_ABI,
      // biome-ignore lint/suspicious/noExplicitAny: one helper over three voter reads
      functionName: functionName as any,
      // biome-ignore lint/suspicious/noExplicitAny: argument tuples differ per read
      args: args as any,
    }),
    abi: AERODROME_VOTER_ABI,
    functionName,
  });
}

function escrowRead(id: string, functionName: string, args: readonly unknown[]) {
  return functionReadCall({
    id,
    to: AERODROME_DEPLOYMENT.voting_escrow,
    data: encodeFunctionData({
      abi: AERODROME_VOTING_ESCROW_ABI,
      // biome-ignore lint/suspicious/noExplicitAny: one helper over five escrow reads
      functionName: functionName as any,
      // biome-ignore lint/suspicious/noExplicitAny: argument tuples differ per read
      args: args as any,
    }),
    abi: AERODROME_VOTING_ESCROW_ABI,
    functionName,
  });
}

function distributorRead(id: string, functionName: string, args: readonly unknown[]) {
  return functionReadCall({
    id,
    to: AERODROME_DEPLOYMENT.rewards_distributor,
    data: encodeFunctionData({
      abi: AERODROME_REWARDS_DISTRIBUTOR_ABI,
      // biome-ignore lint/suspicious/noExplicitAny: one helper over the distributor reads
      functionName: functionName as any,
      // biome-ignore lint/suspicious/noExplicitAny: argument tuples differ per read
      args: args as any,
    }),
    abi: AERODROME_REWARDS_DISTRIBUTOR_ABI,
    functionName,
  });
}

function gaugeRead(id: string, gauge: Address, functionName: string, args: readonly unknown[]) {
  return functionReadCall({
    id,
    to: gauge,
    data: encodeFunctionData({
      abi: AERODROME_GAUGE_ABI,
      // biome-ignore lint/suspicious/noExplicitAny: one helper over four gauge reads
      functionName: functionName as any,
      // biome-ignore lint/suspicious/noExplicitAny: argument tuples differ per read
      args: args as any,
    }),
    abi: AERODROME_GAUGE_ABI,
    functionName,
  });
}

function erc20Read(id: string, token: Address, functionName: string, args: readonly unknown[]) {
  return functionReadCall({
    id,
    to: token,
    data: encodeFunctionData({
      abi: AERODROME_ERC20_ABI,
      // biome-ignore lint/suspicious/noExplicitAny: one helper over two token reads
      functionName: functionName as any,
      // biome-ignore lint/suspicious/noExplicitAny: argument tuples differ per read
      args: args as any,
    }),
    abi: AERODROME_ERC20_ABI,
    functionName,
  });
}

function requireBase(chainId: string) {
  if (chainId !== AERODROME_CHAIN_ID) {
    throw new ServiceError(
      "unsupported_aerodrome_chain",
      `Aerodrome is deployed only on Base (chain ${AERODROME_CHAIN_ID}), so chain ${chainId} has no Aerodrome to act on. Velodrome runs the same code elsewhere but is a different deployment and is not prepared by this server.`,
      { supported_chain_ids: [AERODROME_CHAIN_ID] },
    );
  }
}

function requireDistinctTokens(tokenA: Address, tokenB: Address) {
  if (tokenA === tokenB) {
    throw new ServiceError(
      "invalid_pair",
      "A pool needs two different tokens",
    );
  }
}

function requireDefined(value: string | undefined, label: string): string {
  if (value === undefined) {
    throw new ServiceError("missing_argument", `${label} is required for this action`);
  }
  return value;
}

function requireAddress(value: string | undefined, label: string): Address {
  return getAddress(requireDefined(value, label));
}

function requireUint(value: string | undefined, label: string): bigint {
  return positiveUint256(requireDefined(value, label), label);
}

function requireAtMost(value: bigint, ceiling: bigint, label: string, ceilingLabel: string) {
  if (value > ceiling) {
    throw new ServiceError(
      "invalid_minimum",
      `${label} exceeds ${ceilingLabel}, so this deposit can never satisfy it`,
    );
  }
}

/**
 * The escrow floors an unlock time to a week boundary, so a duration under one
 * week rounds to no lock at all. Rejecting it here is clearer than letting the
 * user sign a transaction that reverts or locks nothing.
 */
function lockDurationSeconds(value: string): bigint {
  const duration = positiveUint256(value, "lock_duration");
  if (duration < BigInt(WEEK_SECONDS)) {
    throw new ServiceError(
      "invalid_lock_duration",
      `A lock is rounded down to a whole week, so lock_duration must be at least ${WEEK_SECONDS} seconds`,
    );
  }
  if (duration > BigInt(MAX_LOCK_SECONDS)) {
    throw new ServiceError(
      "invalid_lock_duration",
      `The escrow caps a lock at ${MAX_LOCK_SECONDS} seconds (4 years)`,
    );
  }
  return duration;
}

/**
 * A deadline is a real argument, not a formality: the router compares it with
 * the block timestamp, so one already in the past turns the whole plan into a
 * guaranteed revert that the user still pays gas to discover.
 */
function futureDeadline(value: string): bigint {
  const deadline = positiveUint256(value, "deadline");
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= now) {
    throw new ServiceError(
      "expired_deadline",
      "deadline is a unix timestamp in the past, so this transaction would revert on arrival",
      { supplied_deadline: deadline.toString(), server_time: now.toString() },
    );
  }
  return deadline;
}

function boundedLimit(value: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new ServiceError("invalid_limit", `${label} must be a positive integer`);
  }
  if (value > max) {
    throw new ServiceError(
      "invalid_limit",
      `${label} exceeds the contract's own maximum of ${max}`,
    );
  }
  return value;
}

function boundedIndex(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new ServiceError("invalid_offset", `${label} must be a non-negative integer`);
  }
  return value;
}

function uint256(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ServiceError(
      "invalid_integer",
      `${label} must be a non-negative decimal integer`,
    );
  }
  const parsed = BigInt(value);
  if (parsed >= 1n << 256n) {
    throw new ServiceError("integer_overflow", `${label} must fit uint256`);
  }
  return parsed;
}

function positiveUint256(value: string, label: string): bigint {
  const parsed = uint256(value, label);
  if (parsed === 0n) {
    throw new ServiceError("invalid_integer", `${label} must be greater than zero`);
  }
  return parsed;
}
