import {
  concatHex,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  numberToHex,
  parseAbi,
  size,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { boostedFeesAddresses } from "./contracts.js";
import { type Env, ServiceError } from "./core.js";
import {
  executionPlan,
  executionPlanFromSteps,
  type ExecutionPlanStepInput,
  type PreparedTransaction,
  transactionIdentity,
} from "./execution-plan.js";
import {
  buildPositionStateReadPlan,
  positionStateQuery,
} from "./position-state.js";
import { getOwnedIndexedPosition } from "./positions.js";

const NATIVE_TOKEN = getAddress("0x0000000000000000000000000000000000000000");

// The canonical wrapped-native token per chain. Every entry was verified on
// chain rather than copied from a token list: `symbol()` was read and
// `withdraw(uint256)` was probed with a zero amount, which reverts on a
// contract that does not implement the WETH9 interface this tool encodes.
//
// The symbol is carried alongside the address because the wrapped native is
// not ether everywhere: BNB Chain wraps BNB, Polygon wraps POL, and Monad
// wraps MON. Naming the asset in the response keeps a caller from telling a
// user they are wrapping ETH on a chain where they are not.
//
// A chain absent from this map is one whose wrapped native has not been
// verified, not one that is known to lack it.
const WRAPPED_NATIVE_BY_CHAIN: Record<
  string,
  { address: Address; symbol: string }
> = {
  "1": { address: getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"), symbol: "WETH" },
  "10": { address: getAddress("0x4200000000000000000000000000000000000006"), symbol: "WETH" },
  "56": { address: getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"), symbol: "WBNB" },
  "130": { address: getAddress("0x4200000000000000000000000000000000000006"), symbol: "WETH" },
  "137": { address: getAddress("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"), symbol: "WPOL" },
  "143": { address: getAddress("0x3bd359c1119da7da1d913d1c4d2b7c461115433a"), symbol: "WMON" },
  "1301": { address: getAddress("0x4200000000000000000000000000000000000006"), symbol: "WETH" },
  "4663": { address: getAddress("0x0bd7d308f8e1639fab988df18a8011f41eacad73"), symbol: "WETH" },
  "8453": { address: getAddress("0x4200000000000000000000000000000000000006"), symbol: "WETH" },
  "42161": { address: getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"), symbol: "WETH" },
  "57073": { address: getAddress("0x4200000000000000000000000000000000000006"), symbol: "WETH" },
  "84532": { address: getAddress("0x4200000000000000000000000000000000000006"), symbol: "WETH" },
  "421614": { address: getAddress("0x980B62Da83eFf3D4576C647993b0c1D7faf17c73"), symbol: "WETH" },
  "763373": { address: getAddress("0x4200000000000000000000000000000000000006"), symbol: "WETH" },
  "11155111": { address: getAddress("0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9"), symbol: "WETH" },
  "11155420": { address: getAddress("0x4200000000000000000000000000000000000006"), symbol: "WETH" },
};
const ORACLE_V3 = getAddress("0x517E506700271AEa091b02f42756F5E174Af5230");
const TWAMM_V3 = getAddress("0xd47f1B1eDCfEaBb08F6eBd8FC337c27E636C75BA");
const OLD_TWAMM_V3 = getAddress("0xd4F1060cB9c1A13e1d2d20379b8aa2cF7541eD9b");
const MANUAL_POOL_BOOSTER_V3 = getAddress(
  "0xddb1758118F65e13a91497015B8cB26801402761",
);
const OLD_GEKUBO_TOKEN = getAddress(
  "0x0c93b16cb1d8691e629514fc98f02cbad340da3c",
);
const EKUBO_TOKEN = getAddress("0x04c46e830bb56ce22735d5d8fc9cb90309317d0f");
const HYPER_ROUTER_V2_MAINNET = getAddress(
  "0x8CCB1ffD5C2aa6Bd926473425Dea4c8c15DE60fd",
);
const EKUBO_TOKEN_INDEX = 3;
const OLD_GEKUBO_TOKEN_INDEX = 90;
const MAX_INT128 = (1n << 127n) - 1n;

const WRAPPED_NATIVE_ABI = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 amount)",
]);
const ORACLE_ABI = parseAbi([
  "function expandCapacity(address token,uint32 minCapacity) returns (uint32 capacity)",
]);
const MANUAL_BOOSTER_ABI = parseAbi([
  "function boost((address token0,address token1,bytes32 config) poolKey,uint64 startTime,uint64 endTime,uint112 rate0,uint112 rate1) payable returns (uint112,uint112)",
]);
const TWAMM_ABI = parseAbi([
  "function lockAndExecuteVirtualOrders((address token0,address token1,bytes32 config) poolKey)",
]);
const ERC721_TRANSFER_ABI = parseAbi([
  "function safeTransferFrom(address from,address to,uint256 tokenId)",
]);

export interface ExactPoolKeyInput {
  token0: string;
  token1: string;
  config: Hex;
}

export interface PreparedUiActionInput {
  action: string;
  chainId: string;
  sender: Address;
  request: Record<string, unknown>;
  transaction?: PreparedTransaction;
  approvals?: PreparedTransaction[];
  postExecutionTransactions?: PreparedTransaction[];
  steps?: ExecutionPlanStepInput[];
  atomicBatchRequired?: boolean;
  details?: Record<string, unknown>;
  onchainValidation?: Record<string, unknown>;
}

export function prepareWrapUnwrap(input: {
  chainId: string;
  sender: string;
  direction: "wrap" | "unwrap";
  amount: string;
}) {
  const wrapped = WRAPPED_NATIVE_BY_CHAIN[input.chainId];
  if (wrapped === undefined) {
    throw new ServiceError(
      "unsupported_chain",
      `No verified wrapped native token is known for chain ${input.chainId}; supported chains are ${Object.keys(
        WRAPPED_NATIVE_BY_CHAIN,
      ).join(", ")}`,
    );
  }
  const sender = getAddress(input.sender);
  const amount = positiveUnsigned(input.amount, 256, "amount");
  const data =
    input.direction === "wrap"
      ? encodeFunctionData({ abi: WRAPPED_NATIVE_ABI, functionName: "deposit" })
      : encodeFunctionData({
          abi: WRAPPED_NATIVE_ABI,
          functionName: "withdraw",
          args: [amount],
        });
  const transaction = preparedTransaction(
    input.chainId,
    wrapped.address,
    data,
    input.direction === "wrap" ? amount : 0n,
  );

  return preparedUiAction({
    action: `ekubo_${input.direction}_native_token`,
    chainId: input.chainId,
    sender,
    request: {
      chain_id: input.chainId,
      sender,
      direction: input.direction,
      amount: amount.toString(),
      wrapped_token: wrapped.address,
      wrapped_token_symbol: wrapped.symbol,
    },
    transaction,
    details: {
      native_amount: amount.toString(),
      wrapped_token_amount: amount.toString(),
      wrapped_token_symbol: wrapped.symbol,
    },
  });
}

export async function prepareLpPositionTransfer(
  env: Env,
  input: {
    chainId: string;
    sender: string;
    positionsAddress: string;
    tokenId: string;
    recipient: string;
  },
  fetcher: typeof fetch = fetch,
) {
  const sender = getAddress(input.sender);
  const recipient = getAddress(input.recipient);
  if (sender === recipient) {
    throw new ServiceError(
      "invalid_recipient",
      "Position recipient must differ from the current owner",
    );
  }
  const owned = await getOwnedIndexedPosition(
    env,
    {
      owner: sender,
      chainId: input.chainId,
      positionsAddress: input.positionsAddress,
      tokenId: input.tokenId,
    },
    fetcher,
  );
  const currentStateQuery = buildPositionStateReadPlan(
    owned.indexedPosition,
    owned.owner,
  );
  if (!currentStateQuery.available) {
    throw new ServiceError(
      currentStateQuery.reason,
      "Position transfer requires a supported indexed EVM Positions manager",
      currentStateQuery,
    );
  }
  const data = encodeFunctionData({
    abi: ERC721_TRANSFER_ABI,
    functionName: "safeTransferFrom",
    args: [sender, recipient, owned.tokenId],
  });
  const transaction = preparedTransaction(
    owned.chainId,
    owned.positionsAddress,
    data,
    0n,
  );

  return preparedUiAction({
    action: "ekubo_transfer_lp_position",
    chainId: owned.chainId,
    sender,
    request: {
      chain_id: owned.chainId,
      sender,
      positions_address: owned.positionsAddress,
      token_id: owned.tokenId.toString(),
      recipient,
    },
    transaction,
    details: {
      irreversible_ownership_change: true,
      transfers_liquidity_and_unclaimed_earnings_with_nft: true,
      position: {
        pool_key: currentStateQuery.pool_key,
        bounds: currentStateQuery.bounds,
        manager_version: currentStateQuery.manager_version,
      },
    },
    onchainValidation: {
      status: "not_executed",
      current_state_query: positionStateQuery(currentStateQuery),
      instruction:
        "Pass current_state_query.read_calls_reference unchanged as wallet_batch_eth_call's reference argument, require every inner call to succeed, compare decoded owner with expected_owner locally, and retain raw return data immediately before simulating the transfer.",
    },
  });
}

export function prepareOracleCapacityExpansion(input: {
  chainId: string;
  sender: string;
  token: string;
  minCapacity: number;
}) {
  const sender = getAddress(input.sender);
  const token = getAddress(input.token);
  if (token === NATIVE_TOKEN) {
    throw new ServiceError(
      "invalid_token",
      "Oracle capacity can only be expanded for an ERC-20 token",
    );
  }
  if (
    !Number.isInteger(input.minCapacity) ||
    input.minCapacity < 0 ||
    input.minCapacity > 0xffff_ffff
  ) {
    throw new ServiceError("invalid_capacity", "min_capacity must fit uint32");
  }
  const data = encodeFunctionData({
    abi: ORACLE_ABI,
    functionName: "expandCapacity",
    args: [token, input.minCapacity],
  });
  const transaction = preparedTransaction(input.chainId, ORACLE_V3, data, 0n);

  return preparedUiAction({
    action: "ekubo_expand_oracle_capacity",
    chainId: input.chainId,
    sender,
    request: {
      chain_id: input.chainId,
      sender,
      token,
      min_capacity: input.minCapacity,
    },
    transaction,
    details: {
      oracle: ORACLE_V3,
      contract_resource_uri: `ekubo://contracts/evm/${input.chainId}/${ORACLE_V3}`,
    },
  });
}

export function prepareManualPoolBoost(input: {
  chainId: string;
  sender: string;
  poolKey: ExactPoolKeyInput;
  startTime: string;
  endTime: string;
  amount0: string;
  amount1: string;
}) {
  const sender = getAddress(input.sender);
  const poolKey = normalizeExactPoolKey(input.poolKey);
  // A boost forwards to the pool's own extension (BoostedFeesLib.addIncentives
  // -> core.forward(poolKey.config.extension(), ...)), so a pool with no
  // BoostedFees extension sends the call to an address with no code. That
  // surfaces as a bare CallFailed("0x") with nothing to act on, and
  // re-preparing produces the identical unexecutable plan. The extension is
  // packed into the config the caller already supplied, so this is decidable
  // here without touching the network.
  const boostExtension = getAddress(
    numberToHex(BigInt(poolKey.config) >> 96n, { size: 20 }),
  );
  const boostedFees = boostedFeesAddresses(input.chainId);
  if (!boostedFees.some((address) => address === boostExtension)) {
    throw new ServiceError(
      "invalid_pool_extension",
      boostedFees.length === 0
        ? `No BoostedFees extension is deployed on chain ${input.chainId}, so no pool there can be boosted`
        : `This pool's extension is ${boostExtension}, which is not a BoostedFees deployment; boostable pools on chain ${input.chainId} use ${boostedFees.join(" or ")}`,
    );
  }
  const startTime = unsigned(input.startTime, 64, "start_time");
  const endTime = unsigned(input.endTime, 64, "end_time");
  if (endTime <= startTime) {
    throw new ServiceError(
      "invalid_time_range",
      "end_time must follow start_time",
    );
  }
  const amount0 = unsigned(input.amount0, 128, "amount0");
  const amount1 = unsigned(input.amount1, 128, "amount1");
  if (amount0 === 0n && amount1 === 0n) {
    throw new ServiceError(
      "invalid_amounts",
      "At least one boost amount must be positive",
    );
  }
  const duration = endTime - startTime;
  const rate0 = (amount0 << 32n) / duration;
  const rate1 = (amount1 << 32n) / duration;
  assertFits(rate0, 112, "rate0");
  assertFits(rate1, 112, "rate1");
  const data = encodeFunctionData({
    abi: MANUAL_BOOSTER_ABI,
    functionName: "boost",
    args: [poolKey, startTime, endTime, rate0, rate1],
  });
  const nativeValue = poolKey.token0 === NATIVE_TOKEN ? amount0 : 0n;
  const approvals = [
    ...(poolKey.token0 === NATIVE_TOKEN || amount0 === 0n
      ? []
      : [
          erc20ApprovalTransaction(
            input.chainId,
            poolKey.token0,
            MANUAL_POOL_BOOSTER_V3,
            amount0,
          ),
        ]),
    ...(poolKey.token1 === NATIVE_TOKEN || amount1 === 0n
      ? []
      : [
          erc20ApprovalTransaction(
            input.chainId,
            poolKey.token1,
            MANUAL_POOL_BOOSTER_V3,
            amount1,
          ),
        ]),
  ];
  const transaction = preparedTransaction(
    input.chainId,
    MANUAL_POOL_BOOSTER_V3,
    data,
    nativeValue,
  );

  return preparedUiAction({
    action: "ekubo_manual_pool_boost",
    chainId: input.chainId,
    sender,
    request: {
      chain_id: input.chainId,
      sender,
      pool_key: poolKey,
      start_time: startTime.toString(),
      end_time: endTime.toString(),
      amount0: amount0.toString(),
      amount1: amount1.toString(),
    },
    approvals,
    transaction,
    details: {
      duration_seconds: duration.toString(),
      rate_scale: "Q32 token base units per second",
      native_value: nativeValue.toString(),
    },
  });
}

export function prepareExecuteTwammVirtualOrders(input: {
  chainId: string;
  sender: string;
  poolKey: ExactPoolKeyInput;
}) {
  const sender = getAddress(input.sender);
  const poolKey = normalizeExactPoolKey(input.poolKey);
  const extension = getAddress(`0x${poolKey.config.slice(2, 42)}`);
  if (extension !== TWAMM_V3 && extension !== OLD_TWAMM_V3) {
    throw new ServiceError(
      "invalid_extension",
      "The pool extension is not a supported current or legacy TWAMM extension",
    );
  }
  const data = encodeFunctionData({
    abi: TWAMM_ABI,
    functionName: "lockAndExecuteVirtualOrders",
    args: [poolKey],
  });
  const transaction = preparedTransaction(input.chainId, extension, data, 0n);

  return preparedUiAction({
    action: "ekubo_execute_twamm_virtual_orders",
    chainId: input.chainId,
    sender,
    request: { chain_id: input.chainId, sender, pool_key: poolKey },
    transaction,
    details: {
      permissionless_maintenance: true,
      twamm_extension: extension,
    },
  });
}

export function prepareApprovalRevocations(input: {
  chainId: string;
  sender: string;
  approvals: { token: string; spender: string }[];
}) {
  const sender = getAddress(input.sender);
  if (input.approvals.length === 0) {
    throw new ServiceError(
      "invalid_approvals",
      "At least one token and spender pair is required",
    );
  }
  if (input.approvals.length > 200) {
    throw new ServiceError(
      "too_many_approvals",
      "At most 200 approvals can be revoked in one plan",
    );
  }
  const unique = new Map<string, { token: Address; spender: Address }>();
  for (const item of input.approvals) {
    const token = getAddress(item.token);
    const spender = getAddress(item.spender);
    if (token === NATIVE_TOKEN) {
      throw new ServiceError(
        "invalid_token",
        "Native tokens do not have ERC-20 allowances",
      );
    }
    unique.set(`${token.toLowerCase()}:${spender.toLowerCase()}`, {
      token,
      spender,
    });
  }
  const revocations = [...unique.values()];
  const transactions = revocations.map(({ token, spender }) =>
    preparedTransaction(
      input.chainId,
      token,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, 0n],
      }),
      0n,
    ),
  );
  const steps = transactions.map((transaction): ExecutionPlanStepInput => ({
    kind: "execution",
    transaction,
  }));

  return preparedUiAction({
    action: "ekubo_revoke_erc20_approvals",
    chainId: input.chainId,
    sender,
    request: {
      chain_id: input.chainId,
      sender,
      approvals: revocations,
    },
    steps,
    details: {
      transaction_count: transactions.length,
      exact_ordered_transaction_list: transactions,
      cross_chain_batches_are_not_combined: true,
    },
  });
}

