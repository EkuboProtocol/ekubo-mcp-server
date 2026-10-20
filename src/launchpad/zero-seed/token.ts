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

const namespace = (account: Address, salt: Hex) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [account, salt]));

/**
 * The two salt namespaces: the periphery passes keccak256(abi.encode(owner, userSalt)) to the extension, which
 * deploys the token at CREATE2 salt keccak256(abi.encode(controller, thatSalt)); the controller is the periphery.
 */
export function launchSalts(owner: Address, controller: Address, userSalt: Hex) {
  const ownerSalt = namespace(owner, userSalt);
  return { ownerSalt, tokenSalt: namespace(controller, ownerSalt) };
}

/** The launch token an owner's create through this periphery deploys. */
export function predictLaunchToken(instance: { extension: Address; periphery: Address }, owner: Address, parameters: {
  name: string; symbol: string; decimals: number; salt: string;
}): Address {
  const { tokenSalt } = launchSalts(owner, instance.periphery, parameters.salt as Hex);
  return getContractAddress({
    opcode: "CREATE2", from: instance.extension, salt: tokenSalt, bytecodeHash: tokenInitCodeHash(instance.extension, parameters),
  }).toLowerCase() as Address;
}
