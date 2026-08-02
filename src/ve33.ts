import {
  decodeEvmPoolConfig,
  deriveEvmIndexedSalt,
  deriveEvmPoolId,
  deriveEvmVeTokenId,
  encodeEvmConcentratedPoolConfig,
  encodeEvmStableswapPoolConfig,
} from "@ekubo/sdk";
import {
  type Address,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  keccak256,
  numberToHex,
  parseAbi,
  stringToHex,
} from "viem";
import {
  type Env,
  getOwnedVe33Tokens,
  getVe33Pools,
  prepareSwap,
  type QuoteSource,
  ServiceError,
} from "./core.js";
import {
  type PreparedTransaction,
  transactionIdentity,
  executionPlan,
} from "./execution-plan.js";

const VE_TOKEN_ABI = parseAbi([
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function balanceOf(address owner) view returns (uint256 result)",
  "function ownerOf(uint256 id) view returns (address result)",
  "function stakes(uint256 id) view returns (uint128 amount,uint64 endTime)",
  "function votingPower(uint256 veId) view returns (uint256 result)",
  "function voteState(uint256 veId) view returns (bytes32 poolId,uint128 weight,uint64 votedSwapFee,uint128 claimable0,uint128 claimable1)",
  "function claimPoolFees(uint256 veId, (address token0,address token1,bytes32 config) poolKey, address recipient) payable returns (uint128 amount0,uint128 amount1)",
  "function claimPoolFeesToSelf(uint256 veId, (address token0,address token1,bytes32 config) poolKey) payable returns (uint128 amount0,uint128 amount1)",
  "function clearVote(uint256 veId) payable",
  "function vote(uint256 veId, (address token0,address token1,bytes32 config) poolKey, uint64 swapFee) payable",
  "function splitStake(uint256 veId, uint128 amount, bytes32 salt) payable returns (uint256 splitVeId)",
  "function claimPoolFeesAndMergeStakesToSelf(uint256 fromVeId, uint256 toVeId, (address token0,address token1,bytes32 config) poolKey) payable returns (uint128 amount0,uint128 amount1,uint128 nextAmount)",
  "function mergeStakes(uint256 fromVeId, uint256 toVeId) payable returns (uint128 nextAmount)",
  "function claimPoolFeesAndExtendStakeToSelfForDuration(uint256 veId, uint32 duration, (address token0,address token1,bytes32 config) poolKey) payable returns (uint128 amount0,uint128 amount1)",
  "function claimPoolFeesAndExtendStakeToSelfMaxDuration(uint256 veId, (address token0,address token1,bytes32 config) poolKey) payable returns (uint128 amount0,uint128 amount1)",
  "function extendStakeForDuration(uint256 veId, uint32 duration) payable",
  "function extendStakeMaxDuration(uint256 veId) payable",
  "function increaseStakeAmount(uint256 veId, uint128 amount) payable",
  "function withdrawStakeToSelf(uint256 veId) payable returns (uint128 amount)",
  "function stakeForDuration(uint128 amount, uint32 duration, bytes32 salt) payable returns (uint256 veId)",
  "function stakeMaxDuration(uint128 amount, bytes32 salt) payable returns (uint256 veId)",
]);

