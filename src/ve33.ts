import {
  type Address,
  encodeAbiParameters,
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
  prepareSwap,
  type QuoteSource,
  ServiceError,
} from "./core.js";

const VE_TOKEN_ABI = parseAbi([
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function claimPoolFees(uint256 veId, (address token0,address token1,bytes32 config) poolKey, address recipient) payable returns (uint128 amount0,uint128 amount1)",
  "function claimPoolFeesToSelf(uint256 veId, (address token0,address token1,bytes32 config) poolKey) payable returns (uint128 amount0,uint128 amount1)",
  "function clearVote(uint256 veId) payable",
  "function vote(uint256 veId, (address token0,address token1,bytes32 config) poolKey, uint64 swapFee) payable",
  "function splitStake(uint256 veId, uint128 amount, bytes32 salt) payable returns (uint256 splitVeId)",
  "function extendStakeForDuration(uint256 veId, uint32 duration) payable",
  "function extendStakeMaxDuration(uint256 veId) payable",
  "function claimPoolFeesAndExtendStakeToSelfForDuration(uint256 veId, uint32 duration, (address token0,address token1,bytes32 config) poolKey) payable returns (uint128 amount0,uint128 amount1)",
  "function claimPoolFeesAndExtendStakeToSelfMaxDuration(uint256 veId, (address token0,address token1,bytes32 config) poolKey) payable returns (uint128 amount0,uint128 amount1)",
  "function increaseStakeAmount(uint256 veId, uint128 amount) payable",
]);

const UINT64_MAX = (1n << 64n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;
const UINT192_MASK = (1n << 192n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const PERMILLE_TOTAL = 1_000;

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
  currentVote?: {
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

export interface PrepareVe33SplitIntent {
  chainId: string;
  veToken: Address;
  sender: Address;
  veId: string;
  amount: string;
  salt: Hex;
}

export interface PrepareVe33ClaimIntent {
  chainId: string;
  veToken: Address;
  sender: Address;
  recipient?: Address;
  claims: { veId: string; poolKey: Ve33PoolKeyInput }[];
}

export type PrepareVe33ReinvestIntent =
  | {
      phase: "claim";
      chainId: string;
      veToken: Address;
      sender: Address;
      claims: { veId: string; poolKey: Ve33PoolKeyInput }[];
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
    };

export function prepareVe33Vote(intent: PrepareVe33VoteIntent) {
  const sourceVeId = unsigned(intent.sourceVeId, 192, "source_ve_id");
  const sourceAmount = unsigned(intent.sourceAmount, 128, "source_amount");
  if (sourceAmount === 0n) throw invalid("source_amount must be positive");
  if (intent.allocations.length === 0) {
    throw invalid("at least one allocation is required");
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
    throw invalid(`allocation permilles sum to ${totalPermille}, expected 1000`);
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
      (sourceAmount * BigInt(allocation.permille)) /
      BigInt(PERMILLE_TOTAL),
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
  const currentBucket = intent.currentVote
    ? (targets.find(
        ({ poolKeyId }) => poolKeyId === intent.currentVote?.poolKeyId,
      ) ?? null)
    : null;
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
  if (intent.currentVote) {
    poolKeys.set(
      intent.currentVote.poolKeyId,
      toPoolKeyArgument(intent.currentVote.poolKey),
    );
  }

  const claimCalls: Ve33Call[] = [];
  const splitCalls: Ve33Call[] = [];
  const voteCalls: Ve33Call[] = [];
  const keptTarget = keptBucket.poolKeyId === null ? null : keptBucket;
  const currentFee = intent.currentVote?.swapFee
    ? unsigned(intent.currentVote.swapFee, 64, "current_swap_fee")
    : undefined;
  const keepsVoteUntouched = Boolean(
    intent.currentVote &&
      keptTarget &&
      keptTarget.poolKeyId === intent.currentVote.poolKeyId &&
      currentFee !== undefined &&
      currentFee === keptTarget.swapFee,
  );
  if (intent.currentVote && !keepsVoteUntouched) {
    const poolKey = poolKeys.get(intent.currentVote.poolKeyId);
    if (!poolKey) throw invalid("current vote is missing its pool key");
    claimCalls.push({
      type: "claim_pool_fees",
      ve_id: sourceVeId.toString(),
      pool_key_id: intent.currentVote.poolKeyId,
      data: encodeFunctionData({
        abi: VE_TOKEN_ABI,
        functionName: "claimPoolFeesToSelf",
        args: [sourceVeId, poolKey],
      }),
    });
  }

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
  } else if (!keptTarget && intent.currentVote) {
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
    details: { resulting_nfts: resultingNfts },
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
  const poolKey = intent.currentPoolKey
    ? toPoolKeyArgument(intent.currentPoolKey)
    : null;
  let data: Hex;
  let type: string;
  if (poolKey && intent.maxDuration) {
    type = "claim_fees_and_extend_max_duration";
    data = encodeFunctionData({
      abi: VE_TOKEN_ABI,
      functionName: "claimPoolFeesAndExtendStakeToSelfMaxDuration",
      args: [veId, poolKey],
    });
  } else if (poolKey) {
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
      claims_current_pool_fees_first: poolKey !== null,
      clears_current_vote: true,
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

export function prepareVe33Claim(intent: PrepareVe33ClaimIntent) {
  if (intent.claims.length === 0) throw invalid("at least one claim is required");
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

export async function prepareVe33Reinvest(
  env: Env,
  intent: PrepareVe33ReinvestIntent,
  fetcher: typeof fetch = fetch,
) {
  if (intent.phase === "claim") {
    const plan = prepareVe33Claim({
      chainId: intent.chainId,
      veToken: intent.veToken,
      sender: intent.sender,
      claims: intent.claims,
    });
    return {
      phase: "claim" as const,
      plan,
      next_phase:
        "Immediately before execution, snapshot the sender's balances for every pool fee token. After the claim confirms, subtract those snapshots from the new balances and call this tool with phase=swap using the complete deltas. Static pre-claim estimates cannot guarantee that every newly accrued unit is reinvested.",
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
        "After all swap receipts confirm, measure the sender's stake-token increase (including directly claimed stake token) and call this tool with phase=stake and that full amount.",
    };
  }

  const veId = unsigned(intent.veId, 192, "ve_id");
  const amount = unsigned(intent.amount, 128, "amount");
  if (amount === 0n) throw invalid("amount must be positive");
  const stakeToken = getAddress(intent.stakeToken);
  const veToken = getAddress(intent.veToken);
  const approvals =
    BigInt(stakeToken) === 0n
      ? []
      : [
          {
            chain_id: intent.chainId,
            to: stakeToken,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [veToken, amount],
            }),
            value: "0",
          },
        ];
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
    calls: [
      {
        type: "increase_stake_amount",
        ve_id: veId.toString(),
        amount: amount.toString(),
        data,
      },
    ],
    details: {
      approvals,
      transaction_value: BigInt(stakeToken) === 0n ? amount.toString() : "0",
    },
    value: BigInt(stakeToken) === 0n ? amount : 0n,
  });
  return { phase: "stake" as const, plan, next_phase: null };
}

export function toPoolKeyArgument(input: Ve33PoolKeyInput): Ve33PoolKeyArgument {
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
  if (!Number.isInteger(tickSpacing) || tickSpacing < 0 || tickSpacing > 0x7fff_ffff) {
    throw invalid("pool_key.tick_spacing must be a non-negative int31");
  }
  const stable = input.stableswapParams;
  let low32: bigint;
  if (stable) {
    if (
      !Number.isInteger(stable.amplification) ||
      stable.amplification < 0 ||
      stable.amplification > 127 ||
      !Number.isInteger(stable.centerTick) ||
      stable.centerTick % 16 !== 0
    ) {
      throw invalid(
        "stableswap amplification must be 0..127 and center_tick a multiple of 16",
      );
    }
    const encodedCenter = stable.centerTick / 16;
    if (encodedCenter < -(1 << 23) || encodedCenter > (1 << 23) - 1) {
      throw invalid("stableswap center_tick does not fit int24 after division");
    }
    low32 =
      (BigInt(stable.amplification) << 24n) |
      BigInt(encodedCenter & 0x00ff_ffff);
  } else {
    if (tickSpacing !== 0 && !isPowerOfFour(tickSpacing)) {
      throw invalid("ve33 concentrated tick_spacing must be a power of four");
    }
    low32 = BigInt(tickSpacing);
    if (tickSpacing !== 0) low32 |= 1n << 31n;
  }
  const packed =
    low32 | (fee << 32n) | (BigInt(normalizeAddress(input.extension)) << 96n);
  return { token0, token1, config: numberToHex(packed, { size: 32 }) };
}

export function saltToId(
  sender: Address,
  salt: Hex,
  chainId: bigint,
  veToken: Address,
): bigint {
  return (
    BigInt(
      keccak256(
        encodeAbiParameters(
          [
            { type: "address" },
            { type: "bytes32" },
            { type: "uint256" },
            { type: "address" },
          ],
          [getAddress(sender), salt, chainId, getAddress(veToken)],
        ),
      ),
    ) & UINT192_MASK
  );
}

function deriveSalt(nonce: Hex, index: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }],
      [nonce, BigInt(index)],
    ),
  );
}

