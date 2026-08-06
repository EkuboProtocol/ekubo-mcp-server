import { deriveEvmAuctionTokenId, encodeEvmAuctionConfig } from "@ekubo/sdk";
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { functionReadCall, readCallsBundle } from "./abi-decode.js";
import { ServiceError } from "./core.js";
import {
  erc20ApprovalTransaction,
  preparedTransaction,
  preparedUiAction,
} from "./ui-actions.js";

const NATIVE_TOKEN = getAddress("0x0000000000000000000000000000000000000000");
const AUCTIONS_V3 = getAddress("0xcB4e1b5Fb7b120dB0815aFA63453C969136C0Ec9");

const AUCTIONS_ABI = parseAbi([
  "function mint(bytes32 salt) payable returns (uint256 id)",
  "function sellAmountByAuction(uint256 tokenId,(address token0,address token1,bytes32 config) auctionKey,uint128 amount) payable returns (uint112 saleRate)",
  "function maybeInitializeGraduationPool((address token0,address token1,bytes32 config) auctionKey,int32 tick) payable returns (bool initialized,uint96 sqrtRatio)",
  "function completeAuctionAndStartBoost(uint256 tokenId,(address token0,address token1,bytes32 config) auctionKey) payable returns (uint128 creatorAmount,uint128 boostAmount,uint112 boostRate,uint64 boostEndTime)",
  "function collectCreatorProceeds(uint256 tokenId,(address token0,address token1,bytes32 config) auctionKey) payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function ownerOf(uint256 id) view returns (address owner)",
]);

export function prepareAuctionCreate(input: {
  chainId: string;
  sender: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  creatorFeeQ32: string;
  minBoostDuration: number;
  graduationPoolFeeQ64: string;
  graduationPoolTickSpacing: number;
  startTime: string;
  auctionDuration: number;
  salt: Hex;
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
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.salt)) {
    throw new ServiceError("invalid_salt", "salt must be bytes32");
  }
  const sellAmount = positiveUnsigned(input.sellAmount, 128, "sell_amount");
  const creatorFee = unsigned(input.creatorFeeQ32, 32, "creator_fee_q32");
  const graduationPoolFee = unsigned(
    input.graduationPoolFeeQ64,
    64,
    "graduation_pool_fee_q64",
  );
  assertSafeUint(input.minBoostDuration, 24, "min_boost_duration");
  assertSafeUint(
    input.graduationPoolTickSpacing,
    32,
    "graduation_pool_tick_spacing",
  );
  assertSafeUint(input.auctionDuration, 32, "auction_duration");
  const startTime = unsigned(input.startTime, 64, "start_time");
  const [token0, token1] =
    BigInt(sellToken) < BigInt(buyToken)
      ? [sellToken, buyToken]
      : [buyToken, sellToken];
  const isSellingToken1 = sellToken === token1;
  const config = encodeEvmAuctionConfig({
    creatorFee: Number(creatorFee),
    isSellingToken1,
    minBoostDuration: input.minBoostDuration,
    graduationPoolFee,
    graduationPoolTickSpacing: input.graduationPoolTickSpacing,
    startTime,
    auctionDuration: input.auctionDuration,
  });
  const auctionKey = { token0, token1, config } as const;
  const tokenId = deriveEvmAuctionTokenId(
    {
      minter: sender,
      salt: input.salt,
      chainId: BigInt(input.chainId),
      contract: AUCTIONS_V3,
    },
    keccak256,
  );
  const calls = [
    encodeFunctionData({
      abi: AUCTIONS_ABI,
      functionName: "mint",
      args: [input.salt],
    }),
    encodeFunctionData({
      abi: AUCTIONS_ABI,
      functionName: "sellAmountByAuction",
      args: [tokenId, auctionKey, sellAmount],
    }),
  ];
  const nativeValue = sellToken === NATIVE_TOKEN ? sellAmount : 0n;
  // One step per call. `mint` takes no value; `sellAmountByAuction` is the
  // payable call that consumes the sell amount, so the value rides on it
  // rather than on an opaque multicall wrapper.
  const transactions = calls.map((call, index) =>
    preparedTransaction(
      input.chainId,
      AUCTIONS_V3,
      call,
      index === calls.length - 1 ? nativeValue : 0n,
    ),
  );
  const approvals =
    sellToken === NATIVE_TOKEN
      ? []
      : [
          erc20ApprovalTransaction(
            input.chainId,
            sellToken,
            AUCTIONS_V3,
            sellAmount,
          ),
        ];

  return preparedUiAction({
    action: "ekubo_create_auction",
    chainId: input.chainId,
    sender,
    request: {
      chain_id: input.chainId,
      sender,
      sell_token: sellToken,
      buy_token: buyToken,
      sell_amount: sellAmount.toString(),
      salt: input.salt,
      auction_key: auctionKey,
    },
    decodedCalls: [
      ...approvals.map((approval) => ({
        order: 1,
        function: "approve",
        target: approval.to,
        arguments: { spender: AUCTIONS_V3, amount: sellAmount.toString() },
      })),
      {
        order: approvals.length + 1,
        function: "mint",
        target: AUCTIONS_V3,
        arguments: { salt: input.salt, expected_token_id: tokenId.toString() },
      },
      {
        order: approvals.length + 2,
        function: "sellAmountByAuction",
        target: AUCTIONS_V3,
        arguments: {
          token_id: tokenId.toString(),
          auction_key: auctionKey,
          amount: sellAmount.toString(),
        },
      },
    ],
    approvals,
    steps: transactions.map((transaction) => ({
      kind: "execution" as const,
      transaction,
    })),
    atomicBatchRequired: transactions.length > 1,
    details: {
      auctions_manager: AUCTIONS_V3,
      expected_token_id: tokenId.toString(),
      auction_config: {
        config,
        creator_fee_q32: creatorFee.toString(),
        is_selling_token1: isSellingToken1,
        min_boost_duration: input.minBoostDuration,
        graduation_pool_fee_q64: graduationPoolFee.toString(),
        graduation_pool_tick_spacing: input.graduationPoolTickSpacing,
        start_time: startTime.toString(),
        auction_duration: input.auctionDuration,
        end_time: (startTime + BigInt(input.auctionDuration)).toString(),
      },
    },
  });
}