const UINT64_MAX = (1n << 64n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;
const UINT192_MASK = (1n << 192n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const PERMILLE_TOTAL = 1_000;
const BPS_TOTAL = 10_000;
const MAX_ALLOCATION_TARGETS = 100;
const MAX_REALLOCATION_TARGETS = 25;
const VE33_MAX_STAKE_DURATION = 4n * 365n * 24n * 60n * 60n;

export interface Ve33PoolKeyInput {
  token0: Address;
  token1: Address;
  config?: Hex;
  fee?: string;
  tickSpacing?: number | null;
  extension?: Address;
  stableswapParams?: {
    centerTick: number;
    amplification: number;
  } | null;
}

export interface Ve33PoolKeyArgument {
  token0: Address;
  token1: Address;
  config: Hex;
}

interface Ve33Call {
  type: string;
  data: Hex;
  [key: string]: unknown;
}

export interface PrepareVe33VoteIntent {
  chainId: string;
  veToken: Address;
  sender: Address;
  sourceVeId: string;
  sourceAmount: string;
  currentVote: {
    poolKeyId: string;
    poolKey: Ve33PoolKeyInput;
    swapFee?: string;
  };
  allocations: {
    poolKeyId: string;
    poolKey: Ve33PoolKeyInput;
    swapFee: string;
    permille: number;
  }[];
  unallocatedPermille: number;
  saltNonce: Hex;
}

export interface PrepareVe33ExtendIntent {
  chainId: string;
  veToken: Address;
  sender: Address;
  veId: string;
  durationSeconds?: number;
  maxDuration: boolean;
  currentPoolKey?: Ve33PoolKeyInput;
}

export interface PrepareVe33WithdrawIntent {
  chainId: string;
  veToken: Address;
  sender: Address;
  veId: string;
  currentPoolKey?: Ve33PoolKeyInput;
}

export interface PrepareVe33IncreaseStakeIntent {
  chainId: string;
  veToken: Address;
  sender: Address;
  stakeToken: Address;
  veId: string;
  amount: string;
}

export interface PrepareVe33MergeIntent {
  chainId: string;
  veToken: Address;
  sender: Address;
  destinationVeId: string;
  destinationPoolKey?: Ve33PoolKeyInput;
  sources: { veId: string; currentPoolKey?: Ve33PoolKeyInput }[];
  resultingVote?: { poolKey: Ve33PoolKeyInput; swapFee: string } | null;
}

export interface PrepareVe33SplitIntent {
  chainId: string;
  veToken: Address;
  sender: Address;
  veId: string;
  amount: string;
  salt: Hex;
}

export interface PrepareVe33StakeIntent {
  chainId: string;
  veToken: Address;
  sender: Address;
  stakeToken: Address;
  amount: string;
  salt: Hex;
  durationSeconds?: number;
  maxDuration: boolean;
}

export interface PrepareVe33ClaimIntent {
  chainId: string;
  veToken: Address;
  sender: Address;
  recipient?: Address;
  claims: { veId: string; poolKey: Ve33PoolKeyInput }[];
}

export interface PrepareAllVe33FeeClaimsIntent {
  chainId: string;
  veToken: Address;
  sender: Address;
  recipient?: Address;
}

export interface GetVe33AllocationsIntent {
  chainId: string;
  veToken: Address;
  owner: Address;
}

export interface PrepareVe33ReallocationIntent {
  chainId: string;
  veToken: Address;
  sender: Address;
  currentStateId: Hex;
  targets: {
    poolKeyId: string;
    swapFee: string;
    weightBps: number;
  }[];
  saltNonce: Hex;
  strategy?: "preserve_existing_locks" | "compact_max_lock";
}

interface IndexedVe33Vote {
  poolKeyId: string;
  poolId: Hex;
  poolKeyInput: Ve33PoolKeyInput;
  poolKey: Ve33PoolKeyArgument;
  swapFee: bigint;
  appliedWeight: bigint;
  poolTotalWeight: bigint;
}

interface IndexedVeTokenState {
  veId: bigint;
  amount: bigint;
  endTime: bigint;
  stakeId: Hex;
  vote: IndexedVe33Vote | null;
  lastStakeChangedEventId: string;
  lastTransferEventId: string;
}

interface Ve33Portfolio {
  chainId: string;
  owner: Address;
  veToken: Address;
  ve33: Address | null;
  sourceUrl: string;
  totalItems: number;
  stateId: Hex;
  tokens: IndexedVeTokenState[];
}

interface ResolvedReallocationTarget {
  index: number;
  poolKeyId: string;
  poolId: Hex;
  poolKey: Ve33PoolKeyArgument;
  swapFee: bigint;
  weightBps: number;
}

interface TargetChunk {
  target: ResolvedReallocationTarget;
  amount: bigint;
}

export type PrepareVe33ReinvestIntent =
  | {
      phase: "claim";
      chainId: string;
      veToken: Address;
      sender: Address;
      claims?: { veId: string; poolKey: Ve33PoolKeyInput }[];
    }
  | {
      phase: "swap";
      chainId: string;
      veToken: Address;
      sender: Address;
      stakeToken: Address;
      feeBalances: { token: Address; amount: string }[];
      slippageBps: number;
      source?: QuoteSource;
    }
  | {
      phase: "stake";
      chainId: string;
      veToken: Address;
      sender: Address;
      stakeToken: Address;
      veId: string;
      amount: string;
    }
  | {
      phase: "stake_all";
      chainId: string;
      veToken: Address;
      sender: Address;
      stakeToken: Address;
      currentStateId: Hex;
      amount: string;
    };

export function prepareVe33Vote(intent: PrepareVe33VoteIntent) {
  const sourceVeId = unsigned(intent.sourceVeId, 192, "source_ve_id");
  const sourceAmount = unsigned(intent.sourceAmount, 128, "source_amount");
  if (sourceAmount === 0n) throw invalid("source_amount must be positive");
  if (intent.allocations.length === 0) {
    throw invalid("at least one allocation is required");
  }
  if (intent.allocations.length > MAX_ALLOCATION_TARGETS) {
    throw invalid(
      `at most ${MAX_ALLOCATION_TARGETS} allocations are supported`,
    );
  }
  const poolIds = new Set(intent.allocations.map(({ poolKeyId }) => poolKeyId));
  if (poolIds.size !== intent.allocations.length) {
    throw invalid("allocations must target distinct pool_key_id values");
  }
  const totalPermille = intent.allocations.reduce(
    (sum, allocation) => sum + allocation.permille,
    intent.unallocatedPermille,
  );
  if (totalPermille !== PERMILLE_TOTAL) {
    throw invalid(
      `allocation permilles sum to ${totalPermille}, expected 1000`,
    );
  }
  if (
    intent.unallocatedPermille < 0 ||
    intent.allocations.some(
      ({ permille }) => !Number.isInteger(permille) || permille <= 0,
    )
  ) {
    throw invalid("allocation permilles must be positive integers");
  }

  const targets = intent.allocations.map((allocation) => ({
    ...allocation,
    poolKey: toPoolKeyArgument(allocation.poolKey),
    swapFee: unsigned(allocation.swapFee, 64, "swap_fee"),
    amount:
      (sourceAmount * BigInt(allocation.permille)) / BigInt(PERMILLE_TOTAL),
  }));
  if (targets.some(({ amount }) => amount === 0n)) {
    throw invalid("an allocation rounds to zero stake token units");
  }
  const unallocated = {
    poolKeyId: null,
    poolKey: null,
    swapFee: null,
    amount:
      (sourceAmount * BigInt(intent.unallocatedPermille)) /
      BigInt(PERMILLE_TOTAL),
    permille: intent.unallocatedPermille,
  };
  const buckets = [...targets, unallocated];
  const currentBucket =
    targets.find(
      ({ poolKeyId }) => poolKeyId === intent.currentVote.poolKeyId,
    ) ?? null;
  const keptBucket =
    currentBucket ??
    buckets.reduce((largest, bucket) =>
      bucket.amount > largest.amount ? bucket : largest,
    );
  const allocated = buckets.reduce((sum, bucket) => sum + bucket.amount, 0n);
  keptBucket.amount += sourceAmount - allocated;

  const poolKeys = new Map<string, Ve33PoolKeyArgument>(
    targets.map(({ poolKeyId, poolKey }) => [poolKeyId, poolKey]),
  );
  poolKeys.set(
    intent.currentVote.poolKeyId,
    toPoolKeyArgument(intent.currentVote.poolKey),
  );

  const claimCalls: Ve33Call[] = [];
  const splitCalls: Ve33Call[] = [];
  const voteCalls: Ve33Call[] = [];
  const keptTarget = keptBucket.poolKeyId === null ? null : keptBucket;
  const currentFee = intent.currentVote.swapFee
    ? unsigned(intent.currentVote.swapFee, 64, "current_swap_fee")
    : undefined;
  const keepsVoteUntouched = Boolean(
    keptTarget &&
    keptTarget.poolKeyId === intent.currentVote.poolKeyId &&
    currentFee !== undefined &&
    currentFee === keptTarget.swapFee,
  );
  const currentPoolKey = poolKeys.get(intent.currentVote.poolKeyId);
  if (!currentPoolKey) throw invalid("current vote is missing its pool key");
  claimCalls.push({
    type: "claim_pool_fees",
    ve_id: sourceVeId.toString(),
    pool_key_id: intent.currentVote.poolKeyId,
    data: encodeFunctionData({
      abi: VE_TOKEN_ABI,
      functionName: "claimPoolFeesToSelf",
      args: [sourceVeId, currentPoolKey],
    }),
  });

  const resultingNfts: {
    ve_id: string;
    amount: string;
    pool_key_id: string | null;
    swap_fee: string | null;
    is_new: boolean;
  }[] = [
    {
      ve_id: sourceVeId.toString(),
      amount: keptBucket.amount.toString(),
      pool_key_id: keptBucket.poolKeyId,
      swap_fee: keptBucket.swapFee?.toString() ?? null,
      is_new: false,
    },
  ];

  if (keptTarget && !keepsVoteUntouched) {
    voteCalls.push({
      type: "vote",
      ve_id: sourceVeId.toString(),
      pool_key_id: keptTarget.poolKeyId,
      swap_fee: keptTarget.swapFee?.toString(),
      data: encodeFunctionData({
        abi: VE_TOKEN_ABI,
        functionName: "vote",
        args: [sourceVeId, keptTarget.poolKey, keptTarget.swapFee as bigint],
      }),
    });
  } else if (!keptTarget) {
    voteCalls.push({
      type: "clear_vote",
      ve_id: sourceVeId.toString(),
      data: encodeFunctionData({
        abi: VE_TOKEN_ABI,
        functionName: "clearVote",
        args: [sourceVeId],
      }),
    });
  }

  let saltIndex = 0;
  for (const bucket of buckets) {
    if (bucket === keptBucket || bucket.amount === 0n) continue;
    const salt = deriveSalt(intent.saltNonce, saltIndex++);
    const splitVeId = saltToId(
      intent.sender,
      salt,
      BigInt(intent.chainId),
      intent.veToken,
    );
    splitCalls.push({
      type: "split_stake",
      source_ve_id: sourceVeId.toString(),
      ve_id: splitVeId.toString(),
      amount: bucket.amount.toString(),
      salt,
      data: encodeFunctionData({
        abi: VE_TOKEN_ABI,
        functionName: "splitStake",
        args: [sourceVeId, bucket.amount, salt],
      }),
    });
    if (bucket.poolKeyId !== null && bucket.poolKey !== null) {
      voteCalls.push({
        type: "vote",
        ve_id: splitVeId.toString(),
        pool_key_id: bucket.poolKeyId,
        swap_fee: bucket.swapFee?.toString(),
        data: encodeFunctionData({
          abi: VE_TOKEN_ABI,
          functionName: "vote",
          args: [splitVeId, bucket.poolKey, bucket.swapFee as bigint],
        }),
      });
    }
    resultingNfts.push({
      ve_id: splitVeId.toString(),
      amount: bucket.amount.toString(),
      pool_key_id: bucket.poolKeyId,
      swap_fee: bucket.swapFee?.toString() ?? null,
      is_new: true,
    });
  }

  const calls = [...claimCalls, ...splitCalls, ...voteCalls];

  return ve33Plan({
    action: "ve33_change_votes",
    chainId: intent.chainId,
    veToken: intent.veToken,
    sender: intent.sender,
    calls,
    details: {
      resulting_nfts: resultingNfts,
      safety: {
        current_vote_is_required: true,
        current_pool_fees_are_claimed_unconditionally_first: true,
        caller_supplied_source_amount_requires_provider_validation: true,
        preferred_complete_portfolio_workflow: [
          "ekubo_get_ve33_allocations",
          "ekubo_prepare_ve33_reallocation",
        ],
      },
    },
  });
}

export function prepareVe33Extend(intent: PrepareVe33ExtendIntent) {
  const veId = unsigned(intent.veId, 192, "ve_id");
  if (intent.maxDuration === (intent.durationSeconds !== undefined)) {
    throw invalid(
      "choose exactly one extension mode: max_duration=true or duration_seconds",
    );
  }
  if (
    intent.durationSeconds !== undefined &&
    (!Number.isInteger(intent.durationSeconds) ||
      intent.durationSeconds <= 0 ||
      intent.durationSeconds > 0xffff_ffff)
  ) {
    throw invalid("duration_seconds must be a positive uint32");
  }
  let data: Hex;
  let type: string;
  if (intent.currentPoolKey !== undefined && intent.maxDuration) {
    const poolKey = toPoolKeyArgument(intent.currentPoolKey);
    type = "claim_fees_and_extend_max_duration";
    data = encodeFunctionData({
      abi: VE_TOKEN_ABI,
      functionName: "claimPoolFeesAndExtendStakeToSelfMaxDuration",
      args: [veId, poolKey],
    });
  } else if (intent.currentPoolKey !== undefined) {
    const poolKey = toPoolKeyArgument(intent.currentPoolKey);
    type = "claim_fees_and_extend_for_duration";
    data = encodeFunctionData({
      abi: VE_TOKEN_ABI,
      functionName: "claimPoolFeesAndExtendStakeToSelfForDuration",
      args: [veId, intent.durationSeconds as number, poolKey],
    });
  } else if (intent.maxDuration) {
    type = "extend_max_duration";
    data = encodeFunctionData({
      abi: VE_TOKEN_ABI,
      functionName: "extendStakeMaxDuration",
      args: [veId],
    });
  } else {
    type = "extend_for_duration";
    data = encodeFunctionData({
      abi: VE_TOKEN_ABI,
      functionName: "extendStakeForDuration",
      args: [veId, intent.durationSeconds as number],
    });
  }
  return ve33Plan({
    action: "ve33_extend",
    chainId: intent.chainId,
    veToken: intent.veToken,
    sender: intent.sender,
    calls: [{ type, ve_id: veId.toString(), data }],
    details: {
      claims_current_pool_fees_first: intent.currentPoolKey !== undefined,
      clears_current_vote: intent.currentPoolKey !== undefined,
      source_was_voted: intent.currentPoolKey !== undefined,
    },
  });
}

export function prepareVe33Withdraw(intent: PrepareVe33WithdrawIntent) {
  const veId = unsigned(intent.veId, 192, "ve_id");
  const calls: Ve33Call[] = [];
  if (intent.currentPoolKey !== undefined) {
    const poolKey = toPoolKeyArgument(intent.currentPoolKey);
    calls.push({
      type: "claim_pool_fees",
      ve_id: veId.toString(),
      data: encodeFunctionData({
        abi: VE_TOKEN_ABI,
        functionName: "claimPoolFeesToSelf",
        args: [veId, poolKey],
      }),
    });
  }
  calls.push({
    type: "withdraw_expired_stake",
    ve_id: veId.toString(),
    recipient: getAddress(intent.sender),
    data: encodeFunctionData({
      abi: VE_TOKEN_ABI,
      functionName: "withdrawStakeToSelf",
      args: [veId],
    }),
  });
  const veToken = getAddress(intent.veToken);
  const ownerRead = encodeFunctionData({
    abi: VE_TOKEN_ABI,
    functionName: "ownerOf",
    args: [veId],
  });
  const stakeRead = encodeFunctionData({
    abi: VE_TOKEN_ABI,
    functionName: "stakes",
    args: [veId],
  });

  return ve33Plan({
    action: "ve33_withdraw_expired_stake",
    chainId: intent.chainId,
    veToken,
    sender: intent.sender,
    calls,
    details: {
      ve_id: veId.toString(),
      recipient: getAddress(intent.sender),
      claims_current_pool_fees_first: intent.currentPoolKey !== undefined,
      requires_expired_stake: true,
      onchain_validation: {
        status: "not_executed",
        rpc_requests: [
          {
            label: "owner",
            request: {
              jsonrpc: "2.0",
              id: 1,
              method: "eth_call",
              params: [{ to: veToken, data: ownerRead }, "pending"],
            },
            decode_as: "address",
            expected: getAddress(intent.sender),
          },
          {
            label: "stake",
            request: {
              jsonrpc: "2.0",
              id: 2,
              method: "eth_call",
              params: [{ to: veToken, data: stakeRead }, "pending"],
            },
            decode_as: "(uint128 amount,uint64 endTime)",
          },
        ],
        instruction:
          "Verify owner equals sender, amount is positive, and endTime is not later than the pending block timestamp before simulation and submission.",
      },
      safety: {
        returns_stake_to_owner: true,
        never_burns_without_withdrawing: true,
        exact_call_list_is_complete: true,
      },
    },
  });
}

export function prepareVe33Split(intent: PrepareVe33SplitIntent) {
  const veId = unsigned(intent.veId, 192, "ve_id");
  const amount = unsigned(intent.amount, 128, "amount");
  if (amount === 0n) throw invalid("amount must be positive");
  const splitVeId = saltToId(
    intent.sender,
    intent.salt,
    BigInt(intent.chainId),
    intent.veToken,
  );
  const data = encodeFunctionData({
    abi: VE_TOKEN_ABI,
    functionName: "splitStake",
    args: [veId, amount, intent.salt],
  });
  return ve33Plan({
    action: "ve33_split",
    chainId: intent.chainId,
    veToken: intent.veToken,
    sender: intent.sender,
    calls: [
      {
        type: "split_stake",
        source_ve_id: veId.toString(),
        ve_id: splitVeId.toString(),
        amount: amount.toString(),
        salt: intent.salt,
        data,
      },
    ],
    details: {
      split_ve_id: splitVeId.toString(),
      source_vote_is_preserved_with_reduced_weight: true,
      split_token_starts_unvoted: true,
    },
  });
}

export function prepareVe33Stake(intent: PrepareVe33StakeIntent) {
  const amount = unsigned(intent.amount, 128, "amount");
  if (amount === 0n) throw invalid("amount must be positive");
  if (intent.maxDuration === (intent.durationSeconds !== undefined)) {
    throw invalid(
      "choose exactly one staking mode: max_duration=true or duration_seconds",
    );
  }
  if (
    intent.durationSeconds !== undefined &&
    (!Number.isInteger(intent.durationSeconds) ||
      intent.durationSeconds <= 0 ||
      intent.durationSeconds > 0xffff_ffff)
  ) {
    throw invalid("duration_seconds must be a positive uint32");
  }
  const stakeToken = getAddress(intent.stakeToken);
  const veToken = getAddress(intent.veToken);
  const sender = getAddress(intent.sender);
  const veId = saltToId(sender, intent.salt, BigInt(intent.chainId), veToken);
  const nativeStake = BigInt(stakeToken) === 0n;
  const approvals = nativeStake
    ? []
    : [erc20Approval(intent.chainId, stakeToken, veToken, amount)];
  const type = intent.maxDuration ? "stake_max_duration" : "stake_for_duration";
  const data = intent.maxDuration
    ? encodeFunctionData({
        abi: VE_TOKEN_ABI,
        functionName: "stakeMaxDuration",
        args: [amount, intent.salt],
      })
    : encodeFunctionData({
        abi: VE_TOKEN_ABI,
        functionName: "stakeForDuration",
        args: [amount, intent.durationSeconds as number, intent.salt],
      });
  return ve33Plan({
    action: "ve33_stake",
    chainId: intent.chainId,
    veToken,
    sender,
    approvals,
    calls: [
      {
        type,
        ve_id: veId.toString(),
        amount: amount.toString(),
        salt: intent.salt,
        data,
      },
    ],
    details: {
      ve_id: veId.toString(),
      stake_token: stakeToken,
      amount: amount.toString(),
      max_duration: intent.maxDuration,
      duration_seconds: intent.durationSeconds ?? null,
      approval_scope: nativeStake
        ? null
        : {
            token: stakeToken,
            spender: veToken,
            exact_amount: amount.toString(),
          },
      safety: {
        creates_new_ve_token: true,
        existing_votes_and_unclaimed_fees_are_untouched: true,
        max_duration_is_the_default_when_duration_is_omitted: true,
      },
    },
    value: nativeStake ? amount : 0n,
  });
}

export function prepareVe33IncreaseStake(
  intent: PrepareVe33IncreaseStakeIntent,
) {
  const veId = unsigned(intent.veId, 192, "ve_id");
  const amount = unsigned(intent.amount, 128, "amount");
  if (amount === 0n) throw invalid("amount must be positive");
  const stakeToken = getAddress(intent.stakeToken);
  const veToken = getAddress(intent.veToken);
  const nativeStake =
    stakeToken === getAddress("0x0000000000000000000000000000000000000000");
  const approvals = nativeStake
    ? []
    : [erc20Approval(intent.chainId, stakeToken, veToken, amount)];
  const data = encodeFunctionData({
    abi: VE_TOKEN_ABI,
    functionName: "increaseStakeAmount",
    args: [veId, amount],
  });
  return ve33Plan({
    action: "ve33_increase_stake",
    chainId: intent.chainId,
    veToken,
    sender: intent.sender,
    approvals,
    calls: [
      {
        type: "increase_stake_amount",
        ve_id: veId.toString(),
        amount: amount.toString(),
        data,
      },
    ],
    details: {
      ve_id: veId.toString(),
      stake_token: stakeToken,
      amount: amount.toString(),
      preserves_vote_and_fee_accounting: true,
      creates_new_ve_token: false,
    },
    value: nativeStake ? amount : 0n,
  });
}

export function prepareVe33Merge(intent: PrepareVe33MergeIntent) {
  const destinationVeId = unsigned(
    intent.destinationVeId,
    192,
    "destination_ve_id",
  );
  if (intent.sources.length === 0) {
    throw invalid("at least one source VeToken is required");
  }
  if (intent.sources.length > 99) {
    throw invalid("at most 99 source VeTokens can be merged in one plan");
  }
  const sourceIds = intent.sources.map((source) =>
    unsigned(source.veId, 192, "source_ve_id"),
  );
  if (
    sourceIds.some((sourceVeId) => sourceVeId === destinationVeId) ||
    new Set(sourceIds.map(String)).size !== sourceIds.length
  ) {
    throw invalid("source VeToken IDs must be distinct from the destination");
  }

  const calls: Ve33Call[] = [];
  if (intent.destinationPoolKey !== undefined) {
    const poolKey = toPoolKeyArgument(intent.destinationPoolKey);
    calls.push({
      type: "claim_destination_pool_fees",
      ve_id: destinationVeId.toString(),
      data: encodeFunctionData({
        abi: VE_TOKEN_ABI,
        functionName: "claimPoolFeesToSelf",
        args: [destinationVeId, poolKey],
      }),
    });
  }
  intent.sources.forEach((source, index) => {
    const sourceVeId = sourceIds[index];
    if (source.currentPoolKey === undefined) {
      calls.push({
        type: "merge_unvoted_stake",
        source_ve_id: sourceVeId.toString(),
        destination_ve_id: destinationVeId.toString(),
        data: encodeFunctionData({
          abi: VE_TOKEN_ABI,
          functionName: "mergeStakes",
          args: [sourceVeId, destinationVeId],
        }),
      });
      return;
    }
    const poolKey = toPoolKeyArgument(source.currentPoolKey);
    calls.push({
      type: "claim_source_fees_and_merge_stake",
      source_ve_id: sourceVeId.toString(),
      destination_ve_id: destinationVeId.toString(),
      data: encodeFunctionData({
        abi: VE_TOKEN_ABI,
        functionName: "claimPoolFeesAndMergeStakesToSelf",
        args: [sourceVeId, destinationVeId, poolKey],
      }),
    });
  });
  if (intent.resultingVote === null) {
    if (intent.destinationPoolKey !== undefined) {
      calls.push({
        type: "clear_destination_vote",
        ve_id: destinationVeId.toString(),
        data: encodeFunctionData({
          abi: VE_TOKEN_ABI,
          functionName: "clearVote",
          args: [destinationVeId],
        }),
      });
    }
  } else if (intent.resultingVote !== undefined) {
    const swapFee = unsigned(intent.resultingVote.swapFee, 64, "swap_fee");
    const poolKey = toPoolKeyArgument(intent.resultingVote.poolKey);
    calls.push({
      type: "set_destination_vote",
      ve_id: destinationVeId.toString(),
      swap_fee: swapFee.toString(),
      data: encodeFunctionData({
        abi: VE_TOKEN_ABI,
        functionName: "vote",
        args: [destinationVeId, poolKey, swapFee],
      }),
    });
  }

  const veToken = getAddress(intent.veToken);
  const ownerReads = [destinationVeId, ...sourceIds].map((veId, index) => ({
    label: index === 0 ? "destination_owner" : `source_${index}_owner`,
    ve_id: veId.toString(),
    request: {
      jsonrpc: "2.0",
      id: index + 1,
      method: "eth_call",
      params: [
        {
          to: veToken,
          data: encodeFunctionData({
            abi: VE_TOKEN_ABI,
            functionName: "ownerOf",
            args: [veId],
          }),
        },
        "pending",
      ],
    },
    decode_as: "address",
    expected: getAddress(intent.sender),
  }));

  return ve33Plan({
    action: "ve33_merge_stakes",
    chainId: intent.chainId,
    veToken,
    sender: intent.sender,
    calls,
    details: {
      destination_ve_id: destinationVeId.toString(),
      source_ve_ids: sourceIds.map(String),
      resulting_vote:
        intent.resultingVote === undefined
          ? "keep_destination_vote"
          : intent.resultingVote === null
            ? null
            : {
                pool_key: toPoolKeyArgument(intent.resultingVote.poolKey),
                swap_fee: intent.resultingVote.swapFee,
              },
      onchain_validation: {
        status: "not_executed",
        owner_reads: ownerReads,
        instruction:
          "Verify every NFT is still owned by sender and simulate the complete atomic multicall. The destination must satisfy the contract's active-lock and expiry ordering requirements.",
      },
      safety: {
        every_voted_source_claims_fees_during_merge: true,
        voted_destination_claims_fees_before_vote_changes: true,
        source_nfts_are_consumed_by_the_merge: true,
        exact_call_list_is_complete: true,
      },
    },
  });
}

export function prepareVe33Claim(intent: PrepareVe33ClaimIntent) {
  if (intent.claims.length === 0)
    throw invalid("at least one claim is required");
  const recipient = getAddress(intent.recipient ?? intent.sender);
  const toSelf = recipient === getAddress(intent.sender);
  const calls = intent.claims.map(({ veId: rawVeId, poolKey: rawPoolKey }) => {
    const veId = unsigned(rawVeId, 192, "ve_id");
    const poolKey = toPoolKeyArgument(rawPoolKey);
    return {
      type: "claim_pool_fees",
      ve_id: veId.toString(),
      recipient,
      data: toSelf
        ? encodeFunctionData({
            abi: VE_TOKEN_ABI,
            functionName: "claimPoolFeesToSelf",
            args: [veId, poolKey],
          })
        : encodeFunctionData({
            abi: VE_TOKEN_ABI,
            functionName: "claimPoolFees",
            args: [veId, poolKey, recipient],
          }),
    };
  });
  return ve33Plan({
    action: "ve33_claim_fees",
    chainId: intent.chainId,
    veToken: intent.veToken,
    sender: intent.sender,
    calls,
    details: { recipient },
  });
}

export async function getVe33Allocations(
  env: Env,
  intent: GetVe33AllocationsIntent,
  fetcher: typeof fetch = fetch,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const portfolio = await loadVe33Portfolio(env, intent, fetcher);
  const pools = new Map<
    string,
    {
      poolKeyId: string;
      poolId: Hex;
      poolKey: Ve33PoolKeyArgument;
      accountStakeAmount: bigint;
      accountAppliedWeight: bigint;
      projectedCurrentWeight: bigint;
      indexedPoolTotalWeight: bigint;
      veTokens: Record<string, unknown>[];
      feeSelections: Map<
        string,
        {
          swapFee: string;
          appliedWeight: bigint;
          projectedWeight: bigint;
          veIds: string[];
        }
      >;
    }
  >();
  const unvoted: Record<string, unknown>[] = [];
  let totalStakeAmount = 0n;
  let totalAppliedWeight = 0n;
  let totalProjectedWeight = 0n;
  let unvotedStakeAmount = 0n;

  for (const token of portfolio.tokens) {
    const projectedWeight = projectVotingPower(
      token.amount,
      token.endTime,
      BigInt(nowSeconds),
    );
    totalStakeAmount += token.amount;
    if (token.vote === null) {
      unvotedStakeAmount += token.amount;
      unvoted.push({
        ve_id: token.veId.toString(),
        stake_amount: token.amount.toString(),
        end_time: token.endTime.toString(),
        projected_current_voting_power: projectedWeight.toString(),
      });
      continue;
    }

    totalAppliedWeight += token.vote.appliedWeight;
    totalProjectedWeight += projectedWeight;
    const existing = pools.get(token.vote.poolId);
    const pool = existing ?? {
      poolKeyId: token.vote.poolKeyId,
      poolId: token.vote.poolId,
      poolKey: token.vote.poolKey,
      accountStakeAmount: 0n,
      accountAppliedWeight: 0n,
      projectedCurrentWeight: 0n,
      indexedPoolTotalWeight: token.vote.poolTotalWeight,
      veTokens: [],
      feeSelections: new Map<
        string,
        {
          swapFee: string;
          appliedWeight: bigint;
          projectedWeight: bigint;
          veIds: string[];
        }
      >(),
    };
    if (
      pool.poolKeyId !== token.vote.poolKeyId ||
      JSON.stringify(pool.poolKey) !== JSON.stringify(token.vote.poolKey)
    ) {
      throw invalidUpstream(
        "one pool ID resolves to conflicting indexed pool keys",
        {
          pool_id: token.vote.poolId,
        },
      );
    }
    if (
      existing !== undefined &&
      pool.indexedPoolTotalWeight !== token.vote.poolTotalWeight
    ) {
      throw invalidUpstream(
        "one pool has conflicting indexed total vote weights",
        { pool_id: token.vote.poolId },
      );
    }
    pool.accountStakeAmount += token.amount;
    pool.accountAppliedWeight += token.vote.appliedWeight;
    pool.projectedCurrentWeight += projectedWeight;
    pool.veTokens.push({
      ve_id: token.veId.toString(),
      stake_amount: token.amount.toString(),
      end_time: token.endTime.toString(),
      applied_vote_weight: token.vote.appliedWeight.toString(),
      projected_current_voting_power: projectedWeight.toString(),
      selected_swap_fee: token.vote.swapFee.toString(),
    });
    const feeKey = token.vote.swapFee.toString();
    const feeSelection = pool.feeSelections.get(feeKey) ?? {
      swapFee: feeKey,
      appliedWeight: 0n,
      projectedWeight: 0n,
      veIds: [],
    };
    feeSelection.appliedWeight += token.vote.appliedWeight;
    feeSelection.projectedWeight += projectedWeight;
    feeSelection.veIds.push(token.veId.toString());
    pool.feeSelections.set(feeKey, feeSelection);
    pools.set(token.vote.poolId, pool);
  }

  return {
    schema_version: "2",
    chain_id: portfolio.chainId,
    owner: portfolio.owner,
    ve_token: portfolio.veToken,
    ve33: portfolio.ve33,
    state_id: portfolio.stateId,
    snapshot: {
      indexed_source_url: portfolio.sourceUrl,
      projected_at_timestamp: nowSeconds.toString(),
      indexed_owned_ve_tokens: portfolio.totalItems,
      active_vote_ve_tokens: portfolio.tokens.length - unvoted.length,
      unvoted_ve_tokens: unvoted.length,
    },
    totals: {
      stake_amount: totalStakeAmount.toString(),
      allocated_stake_amount: (
        totalStakeAmount - unvotedStakeAmount
      ).toString(),
      unvoted_stake_amount: unvotedStakeAmount.toString(),
      applied_vote_weight: totalAppliedWeight.toString(),
      projected_current_voting_power: totalProjectedWeight.toString(),
    },
    allocations: [...pools.values()]
      .sort((left, right) =>
        left.poolId < right.poolId ? -1 : left.poolId > right.poolId ? 1 : 0,
      )
      .map((pool) => ({
        pool_key_id: pool.poolKeyId,
        pool_id: pool.poolId,
        pool_key: pool.poolKey,
        account_stake_amount: pool.accountStakeAmount.toString(),
        account_applied_vote_weight: pool.accountAppliedWeight.toString(),
        account_projected_current_voting_power:
          pool.projectedCurrentWeight.toString(),
        indexed_pool_total_vote_weight: pool.indexedPoolTotalWeight.toString(),
        selected_swap_fees: [...pool.feeSelections.values()]
          .sort((left, right) =>
            BigInt(left.swapFee) < BigInt(right.swapFee) ? -1 : 1,
          )
          .map((selection) => ({
            swap_fee: selection.swapFee,
            applied_vote_weight: selection.appliedWeight.toString(),
            projected_current_voting_power:
              selection.projectedWeight.toString(),
            ve_ids: selection.veIds,
          })),
        ve_tokens: pool.veTokens,
      })),
    unvoted,
    onchain_validation: portfolioOnchainValidation(portfolio),
    safety: {
      indexed_state_is_not_wallet_validation: true,
      state_id_scope:
        "Owned VeToken IDs, amounts, ends, active pool keys, selected swap fees, applied weights, and ownership/stake event cursors; pool-wide totals are informational and intentionally excluded.",
      instruction:
        "Execute onchain_validation.eth_call through the user's provider and compare every decoded result before preparing or signing a reallocation.",
    },
  };
}

export async function prepareVe33Reallocation(
  env: Env,
  intent: PrepareVe33ReallocationIntent,
  fetcher: typeof fetch = fetch,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  if (intent.targets.length === 0) {
    throw invalid("at least one target allocation is required");
  }
  if (intent.targets.length > MAX_REALLOCATION_TARGETS) {
    throw invalid(
      `at most ${MAX_REALLOCATION_TARGETS} target allocations are supported`,
    );
  }
  const totalBps = intent.targets.reduce(
    (sum, target) => sum + target.weightBps,
    0,
  );
  if (totalBps !== BPS_TOTAL) {
    throw invalid(
      `target weight_bps sum to ${totalBps}, expected ${BPS_TOTAL}`,
    );
  }
  if (
    intent.targets.some(
      ({ weightBps }) =>
        !Number.isInteger(weightBps) || weightBps <= 0 || weightBps > BPS_TOTAL,
    )
  ) {
    throw invalid("every target weight_bps must be a positive integer");
  }

  const portfolio = await loadVe33Portfolio(
    env,
    { chainId: intent.chainId, veToken: intent.veToken, owner: intent.sender },
    fetcher,
  );
  if (portfolio.stateId.toLowerCase() !== intent.currentStateId.toLowerCase()) {
    throw new ServiceError(
      "ve33_state_changed",
      "The indexed VeToken allocation changed after it was reviewed; fetch the current allocation again",
      {
        expected_state_id: intent.currentStateId,
        actual_state_id: portfolio.stateId,
      },
    );
  }
  if (portfolio.ve33 === null) {
    throw new ServiceError(
      "no_ve33_tokens",
      "The owner has no indexed VeTokens to reorganize",
    );
  }
  const active = portfolio.tokens.filter(
    (token): token is IndexedVeTokenState & { vote: IndexedVe33Vote } =>
      token.vote !== null,
  );
  if (active.length === 0) {
    throw new ServiceError(
      "no_active_ve33_votes",
      "The owner has no active votes to reorganize",
    );
  }
  const now = BigInt(nowSeconds);
  const expired = active.filter(
    (token) => projectVotingPower(token.amount, token.endTime, now) === 0n,
  );
  if (expired.length !== 0) {
    throw new ServiceError(
      "expired_ve33_votes",
      "Expired VeTokens cannot be safely split or re-voted",
      { ve_ids: expired.map(({ veId }) => veId.toString()) },
    );
  }

  const targetPoolCatalog = await getVe33Pools(
    env,
    { chainId: intent.chainId, ve33: portfolio.ve33 },
    fetcher,
  );
  const targets = resolveReallocationTargets(
    intent.targets,
    targetPoolCatalog.pools,
    portfolio.ve33,
    intent.chainId,
  );
  const targetKeys = new Set<string>();
  for (const target of targets) {
    const key = `${target.poolId}:${target.swapFee}`;
    if (targetKeys.has(key)) {
      throw invalid("target pool and swap_fee combinations must be unique");
    }
    targetKeys.add(key);
  }

  if (intent.strategy === "compact_max_lock") {
    return compactMaxLockReallocationPlan({
      intent,
      portfolio,
      active,
      targets,
      poolCatalogSourceUrl: targetPoolCatalog.sourceUrl,
      now,
      nowSeconds,
    });
  }

  const claims: Ve33Call[] = active.map((token) => ({
    type: "claim_pool_fees",
    phase: "claim_all_current_pool_fees",
    ve_id: token.veId.toString(),
    pool_key_id: token.vote.poolKeyId,
    expected_pool_id: token.vote.poolId,
    recipient: portfolio.owner,
    data: encodeFunctionData({
      abi: VE_TOKEN_ABI,
      functionName: "claimPoolFeesToSelf",
      args: [token.veId, token.vote.poolKey],
    }),
  }));
  const splits: Ve33Call[] = [];
  const votes: Ve33Call[] = [];
  const finalPieces: {
    veId: bigint;
    sourceVeId: bigint;
    amount: bigint;
    endTime: bigint;
    target: ResolvedReallocationTarget;
    isNew: boolean;
    salt: Hex | null;
  }[] = [];
  let saltIndex = 0;
  const cohorts = groupByEndTime(active);
  for (const cohort of cohorts) {
    const assignments = allocateCohort(cohort, targets);
    for (const source of cohort) {
      const chunks = assignments.get(source.veId.toString());
      if (chunks === undefined || chunks.length === 0) {
        throw new Error(
          "internal reallocation error: source has no target chunks",
        );
      }
      const retainedIndex = retainedChunkIndex(source, chunks);
      chunks.forEach((chunk, index) => {
        if (index === retainedIndex) {
          finalPieces.push({
            veId: source.veId,
            sourceVeId: source.veId,
            amount: chunk.amount,
            endTime: source.endTime,
            target: chunk.target,
            isNew: false,
            salt: null,
          });
          return;
        }
        const salt = deriveSalt(intent.saltNonce, saltIndex++);
        const childVeId = saltToId(
          portfolio.owner,
          salt,
          BigInt(intent.chainId),
          portfolio.veToken,
        );
        splits.push({
          type: "split_stake",
          phase: "repartition_stakes",
          source_ve_id: source.veId.toString(),
          ve_id: childVeId.toString(),
          amount: chunk.amount.toString(),
          salt,
          data: encodeFunctionData({
            abi: VE_TOKEN_ABI,
            functionName: "splitStake",
            args: [source.veId, chunk.amount, salt],
          }),
        });
        finalPieces.push({
          veId: childVeId,
          sourceVeId: source.veId,
          amount: chunk.amount,
          endTime: source.endTime,
          target: chunk.target,
          isNew: true,
          salt,
        });
      });
    }
  }
  for (const piece of finalPieces) {
    votes.push({
      type: "vote",
      phase: "apply_target_votes",
      ve_id: piece.veId.toString(),
      source_ve_id: piece.sourceVeId.toString(),
      pool_key_id: piece.target.poolKeyId,
      pool_id: piece.target.poolId,
      swap_fee: piece.target.swapFee.toString(),
      stake_amount: piece.amount.toString(),
      data: encodeFunctionData({
        abi: VE_TOKEN_ABI,
        functionName: "vote",
        args: [piece.veId, piece.target.poolKey, piece.target.swapFee],
      }),
    });
  }
  const calls = [...claims, ...splits, ...votes];
  if (calls.length > 512) {
    throw new ServiceError(
      "ve33_reallocation_too_large",
      "The atomic reallocation would require more than 512 VeToken calls",
      {
        claims: claims.length,
        splits: splits.length,
        votes: votes.length,
        total: calls.length,
      },
    );
  }

  const targetAllocationBase = targets.map((target) => {
    const pieces = finalPieces.filter(
      ({ target: pieceTarget }) => pieceTarget.index === target.index,
    );
    const stakeAmount = pieces.reduce((sum, piece) => sum + piece.amount, 0n);
    const projectedWeight = pieces.reduce(
      (sum, piece) =>
        sum + projectVotingPower(piece.amount, piece.endTime, now),
      0n,
    );
    return {
      pool_key_id: target.poolKeyId,
      pool_id: target.poolId,
      pool_key: target.poolKey,
      swap_fee: target.swapFee.toString(),
      target_weight_bps: target.weightBps,
      stake_amount: stakeAmount.toString(),
      projected_vote_weight: projectedWeight.toString(),
      ve_tokens: pieces.map((piece) => ({
        ve_id: piece.veId.toString(),
        source_ve_id: piece.sourceVeId.toString(),
        stake_amount: piece.amount.toString(),
        end_time: piece.endTime.toString(),
        is_new: piece.isNew,
        salt: piece.salt,
      })),
    };
  });
  const totalProjectedTargetWeight = targetAllocationBase.reduce(
    (sum, target) => sum + BigInt(target.projected_vote_weight),
    0n,
  );
  const targetAllocation = targetAllocationBase.map((target) => {
    const projectedWeight = BigInt(target.projected_vote_weight);
    const projectedWeightBps =
      totalProjectedTargetWeight === 0n
        ? 0
        : Number(
            (projectedWeight * BigInt(BPS_TOTAL) +
              totalProjectedTargetWeight / 2n) /
              totalProjectedTargetWeight,
          );
    return {
      ...target,
      projected_weight_bps_rounded: projectedWeightBps,
      projected_weight_bps_difference:
        projectedWeightBps - target.target_weight_bps,
    };
  });

  return ve33Plan({
    schemaVersion: "2",
    action: "ve33_reallocate_votes",
    chainId: intent.chainId,
    veToken: portfolio.veToken,
    sender: portfolio.owner,
    calls,
    details: {
      current_state_id: portfolio.stateId,
      strategy: "preserve_existing_locks",
      pool_catalog_source_url: targetPoolCatalog.sourceUrl,
      source_active_ve_tokens: active.length,
      untouched_unvoted_ve_tokens: portfolio.tokens.length - active.length,
      expiry_cohort_count: cohorts.length,
      final_voting_nft_count: finalPieces.length,
      target_allocation: targetAllocation,
      operation_counts: {
        fee_claims: claims.length,
        splits: splits.length,
        votes: votes.length,
        total_calls: calls.length,
      },
      onchain_validation: portfolioOnchainValidation(portfolio),
      safety: {
        one_atomic_vetoken_multicall: true,
        all_current_fee_claims_are_first: true,
        claims_are_unconditional_even_when_claimable_is_zero: true,
        stale_active_pool_reverts_before_any_split_or_vote: true,
        target_pools_are_initialized_and_key_verified: true,
        only_claim_split_and_vote_calls: true,
        no_merges: true,
        no_lock_extensions: true,
        no_withdrawals: true,
        no_burns: true,
        no_explicit_clear_vote_calls: true,
        unvoted_ve_tokens_are_untouched: true,
        preserves_each_expiry_cohort_across_every_target: true,
        final_voting_nft_count_may_exceed_target_count: true,
        fee_recipient: portfolio.owner,
        remaining_client_preconditions: [
          "Execute and decode onchain_validation.eth_call immediately before signing.",
          "Confirm balanceOf(owner), every ownerOf, stakes amount/end, and voteState match the indexed state.",
          "Simulate the exact transaction from sender; any claim, split, salt collision, or target-pool failure reverts the entire multicall.",
        ],
      },
      projection: {
        timestamp: nowSeconds.toString(),
        total_projected_vote_weight: totalProjectedTargetWeight.toString(),
        note: "Each end-time cohort is apportioned independently, so target voting-power proportions remain stable as locks decay, subject only to integer rounding.",
      },
    },
  });
}

function compactMaxLockReallocationPlan({
  intent,
  portfolio,
  active,
  targets,
  poolCatalogSourceUrl,
  now,
  nowSeconds,
}: {
  intent: PrepareVe33ReallocationIntent;
  portfolio: Ve33Portfolio;
  active: (IndexedVeTokenState & { vote: IndexedVe33Vote })[];
  targets: ResolvedReallocationTarget[];
  poolCatalogSourceUrl: string;
  now: bigint;
  nowSeconds: number;
}) {
  const destination = [...active].sort((left, right) =>
    left.amount > right.amount
      ? -1
      : left.amount < right.amount
        ? 1
        : left.veId < right.veId
          ? -1
          : 1,
  )[0];
  const sources = active
    .filter(({ veId }) => veId !== destination.veId)
    .sort((left, right) =>
      left.veId < right.veId ? -1 : left.veId > right.veId ? 1 : 0,
    );
  const totalAmount = active.reduce((sum, token) => sum + token.amount, 0n);
  const projectedEnd = now + VE33_MAX_STAKE_DURATION;
  const amounts = apportionAmounts(totalAmount, targets);
  const retainedTargetIndex = targets.reduce(
    (largest, target) =>
      amounts[target.index] > amounts[largest.index] ? target : largest,
    targets[0],
  ).index;

  const consolidationCalls: Ve33Call[] = [
    {
      type: "claim_fees_and_extend_max",
      phase: "preserve_fees_and_prepare_destination",
      ve_id: destination.veId.toString(),
      pool_key_id: destination.vote.poolKeyId,
      expected_pool_id: destination.vote.poolId,
      recipient: portfolio.owner,
      previous_end_time: destination.endTime.toString(),
      projected_end_time: projectedEnd.toString(),
      data: encodeFunctionData({
        abi: VE_TOKEN_ABI,
        functionName: "claimPoolFeesAndExtendStakeToSelfMaxDuration",
        args: [destination.veId, destination.vote.poolKey],
      }),
    },
    ...sources.map((source): Ve33Call => ({
      type: "claim_fees_and_merge_stake",
      phase: "preserve_fees_and_consolidate",
      from_ve_id: source.veId.toString(),
      to_ve_id: destination.veId.toString(),
      pool_key_id: source.vote.poolKeyId,
      expected_pool_id: source.vote.poolId,
      recipient: portfolio.owner,
      burns_source_nft: true,
      data: encodeFunctionData({
        abi: VE_TOKEN_ABI,
        functionName: "claimPoolFeesAndMergeStakesToSelf",
        args: [source.veId, destination.veId, source.vote.poolKey],
      }),
    })),
  ];

  const splits: Ve33Call[] = [];
  const finalPieces: {
    veId: bigint;
    amount: bigint;
    target: ResolvedReallocationTarget;
    isNew: boolean;
    salt: Hex | null;
  }[] = [];
  let saltIndex = 0;
  for (const target of targets) {
    const amount = amounts[target.index];
    if (target.index === retainedTargetIndex) {
      finalPieces.push({
        veId: destination.veId,
        amount,
        target,
        isNew: false,
        salt: null,
      });
      continue;
    }
    const salt = deriveSalt(intent.saltNonce, saltIndex++);
    const childVeId = saltToId(
      portfolio.owner,
      salt,
      BigInt(intent.chainId),
      portfolio.veToken,
    );
    splits.push({
      type: "split_stake",
      phase: "split_one_nft_per_target_pool",
      source_ve_id: destination.veId.toString(),
      ve_id: childVeId.toString(),
      amount: amount.toString(),
      salt,
      data: encodeFunctionData({
        abi: VE_TOKEN_ABI,
        functionName: "splitStake",
        args: [destination.veId, amount, salt],
      }),
    });
    finalPieces.push({ veId: childVeId, amount, target, isNew: true, salt });
  }

  const votes: Ve33Call[] = finalPieces.map((piece) => ({
    type: "vote",
    phase: "apply_one_vote_per_target_pool",
    ve_id: piece.veId.toString(),
    source_ve_id: destination.veId.toString(),
    pool_key_id: piece.target.poolKeyId,
    pool_id: piece.target.poolId,
    swap_fee: piece.target.swapFee.toString(),
    stake_amount: piece.amount.toString(),
    data: encodeFunctionData({
      abi: VE_TOKEN_ABI,
      functionName: "vote",
      args: [piece.veId, piece.target.poolKey, piece.target.swapFee],
    }),
  }));
  const calls = [...consolidationCalls, ...splits, ...votes];
  if (calls.length > 512) {
    throw new ServiceError(
      "ve33_reallocation_too_large",
      "The atomic compact reallocation would require more than 512 VeToken calls",
      { total: calls.length },
    );
  }

  const targetAllocation = targets.map((target) => {
    const piece = finalPieces.find(
      ({ target: pieceTarget }) => pieceTarget.index === target.index,
    );
    if (piece === undefined) {
      throw new Error(
        "internal compact reallocation error: missing target piece",
      );
    }
    return {
      pool_key_id: target.poolKeyId,
      pool_id: target.poolId,
      pool_key: target.poolKey,
      swap_fee: target.swapFee.toString(),
      target_weight_bps: target.weightBps,
      stake_amount: piece.amount.toString(),
      projected_vote_weight: piece.amount.toString(),
      projected_weight_bps_rounded: Number(
        (piece.amount * BigInt(BPS_TOTAL) + totalAmount / 2n) / totalAmount,
      ),
      projected_weight_bps_difference:
        Number(
          (piece.amount * BigInt(BPS_TOTAL) + totalAmount / 2n) / totalAmount,
        ) - target.weightBps,
      ve_tokens: [
        {
          ve_id: piece.veId.toString(),
          source_ve_id: destination.veId.toString(),
          stake_amount: piece.amount.toString(),
          end_time: projectedEnd.toString(),
          projected_end_time: projectedEnd.toString(),
          end_time_formula: `execution_block_timestamp + ${VE33_MAX_STAKE_DURATION}`,
          is_new: piece.isNew,
          salt: piece.salt,
        },
      ],
    };
  });

  return ve33Plan({
    schemaVersion: "3",
    action: "ve33_reallocate_votes",
    chainId: intent.chainId,
    veToken: portfolio.veToken,
    sender: portfolio.owner,
    calls,
    details: {
      current_state_id: portfolio.stateId,
      strategy: "compact_max_lock",
      pool_catalog_source_url: poolCatalogSourceUrl,
      source_active_ve_tokens: active.length,
      untouched_unvoted_ve_tokens: portfolio.tokens.length - active.length,
      target_allocation: targetAllocation,
      compact_portfolio: {
        maximum_voting_nfts: MAX_REALLOCATION_TARGETS,
        final_voting_nft_count: targets.length,
        surviving_ve_id: destination.veId.toString(),
        burned_source_ve_ids: sources.map(({ veId }) => veId.toString()),
        source_voting_nft_count: active.length,
        max_lock_duration_seconds: VE33_MAX_STAKE_DURATION.toString(),
        projected_new_end_time: projectedEnd.toString(),
        new_end_time_formula: `execution_block_timestamp + ${VE33_MAX_STAKE_DURATION}`,
      },
      operation_counts: {
        fee_claim_and_extensions: 1,
        fee_claim_and_merges: sources.length,
        fee_claims: active.length,
        lock_extensions: 1,
        merges: sources.length,
        source_nft_burns: sources.length,
        splits: splits.length,
        votes: votes.length,
        total_calls: calls.length,
      },
      onchain_validation: portfolioOnchainValidation(portfolio),
      safety: {
        one_atomic_vetoken_multicall: true,
        every_vote_is_claimed_before_it_is_cleared: true,
        claims_are_unconditional_even_when_claimable_is_zero: true,
        destination_is_extended_before_merges: true,
        source_merges_are_fee_preserving_compound_calls: true,
        target_pools_are_initialized_and_key_verified: true,
        final_one_voting_nft_per_target_pool: true,
        final_voting_nft_count_at_most_25: true,
        max_lock_extension_is_explicit: true,
        burns_redundant_source_nfts: true,
        no_withdrawals: true,
        no_explicit_clear_vote_calls: true,
        unvoted_ve_tokens_are_untouched: true,
        fee_recipient: portfolio.owner,
        irreversible_effects: [
          `Extends VeToken ${destination.veId} to the maximum four-year duration from the execution block timestamp.`,
          ...(sources.length === 0
            ? []
            : [
                `Burns source VeToken IDs ${sources.map(({ veId }) => veId).join(", ")} after merging their stake into VeToken ${destination.veId}.`,
              ]),
        ],
        remaining_client_preconditions: [
          "Execute and decode onchain_validation.eth_call immediately before signing.",
          "Confirm balanceOf(owner), every ownerOf, stakes amount/end, and voteState match the indexed state.",
          "Show the surviving ID, every burned source ID, the maximum lock extension, final NFT count, and exact decoded calls before confirmation.",
          "Simulate the exact transaction from sender; any claim, extension, merge, split, salt collision, or target-pool failure reverts the entire multicall.",
        ],
      },
      projection: {
        timestamp: nowSeconds.toString(),
        total_projected_vote_weight: totalAmount.toString(),
        note: "The max-duration extension makes voting power equal to stake amount at the execution block; one equally dated VeToken is assigned to each target, subject only to integer apportionment rounding.",
      },
    },
  });
}

export async function prepareAllVe33FeeClaims(
  env: Env,
  intent: PrepareAllVe33FeeClaimsIntent,
  fetcher: typeof fetch = fetch,
) {
  const sender = normalizeAddress(intent.sender);
  const veToken = normalizeAddress(intent.veToken);
  const indexed = await getOwnedVe33Tokens(
    env,
    { chainId: intent.chainId, veToken, owner: sender },
    fetcher,
  );
  const claims: PrepareVe33ClaimIntent["claims"] = [];
  const evidence: Record<string, unknown>[] = [];
  const seenVeIds = new Set<string>();
  const feeTokens = new Set<Address>();
  let skippedUnvoted = 0;

  for (const rawToken of indexed.tokens) {
    const indexedChainId = indexedUint(rawToken, "chain_id");
    const indexedOwner = indexedAddress(rawToken, "owner");
    const indexedVeToken = indexedAddress(rawToken, "ve_token_address");
    if (indexedChainId !== BigInt(intent.chainId)) {
      throw invalidUpstream("indexed VeToken has the wrong chain_id", {
        expected: intent.chainId,
        actual: indexedChainId.toString(),
      });
    }
    if (indexedOwner !== sender || indexedVeToken !== veToken) {
      throw invalidUpstream(
        "indexed VeToken ownership does not match the request",
        {
          expected_owner: sender,
          actual_owner: indexedOwner,
          expected_ve_token: veToken,
          actual_ve_token: indexedVeToken,
        },
      );
    }

    const rawPoolKey = rawToken.voted_pool_key;
    if (rawPoolKey === null) {
      skippedUnvoted++;
      continue;
    }
    if (!isRecord(rawPoolKey)) {
      throw invalidUpstream("voted_pool_key must be an object or null");
    }

    const veId = indexedUint(rawToken, "token_id").toString();
    if (seenVeIds.has(veId)) {
      throw invalidUpstream("duplicate VeToken ID in ownership response", {
        ve_id: veId,
      });
    }
    seenVeIds.add(veId);

    const ve33 = indexedAddress(rawToken, "ve33_address");
    const extension = indexedAddress(rawPoolKey, "extension");
    if (extension !== ve33) {
      throw invalidUpstream(
        "voted pool extension does not match ve33_address",
        {
          ve_id: veId,
          extension,
          ve33,
        },
      );
    }
    const poolKey: Ve33PoolKeyInput = {
      token0: indexedAddress(rawPoolKey, "token0"),
      token1: indexedAddress(rawPoolKey, "token1"),
      fee: indexedIntegerString(rawPoolKey, "fee"),
      tickSpacing: indexedOptionalNumber(rawPoolKey, "tick_spacing"),
      extension,
      stableswapParams: indexedStableswapParams(rawPoolKey),
    };
    feeTokens.add(normalizeAddress(poolKey.token0));
    feeTokens.add(normalizeAddress(poolKey.token1));
    let poolKeyArgument: Ve33PoolKeyArgument;
    try {
      poolKeyArgument = toPoolKeyArgument(poolKey);
    } catch (error) {
      throw invalidUpstream("indexed VeToken has an invalid voted pool key", {
        ve_id: veId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    const computedPoolId = poolIdFor(poolKeyArgument);
    const indexedPoolId = indexedBytes32(rawToken, "voted_pool_id");
    if (computedPoolId !== indexedPoolId) {
      throw invalidUpstream("voted pool key does not hash to voted_pool_id", {
        ve_id: veId,
        computed_pool_id: computedPoolId,
        indexed_pool_id: indexedPoolId,
      });
    }

    claims.push({ veId, poolKey });
    evidence.push({
      ve_id: veId,
      pool_key_id:
        typeof rawToken.pool_key_id === "string" ? rawToken.pool_key_id : null,
      expected_pool_id: computedPoolId,
      pool_key: poolKeyArgument,
      owner_of_call: {
        to: veToken,
        data: encodeFunctionData({
          abi: VE_TOKEN_ABI,
          functionName: "ownerOf",
          args: [BigInt(veId)],
        }),
        expected_owner: sender,
      },
      vote_state_call: {
        to: veToken,
        data: encodeFunctionData({
          abi: VE_TOKEN_ABI,
          functionName: "voteState",
          args: [BigInt(veId)],
        }),
        expected_pool_id: computedPoolId,
      },
      last_stake_changed_event_id:
        typeof rawToken.last_stake_changed_event_id === "string"
          ? rawToken.last_stake_changed_event_id
          : null,
      last_transfer_event_id:
        typeof rawToken.last_transfer_event_id === "string"
          ? rawToken.last_transfer_event_id
          : null,
    });
  }

  if (claims.length === 0) {
    throw new ServiceError(
      "no_active_ve33_votes",
      "The owner has no indexed active VeToken votes with fees to claim",
      { indexed_owned_ve_tokens: indexed.totalItems },
    );
  }

  const sortedFeeTokens = [...feeTokens].sort((left, right) =>
    BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0,
  );

  const plan = prepareVe33Claim({
    chainId: intent.chainId,
    veToken,
    sender,
    recipient: intent.recipient,
    claims,
  });
  return {
    ...plan,
    discovery: {
      source_url: indexed.sourceUrl,
      indexed_owned_ve_tokens: indexed.totalItems,
      active_vote_claims: claims.length,
      skipped_unvoted: skippedUnvoted,
      fee_tokens: sortedFeeTokens,
      pre_claim_balance_snapshots: sortedFeeTokens.map((token) =>
        balanceSnapshotRequest(intent.chainId, token, sender),
      ),
      state_validation: evidence,
    },
  };
}

export async function prepareVe33Reinvest(
  env: Env,
  intent: PrepareVe33ReinvestIntent,
  fetcher: typeof fetch = fetch,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  if (intent.phase === "claim") {
    let plan;
    let feeTokens: Address[];
    if (intent.claims === undefined) {
      const discovered = await prepareAllVe33FeeClaims(
        env,
        {
          chainId: intent.chainId,
          veToken: intent.veToken,
          sender: intent.sender,
        },
        fetcher,
      );
      plan = discovered;
      feeTokens = discovered.discovery.fee_tokens;
    } else {
      plan = prepareVe33Claim({
        chainId: intent.chainId,
        veToken: intent.veToken,
        sender: intent.sender,
        claims: intent.claims,
      });
      feeTokens = feeTokensFromClaims(intent.claims);
    }
    const sender = getAddress(intent.sender);
    return {
      phase: "claim" as const,
      plan,
      fee_tokens: feeTokens,
      pre_claim_balance_snapshots: feeTokens.map((token) =>
        balanceSnapshotRequest(intent.chainId, token, sender),
      ),
      next_phase:
        "Immediately before execution, take every supplied balance snapshot. After the claim confirms, compute each exact claimed delta and call this tool with phase=swap. For the native token, add the claim transaction's gas cost back to the post-claim balance delta. Never pass a wallet's pre-existing balance as a claimed fee amount.",
    };
  }

  if (intent.phase === "swap") {
    if (intent.feeBalances.length === 0) {
      throw invalid("fee_balances must contain at least one token balance");
    }
    const stakeToken = getAddress(intent.stakeToken);
    const balancesByToken = new Map<Address, bigint>();
    for (const balance of intent.feeBalances) {
      const token = normalizeAddress(balance.token);
      const amount = unsigned(balance.amount, 256, "fee balance amount");
      balancesByToken.set(token, (balancesByToken.get(token) ?? 0n) + amount);
    }
    const directStakeAmount = balancesByToken.get(stakeToken) ?? 0n;
    const swapBalances = [...balancesByToken]
      .filter(([token, amount]) => token !== stakeToken && amount > 0n)
      .map(([token, amount]) => ({ token, amount: amount.toString() }));
    const swapPlans = await Promise.all(
      swapBalances.map(({ token, amount }) =>
        prepareSwap(
          env,
          {
            chainId: intent.chainId,
            destinationChainId: intent.chainId,
            tokenIn: getAddress(token),
            tokenOut: stakeToken,
            quoteType: "exact_input",
            amount,
            source: intent.source ?? "auto",
            slippageBps: intent.slippageBps,
            sender: getAddress(intent.sender),
            recipient: getAddress(intent.sender),
          },
          fetcher,
        ),
      ),
    );
    return {
      phase: "swap" as const,
      exact_input_full_balance_swaps: swapPlans,
      stake_token_amount_already_claimed: directStakeAmount.toString(),
      next_phase:
        "After every individual swap receipt confirms, measure the sender's exact stake-token increase, including directly claimed stake token. Refresh ekubo_get_ve33_allocations, then call phase=stake_all with its state_id and that full amount to increase every existing active allocation, or phase=stake with one explicit ve_id.",
    };
  }

  if (intent.phase === "stake_all") {
    const amount = unsigned(intent.amount, 128, "amount");
    if (amount === 0n) throw invalid("amount must be positive");
    const portfolio = await loadVe33Portfolio(
      env,
      {
        chainId: intent.chainId,
        veToken: intent.veToken,
        owner: intent.sender,
      },
      fetcher,
    );
    if (
      portfolio.stateId.toLowerCase() !== intent.currentStateId.toLowerCase()
    ) {
      throw new ServiceError(
        "ve33_state_changed",
        "The indexed VeToken allocation changed after it was reviewed; fetch the current allocation again",
        {
          expected_state_id: intent.currentStateId,
          actual_state_id: portfolio.stateId,
        },
      );
    }
    const active = portfolio.tokens.filter(
      (token): token is IndexedVeTokenState & { vote: IndexedVe33Vote } =>
        token.vote !== null,
    );
    if (active.length === 0) {
      throw new ServiceError(
        "no_active_ve33_votes",
        "The owner has no active allocations to increase",
      );
    }
    const now = BigInt(nowSeconds);
    const expired = active.filter(
      (token) => projectVotingPower(token.amount, token.endTime, now) === 0n,
    );
    if (expired.length !== 0) {
      throw new ServiceError(
        "expired_ve33_votes",
        "Expired VeTokens cannot receive a safe reinvestment allocation",
        { ve_ids: expired.map(({ veId }) => veId.toString()) },
      );
    }
    if (amount < BigInt(active.length)) {
      throw new ServiceError(
        "ve33_reinvest_amount_too_small",
        "The reinvested amount is too small to increase every active allocation",
        { amount: amount.toString(), active_allocations: active.length },
      );
    }
    const apportioned = apportionReinvestment(amount, active);
    const stakeToken = getAddress(intent.stakeToken);
    const veToken = getAddress(intent.veToken);
    const nativeStake = BigInt(stakeToken) === 0n;
    const approvals = nativeStake
      ? []
      : [erc20Approval(intent.chainId, stakeToken, veToken, amount)];
    const calls: Ve33Call[] = active.map((token, index) => ({
      type: "increase_stake_amount",
      ve_id: token.veId.toString(),
      amount: apportioned[index].toString(),
      pool_key_id: token.vote.poolKeyId,
      data: encodeFunctionData({
        abi: VE_TOKEN_ABI,
        functionName: "increaseStakeAmount",
        args: [token.veId, apportioned[index]],
      }),
    }));
    const plan = ve33Plan({
      schemaVersion: "2",
      action: "ve33_reinvest_stake_all",
      chainId: intent.chainId,
      veToken,
      sender: intent.sender,
      approvals,
      calls,
      details: {
        current_state_id: portfolio.stateId,
        stake_token: stakeToken,
        total_amount: amount.toString(),
        approval_scope: nativeStake
          ? null
          : {
              token: stakeToken,
              spender: veToken,
              exact_amount: amount.toString(),
            },
        allocations: active.map((token, index) => ({
          ve_id: token.veId.toString(),
          pool_key_id: token.vote.poolKeyId,
          prior_stake_amount: token.amount.toString(),
          increase_amount: apportioned[index].toString(),
        })),
        onchain_validation: portfolioOnchainValidation(portfolio),
        safety: {
          every_existing_active_allocation_is_increased: true,
          increase_stake_amount_preserves_existing_votes_and_fee_accounting: true,
          no_vote_is_cleared_or_replaced: true,
          unvoted_ve_tokens_are_untouched: true,
          exact_total_amount_is_apportioned: true,
        },
      },
      value: nativeStake ? amount : 0n,
    });
    return { phase: "stake_all" as const, plan, next_phase: null };
  }

  const veId = unsigned(intent.veId, 192, "ve_id");
  const amount = unsigned(intent.amount, 128, "amount");
  if (amount === 0n) throw invalid("amount must be positive");
  const stakeToken = getAddress(intent.stakeToken);
  const veToken = getAddress(intent.veToken);
  const approvals =
    BigInt(stakeToken) === 0n
      ? []
      : [erc20Approval(intent.chainId, stakeToken, veToken, amount)];
  const data = encodeFunctionData({
    abi: VE_TOKEN_ABI,
    functionName: "increaseStakeAmount",
    args: [veId, amount],
  });
  const plan = ve33Plan({
    action: "ve33_reinvest_stake",
    chainId: intent.chainId,
    veToken,
    sender: intent.sender,
    approvals,
    calls: [
      {
        type: "increase_stake_amount",
        ve_id: veId.toString(),
        amount: amount.toString(),
        data,
      },
    ],
    details: {
      approval_scope:
        BigInt(stakeToken) === 0n
          ? null
          : {
              token: stakeToken,
              spender: veToken,
              exact_amount: amount.toString(),
            },
      transaction_value: BigInt(stakeToken) === 0n ? amount.toString() : "0",
    },
    value: BigInt(stakeToken) === 0n ? amount : 0n,
  });
  return { phase: "stake" as const, plan, next_phase: null };
}

async function loadVe33Portfolio(
  env: Env,
  intent: GetVe33AllocationsIntent,
  fetcher: typeof fetch,
): Promise<Ve33Portfolio> {
  const owner = normalizeAddress(intent.owner);
  const veToken = normalizeAddress(intent.veToken);
  const indexed = await getOwnedVe33Tokens(
    env,
    { chainId: intent.chainId, veToken, owner },
    fetcher,
  );
  const tokens: IndexedVeTokenState[] = [];
  const seenVeIds = new Set<string>();
  let ve33: Address | null = null;

  for (const rawToken of indexed.tokens) {
    const indexedChainId = indexedUint(rawToken, "chain_id");
    const indexedOwner = indexedAddress(rawToken, "owner");
    const indexedVeToken = indexedAddress(rawToken, "ve_token_address");
    const indexedVe33 = indexedAddress(rawToken, "ve33_address");
    if (indexedChainId !== BigInt(intent.chainId)) {
      throw invalidUpstream("indexed VeToken has the wrong chain_id", {
        expected: intent.chainId,
        actual: indexedChainId.toString(),
      });
    }
    if (indexedOwner !== owner || indexedVeToken !== veToken) {
      throw invalidUpstream(
        "indexed VeToken ownership does not match the request",
        {
          expected_owner: owner,
          actual_owner: indexedOwner,
          expected_ve_token: veToken,
          actual_ve_token: indexedVeToken,
        },
      );
    }
    if (ve33 !== null && ve33 !== indexedVe33) {
      throw invalidUpstream(
        "one VeToken portfolio references multiple Ve33 contracts",
      );
    }
    ve33 = indexedVe33;

    const veId = indexedUint(rawToken, "token_id");
    if (veId > UINT192_MASK) {
      throw invalidUpstream("token_id does not fit the VeToken uint192 salt", {
        ve_id: veId.toString(),
      });
    }
    const veIdKey = veId.toString();
    if (seenVeIds.has(veIdKey)) {
      throw invalidUpstream("duplicate VeToken ID in ownership response", {
        ve_id: veIdKey,
      });
    }
    seenVeIds.add(veIdKey);
    const amount = indexedUint(rawToken, "amount");
    if (amount > UINT128_MAX) {
      throw invalidUpstream("amount does not fit uint128", { ve_id: veIdKey });
    }
    const endTime = indexedTimestamp(rawToken, "end_time");
    if (endTime > UINT64_MAX) {
      throw invalidUpstream("end_time does not fit uint64", { ve_id: veIdKey });
    }
    const stakeId = indexedBytes32(rawToken, "stake_id");
    const expectedStakeId = numberToHex((veId << 64n) | endTime, { size: 32 });
    if (stakeId !== expectedStakeId) {
      throw invalidUpstream("stake_id does not match token_id and end_time", {
        ve_id: veIdKey,
        expected_stake_id: expectedStakeId,
        actual_stake_id: stakeId,
      });
    }

    const rawPoolKey = rawToken.voted_pool_key;
    let vote: IndexedVe33Vote | null = null;
    if (rawPoolKey === null) {
      for (const field of [
        "voted_pool_id",
        "pool_key_id",
        "applied_vote_weight",
        "voted_swap_fee",
        "pool_total_vote_weight",
      ]) {
        if (rawToken[field] !== null) {
          throw invalidUpstream(`unvoted VeToken has non-null ${field}`, {
            ve_id: veIdKey,
          });
        }
      }
    } else {
      if (!isRecord(rawPoolKey)) {
        throw invalidUpstream("voted_pool_key must be an object or null");
      }
      const poolKeyInput = indexedPoolKey(rawPoolKey);
      if (normalizeAddress(poolKeyInput.extension as Address) !== indexedVe33) {
        throw invalidUpstream(
          "voted pool extension does not match ve33_address",
          {
            ve_id: veIdKey,
          },
        );
      }
      let poolKey: Ve33PoolKeyArgument;
      try {
        poolKey = toPoolKeyArgument(poolKeyInput);
      } catch (error) {
        throw invalidUpstream("indexed VeToken has an invalid voted pool key", {
          ve_id: veIdKey,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      const poolId = poolIdFor(poolKey);
      const indexedPoolId = indexedBytes32(rawToken, "voted_pool_id");
      if (poolId !== indexedPoolId) {
        throw invalidUpstream("voted pool key does not hash to voted_pool_id", {
          ve_id: veIdKey,
          computed_pool_id: poolId,
          indexed_pool_id: indexedPoolId,
        });
      }
      const swapFee = indexedUint(rawToken, "voted_swap_fee");
      const appliedWeight = indexedUint(rawToken, "applied_vote_weight");
      const poolTotalWeight = indexedUint(rawToken, "pool_total_vote_weight");
      if (swapFee > UINT64_MAX) {
        throw invalidUpstream("voted_swap_fee does not fit uint64", {
          ve_id: veIdKey,
        });
      }
      if (appliedWeight === 0n || appliedWeight > UINT128_MAX) {
        throw invalidUpstream(
          "active applied_vote_weight must fit uint128 and be positive",
          {
            ve_id: veIdKey,
          },
        );
      }
      if (poolTotalWeight > UINT128_MAX) {
        throw invalidUpstream("pool_total_vote_weight does not fit uint128", {
          ve_id: veIdKey,
        });
      }
      vote = {
        poolKeyId: indexedIntegerString(rawToken, "pool_key_id"),
        poolId,
        poolKeyInput,
        poolKey,
        swapFee,
        appliedWeight,
        poolTotalWeight,
      };
    }
    tokens.push({
      veId,
      amount,
      endTime,
      stakeId,
      vote,
      lastStakeChangedEventId: indexedEventId(
        rawToken,
        "last_stake_changed_event_id",
      ),
      lastTransferEventId: indexedEventId(rawToken, "last_transfer_event_id"),
    });
  }
  tokens.sort((left, right) =>
    left.veId < right.veId ? -1 : left.veId > right.veId ? 1 : 0,
  );
  const stateId = portfolioStateId({
    chainId: intent.chainId,
    owner,
    veToken,
    ve33,
    tokens,
  });
  return {
    chainId: intent.chainId,
    owner,
    veToken,
    ve33,
    sourceUrl: indexed.sourceUrl,
    totalItems: indexed.totalItems,
    stateId,
    tokens,
  };
}

function resolveReallocationTargets(
  requested: PrepareVe33ReallocationIntent["targets"],
  indexedPools: Record<string, unknown>[],
  ve33: Address,
  chainId: string,
): ResolvedReallocationTarget[] {
  const poolsByKeyId = new Map<string, Record<string, unknown>>();
  for (const pool of indexedPools) {
    const indexedChainId = indexedUint(pool, "chain_id");
    if (indexedChainId !== BigInt(chainId)) {
      throw invalidUpstream("Ve33 pool catalog has the wrong chain_id");
    }
    const poolKeyId = indexedIntegerString(pool, "pool_key_id");
    if (poolsByKeyId.has(poolKeyId)) {
      throw invalidUpstream(
        "Ve33 pool catalog contains duplicate pool_key_id",
        {
          pool_key_id: poolKeyId,
        },
      );
    }
    poolsByKeyId.set(poolKeyId, pool);
  }

  return requested.map((target, index) => {
    const rawPool = poolsByKeyId.get(target.poolKeyId);
    if (rawPool === undefined) {
      throw new ServiceError(
        "unknown_ve33_pool",
        `No Ve33 pool exists for pool_key_id ${target.poolKeyId}`,
      );
    }
    if (rawPool.pool_state === null) {
      throw new ServiceError(
        "uninitialized_ve33_pool",
        `Ve33 pool ${target.poolKeyId} is not initialized and cannot receive a vote`,
      );
    }
    if (!isRecord(rawPool.pool_state)) {
      throw invalidUpstream("Ve33 pool catalog entry is missing pool_state", {
        pool_key_id: target.poolKeyId,
      });
    }
    const rawPoolKey = rawPool.pool_key;
    if (!isRecord(rawPoolKey)) {
      throw invalidUpstream("Ve33 pool catalog entry is missing pool_key");
    }
    const poolKeyInput = indexedPoolKey(rawPoolKey);
    if (normalizeAddress(poolKeyInput.extension as Address) !== ve33) {
      throw invalidUpstream(
        "target pool extension does not match the portfolio Ve33",
        {
          pool_key_id: target.poolKeyId,
        },
      );
    }
    let poolKey: Ve33PoolKeyArgument;
    try {
      poolKey = toPoolKeyArgument(poolKeyInput);
    } catch (error) {
      throw invalidUpstream("Ve33 pool catalog contains an invalid pool key", {
        pool_key_id: target.poolKeyId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    const poolId = poolIdFor(poolKey);
    if (poolId !== indexedBytes32(rawPool, "pool_id")) {
      throw invalidUpstream(
        "target pool key does not hash to its indexed pool_id",
        {
          pool_key_id: target.poolKeyId,
        },
      );
    }
    return {
      index,
      poolKeyId: target.poolKeyId,
      poolId,
      poolKey,
      swapFee: unsigned(target.swapFee, 64, "swap_fee"),
      weightBps: target.weightBps,
    };
  });
}

function groupByEndTime(
  tokens: (IndexedVeTokenState & { vote: IndexedVe33Vote })[],
) {
  const groups = new Map<
    string,
    (IndexedVeTokenState & { vote: IndexedVe33Vote })[]
  >();
  for (const token of tokens) {
    const key = token.endTime.toString();
    const group = groups.get(key) ?? [];
    group.push(token);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) =>
      BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0,
    )
    .map(([, group]) =>
      group.sort((left, right) =>
        left.veId < right.veId ? -1 : left.veId > right.veId ? 1 : 0,
      ),
    );
}

function allocateCohort(
  cohort: (IndexedVeTokenState & { vote: IndexedVe33Vote })[],
  targets: ResolvedReallocationTarget[],
): Map<string, TargetChunk[]> {
  const totalAmount = cohort.reduce((sum, token) => sum + token.amount, 0n);
  const demand = apportionAmounts(totalAmount, targets);
  const assignments = new Map<string, TargetChunk[]>();
  const unassigned = [...cohort].sort((left, right) =>
    left.amount > right.amount
      ? -1
      : left.amount < right.amount
        ? 1
        : left.veId < right.veId
          ? -1
          : 1,
  );

  for (let index = unassigned.length - 1; index >= 0; index--) {
    const source = unassigned[index];
    const affinity = targets.findIndex(
      (target) =>
        target.poolId === source.vote.poolId &&
        target.swapFee === source.vote.swapFee &&
        demand[target.index] >= source.amount,
    );
    if (affinity === -1) continue;
    assignments.set(source.veId.toString(), [
      { target: targets[affinity], amount: source.amount },
    ]);
    demand[targets[affinity].index] -= source.amount;
    unassigned.splice(index, 1);
  }

  for (let index = unassigned.length - 1; index >= 0; index--) {
    const source = unassigned[index];
    const fitting = targets
      .filter((target) => demand[target.index] >= source.amount)
      .sort((left, right) => {
        const leftRemainder = demand[left.index] - source.amount;
        const rightRemainder = demand[right.index] - source.amount;
        return leftRemainder < rightRemainder
          ? -1
          : leftRemainder > rightRemainder
            ? 1
            : left.index - right.index;
      });
    const target = fitting[0];
    if (target === undefined) continue;
    assignments.set(source.veId.toString(), [
      { target, amount: source.amount },
    ]);
    demand[target.index] -= source.amount;
    unassigned.splice(index, 1);
  }

  for (const source of unassigned) {
    let remaining = source.amount;
    const chunks: TargetChunk[] = [];
    while (remaining !== 0n) {
      const affinity = targets.find(
        (target) =>
          target.poolId === source.vote.poolId &&
          target.swapFee === source.vote.swapFee &&
          demand[target.index] !== 0n &&
          !chunks.some(
            ({ target: chunkTarget }) => chunkTarget.index === target.index,
          ),
      );
      const target =
        affinity ??
        [...targets]
          .filter((candidate) => demand[candidate.index] !== 0n)
          .sort((left, right) =>
            demand[left.index] > demand[right.index]
              ? -1
              : demand[left.index] < demand[right.index]
                ? 1
                : left.index - right.index,
          )[0];
      if (target === undefined) {
        throw new Error(
          "internal reallocation error: target demand exhausted early",
        );
      }
      const amount =
        remaining < demand[target.index] ? remaining : demand[target.index];
      chunks.push({ target, amount });
      remaining -= amount;
      demand[target.index] -= amount;
    }
    assignments.set(source.veId.toString(), chunks);
  }
  if (demand.some((amount) => amount !== 0n)) {
    throw new Error(
      "internal reallocation error: target demand was not filled",
    );
  }
  return assignments;
}

function apportionAmounts(
  totalAmount: bigint,
  targets: ResolvedReallocationTarget[],
): bigint[] {
  const denominator = BigInt(BPS_TOTAL);
  const amounts = targets.map(
    (target) => (totalAmount * BigInt(target.weightBps)) / denominator,
  );
  let remainder =
    totalAmount - amounts.reduce((sum, amount) => sum + amount, 0n);
  const order = targets
    .map((target) => ({
      index: target.index,
      remainder: (totalAmount * BigInt(target.weightBps)) % denominator,
    }))
    .sort((left, right) =>
      left.remainder > right.remainder
        ? -1
        : left.remainder < right.remainder
          ? 1
          : left.index - right.index,
    );
  for (const target of order) {
    if (remainder === 0n) break;
    amounts[target.index] += 1n;
    remainder -= 1n;
  }
  if (remainder !== 0n) {
    throw new Error(
      "internal reallocation error: basis-point remainder is too large",
    );
  }
  if (amounts.some((amount) => amount === 0n)) {
    throw new ServiceError(
      "ve33_target_rounds_to_zero",
      "A target allocation rounds to zero stake units within one lock-end cohort; use fewer targets or a larger active stake",
      {
        cohort_stake_amount: totalAmount.toString(),
        target_weight_bps: targets.map(({ weightBps }) => weightBps),
      },
    );
  }
  return amounts;
}

function retainedChunkIndex(
  source: IndexedVeTokenState & { vote: IndexedVe33Vote },
  chunks: TargetChunk[],
): number {
  const affinity = chunks.findIndex(
    ({ target }) =>
      target.poolId === source.vote.poolId &&
      target.swapFee === source.vote.swapFee,
  );
  if (affinity !== -1) return affinity;
  return chunks.reduce(
    (largest, chunk, index) =>
      chunk.amount > chunks[largest].amount ? index : largest,
    0,
  );
}

function portfolioOnchainValidation(portfolio: Ve33Portfolio) {
  const calls: {
    type: string;
    ve_id?: string;
    data: Hex;
    expected: Record<string, unknown>;
  }[] = [
    {
      type: "balance_of",
      data: encodeFunctionData({
        abi: VE_TOKEN_ABI,
        functionName: "balanceOf",
        args: [portfolio.owner],
      }),
      expected: { balance: portfolio.totalItems.toString() },
    },
  ];
  for (const token of portfolio.tokens) {
    calls.push(
      {
        type: "owner_of",
        ve_id: token.veId.toString(),
        data: encodeFunctionData({
          abi: VE_TOKEN_ABI,
          functionName: "ownerOf",
          args: [token.veId],
        }),
        expected: { owner: portfolio.owner },
      },
      {
        type: "stakes",
        ve_id: token.veId.toString(),
        data: encodeFunctionData({
          abi: VE_TOKEN_ABI,
          functionName: "stakes",
          args: [token.veId],
        }),
        expected: {
          amount: token.amount.toString(),
          end_time: token.endTime.toString(),
        },
      },
      {
        type: "vote_state",
        ve_id: token.veId.toString(),
        data: encodeFunctionData({
          abi: VE_TOKEN_ABI,
          functionName: "voteState",
          args: [token.veId],
        }),
        expected: {
          pool_id: token.vote?.poolId ?? numberToHex(0n, { size: 32 }),
          weight: token.vote?.appliedWeight.toString() ?? "0",
          voted_swap_fee: token.vote?.swapFee.toString() ?? "0",
        },
      },
      {
        type: "voting_power",
        ve_id: token.veId.toString(),
        data: encodeFunctionData({
          abi: VE_TOKEN_ABI,
          functionName: "votingPower",
          args: [token.veId],
        }),
        expected: {
          note: "Dynamic at the provider block; use this value for the final displayed projection.",
        },
      },
    );
  }
  const data = encodeFunctionData({
    abi: VE_TOKEN_ABI,
    functionName: "multicall",
    args: [calls.map(({ data }) => data)],
  });
  return {
    status: "not_executed" as const,
    required_before_signing: true,
    eth_call: {
      chain_id: portfolio.chainId,
      to: portfolio.veToken,
      data,
    },
    calls,
    instruction:
      "Execute eth_call through the user's connected provider, decode its ordered results, and compare every expectation immediately before signing.",
  };
}

function portfolioStateId(input: {
  chainId: string;
  owner: Address;
  veToken: Address;
  ve33: Address | null;
  tokens: IndexedVeTokenState[];
}) {
  return keccak256(
    stringToHex(
      JSON.stringify({
        schema_version: "2",
        chain_id: input.chainId,
        owner: input.owner,
        ve_token: input.veToken,
        ve33: input.ve33,
        tokens: input.tokens.map((token) => ({
          ve_id: token.veId.toString(),
          amount: token.amount.toString(),
          end_time: token.endTime.toString(),
          stake_id: token.stakeId,
          vote:
            token.vote === null
              ? null
              : {
                  pool_key_id: token.vote.poolKeyId,
                  pool_id: token.vote.poolId,
                  pool_key: token.vote.poolKey,
                  swap_fee: token.vote.swapFee.toString(),
                  applied_weight: token.vote.appliedWeight.toString(),
                },
          last_stake_changed_event_id: token.lastStakeChangedEventId,
          last_transfer_event_id: token.lastTransferEventId,
        })),
      }),
    ),
  );
}

function feeTokensFromClaims(
  claims: { veId: string; poolKey: Ve33PoolKeyInput }[],
): Address[] {
  const tokens = new Set<Address>();
  for (const claim of claims) {
    const poolKey = toPoolKeyArgument(claim.poolKey);
    tokens.add(poolKey.token0);
    tokens.add(poolKey.token1);
  }
  return [...tokens].sort((left, right) =>
    BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0,
  );
}

function balanceSnapshotRequest(
  chainId: string,
  token: Address,
  owner: Address,
) {
  return BigInt(token) === 0n
    ? {
        token,
        type: "native_balance",
        rpc: {
          chain_id: chainId,
          method: "eth_getBalance",
          params: [owner, "pending"],
        },
        claimed_delta_instruction:
          "post_claim_balance - pre_claim_balance + claim_transaction_gas_cost",
      }
    : {
        token,
        type: "erc20_balance",
        rpc: {
          chain_id: chainId,
          method: "eth_call",
          params: [
            {
              to: token,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [owner],
              }),
            },
            "pending",
          ],
        },
        claimed_delta_instruction: "post_claim_balance - pre_claim_balance",
      };
}

function apportionReinvestment(
  totalAmount: bigint,
  active: (IndexedVeTokenState & { vote: IndexedVe33Vote })[],
): bigint[] {
  const sourceTotal = active.reduce((sum, token) => sum + token.amount, 0n);
  if (sourceTotal === 0n) {
    throw invalid("active allocation stake total must be positive");
  }
  const minimum = BigInt(active.length);
  if (totalAmount < minimum) {
    throw invalid(
      "reinvestment amount cannot increase every active allocation",
    );
  }
  const remaining = totalAmount - minimum;
  const amounts = active.map(
    (token) => 1n + (remaining * token.amount) / sourceTotal,
  );
  let remainder =
    totalAmount - amounts.reduce((sum, amount) => sum + amount, 0n);
  const order = active
    .map((token, index) => ({
      index,
      remainder: (remaining * token.amount) % sourceTotal,
    }))
    .sort((left, right) =>
      left.remainder > right.remainder
        ? -1
        : left.remainder < right.remainder
          ? 1
          : active[left.index].veId < active[right.index].veId
            ? -1
            : 1,
    );
  for (const target of order) {
    if (remainder === 0n) break;
    amounts[target.index] += 1n;
    remainder -= 1n;
  }
  if (remainder !== 0n || amounts.some((amount) => amount <= 0n)) {
    throw new Error("internal reinvestment apportionment error");
  }
  return amounts;
}

function erc20Approval(
  chainId: string,
  token: Address,
  spender: Address,
  amount: bigint,
) {
  return {
    chain_id: chainId,
    to: getAddress(token),
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [getAddress(spender), amount],
    }),
    value: "0",
  };
}

function projectVotingPower(amount: bigint, endTime: bigint, now: bigint) {
  if (endTime <= now) return 0n;
  const remaining = endTime - now;
  if (remaining > VE33_MAX_STAKE_DURATION) return 0n;
  return (amount * remaining) / VE33_MAX_STAKE_DURATION;
}

function poolIdFor(poolKey: Ve33PoolKeyArgument): Hex {
  return deriveEvmPoolId(poolKey, keccak256);
}

function indexedPoolKey(poolKey: Record<string, unknown>): Ve33PoolKeyInput {
  return {
    token0: indexedAddress(poolKey, "token0"),
    token1: indexedAddress(poolKey, "token1"),
    fee: indexedIntegerString(poolKey, "fee"),
    tickSpacing: indexedOptionalNumber(poolKey, "tick_spacing"),
    extension: indexedAddress(poolKey, "extension"),
    stableswapParams: indexedStableswapParams(poolKey),
  };
}

export function toPoolKeyArgument(
  input: Ve33PoolKeyInput,
): Ve33PoolKeyArgument {
  const token0 = normalizeAddress(input.token0);
  const token1 = normalizeAddress(input.token1);
  if (BigInt(token0) >= BigInt(token1)) {
    throw invalid("pool_key.token0 must be numerically less than token1");
  }
  if (input.config) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.config)) {
      throw invalid("pool_key.config must contain exactly 32 bytes");
    }
    validateVe33Config(input.config);
    return { token0, token1, config: input.config };
  }
  if (input.fee === undefined || input.extension === undefined) {
    throw invalid(
      "pool_key requires config or the fee, tick_spacing, and extension fields",
    );
  }
  const fee = unsigned(input.fee, 64, "pool_key.fee");
  if (fee !== 0n) throw invalid("ve33 pool_key.fee must be zero");
  const tickSpacing = input.tickSpacing ?? 0;
  if (
    !Number.isInteger(tickSpacing) ||
    tickSpacing < 0 ||
    tickSpacing > 698_605
  ) {
    throw invalid("pool_key.tick_spacing must be between 0 and 698605");
  }
  const stable = input.stableswapParams;
  if (stable) {
    if (
      !Number.isInteger(stable.amplification) ||
      stable.amplification < 0 ||
      stable.amplification > 26 ||
      !Number.isInteger(stable.centerTick) ||
      stable.centerTick % 16 !== 0
    ) {
      throw invalid(
        "stableswap amplification must be 0..26 and center_tick a multiple of 16",
      );
    }
    const encodedCenter = stable.centerTick / 16;
    if (encodedCenter < -(1 << 23) || encodedCenter > (1 << 23) - 1) {
      throw invalid("stableswap center_tick does not fit int24 after division");
    }
    try {
      return {
        token0,
        token1,
        config: encodeEvmStableswapPoolConfig({
          fee,
          centerTick: stable.centerTick,
          amplification: stable.amplification,
          extension: normalizeAddress(input.extension),
        }),
      };
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error));
    }
  } else {
    if (tickSpacing !== 0 && !isPowerOfFour(tickSpacing)) {
      throw invalid("ve33 concentrated tick_spacing must be a power of four");
    }
    try {
      return {
        token0,
        token1,
        config:
          tickSpacing === 0
            ? encodeEvmStableswapPoolConfig({
                fee,
                centerTick: 0,
                amplification: 0,
                extension: normalizeAddress(input.extension),
              })
            : encodeEvmConcentratedPoolConfig({
                fee,
                tickSpacing,
                extension: normalizeAddress(input.extension),
              }),
      };
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error));
    }
  }
}

