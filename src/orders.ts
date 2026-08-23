import {
  calculateEvmTwammMaxSaleRate,
  deriveEvmTwammOrderTokenId,
  encodeEvmTwammOrderConfig,
} from "@ekubo/sdk";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import {
  errorResultDecodePlan,
  functionReadCall,
  readCallsBundle,
} from "./abi-decode.js";
import { ServiceError } from "./core.js";
import {
  erc20ApprovalTransaction,
  preparedTransaction,
  preparedUiAction,
} from "./ui-actions.js";

const NATIVE_TOKEN = getAddress("0x0000000000000000000000000000000000000000");
const ORDERS_V2 = getAddress("0xae1430e3e089794beacba260657fcd0f0967c18a");
const OLD_ORDERS_V3 = getAddress("0xfF6cF0Ca6d7a30a60539AcD4bB20B3df84EA0644");
const ORDERS_V3 = getAddress("0x3325428adB409c239E88ca472F50b0efe00E98B4");

const ORDERS_ABI = parseAbi([
  "function mint(bytes32 salt) payable returns (uint256 id)",
  "function mintAndIncreaseSellAmount((address token0,address token1,bytes32 config) orderKey,uint112 amount,uint112 maxSaleRate) payable returns (uint256 id,uint112 saleRate)",
  "function increaseSellAmount(uint256 id,(address token0,address token1,bytes32 config) orderKey,uint128 amount,uint112 maxSaleRate) payable returns (uint112 saleRate)",
  "function collectProceeds(uint256 id,(address token0,address token1,bytes32 config) orderKey) payable returns (uint128 proceeds)",
  "function decreaseSaleRate(uint256 id,(address token0,address token1,bytes32 config) orderKey,uint112 saleRateDecrease) payable returns (uint112 refund)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function ownerOf(uint256 id) view returns (address owner)",
]);

// Without these a TWAMM revert reaches the caller as a bare four-byte selector
// and "execution reverted", which says nothing about which precondition failed.
// From ITWAMM plus the sale-rate errors in math/twamm.sol.
const TWAMM_ERRORS_ABI = parseAbi([
  "error TimeNumOrdersOverflow()",
  "error FullRangePoolOnly()",
  "error OrderAlreadyEnded()",
  "error InvalidTimestamps()",
  "error MaxSaleRateDeltaPerTime()",
  "error PoolNotInitialized()",
  "error SaleRateOverflow()",
  "error SaleRateDeltaOverflow()",
]);

/**
 * The step size a TWAMM start or end time must be a multiple of, mirroring
 * `computeStepSize` in evm-contracts math/time.sol: 256 seconds near the
 * current time, then growing in powers of 16 as the gap widens.
 */
function twammStepSize(currentTime: bigint, time: bigint): bigint {
  if (time <= currentTime + 4095n) {
    return 256n;
  }
  const diff = time - currentTime;
  let msb = BigInt(diff.toString(2).length - 1);
  msb -= msb % 4n;
  return 1n << msb;
}

/**
 * Reject a start or end time the TWAMM extension will reject, rather than
 * shipping a plan that is a guaranteed InvalidTimestamps revert. This is pure
 * arithmetic over values the caller already supplied, so there is no reason to
 * spend a transaction finding out.
 */
function assertValidTwammTime(
  currentTime: bigint,
  time: bigint,
  label: string,
): void {
  const stepSize = twammStepSize(currentTime, time);
  if (time % stepSize !== 0n) {
    throw new ServiceError(
      "invalid_order_time",
      `${label} must be a multiple of ${stepSize} seconds at this distance from pending_timestamp; ${time} is not. The nearest valid times are ${(time / stepSize) * stepSize} and ${((time / stepSize) + 1n) * stepSize}.`,
    );
  }
  if (time >= currentTime && time - currentTime >= 1n << 32n) {
    throw new ServiceError(
      "invalid_order_time",
      `${label} is more than 2^32 seconds past pending_timestamp`,
    );
  }
}

export interface OrderSplitInput {
  fee: string;
  startTime: string;
  endTime: string;
  amount: string;
}