export function prepareOldGekuboUnwrap(input: {
  chainId: string;
  sender: string;
  amount: string;
}) {
  if (input.chainId !== "1") {
    throw new ServiceError(
      "unsupported_chain",
      "Old gEKUBO unwrapping is available only on Ethereum mainnet",
    );
  }
  const sender = getAddress(input.sender);
  const amount = positiveUnsigned(input.amount, 127, "amount");
  if (amount > MAX_INT128) {
    throw new ServiceError("invalid_amount", "amount must fit positive int128");
  }
  const amountByteSize = size(numberToHex(amount));
  const data = concatHex([
    numberToHex(0, { size: 1 }),
    numberToHex(amountByteSize, { size: 1 }),
    numberToHex(0, { size: 1 }),
    numberToHex(OLD_GEKUBO_TOKEN_INDEX, { size: 1 }),
    numberToHex(EKUBO_TOKEN_INDEX, { size: 1 }),
    numberToHex(0, { size: 1 }),
    numberToHex(0, { size: 1 }),
    numberToHex(0, { size: 1 }),
    numberToHex(amount, { size: amountByteSize }),
    "0x00",
    "0x0501",
  ]);
  const approvalTransaction = erc20ApprovalTransaction(
    input.chainId,
    OLD_GEKUBO_TOKEN,
    HYPER_ROUTER_V2_MAINNET,
    amount,
  );
  const transaction = preparedTransaction(
    input.chainId,
    HYPER_ROUTER_V2_MAINNET,
    data,
    0n,
  );

  return preparedUiAction({
    action: "ekubo_unwrap_old_gekubo",
    chainId: input.chainId,
    sender,
    request: {
      chain_id: input.chainId,
      sender,
      amount: amount.toString(),
    },
    approvals: [approvalTransaction],
    transaction,
    atomicBatchRequired: true,
    details: {
      requires_atomic_batch_wallet_in_interface: true,
      exact_router_calldata: data,
    },
  });
}

