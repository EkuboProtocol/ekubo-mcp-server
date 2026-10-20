import { describe, expect, test } from "bun:test";
import { type Address, getContractAddress, type Hex, keccak256, toEventSelector, toFunctionSelector, zeroAddress } from "viem";
import { CLAIM_SELECTOR, CREATE_SELECTOR, CREATE_SIGNATURE, extensionAbi, LAUNCH_OWNER_SELECTOR, peripheryAbi,
  PREVIEW_SELECTOR, TRANSFER_SELECTOR } from "../../src/launchpad/zero-seed/abi.js";
import { poolIdOf } from "../../src/launchpad/zero-seed/owner.js";
import { LOCAL_INSTANCE_PINS, NATIVE_QUOTE, samePin } from "../../src/launchpad/zero-seed/policy.js";
import { EXTENSION_RUNTIME, PERIPHERY_RUNTIME, verifyExtensionRuntime, verifyPeripheryRuntime } from "../../src/launchpad/zero-seed/runtime.js";
import iface from "../fixtures/launchpad/zero-seed-interface-4f1a306.json";
import { chain } from "./zero-seed-fixture.js";

const deployed = chain.deployed as Record<"native" | "erc20", typeof chain.deployed.native>;
const flip = (code: string, offset: number) => {
  const at = 2 + offset * 2 + 62;
  return `${code.slice(0, at)}${code[at] === "f" ? "e" : "f"}${code.slice(at + 1)}` as Hex;
};

describe("interface manifest of evm-contracts 4f1a306", () => {
  test("selectors, topics and errors used here equal the manifest", () => {
    const periphery = iface.abi.ZeroSeedLaunchPeriphery;
    const extension = iface.abi.ZeroSeedLaunch;
    expect(toFunctionSelector(CREATE_SIGNATURE)).toBe(CREATE_SELECTOR);
    expect(periphery.functions[CREATE_SIGNATURE as keyof typeof periphery.functions]).toBe(CREATE_SELECTOR);
    const fn = (abi: readonly unknown[], name: string) => toFunctionSelector((abi as never[]).find((e: { type: string; name: string }) =>
      e.type === "function" && e.name === name)!);
    expect(fn(peripheryAbi, "create")).toBe(CREATE_SELECTOR);
    expect(fn(peripheryAbi, "previewInstallation")).toBe(PREVIEW_SELECTOR);
    expect(fn(peripheryAbi, "claimFees")).toBe(CLAIM_SELECTOR);
    expect(fn(peripheryAbi, "transferLaunch")).toBe(TRANSFER_SELECTOR);
    expect(fn(peripheryAbi, "launchOwner")).toBe(LAUNCH_OWNER_SELECTOR);
    expect(Object.values(periphery.functions)).toEqual(expect.arrayContaining([PREVIEW_SELECTOR, CLAIM_SELECTOR, TRANSFER_SELECTOR,
      LAUNCH_OWNER_SELECTOR]));
    const events = { ...periphery.events, ...extension.events } as Record<string, string>;
    for (const entry of [...peripheryAbi, ...extensionAbi]) {
      if (entry.type !== "event") continue;
      const topic = toEventSelector(entry);
      expect(Object.values(events) as string[]).toContain(topic as string);
    }
    const errors = periphery.errors as Record<string, string>;
    for (const name of ["OwnerOnly()", "InvalidOwner()", "InvalidRecipient()"]) {
      expect(toFunctionSelector(`function ${name}`) as string).toBe(errors[name]);
    }
    expect(iface.structs.LaunchParameters).not.toContain("quoteToken");
    expect(iface.structs.LaunchParameters).not.toContain("decayFactor");
  });

  test("runtime templates and immutable offsets equal the compiler output", () => {
    const art = iface.artifacts;
    expect(EXTENSION_RUNTIME.templateKeccak256).toBe(art.ZeroSeedLaunch.runtime_template_keccak256_immutables_zero as Hex);
    expect(PERIPHERY_RUNTIME.templateKeccak256).toBe(art.ZeroSeedLaunchPeriphery.runtime_template_keccak256_immutables_zero as Hex);
    expect(EXTENSION_RUNTIME.length).toBe(art.ZeroSeedLaunch.runtime_length);
    expect(PERIPHERY_RUNTIME.length).toBe(art.ZeroSeedLaunchPeriphery.runtime_length);
    const offsets = (refs: Record<string, { start: number }[]>) => Object.values(refs).map((r) => r.map((x) => x.start)).sort();
    expect(EXTENSION_RUNTIME.immutables.map((i) => [...i.offsets]).sort())
      .toEqual(offsets(art.ZeroSeedLaunch.immutable_references));
    expect(PERIPHERY_RUNTIME.immutables.map((i) => [...i.offsets]).sort())
      .toEqual(offsets(art.ZeroSeedLaunchPeriphery.immutable_references));
  });
});

