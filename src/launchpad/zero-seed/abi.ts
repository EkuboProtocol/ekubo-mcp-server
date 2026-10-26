import type { Abi, AbiFunction } from "viem";
import extensionJson from "./frozen/ZeroSeedLaunch.abi.json";
import peripheryJson from "./frozen/ZeroSeedLaunchPeriphery.abi.json";
import tokenJson from "./frozen/LaunchToken.abi.json";
import provenance from "./frozen/provenance.json";

// The compiled ABIs of the frozen final launch contracts, imported verbatim (see frozen/provenance.json). Nothing
// here is reconstructed from prose, and no address is attached to them: a deployment comes only from configuration.
export const extensionAbi = extensionJson as Abi;
export const peripheryAbi = peripheryJson as Abi;
export const launchTokenAbi = tokenJson as Abi;
export const CONTRACTS_COMMIT = provenance.source_commit;
export const RUNTIME_TEMPLATES = provenance.runtime_templates;

/** One function entry of a frozen ABI; throws if the frozen ABI lacks it. */
export function abiFunction(abi: Abi, name: string): AbiFunction {
  const entry = abi.find((item): item is AbiFunction => item.type === "function" && item.name === name);
  if (entry === undefined) throw new Error(`internal error: frozen ABI has no function ${name}`);
  return entry;
}

export const SELECTORS = Object.freeze({
  create: "0x9a09bd5d",
  previewInstallation: "0xd215dcb2",
  claimFees: "0x6906b4c0",
  transferLaunch: "0x8b1cb36f",
  launchOwner: "0x60ac0b66",
  feeAt: "0xe81084ec",
  getLaunch: "0x7d1d589c",
  creatorFees: "0xb4ce9a2e",
});