export function preparedUiAction(input: PreparedUiActionInput) {
  if ((input.steps === undefined) === (input.transaction === undefined)) {
    throw new Error(
      "internal UI action plan error: provide either steps or one transaction",
    );
  }
  // `steps` is the whole plan, so approvals and cleanups have to be in it.
  // Accepting them alongside would silently drop them from the plan — an
  // approval that never executes turns into a revert at signing time.
  if (
    input.steps !== undefined &&
    ((input.approvals?.length ?? 0) > 0 ||
      (input.postExecutionTransactions?.length ?? 0) > 0)
  ) {
    throw new Error(
      "internal UI action plan error: fold approvals and cleanups into steps",
    );
  }
  const approvals = input.approvals ?? [];
  const postExecutionTransactions = input.postExecutionTransactions ?? [];
  const plan = input.steps
    ? executionPlanFromSteps({
        chainId: input.chainId,
        sender: input.sender,
        steps: input.steps,
        atomicBatchRequired: input.atomicBatchRequired,
      })
    : executionPlan({
        chainId: input.chainId,
        sender: input.sender,
        approvals,
        transaction: input.transaction as PreparedTransaction,
        postExecutionTransactions,
        atomicBatchRequired: input.atomicBatchRequired,
      });
  const exactTransactions = plan.ordered_steps.map((step) => step.transaction);
  const identity = {
    action: input.action,
    request: input.request,
    transactions: exactTransactions.map(({ chain_id, to, data, value }) => ({
      chain_id,
      to,
      data,
      value,
    })),
  };
  return {
    schema_version: "1",
    action: input.action,
    plan_id: keccak256(stringToHex(JSON.stringify(identity))),
    execution_plan_ready: true,
    agent_confirmation_required: false,
    wallet_validation_required: true,
    request: input.request,
    ...(input.details === undefined ? {} : { details: input.details }),
    execution_plan: plan,
    onchain_validation: {
      ...(input.onchainValidation ?? {}),
      exact_transaction_simulation_required: true,
    },
    wallet_handoff: {
      instruction:
        "Pass the complete plan to the wallet's simulation and authorization flow. Do not ask for separate agent-level confirmation; the wallet presents the simulated result and collects authorization or signature.",
      complete_transaction_list:
        "execution_plan is the complete ordered transaction list for this action.",
      calldata_complete:
        "All calldata and transaction ordering are supplied. Pass the execution_plan_reference envelope unchanged as the wallet's reference argument; do not reconstruct calldata or add calls with setup-specific tools.",
    },
  };
}