export function prepareTwammOrder(input: {
  chainId: string;
  sender: string;
  sellToken: string;
  buyToken: string;
  orders: OrderSplitInput[];
  pendingTimestamp: string;
  deadlineSeconds?: number;
  salt?: Hex;
}) {
  const sender = getAddress(input.sender);
  const sellToken = getAddress(input.sellToken);
  const buyToken = getAddress(input.buyToken);
  if (sellToken === buyToken) {
    throw new ServiceError(
      "invalid_pair",
      "sell_token and buy_token must differ",
    );
  }
  if (input.orders.length === 0 || input.orders.length > 100) {
    throw new ServiceError(
      "invalid_orders",
      "Provide between 1 and 100 TWAMM order splits",
    );
  }
  const pendingTimestamp = unsigned(
    input.pendingTimestamp,
    64,
    "pending_timestamp",
  );
  const deadlineSeconds = input.deadlineSeconds ?? 120;
  if (
    !Number.isInteger(deadlineSeconds) ||
    deadlineSeconds < 0 ||
    deadlineSeconds > 3_600
  ) {
    throw new ServiceError(
      "invalid_deadline",
      "deadline_seconds must be an integer from 0 through 3600",
    );
  }
  const [token0, token1] =
    BigInt(sellToken) < BigInt(buyToken)
      ? [sellToken, buyToken]
      : [buyToken, sellToken];
  const isSellingToken1 = sellToken === token1;
  const parsedOrders = input.orders.map((order, index) => {
    const fee = unsigned(order.fee, 64, `orders[${index}].fee`);
    const startTime = unsigned(
      order.startTime,
      64,
      `orders[${index}].start_time`,
    );
    const endTime = unsigned(order.endTime, 64, `orders[${index}].end_time`);
    const amount = positiveUnsigned(
      order.amount,
      128,
      `orders[${index}].amount`,
    );
    if (endTime <= startTime) {
      throw new ServiceError(
        "invalid_order_time",
        `orders[${index}] must end after its start`,
      );
    }
    if (endTime <= pendingTimestamp) {
      throw new ServiceError(
        "invalid_order_time",
        `orders[${index}].end_time has already passed at pending_timestamp; the extension reverts with OrderAlreadyEnded`,
      );
    }
    assertValidTwammTime(
      pendingTimestamp,
      startTime,
      `orders[${index}].start_time`,
    );
    assertValidTwammTime(pendingTimestamp, endTime, `orders[${index}].end_time`);
    let maxSaleRate: bigint;
    try {
      maxSaleRate = calculateEvmTwammMaxSaleRate({
        amount,
        startTime,
        endTime,
        pendingTimestamp,
        deadlineSeconds: BigInt(deadlineSeconds),
      });
    } catch (error) {
      throw new ServiceError(
        "invalid_max_sale_rate",
        error instanceof Error ? error.message : String(error),
      );
    }
    const orderKey = {
      token0,
      token1,
      config: encodeEvmTwammOrderConfig({
        fee,
        isSellingToken1,
        startTime,
        endTime,
      }),
    } as const;
    return { fee, startTime, endTime, amount, maxSaleRate, orderKey };
  });
  const totalAmount = parsedOrders.reduce(
    (total, order) => total + order.amount,
    0n,
  );
  assertFits(totalAmount, 128, "total_amount");

  if (input.salt !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(input.salt)) {
    throw new ServiceError("invalid_salt", "salt must be a bytes32 value");
  }
  // Every order is minted against a salt, including a single one. The salt-free
  // `mint()` derives its own from prevrandao() and gas(), so the id it returns
  // in a simulation is never the id that gets minted on chain -- and once the
  // receipt is out of reach there is no way back to the order, because every
  // downstream TWAMM tool is keyed by token_id and nothing here enumerates
  // orders by owner. `mintAndIncreaseSellAmount` only exists in the salt-free
  // form, so a deterministic id costs one extra call.
  const salt = input.salt ?? defaultOrderSalt(sender, input.chainId, parsedOrders);
  const tokenId = deriveEvmTwammOrderTokenId(
    {
      minter: sender,
      salt,
      chainId: BigInt(input.chainId),
      contract: ORDERS_V3,
    },
    keccak256,
  );
  // The native value each call carries when the sell token is the native one.
  // A multicall let one msg.value cover every inner call; as separate steps
  // each call funds its own order, and the total is unchanged.
  const calls: Hex[] = [
    encodeFunctionData({
      abi: ORDERS_ABI,
      functionName: "mint",
      args: [salt],
    }),
    ...parsedOrders.map((order) =>
      encodeFunctionData({
        abi: ORDERS_ABI,
        functionName: "increaseSellAmount",
        args: [tokenId, order.orderKey, order.amount, order.maxSaleRate],
      }),
    ),
  ];
  const callValues: bigint[] = [
    0n,
    ...parsedOrders.map((order) => order.amount),
  ];
  const nativeValue = sellToken === NATIVE_TOKEN ? totalAmount : 0n;
  // One step per call so the wallet decodes each, with each order funding
  // itself instead of one msg.value covering an opaque payload.
  const transactions = calls.map((call, index) =>
    preparedTransaction(
      input.chainId,
      ORDERS_V3,
      call,
      sellToken === NATIVE_TOKEN ? callValues[index] : 0n,
    ),
  );
  const approvals =
    sellToken === NATIVE_TOKEN
      ? []
      : [
          erc20ApprovalTransaction(
            input.chainId,
            sellToken,
            ORDERS_V3,
            totalAmount,
          ),
        ];

  return preparedUiAction({
    action: "ekubo_create_twamm_order",
    chainId: input.chainId,
    sender,
    request: {
      chain_id: input.chainId,
      sender,
      sell_token: sellToken,
      buy_token: buyToken,
      pending_timestamp: pendingTimestamp.toString(),
      deadline_seconds: deadlineSeconds,
      salt,
      salt_source: input.salt === undefined ? "derived" : "caller",
      orders: parsedOrders.map(serializeOrder),
    },
    steps: [
      ...approvals.map((transaction) => ({
        kind: "approval" as const,
        transaction,
      })),
      ...transactions.map((transaction) => ({
        kind: "execution" as const,
        transaction,
        revertDecode: errorResultDecodePlan(TWAMM_ERRORS_ABI),
      })),
    ],
    atomicBatchRequired: approvals.length + transactions.length > 1,
    details: {
      orders_manager: ORDERS_V3,
      token_id: tokenId.toString(),
      token_id_is_deterministic:
        "This is saltToId(sender, salt) and is the id that will be minted. Keep it: prepare_twamm_order_collection and prepare_twamm_order_stop are keyed by it, and nothing in this catalog enumerates orders by owner.",
      total_sell_amount: totalAmount.toString(),
      native_value: nativeValue.toString(),
      complete_atomic_manager_multicall: calls.length > 1,
    },
  });
}