export function saltToId(
  sender: Address,
  salt: Hex,
  chainId: bigint,
  veToken: Address,
): bigint {
  return deriveEvmVeTokenId(
    {
      minter: getAddress(sender),
      salt,
      chainId,
      contract: getAddress(veToken),
    },
    keccak256,
  );
}

function deriveSalt(nonce: Hex, index: number): Hex {
  return deriveEvmIndexedSalt(nonce, BigInt(index), keccak256);
}

function normalizeAddress(value: Address): Address {
  return getAddress(numberToHex(BigInt(value), { size: 20 }));
}

function validateVe33Config(config: Hex) {
  const decoded = decodeEvmPoolConfig(config);
  if (decoded.fee !== 0n) {
    throw invalid("ve33 pool_key.config must encode zero fee");
  }
  if (
    decoded.poolType === "concentrated" &&
    !isPowerOfFour(decoded.tickSpacing)
  ) {
    throw invalid(
      "ve33 concentrated pool_key.config must encode power-of-four tick spacing",
    );
  }
  if (
    decoded.poolType === "stableswap" &&
    decoded.stableswapParams.amplification > 26
  ) {
    throw invalid("ve33 stableswap pool_key.config amplification exceeds 26");
  }
}

function isPowerOfFour(value: number): boolean {
  if (!Number.isInteger(value) || value <= 0) return false;
  let remaining = value;
  while (remaining % 4 === 0) remaining /= 4;
  return remaining === 1;
}