export function preparedTransaction(
  chainId: string,
  to: Address,
  data: Hex,
  value: bigint,
): PreparedTransaction {
  return { chain_id: chainId, to, data, value: value.toString() };
}

export function erc20ApprovalTransaction(
  chainId: string,
  token: Address,
  spender: Address,
  amount: bigint,
): PreparedTransaction {
  return preparedTransaction(
    chainId,
    token,
    encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
    }),
    0n,
  );
}

export function normalizeExactPoolKey(input: ExactPoolKeyInput) {
  const token0 = getAddress(input.token0);
  const token1 = getAddress(input.token1);
  if (BigInt(token0) >= BigInt(token1)) {
    throw new ServiceError(
      "invalid_pool_key",
      "pool_key token0 must be numerically less than token1",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.config)) {
    throw new ServiceError(
      "invalid_pool_key",
      "pool_key config must be bytes32",
    );
  }
  return { token0, token1, config: input.config } as const;
}

function unsigned(value: string, bits: number, label: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ServiceError(
      "invalid_integer",
      `${label} must be a decimal integer`,
    );
  }
  const parsed = BigInt(value);
  assertFits(parsed, bits, label);
  return parsed;
}

function positiveUnsigned(value: string, bits: number, label: string): bigint {
  const parsed = unsigned(value, bits, label);
  if (parsed === 0n) {
    throw new ServiceError("invalid_integer", `${label} must be positive`);
  }
  return parsed;
}

function assertFits(value: bigint, bits: number, label: string) {
  if (value < 0n || value >= 1n << BigInt(bits)) {
    throw new ServiceError("integer_overflow", `${label} must fit uint${bits}`);
  }
}

export const UI_ACTION_ADDRESSES = {
  native_token: NATIVE_TOKEN,
  weth_mainnet: WRAPPED_NATIVE_BY_CHAIN["1"]!.address,
  oracle_v3: ORACLE_V3,
  twamm_v3: TWAMM_V3,
  old_twamm_v3: OLD_TWAMM_V3,
  manual_pool_booster_v3: MANUAL_POOL_BOOSTER_V3,
  old_gekubo_token: OLD_GEKUBO_TOKEN,
  ekubo_token: EKUBO_TOKEN,
  hyper_router_v2_mainnet: HYPER_ROUTER_V2_MAINNET,
} as const;

export { transactionIdentity };