export function prepareTwammOrderCollection(input: {
  chainId: string;
  sender: string;
  ordersAddress: string;
  tokenId: string;
  orderKeys: { token0: string; token1: string; config: Hex }[];
}) {
  return prepareExistingOrderAction({ ...input, mode: "collect" });
}

export function prepareTwammOrderStop(input: {
  chainId: string;
  sender: string;
  ordersAddress: string;
  tokenId: string;
  pendingTimestamp: string;
  orders: {
    orderKey: { token0: string; token1: string; config: Hex };
    endTime: string;
    saleRate: string;
  }[];
}) {
  return prepareExistingOrderAction({ ...input, mode: "stop" });
}

function prepareExistingOrderAction(
  input:
    | {
        mode: "collect";
        chainId: string;
        sender: string;
        ordersAddress: string;
        tokenId: string;
        orderKeys: { token0: string; token1: string; config: Hex }[];
      }
    | {
        mode: "stop";
        chainId: string;
        sender: string;
        ordersAddress: string;
        tokenId: string;
        pendingTimestamp: string;
        orders: {
          orderKey: { token0: string; token1: string; config: Hex };
          endTime: string;
          saleRate: string;
        }[];
      },
) {
  const sender = getAddress(input.sender);
  const ordersAddress = getAddress(input.ordersAddress);
  if (![ORDERS_V2, OLD_ORDERS_V3, ORDERS_V3].includes(ordersAddress)) {
    throw new ServiceError(
      "unsupported_orders_manager",
      "orders_address is not a manager used by the current EVM interface",
    );
  }
  const tokenId = unsigned(input.tokenId, 256, "token_id");
  const rawOrders =
    input.mode === "collect"
      ? input.orderKeys.map((orderKey) => ({ orderKey }))
      : input.orders;
  if (rawOrders.length === 0 || rawOrders.length > 100) {
    throw new ServiceError(
      "invalid_orders",
      "Provide between 1 and 100 order keys",
    );
  }
  const orders = rawOrders.map((order, index) => ({
    ...order,
    orderKey: normalizeOrderKey(order.orderKey, `orders[${index}].order_key`),
  }));
  const calls: Hex[] = orders.map(({ orderKey }) =>
    encodeFunctionData({
      abi: ORDERS_ABI,
      functionName: "collectProceeds",
      args: [tokenId, orderKey],
    }),
  );
  if (input.mode === "stop") {
    const pendingTimestamp = unsigned(
      input.pendingTimestamp,
      64,
      "pending_timestamp",
    );
    input.orders.forEach((order, index) => {
      const endTime = unsigned(order.endTime, 64, `orders[${index}].end_time`);
      const saleRate = unsigned(
        order.saleRate,
        112,
        `orders[${index}].sale_rate`,
      );
      if (endTime <= pendingTimestamp || saleRate === 0n) return;
      const orderKey = orders[index].orderKey;
      calls.push(
        encodeFunctionData({
          abi: ORDERS_ABI,
          functionName: "decreaseSaleRate",
          args: [tokenId, orderKey, saleRate],
        }),
      );
    });
  }
  // One step per call: an opaque `bytes[]` payload collapses the batch into a
  // single allowlisted target the wallet cannot decode, and the atomic batch
  // keeps the separate steps all-or-nothing.
  const transactions = calls.map((call) =>
    preparedTransaction(input.chainId, ordersAddress, call, 0n),
  );
  const ownerRead = encodeFunctionData({
    abi: ORDERS_ABI,
    functionName: "ownerOf",
    args: [tokenId],
  });

  return preparedUiAction({
    action:
      input.mode === "collect"
        ? "ekubo_collect_twamm_order_proceeds"
        : "ekubo_stop_twamm_order",
    chainId: input.chainId,
    sender,
    request: {
      chain_id: input.chainId,
      sender,
      orders_address: ordersAddress,
      token_id: tokenId.toString(),
      mode: input.mode,
    },
    steps: transactions.map((transaction) => ({
      kind: "execution" as const,
      transaction,
    })),
    atomicBatchRequired: transactions.length > 1,
    details: {
      manager_version: ordersAddress === ORDERS_V2 ? "v2" : "v3",
      collects_every_order_first: true,
      decreases_only_pending_nonzero_sale_rates: input.mode === "stop",
    },
    onchainValidation: {
      owner: {
        decode_as: "address",
        read_calls: readCallsBundle({
          chainId: input.chainId,
          calls: [
            functionReadCall({
              id: `ekubo-twamm-order-owner-${tokenId}`,
              to: ordersAddress,
              data: ownerRead,
              abi: ORDERS_ABI,
              functionName: "ownerOf",
            }),
          ],
        }),
        expected: sender,
      },
    },
  });
}