export function prepareAuctionComplete(input: {
  chainId: string;
  sender: string;
  tokenId: string;
  auctionKey: { token0: string; token1: string; config: Hex };
  graduationPoolInitialized: boolean;
  launchPoolTick?: number;
}) {
  const sender = getAddress(input.sender);
  const tokenId = unsigned(input.tokenId, 256, "token_id");
  const auctionKey = normalizeAuctionKey(input.auctionKey);
  if (!input.graduationPoolInitialized) {
    if (
      input.launchPoolTick === undefined ||
      !Number.isInteger(input.launchPoolTick) ||
      input.launchPoolTick < -2_147_483_648 ||
      input.launchPoolTick > 2_147_483_647
    ) {
      throw new ServiceError(
        "invalid_launch_tick",
        "launch_pool_tick must fit int32 when the graduation pool is uninitialized",
      );
    }
  }
  const calls = [
    ...(input.graduationPoolInitialized
      ? []
      : [
          encodeFunctionData({
            abi: AUCTIONS_ABI,
            functionName: "maybeInitializeGraduationPool",
            args: [auctionKey, input.launchPoolTick as number],
          }),
        ]),
    encodeFunctionData({
      abi: AUCTIONS_ABI,
      functionName: "completeAuctionAndStartBoost",
      args: [tokenId, auctionKey],
    }),
  ];
  // One step per call, so the wallet decodes each rather than one opaque
  // `bytes[]` payload; the atomic batch keeps them all-or-nothing.
  const transactions = calls.map((call) =>
    preparedTransaction(input.chainId, AUCTIONS_V3, call, 0n),
  );

  return preparedUiAction({
    action: "ekubo_complete_auction",
    chainId: input.chainId,
    sender,
    request: {
      chain_id: input.chainId,
      sender,
      token_id: tokenId.toString(),
      auction_key: auctionKey,
      graduation_pool_initialized: input.graduationPoolInitialized,
      launch_pool_tick: input.launchPoolTick ?? null,
    },
    decodedCalls: [
      ...(input.graduationPoolInitialized
        ? []
        : [
            {
              order: 1,
              function: "maybeInitializeGraduationPool",
              target: AUCTIONS_V3,
              arguments: {
                auction_key: auctionKey,
                tick: input.launchPoolTick,
              },
            },
          ]),
      {
        order: input.graduationPoolInitialized ? 1 : 2,
        function: "completeAuctionAndStartBoost",
        target: AUCTIONS_V3,
        arguments: { token_id: tokenId.toString(), auction_key: auctionKey },
      },
    ],
    steps: transactions.map((transaction) => ({
      kind: "execution" as const,
      transaction,
    })),
    atomicBatchRequired: transactions.length > 1,
    details: {
      permissionless_completion: true,
      initializes_graduation_pool_if_needed: !input.graduationPoolInitialized,
    },
  });
}