function ve33Plan<TDetails extends Record<string, unknown>>({
  schemaVersion = "1",
  action,
  chainId,
  veToken,
  sender,
  approvals = [],
  calls,
  details,
  value = 0n,
}: {
  schemaVersion?: string;
  action: string;
  chainId: string;
  veToken: Address;
  sender: Address;
  approvals?: PreparedTransaction[];
  calls: Ve33Call[];
  details: TDetails;
  value?: bigint;
}) {
  const functionNames = calls.map(({ data }) => safeVeTokenFunctionName(data));
  const calldata = calls.map(({ data }) => data);
  const transactionData =
    calldata.length === 0
      ? null
      : calldata.length === 1
        ? calldata[0]
        : encodeFunctionData({
            abi: VE_TOKEN_ABI,
            functionName: "multicall",
            args: [calldata],
          });
  const identity = {
    action,
    chain_id: chainId,
    sender: getAddress(sender),
    approvals: approvals.map(transactionIdentity),
    transaction:
      transactionData === null
        ? null
        : transactionIdentity({
            chain_id: chainId,
            to: getAddress(veToken),
            data: transactionData,
            value: value.toString(),
          }),
  };
  const transaction =
    transactionData === null
      ? null
      : {
          chain_id: chainId,
          to: getAddress(veToken),
          data: transactionData,
          value: value.toString(),
        };
  return {
    schema_version: schemaVersion,
    action,
    plan_id: keccak256(stringToHex(JSON.stringify(identity))),
    requires_user_confirmation: true,
    confirmation_ready: transactionData !== null,
    wallet_validation_required: true,
    approvals,
    calls,
    transaction,
    execution_plan:
      transaction === null
        ? null
        : executionPlan({
            chainId,
            sender,
            approvals,
            transaction,
          }),
    ...details,
    transaction_safety: {
      allowlisted_vetoken_functions: functionNames,
      only_allowlisted_vetoken_functions: true,
      ownership_or_nft_transfer_calls: 0,
      ownership_or_nft_transfer_calls_are_forbidden: true,
      source_nft_burns_inside_compound_merges: calls.filter(
        ({ type }) => type === "claim_fees_and_merge_stake",
      ).length,
      signs_transactions: false,
      submits_transactions: false,
    },
    client_execution: {
      must_revalidate_before_signing: true,
      instruction:
        "Verify ownership or operator approval, current stake/vote state, balances, allowances, and gas through the user's connected provider; then ask the user to confirm this exact plan_id before signing.",
    },
  };
}