function normalizeOrderKey(
  input: { token0: string; token1: string; config: Hex },
  label: string,
) {
  const token0 = getAddress(input.token0);
  const token1 = getAddress(input.token1);
  if (BigInt(token0) >= BigInt(token1)) {
    throw new ServiceError(
      "invalid_order_key",
      `${label} tokens are not sorted`,
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.config)) {
    throw new ServiceError(
      "invalid_order_key",
      `${label} config must be bytes32`,
    );
  }
  return { token0, token1, config: input.config } as const;
}

function serializeOrder(order: {
  fee: bigint;
  startTime: bigint;
  endTime: bigint;
  amount: bigint;
  maxSaleRate: bigint;
  orderKey: { token0: Address; token1: Address; config: Hex };
}) {
  return {
    fee: order.fee.toString(),
    start_time: order.startTime.toString(),
    end_time: order.endTime.toString(),
    amount: order.amount.toString(),
    max_sale_rate: order.maxSaleRate.toString(),
    order_key: order.orderKey,
  };
}

function unsigned(value: string, bits: number, label: string) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ServiceError("invalid_integer", `${label} must be decimal`);
  }
  const parsed = BigInt(value);
  assertFits(parsed, bits, label);
  return parsed;
}

function positiveUnsigned(value: string, bits: number, label: string) {
  const parsed = unsigned(value, bits, label);
  if (parsed === 0n) {
    throw new ServiceError("invalid_integer", `${label} must be positive`);
  }
  return parsed;
}

/**
 * A salt for callers that did not choose one, derived from the request itself
 * so the same order always resolves to the same id. That makes a retry
 * detectable -- the second attempt derives an id that already exists rather
 * than silently minting a second order -- which is the property the salt-free
 * `mint()` cannot offer at all. Callers who want independent ids for identical
 * orders pass their own salt.
 */
function defaultOrderSalt(
  sender: Address,
  chainId: string,
  orders: { orderKey: { config: Hex }; amount: bigint }[],
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32[]" },
        { type: "uint256[]" },
      ],
      [
        "ekubo.twamm.order.salt.v1",
        sender,
        BigInt(chainId),
        orders.map((order) => order.orderKey.config),
        orders.map((order) => order.amount),
      ],
    ),
  );
}

function assertFits(value: bigint, bits: number, label: string) {
  if (value < 0n || value >= 1n << BigInt(bits)) {
    throw new ServiceError("integer_overflow", `${label} must fit uint${bits}`);
  }
}

export const ORDER_MANAGER_ADDRESSES = {
  v2: ORDERS_V2,
  old_v3: OLD_ORDERS_V3,
  v3: ORDERS_V3,
} as const;