function normalizeAddress(value: Address): Address {
  return getAddress(numberToHex(BigInt(value), { size: 20 }));
}

function validateVe33Config(config: Hex) {
  const packed = BigInt(config);
  const fee = (packed >> 32n) & UINT64_MAX;
  if (fee !== 0n) throw invalid("ve33 pool_key.config must encode zero fee");
  const low32 = Number(packed & 0xffff_ffffn);
  const isConcentrated = (low32 & 0x8000_0000) !== 0;
  const tickSpacing = low32 & 0x7fff_ffff;
  if (isConcentrated && !isPowerOfFour(tickSpacing)) {
    throw invalid(
      "ve33 concentrated pool_key.config must encode power-of-four tick spacing",
    );
  }
}

function isPowerOfFour(value: number): boolean {
  if (!Number.isInteger(value) || value <= 0) return false;
  let remaining = value;
  while (remaining % 4 === 0) remaining /= 4;
  return remaining === 1;
}

function ve33Plan<TDetails extends Record<string, unknown>>({
  action,
  chainId,
  veToken,
  sender,
  calls,
  details,
  value = 0n,
}: {
  action: string;
  chainId: string;
  veToken: Address;
  sender: Address;
  calls: Ve33Call[];
  details: TDetails;
  value?: bigint;
}) {
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
    to: getAddress(veToken),
    data: transactionData,
    value: value.toString(),
  };
  return {
    schema_version: "1",
    action,
    plan_id: keccak256(stringToHex(JSON.stringify(identity))),
    requires_user_confirmation: true,
    confirmation_ready: transactionData !== null,
    wallet_validation_required: true,
    calls,
    transaction:
      transactionData === null
        ? null
        : {
            chain_id: chainId,
            to: getAddress(veToken),
            data: transactionData,
            value: value.toString(),
          },
    ...details,
    client_execution: {
      must_revalidate_before_signing: true,
      instruction:
        "Verify ownership or operator approval, current stake/vote state, balances, allowances, and gas through the user's connected provider; then ask the user to confirm this exact plan_id before signing.",
    },
  };
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

function invalid(message: string) {
  return new ServiceError("invalid_ve33_intent", message);
}
