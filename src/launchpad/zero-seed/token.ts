import { type Address, concat, encodeAbiParameters, getContractAddress, type Hex, keccak256 } from "viem";
import { MINTABLE_ERC20_CREATION, MINTABLE_ERC20_CREATION_KECCAK } from "./mintable-erc20.js";
import { ZeroSeedError } from "./policy.js";

let creationChecked = false;

function creationCode(): Hex {
  if (!creationChecked) {
    if (keccak256(MINTABLE_ERC20_CREATION) !== MINTABLE_ERC20_CREATION_KECCAK) throw new ZeroSeedError("token_initcode_mismatch");
    creationChecked = true;
  }
  return MINTABLE_ERC20_CREATION;
}

/** keccak256 of the launch token's init code; metadata and decimals are part of it. */
export function tokenInitCodeHash(extension: Address, metadata: { name: string; symbol: string; decimals: number }): Hex {
  return keccak256(concat([creationCode(), encodeAbiParameters(
    [{ type: "address" }, { type: "string" }, { type: "string" }, { type: "uint8" }],
    [extension, metadata.name, metadata.symbol, metadata.decimals],
  )]));
}

/** ZeroSeedLaunch._tokenAddress: CREATE2(extension, keccak256(abi.encode(creator, salt)), init code). */
export function predictLaunchToken(extension: Address, creator: Address, parameters: {
  name: string; symbol: string; decimals: number; salt: string;
}): Address {
  const salt = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [creator, parameters.salt as Hex]));
  return getContractAddress({
    opcode: "CREATE2", from: extension, salt, bytecodeHash: tokenInitCodeHash(extension, parameters),
  }).toLowerCase() as Address;
}