describe("launcher-deployed local instances", () => {
  for (const pin of LOCAL_INSTANCE_PINS) {
    const d = deployed[pin.quoteKind];
    test(`${pin.quoteKind}: pins equal the deployment, its runtimes and its immutables`, () => {
      expect(chain.pins.some((recorded) => samePin(recorded as never, pin))).toBe(true);
      expect(verifyExtensionRuntime(d.extension_code as Hex, pin)).toBe(pin.extensionRuntime as Hex);
      expect(verifyPeripheryRuntime(d.periphery_code as Hex, pin)).toBe(pin.peripheryRuntime as Hex);
      const extension = getContractAddress({ opcode: "CREATE2", from: d.create2_deployer as Address, salt: d.extension_salt as Hex,
        bytecodeHash: d.extension_init_code_keccak256 as Hex });
      expect(extension.toLowerCase()).toBe(pin.extension);
      expect(pin.extension.slice(0, 4)).toBe("0x51");
      expect(pin.quote === NATIVE_QUOTE).toBe(pin.quoteKind === "native");
    });

    test(`${pin.quoteKind}: a template-equal runtime bound to another Core, quote or extension refuses`, () => {
      const other = LOCAL_INSTANCE_PINS.find((p) => p !== pin)!;
      expect(() => verifyExtensionRuntime(d.extension_code as Hex, { core: pin.core, quote: other.quote })).toThrow("extension_immutable_mismatch");
      expect(() => verifyExtensionRuntime(d.extension_code as Hex, { core: pin.extension, quote: pin.quote })).toThrow("extension_immutable_mismatch");
      expect(() => verifyPeripheryRuntime(d.periphery_code as Hex, { core: pin.core, extension: other.extension })).toThrow("periphery_immutable_mismatch");
      for (const { offsets } of EXTENSION_RUNTIME.immutables) {
        for (const offset of offsets) {
          expect(() => verifyExtensionRuntime(flip(d.extension_code, offset), pin)).toThrow("extension_immutable_mismatch");
        }
      }
      expect(() => verifyExtensionRuntime(`${d.extension_code}00` as Hex, pin)).toThrow("extension_runtime_mismatch");
      const body = flip(d.extension_code, 100);
      expect(() => verifyExtensionRuntime(body, pin)).toThrow("extension_runtime_mismatch");
      expect(() => verifyPeripheryRuntime(d.extension_code as Hex, { core: pin.core, extension: pin.extension })).toThrow("periphery_runtime_mismatch");
      // The two instances share templates and differ only in their immutables.
      expect(keccak256(d.extension_code as Hex)).not.toBe(keccak256(deployed[other.quoteKind].extension_code as Hex));
    });
  }
});

describe("ownership, claims and accounting on the local chain", () => {
  const key = chain.launches.native.preview.installation.poolKey;
  const poolId = poolIdOf(key);
  const fees = (swaps: typeof chain.swaps) => swaps.reduce((sum, swap) => {
    const e = swap.events.find((x) => x.event === "LaunchSwapped")!.args as unknown as { feeAmount: string; feeIsToken1: boolean };
    return e.feeIsToken1 ? { ...sum, t1: sum.t1 + BigInt(e.feeAmount) } : { ...sum, t0: sum.t0 + BigInt(e.feeAmount) };
  }, { t0: 0n, t1: 0n });

  test("the initial creator is the zero-to-owner event; the extension's controller is the periphery", () => {
    const events = chain.launches.native.events;
    expect(events.map((e) => `${e.source}:${e.event}`)).toEqual(["extension:LaunchCreated", "periphery:LaunchOwnerChanged"]);
    expect(events[0].args).toMatchObject({ poolId, controller: LOCAL_INSTANCE_PINS[0].periphery });
    expect(events[1].args).toEqual({ poolId, previousOwner: zeroAddress, newOwner: chain.accounts.owner });
  });

  test("a claim pays the whole ledger once: both events report the same amounts the recipient received", () => {
    const claim = chain.first_claim;
    const { t0, t1 } = fees(chain.swaps);
    const [ledger, payout] = claim.events;
    expect([ledger.source, ledger.event, payout.source, payout.event])
      .toEqual(["extension", "CreatorFeesClaimed", "periphery", "LaunchFeesClaimed"]);
    expect(ledger.args).toEqual({ poolId, controller: LOCAL_INSTANCE_PINS[0].periphery, amount0: t0.toString(), amount1: t1.toString() });
    expect(payout.args).toEqual({ poolId, owner: chain.accounts.owner, recipient: chain.accounts.recipient,
      amount0: t0.toString(), amount1: t1.toString() });
    expect(claim.deltas).toEqual({ token0: t0.toString(), token1: t1.toString() });
  });

  test("a transfer moves the claim right, including fees accrued before it; the creator stays the zero-event owner", () => {
    expect(chain.transfer.events).toEqual([{ emitter: LOCAL_INSTANCE_PINS[0].periphery, source: "periphery", event: "LaunchOwnerChanged",
      args: { poolId, previousOwner: chain.accounts.owner, newOwner: chain.accounts.new_owner } }]);
    expect(chain.after_transfer.old_owner_claim).toBe("0x596dcdb8");
    const { t0, t1 } = fees([chain.after_transfer.swap]);
    const [ledger, payout] = chain.after_transfer.claim.events;
    expect(ledger.args).toMatchObject({ amount0: t0.toString(), amount1: t1.toString() });
    expect(payout.args).toMatchObject({ owner: chain.accounts.new_owner, recipient: chain.accounts.new_owner });
    expect(chain.after_transfer.claim.owner_check.launch_owner).toBe(chain.accounts.new_owner);
    const creators = [chain.launches.native.events[1], ...chain.transfer.events]
      .filter((e) => e.event === "LaunchOwnerChanged" && e.args.previousOwner === zeroAddress);
    expect(creators.map((e) => e.args.newOwner)).toEqual([chain.accounts.owner]);
  });

  test("the chain refuses what the MCP refuses", () => {
    expect(chain.refusals).toEqual({
      claim_by_non_owner: "0x596dcdb8", claim_to_periphery: "0x9c8d2cd2", claim_to_zero: "0x9c8d2cd2",
      claim_with_value: "revert_without_data", swap_before_trading_start: "0xacf75be8",
    });
    expect(chain.launches.native.create_with_value).toBe("revert_without_data");
  });
});
