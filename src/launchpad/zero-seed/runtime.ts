import { type Hex, hexToBytes, keccak256 } from "viem";
import { ZeroSeedError } from "./policy.js";

/**
 * Compiler output of evm-contracts 4f1a306 (solc 0.8.33, via-IR, 9,999,999 runs, osaka): the runtime with every
 * immutable zeroed, its length, and where each immutable is embedded (compiler immutableReferences). A deployed
 * instance is accepted only when its code is this template with exactly the expected words at those offsets: a
 * template hash alone says nothing about which Core, quote or extension an instance is bound to.
 */
interface RuntimeTemplate {
  templateKeccak256: Hex;
  length: number;
  immutables: readonly { role: string; offsets: readonly number[] }[];
}

export const EXTENSION_RUNTIME: RuntimeTemplate = Object.freeze({
  templateKeccak256: "0x25637ad2d1071b641f275d3b1037616b8836d2445501c05d38618764fa924167",
  length: 20432,
  immutables: Object.freeze([
    { role: "core", offsets: [857, 4501, 5721, 7607] },
    { role: "accountant", offsets: [2739] },
    { role: "quote", offsets: [2378, 10332] },
  ]),
});

export const PERIPHERY_RUNTIME: RuntimeTemplate = Object.freeze({
  templateKeccak256: "0x271683d2c3cf5e518fc5aa531f8568191b166a262a43e05d13325f0630dd5d7a",
  length: 5541,
  immutables: Object.freeze([
    { role: "core", offsets: [1063, 4390] },
    { role: "launch", offsets: [999, 1818, 2019, 4335] },
    { role: "accountant", offsets: [2125, 4629, 5250] },
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

/** Extension runtime bound to Core (core and accountant) and its constructor quote. */
export function verifyExtensionRuntime(code: Hex, identity: { core: string; quote: string }): Hex {
  return verify(code, EXTENSION_RUNTIME, { core: identity.core, accountant: identity.core, quote: identity.quote }, "extension");
}

/** Periphery runtime bound to Core (core and accountant) and its one extension. */
export function verifyPeripheryRuntime(code: Hex, identity: { core: string; extension: string }): Hex {
  return verify(code, PERIPHERY_RUNTIME, { core: identity.core, accountant: identity.core, launch: identity.extension }, "periphery");
}
