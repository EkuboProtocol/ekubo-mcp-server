import { v4PoolId } from "./pool-key.js";
export { v4PoolId } from "./pool-key.js";
import { encodeFunctionData, parseAbi, zeroAddress } from "viem";
import { z } from "zod";
import {
  functionReadCall,
  readCallsBundle,
  type ReadCall,
} from "../abi-decode.js";
import {
  chainSchema,
  addressSchema,
  uintSchema,
  tokensSchema,
  deployment,
  pair,
  uint,
} from "./common.js";
import { V3_ABI } from "./v3.js";
import { V4_ABI, PERMIT2_ABI } from "./v4.js";
import { v2PairAddress } from "./v2.js";
const erc20Abi = parseAbi([
  "function allowance(address owner,address spender) view returns (uint256)",
]);
export const V3_POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
  "function fee() view returns (uint24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
]);
export const V3_FACTORY_ABI = parseAbi([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
  "function feeAmountTickSpacing(uint24 fee) view returns (int24)",
]);
export const V2_PAIR_ABI = parseAbi([
  "function allowance(address owner,address spender) view returns (uint256)",
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
]);
export const V4_STATE_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
export const readsSchema = z.object({
  chain_id: chainSchema,
  version: z.enum(["v2", "v3", "v4"]),
  ...tokensSchema,
  fee: z.number().int().min(0).max(8388608).default(3000),
  tick_spacing: z.number().int().min(1).max(32767).default(60),
  hooks: addressSchema.default(zeroAddress),
  pool_address: addressSchema.optional(),
  owner: addressSchema.optional(),
  token_ids: z.array(uintSchema).max(30).default([]),
  owner_indices: z.array(uintSchema).max(30).default([]),
});
export function prepareUniswapReads(raw: z.input<typeof readsSchema>) {
  const input = readsSchema.parse(raw);
  pair(input.token0, input.token1, input.version === "v4");
  const calls = [
    ...(input.version === "v2" ? v2Reads(input) : concentratedReads(input)),
    ...allowanceReads(input),
  ];
  return {
    protocol: "uniswap",
    version: input.version,
    ...(input.version === "v4" ? { pool_id: v4PoolId(input) } : {}),
    deployment: deployment(input.chain_id),
    read_calls: readCallsBundle({
      chainId: input.chain_id,
      from: input.owner,
      calls,
    }),
    instructions:
      "Verify pool tokens, fee, factory/pool key and NFT owner against the requested position before preparing. V3 owner_indices enumerate token IDs; request positions for returned IDs. V4 NFTs are not enumerable: obtain token IDs from wallet NFT inventory or Transfer logs. Indexed pool data can lag; use these reads for current state.",
  };
}
function v2Reads(input: z.infer<typeof readsSchema>): ReadCall[] {
  const to = v2PairAddress(input.chain_id, input.token0, input.token1);
  const calls = (
    ["getReserves", "totalSupply", "token0", "token1", "factory"] as const
  ).map((functionName) =>
    functionReadCall({
      id: functionName,
      to,
      abi: V2_PAIR_ABI,
      functionName,
      data: encodeFunctionData({ abi: V2_PAIR_ABI, functionName }),
    }),
  );
  if (input.owner)
    calls.push(
      functionReadCall({
        id: "balance",
        to,
        abi: V2_PAIR_ABI,
        functionName: "balanceOf",
        data: encodeFunctionData({
          abi: V2_PAIR_ABI,
          functionName: "balanceOf",
          args: [input.owner],
        }),
      }),
    );
  if (input.owner)
    calls.push(
      functionReadCall({
        id: "lp_allowance",
        to,
        abi: V2_PAIR_ABI,
        functionName: "allowance",
        data: encodeFunctionData({
          abi: V2_PAIR_ABI,
          functionName: "allowance",
          args: [input.owner, deployment(input.chain_id).v2_router],
        }),
      }),
    );
  return calls;
}
function concentratedReads(input: z.infer<typeof readsSchema>): ReadCall[] {
  const d = deployment(input.chain_id);
  const abi = input.version === "v3" ? V3_ABI : V4_ABI;
  const to =
    input.version === "v3" ? d.v3_position_manager : d.v4_position_manager;
  const calls: ReadCall[] = input.token_ids.flatMap((id) => {
    const tokenId = uint(id);
    const ownership = functionReadCall({
      id: `owner:${id}`,
      to,
      abi,
      functionName: "ownerOf",
      data: encodeFunctionData({
        abi,
        functionName: "ownerOf",
        args: [tokenId],
      }),
    });
    return [ownership, ...positionReads(input, id)];
  });
  if (input.version === "v3")
    return [...calls, ...v3PoolReads(input), ...enumerationReads(input)];
  const poolId = v4PoolId(input);
  calls.push(
    functionReadCall({
      id: "next_token_id",
      to: d.v4_position_manager,
      abi: V4_ABI,
      functionName: "nextTokenId",
      data: encodeFunctionData({ abi: V4_ABI, functionName: "nextTokenId" }),
    }),
  );
  return [
    ...calls,
    ...(["getSlot0", "getLiquidity"] as const).map((functionName) =>
      functionReadCall({
        id: functionName,
        to: d.v4_state_view,
        abi: V4_STATE_ABI,
        functionName,
        data: encodeFunctionData({
          abi: V4_STATE_ABI,
          functionName,
          args: [poolId],
        }),
      }),
    ),
  ];
}
function positionReads(
  input: z.infer<typeof readsSchema>,
  id: string,
): ReadCall[] {
  const d = deployment(input.chain_id),
    tokenId = uint(id);
  if (input.version === "v3")
    return [
      functionReadCall({
        id: `position:${id}`,
        to: d.v3_position_manager,
        abi: V3_ABI,
        functionName: "positions",
        data: encodeFunctionData({
          abi: V3_ABI,
          functionName: "positions",
          args: [tokenId],
        }),
      }),
    ];
  return (["getPoolAndPositionInfo", "getPositionLiquidity"] as const).map(
    (functionName) =>
      functionReadCall({
        id: `${functionName}:${id}`,
        to: d.v4_position_manager,
        abi: V4_ABI,
        functionName,
        data: encodeFunctionData({
          abi: V4_ABI,
          functionName,
          args: [tokenId],
        }),
      }),
  );
}
function enumerationReads(input: z.infer<typeof readsSchema>): ReadCall[] {
  if (!input.owner) return [];
  const owner = input.owner,
    to = deployment(input.chain_id).v3_position_manager;
  return [
    functionReadCall({
      id: "nft_balance",
      to,
      abi: V3_ABI,
      functionName: "balanceOf",
      data: encodeFunctionData({
        abi: V3_ABI,
        functionName: "balanceOf",
        args: [owner],
      }),
    }),
    ...input.owner_indices.map((index) =>
      functionReadCall({
        id: `token_at:${index}`,
        to,
        abi: V3_ABI,
        functionName: "tokenOfOwnerByIndex",
        data: encodeFunctionData({
          abi: V3_ABI,
          functionName: "tokenOfOwnerByIndex",
          args: [owner, uint(index)],
        }),
      }),
    ),
  ];
}
function v3PoolReads(input: z.infer<typeof readsSchema>): ReadCall[] {
  const to = deployment(input.chain_id).v3_factory;
  const calls = [
    functionReadCall({
      id: "canonical_pool",
      to,
      abi: V3_FACTORY_ABI,
      functionName: "getPool",
      data: encodeFunctionData({
        abi: V3_FACTORY_ABI,
        functionName: "getPool",
        args: [input.token0, input.token1, input.fee],
      }),
    }),
    functionReadCall({
      id: "fee_tick_spacing",
      to,
      abi: V3_FACTORY_ABI,
      functionName: "feeAmountTickSpacing",
      data: encodeFunctionData({
        abi: V3_FACTORY_ABI,
        functionName: "feeAmountTickSpacing",
        args: [input.fee],
      }),
    }),
  ];
  if (!input.pool_address) return calls;
  const pool = input.pool_address;
  return [
    ...calls,
    ...(
      [
        "slot0",
        "liquidity",
        "tickSpacing",
        "fee",
        "token0",
        "token1",
        "factory",
      ] as const
    ).map((functionName) =>
      functionReadCall({
        id: functionName,
        to: pool,
        abi: V3_POOL_ABI,
        functionName,
        data: encodeFunctionData({ abi: V3_POOL_ABI, functionName }),
      }),
    ),
  ];
}

function allowanceReads(input: z.infer<typeof readsSchema>): ReadCall[] {
  if (!input.owner) return [];
  const owner = input.owner,
    d = deployment(input.chain_id);
  const spender = { v2: d.v2_router, v3: d.v3_position_manager, v4: d.permit2 }[
    input.version
  ];
  return [input.token0, input.token1]
    .filter((token) => token !== zeroAddress)
    .flatMap((token) => {
      const calls = [
        functionReadCall({
          id: `allowance:${token}`,
          to: token,
          abi: erc20Abi,
          functionName: "allowance",
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "allowance",
            args: [owner, spender],
          }),
        }),
      ];
      if (input.version === "v4")
        calls.push(
          functionReadCall({
            id: `permit2:${token}`,
            to: d.permit2,
            abi: PERMIT2_ABI,
            functionName: "allowance",
            data: encodeFunctionData({
              abi: PERMIT2_ABI,
              functionName: "allowance",
              args: [owner, token, d.v4_position_manager],
            }),
          }),
        );
      return calls;
    });
}