const SAFE_VE_TOKEN_FUNCTIONS = new Set([
  "claimPoolFees",
  "claimPoolFeesToSelf",
  "clearVote",
  "vote",
  "splitStake",
  "claimPoolFeesAndMergeStakesToSelf",
  "claimPoolFeesAndExtendStakeToSelfForDuration",
  "claimPoolFeesAndExtendStakeToSelfMaxDuration",
  "extendStakeForDuration",
  "extendStakeMaxDuration",
  "withdrawStakeToSelf",
  "mergeStakes",
  "increaseStakeAmount",
  "stakeForDuration",
  "stakeMaxDuration",
]);

function safeVeTokenFunctionName(data: Hex): string {
  let functionName: string;
  try {
    functionName = decodeFunctionData({ abi: VE_TOKEN_ABI, data }).functionName;
  } catch {
    throw new Error("internal safety error: unknown VeToken calldata");
  }
  if (!SAFE_VE_TOKEN_FUNCTIONS.has(functionName)) {
    throw new Error(
      `internal safety error: VeToken function ${functionName} is not allowlisted`,
    );
  }
  return functionName;
}

function unsigned(
  value: string,
  bits: 64 | 128 | 192 | 256,
  label: string,
): bigint {
  if (!/^(?:[0-9]+|0x[0-9a-fA-F]+)$/.test(value)) {
    throw invalid(`${label} must be an unsigned integer`);
  }
  const parsed = BigInt(value);
  const max =
    bits === 64
      ? UINT64_MAX
      : bits === 128
        ? UINT128_MAX
        : bits === 192
          ? UINT192_MASK
          : UINT256_MAX;
  if (parsed > max) throw invalid(`${label} does not fit uint${bits}`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function indexedUint(record: Record<string, unknown>, field: string): bigint {
  const value = record[field];
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
  ) {
    throw invalidUpstream(`${field} must be an unsigned integer`);
  }
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw invalidUpstream(`${field} must be an unsigned integer`);
  }
}

