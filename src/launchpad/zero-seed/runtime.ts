import { type Hex, hexToBytes, keccak256 } from "viem";
import { ZeroSeedError } from "./policy.js";

/**
 * Compiler output of evm-contracts 40af6cb (solc 0.8.33, via-IR, 9,999,999 runs, osaka): the runtime with every
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
  templateKeccak256: "0x39a99e30dfff34873b7a820416ae4bc33a337612c644c45e68c51ac6564a9f4d",
  length: 20184,
  immutables: Object.freeze([
    { role: "core", offsets: [846, 6258, 7399, 9094] },
    { role: "accountant", offsets: [2418] },
  ]),
});

export const PERIPHERY_RUNTIME: RuntimeTemplate = Object.freeze({
  templateKeccak256: "0x08216f696368b4398afb8c43ca3eff0cccdcea00e71397178b78b2b94f957dbb",
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
