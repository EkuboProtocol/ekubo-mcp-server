import {
  CHAIN_TO_ADDRESSES_MAP,
  V2_FACTORY_ADDRESSES,
  V2_ROUTER_ADDRESSES,
  WETH9,
} from "@uniswap/sdk-core";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { ServiceError } from "../core.js";
import {
  erc20ApprovalTransaction,
  preparedTransaction,
  preparedUiAction,
} from "../ui-actions.js";

export const chainNames = {
  "1": "ETHEREUM",
  "10": "OPTIMISM",
  "8453": "BASE",
  "42161": "ARBITRUM",
  "130": "UNICHAIN",
} as const;
export const chainSchema = z.enum(["1", "10", "8453", "42161", "130"]);
export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => getAddress(value));
export const uintSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(78);
export const bytesSchema = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/)
  .max(16386);
export const actionSchema = z.object({
  chain_id: chainSchema,
  sender: addressSchema,
  deadline: uintSchema,
});
export type Action = z.infer<typeof actionSchema>;
export const tokensSchema = { token0: addressSchema, token1: addressSchema };
export const amountsSchema = {
  amount0: uintSchema,
  amount1: uintSchema,
  amount0_min: uintSchema,
  amount1_min: uintSchema,
};
export const ticksSchema = {
  tick_lower: z.number().int().min(-887272).max(887272),
  tick_upper: z.number().int().min(-887272).max(887272),
  tick_spacing: z.number().int().min(1).max(32767),
};

export function deployment(chain: string) {
  const chainId = chainSchema.parse(chain);
  const id = Number(chainId) as keyof typeof CHAIN_TO_ADDRESSES_MAP;
  const addresses = CHAIN_TO_ADDRESSES_MAP[id];
  return {
    chain_id: chainId,
    network: chainNames[chainId],
    v2_factory: getAddress(V2_FACTORY_ADDRESSES[id]),
    v2_router: getAddress(V2_ROUTER_ADDRESSES[id]),
    v3_factory: getAddress(addresses.v3CoreFactoryAddress),
    v3_position_manager: getAddress(
      addresses.nonfungiblePositionManagerAddress!,
    ),
    v4_pool_manager: getAddress(addresses.v4PoolManagerAddress!),
    v4_position_manager: getAddress(addresses.v4PositionManagerAddress!),
    v4_state_view: getAddress(addresses.v4StateView!),
    wrapped_native: getAddress(WETH9[id].address),
    permit2: getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
  };
}
export function getUniswapDeployments() {
  return {
    protocol: "uniswap",
    deployments: Object.keys(chainNames).map(deployment),
    source: "@uniswap/sdk-core@7.19.2",
    interface_source:
      "https://github.com/Uniswap/interface/tree/da6d36f71c4d2fd665b0aae1a052a4ffda917b31",
    native_currency:
      "V2/V3 use wrapped_native plus use_native; V4 uses the zero address as currency0",
    v2_fees:
      "Fees accrue in LP reserves and are realized by removing liquidity; there is no separate claim.",
  };
}
export function uint(value: string, bits = 256): bigint {
  const n = BigInt(uintSchema.parse(value));
  if (n >= 1n << BigInt(bits))
    throw new ServiceError(
      "invalid_uniswap_amount",
      `Amount exceeds uint${bits}`,
    );
  return n;
}
export function positive(value: string, bits = 256) {
  const n = uint(value, bits);
  if (!n)
    throw new ServiceError("invalid_uniswap_amount", "Amount must be positive");
  return n;
}
export function deadline(input: Action) {
  const n = uint(input.deadline, 48);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (n <= now || n > now + 86400n)
    throw new ServiceError(
      "invalid_uniswap_deadline",
      "Deadline must be in the future and within 24 hours",
    );
  return n;
}
export function pair(token0: Address, token1: Address, native = false) {
  if (BigInt(token0) >= BigInt(token1))
    throw new ServiceError(
      "invalid_uniswap_pair",
      "token0 must be numerically less than token1",
    );
  if (!native && token0 === zeroAddress)
    throw new ServiceError(
      "invalid_uniswap_pair",
      "V2/V3 require ERC20 addresses, including wrapped native",
    );
}
export function ticks(input: {
  tick_lower: number;
  tick_upper: number;
  tick_spacing: number;
}) {
  if (
    input.tick_lower >= input.tick_upper ||
    input.tick_lower % input.tick_spacing ||
    input.tick_upper % input.tick_spacing
  )
    throw new ServiceError(
      "invalid_uniswap_ticks",
      "Ticks must be ordered and multiples of tick_spacing",
    );
}
export function amounts(input: {
  amount0: string;
  amount1: string;
  amount0_min: string;
  amount1_min: string;
}) {
  const a0 = uint(input.amount0),
    a1 = uint(input.amount1),
    m0 = uint(input.amount0_min),
    m1 = uint(input.amount1_min);
  if (a0 + a1 === 0n || m0 > a0 || m1 > a1)
    throw new ServiceError(
      "invalid_uniswap_amount",
      "Amounts must be nonzero in total and minima cannot exceed desired amounts",
    );
  return [a0, a1, m0, m1] as const;
}
export function plan(
  input: Action,
  action: string,
  to: Address,
  data: Hex,
  value = 0n,
  spending: readonly { token: Address; amount: bigint }[] = [],
) {
  const tokens = spending.filter(
    (s) => s.amount > 0n && s.token !== zeroAddress,
  );
  return preparedUiAction({
    action,
    chainId: input.chain_id,
    sender: input.sender,
    request: input,
    transaction: preparedTransaction(input.chain_id, to, data, value),
    approvals: tokens.map((s) =>
      erc20ApprovalTransaction(input.chain_id, s.token, to, s.amount),
    ),
    postExecutionTransactions: tokens.map((s) =>
      erc20ApprovalTransaction(input.chain_id, s.token, to, 0n),
    ),
    atomicBatchRequired: tokens.length > 0,
    details: {
      protocol: "uniswap",
      deadline: input.deadline,
      live_state_queried: false,
      simulation_required: true,
    },
  });
}