function indexedIntegerString(
  record: Record<string, unknown>,
  field: string,
): string {
  return indexedUint(record, field).toString();
}

function indexedTimestamp(
  record: Record<string, unknown>,
  field: string,
): bigint {
  const value = record[field];
  if (typeof value !== "string") {
    throw invalidUpstream(
      `${field} must be an ISO timestamp or unsigned integer`,
    );
  }
  if (/^(?:0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < 0 ||
    milliseconds % 1_000 !== 0
  ) {
    throw invalidUpstream(`${field} must resolve to a whole-second timestamp`);
  }
  return BigInt(milliseconds / 1_000);
}

function indexedEventId(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "number" && !Number.isSafeInteger(value))
  ) {
    throw invalidUpstream(`${field} must be an integer`);
  }
  const text = String(value);
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(text)) {
    throw invalidUpstream(`${field} must be an integer`);
  }
  return text;
}

function indexedAddress(
  record: Record<string, unknown>,
  field: string,
): Address {
  const value = record[field];
  if (typeof value !== "string") {
    throw invalidUpstream(`${field} must be an EVM address`);
  }
  try {
    return normalizeAddress(value as Address);
  } catch {
    throw invalidUpstream(`${field} must be an EVM address`);
  }
}

function indexedBytes32(record: Record<string, unknown>, field: string): Hex {
  const value = indexedUint(record, field);
  if (value > UINT256_MAX) {
    throw invalidUpstream(`${field} does not fit bytes32`);
  }
  return numberToHex(value, { size: 32 });
}

function indexedOptionalNumber(
  record: Record<string, unknown>,
  field: string,
): number | null {
  if (record[field] === null || record[field] === undefined) return null;
  const value = indexedUint(record, field);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalidUpstream(`${field} is too large`);
  }
  return Number(value);
}

function indexedStableswapParams(
  poolKey: Record<string, unknown>,
): Ve33PoolKeyInput["stableswapParams"] {
  const value = poolKey.stableswap_params;
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    throw invalidUpstream("stableswap_params must be an object or null");
  }
  const centerTick = value.center_tick;
  const amplification = value.amplification;
  if (
    typeof centerTick !== "number" ||
    !Number.isSafeInteger(centerTick) ||
    typeof amplification !== "number" ||
    !Number.isSafeInteger(amplification)
  ) {
    throw invalidUpstream(
      "stableswap_params center_tick and amplification must be integers",
    );
  }
  return { centerTick, amplification };
}

function invalidUpstream(message: string, details?: unknown) {
  return new ServiceError("invalid_upstream_response", message, details);
}

function invalid(message: string) {
  return new ServiceError("invalid_ve33_intent", message);
}
