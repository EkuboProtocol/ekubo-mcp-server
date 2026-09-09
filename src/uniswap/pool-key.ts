import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  type Address,
} from "viem";
export type V4Key = {
  token0: Address;
  token1: Address;
  fee: number;
  tick_spacing: number;
  hooks: Address;
};
export function v4PoolId(input: V4Key) {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("address,address,uint24,int24,address"),
      [input.token0, input.token1, input.fee, input.tick_spacing, input.hooks],
    ),
  );
}
export function verifyV4Pool(input: V4Key & { pool_id: string }) {
  if (v4PoolId(input) !== input.pool_id.toLowerCase())
    throw new Error(
      "V4 pool_id does not match the exact pool key. Indexed display feeTier may include protocol fees; use the immutable key fee, not the displayed total fee.",
    );
}

/** PositionInfoLibrary: uint200 pool prefix, int24 upper/lower, uint8 flag. */
export function decodeV4PositionInfo(info: string) {
  if (!/^(0|[1-9][0-9]*)$/.test(info))
    throw new Error("Position info must be a decimal uint256");
  const n = BigInt(info);
  if (n >= 1n << 256n) throw new Error("Position info exceeds uint256");
  return {
    tick_lower: Number(BigInt.asIntN(24, n >> 8n)),
    tick_upper: Number(BigInt.asIntN(24, n >> 32n)),
    has_subscriber: (n & 255n) !== 0n,
    pool_id_prefix: `0x${(n >> 56n).toString(16).padStart(50, "0")}`,
    instruction:
      "The 25-byte prefix is not a complete pool ID. Derive the full ID from getPoolAndPositionInfo's complete key.",
  };
}
