import { type Hex, hexToBytes, keccak256 } from "viem";
import { ZeroSeedError } from "./policy.js";

/**
 * Compiler output of evm-contracts 43d6628 (solc 0.8.33, via-IR, 9,999,999 runs, osaka): the runtime with every
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

export const EXTENSION_RUNTIME: RuntimeTemplate = Object.freeze({
  templateKeccak256: "0x19d7461a57e0058bd09c848684152a234b4b3909404c1c85dbf6e69b9d59c925",
  length: 20402,
  immutables: Object.freeze([
    { role: "core", offsets: [846, 6169, 7310, 9005] },
    { role: "accountant", offsets: [2418] },
  ]),
});

export const PERIPHERY_RUNTIME: RuntimeTemplate = Object.freeze({
  templateKeccak256: "0x76db610aa6d183253d966ff21d2c59f750028b9ad83c0e4cc0d362324740e2e7",
  length: 5552,
  immutables: Object.freeze([
    { role: "core", offsets: [1399, 4401] },
    { role: "launch", offsets: [311, 1335, 2015, 4346] },
    { role: "accountant", offsets: [2121, 4640, 5261] },
  ]),
});

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

/** Extension runtime bound to Core (core and accountant). */
export function verifyExtensionRuntime(code: Hex, identity: { core: string }): Hex {
  return verify(code, EXTENSION_RUNTIME, { core: identity.core, accountant: identity.core }, "extension");
}

/** Periphery runtime bound to Core (core and accountant) and its one extension. */
export function verifyPeripheryRuntime(code: Hex, identity: { core: string; extension: string }): Hex {
  return verify(code, PERIPHERY_RUNTIME, { core: identity.core, accountant: identity.core, launch: identity.extension }, "periphery");
}