export function prepareAuctionCreatorProceeds(input: {
  chainId: string;
  sender: string;
  tokenId: string;
  auctionKey: { token0: string; token1: string; config: Hex };
}) {
  const sender = getAddress(input.sender);
  const tokenId = unsigned(input.tokenId, 256, "token_id");
  const auctionKey = normalizeAuctionKey(input.auctionKey);
  const data = encodeFunctionData({
    abi: AUCTIONS_ABI,
    functionName: "collectCreatorProceeds",
    args: [tokenId, auctionKey],
  });
  const transaction = preparedTransaction(input.chainId, AUCTIONS_V3, data, 0n);
  const ownerRead = encodeFunctionData({
    abi: AUCTIONS_ABI,
    functionName: "ownerOf",
    args: [tokenId],
  });

  return preparedUiAction({
    action: "ekubo_collect_auction_creator_proceeds",
    chainId: input.chainId,
    sender,
    request: {
      chain_id: input.chainId,
      sender,
      token_id: tokenId.toString(),
      auction_key: auctionKey,
    },
    decodedCalls: [
      {
        order: 1,
        function: "collectCreatorProceeds",
        target: AUCTIONS_V3,
        arguments: { token_id: tokenId.toString(), auction_key: auctionKey },
      },
    ],
    transaction,
    onchainValidation: {
      owner: {
        decode_as: "address",
        read_calls: readCallsBundle({
          chainId: input.chainId,
          calls: [
            functionReadCall({
              id: `ekubo-auction-owner-${tokenId}`,
              to: AUCTIONS_V3,
              data: ownerRead,
              abi: AUCTIONS_ABI,
              functionName: "ownerOf",
            }),
          ],
        }),
        expected: sender,
      },
    },
  });
}

function normalizeAuctionKey(input: {
  token0: string;
  token1: string;
  config: Hex;
}) {
  const token0 = getAddress(input.token0);
  const token1 = getAddress(input.token1);
  if (BigInt(token0) >= BigInt(token1)) {
    throw new ServiceError(
      "invalid_auction_key",
      "auction_key tokens are not sorted",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.config)) {
    throw new ServiceError(
      "invalid_auction_key",
      "auction_key config must be bytes32",
    );
  }
  return { token0, token1, config: input.config } as const;
}

function unsigned(value: string, bits: number, label: string) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ServiceError("invalid_integer", `${label} must be decimal`);
  }
  const parsed = BigInt(value);
  if (parsed >= 1n << BigInt(bits)) {
    throw new ServiceError("integer_overflow", `${label} must fit uint${bits}`);
  }
  return parsed;
}

function positiveUnsigned(value: string, bits: number, label: string) {
  const parsed = unsigned(value, bits, label);
  if (parsed === 0n) {
    throw new ServiceError("invalid_integer", `${label} must be positive`);
  }
  return parsed;
}

function assertSafeUint(value: number, bits: number, label: string) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    BigInt(value) >= 1n << BigInt(bits)
  ) {
    throw new ServiceError("integer_overflow", `${label} must fit uint${bits}`);
  }
}

export const AUCTIONS_V3_ADDRESS = AUCTIONS_V3;
