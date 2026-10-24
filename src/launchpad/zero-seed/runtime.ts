import { type Hex, hexToBytes, keccak256 } from "viem";
import type { FeeModel } from "./abi.js";
import { ZeroSeedError } from "./policy.js";

/**
 * Compiler output of each fee model's revision (evm-contracts 43d6628 and 3d6378f; solc 0.8.33, via-IR, 9,999,999
 * runs, osaka): the runtime with every
 * immutable zeroed, its length, and where each immutable is embedded (compiler immutableReferences). A deployed
 * instance is accepted only when its code is this template with exactly the expected words at those offsets: a
 * template hash alone says nothing about which Core or extension an instance is bound to. The extension has no
 * quote immutable: each launch names its own quote.
 */
interface RuntimeTemplate {
  templateKeccak256: Hex;
  length: number;
  immutables: readonly { role: string; offsets: readonly number[] }[];
}

const EXTENSION_RUNTIME_V1: RuntimeTemplate = Object.freeze({
  templateKeccak256: "0x19d7461a57e0058bd09c848684152a234b4b3909404c1c85dbf6e69b9d59c925",
  length: 20402,
  immutables: Object.freeze([
    { role: "core", offsets: [846, 6169, 7310, 9005] },
    { role: "accountant", offsets: [2418] },
  ]),
});

const PERIPHERY_RUNTIME_V1: RuntimeTemplate = Object.freeze({
  templateKeccak256: "0x76db610aa6d183253d966ff21d2c59f750028b9ad83c0e4cc0d362324740e2e7",
  length: 5552,
  immutables: Object.freeze([
    { role: "core", offsets: [1399, 4401] },
    { role: "launch", offsets: [311, 1335, 2015, 4346] },
    { role: "accountant", offsets: [2121, 4640, 5261] },
  ]),
});

const EXTENSION_RUNTIME_V2: RuntimeTemplate = Object.freeze({
  templateKeccak256: "0xae9245361f958f479a4ff1a85ca242f6adf3ae21b3e1f3696317368ba8c47c3b",
  length: 19694,
  immutables: Object.freeze([
    { role: "core", offsets: [1317, 6078, 7176, 8949] },
    { role: "accountant", offsets: [2375] },
  ]),
});

const PERIPHERY_RUNTIME_V2: RuntimeTemplate = Object.freeze({
  templateKeccak256: "0x1fa935c3de39691b912dd3db3ef84d7e66cc0e54dddef3740aeb1d453e6ad3f8",
  length: 5534,
  immutables: Object.freeze([
    { role: "core", offsets: [1745, 4377] },
    { role: "launch", offsets: [667, 1681, 2015, 4322] },
    { role: "accountant", offsets: [2121, 4616, 5183] },
  ]),
});

export const EXTENSION_RUNTIME: Readonly<Record<FeeModel, RuntimeTemplate>> =
  Object.freeze({ fixed_base_duration_v1: EXTENSION_RUNTIME_V1, tick_rate_v2: EXTENSION_RUNTIME_V2 });
export const PERIPHERY_RUNTIME: Readonly<Record<FeeModel, RuntimeTemplate>> =
  Object.freeze({ fixed_base_duration_v1: PERIPHERY_RUNTIME_V1, tick_rate_v2: PERIPHERY_RUNTIME_V2 });

function word(address: string): Uint8Array {
  return hexToBytes(`0x${address.slice(2).toLowerCase().padStart(64, "0")}` as Hex);
}

/** Checks deployed code against its template and expected immutables; returns the code's keccak256. */
function verify(code: Hex, template: RuntimeTemplate, values: Readonly<Record<string, string>>, label: string): Hex {
  const bytes = hexToBytes(code);
  if (bytes.length !== template.length) throw new ZeroSeedError(`${label}_runtime_mismatch`);
  const zeroed = bytes.slice();
  for (const { role, offsets } of template.immutables) {
    const expected = word(values[role]);
    for (const offset of offsets) {
      const actual = bytes.subarray(offset, offset + 32);
      if (actual.some((byte, i) => byte !== expected[i])) throw new ZeroSeedError(`${label}_immutable_mismatch`);
      zeroed.fill(0, offset, offset + 32);
    }
  }
  if (keccak256(zeroed) !== template.templateKeccak256) throw new ZeroSeedError(`${label}_runtime_mismatch`);
  return keccak256(bytes);
}

/** Extension runtime of the fee model's revision, bound to Core (core and accountant). */
export function verifyExtensionRuntime(code: Hex, identity: { core: string; feeModel: FeeModel }): Hex {
  return verify(code, EXTENSION_RUNTIME[identity.feeModel], { core: identity.core, accountant: identity.core }, "extension");
}

/** Periphery runtime of the fee model's revision, bound to Core (core and accountant) and its one extension. */
export function verifyPeripheryRuntime(code: Hex, identity: { core: string; extension: string; feeModel: FeeModel }): Hex {
  return verify(code, PERIPHERY_RUNTIME[identity.feeModel],
    { core: identity.core, accountant: identity.core, launch: identity.extension }, "periphery");
}
