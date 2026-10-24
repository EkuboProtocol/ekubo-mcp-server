import { describe, expect, test } from "bun:test";
import { type Address, zeroAddress } from "viem";
import {
  launchQuote, LIVE_REVIEWED_ERC20_QUOTES, LOCAL_INSTANCE_PINS, LOCAL_REVIEWED_ERC20_QUOTES, NATIVE_QUOTE, refuseExecutableUse,
  supportedInstances, unsigned, validateClaimRecipient, validateCreationTiming, validateMetadata, verifyQuoteRuntime, wellFormedPin,
} from "../../src/launchpad/zero-seed/policy.js";

const timing = { buildTime: 1800000000n, tradingStart: 1800000300n, executionExpiry: 1800000300n };

describe("frozen zero-seed constraints (not executable acceptance)", () => {
  test("all support is disabled outside the explicit local harness", () => {
    expect(supportedInstances(LOCAL_INSTANCE_PINS, false)).toEqual([]);
    expect(supportedInstances([], true)).toEqual([]);
    expect(supportedInstances(LOCAL_INSTANCE_PINS, true)).toEqual(LOCAL_INSTANCE_PINS);
  });

  for (const key of Object.keys(LOCAL_INSTANCE_PINS[0]) as (keyof typeof LOCAL_INSTANCE_PINS[0])[]) {
    test(`missing/mismatched ${key} pin disables support`, () => {
      expect(supportedInstances([{ ...LOCAL_INSTANCE_PINS[0], [key]: "wrong" }], true)).toEqual([]);
    });
  }

  test("an extra or missing pin field disables support, including the earlier quote fields", () => {
    const [pin] = LOCAL_INSTANCE_PINS;
    expect(supportedInstances([{ ...pin, address: pin.extension } as never], true)).toEqual([]);
    const { deploymentBlock: _, ...missing } = pin;
    expect(supportedInstances([missing as never], true)).toEqual([]);
    for (const extra of [{ quote: NATIVE_QUOTE }, { quoteKind: "native" }, { quoteRuntime: null }]) {
      expect(supportedInstances([{ ...pin, ...extra } as never], true)).toEqual([]);
    }
  });

  test("one instance pin serves every quote; identity rules: distinct contracts, call-points byte", () => {
    const [pin] = LOCAL_INSTANCE_PINS;
    expect(LOCAL_INSTANCE_PINS).toHaveLength(1);
    expect(wellFormedPin(pin)).toBe(true);
    expect(Object.keys(pin).sort()).toEqual(["chainId", "core", "deploymentBlock", "extension", "extensionAbiSha256",
      "extensionRuntime", "periphery", "peripheryAbiSha256", "peripheryRuntime"]);
    for (const bad of [
      { ...pin, periphery: pin.extension }, { ...pin, periphery: pin.core }, { ...pin, extension: pin.core },
      { ...pin, extension: `0x52${pin.extension.slice(4)}` }, { ...pin, periphery: NATIVE_QUOTE }, { ...pin, chainId: "0" },
      { ...pin, extensionAbiSha256: pin.peripheryAbiSha256 }, { ...pin, deploymentBlock: "02" }, { ...pin, deploymentBlock: "-1" },
    ]) expect(wellFormedPin(bad as never)).toBe(false);
  });

  test("quote support: native always; an ERC-20 only from the reviewed list, which is empty on live chains", () => {
    expect(LIVE_REVIEWED_ERC20_QUOTES).toEqual([]);
    expect(Object.isFrozen(LIVE_REVIEWED_ERC20_QUOTES)).toBe(true);
    expect(LOCAL_REVIEWED_ERC20_QUOTES).toEqual([{ chainId: "31337", address: "0xffffffffffffffffffffffffffffffffffffffff",
      runtime: "0xe8ccd7c4eb891208d5e04a27a31dfaf2b9bce01e083d7b36f10b6dd6ea643e63" }]);
    for (const local of [true, false]) {
      expect(launchQuote("31337", NATIVE_QUOTE, local)).toEqual({ kind: "native", address: NATIVE_QUOTE, runtime: null });
      expect(launchQuote("8453", NATIVE_QUOTE, local).kind).toBe("native");
    }
    const [reviewed] = LOCAL_REVIEWED_ERC20_QUOTES;
    expect(launchQuote("31337", reviewed.address, true)).toEqual({ kind: "erc20", address: reviewed.address, runtime: reviewed.runtime });
    expect(() => launchQuote("31337", reviewed.address, false)).toThrow("unsupported_quote");
    expect(() => launchQuote("8453", reviewed.address, true)).toThrow("unsupported_quote");
    for (const quote of ["0x4200000000000000000000000000000000000006", "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF", "0x00", ""]) {
      expect(() => launchQuote("31337", quote, true)).toThrow("unsupported_quote");
    }
    const erc20 = launchQuote("31337", reviewed.address, true);
    expect(() => verifyQuoteRuntime(erc20, reviewed.runtime)).not.toThrow();
    expect(() => verifyQuoteRuntime(erc20, `0x${"00".repeat(32)}`)).toThrow("unsupported_quote");
    expect(() => verifyQuoteRuntime(launchQuote("31337", NATIVE_QUOTE, true), null)).not.toThrow();
  });

  test("returned pins cannot be mutated after screening", () => {
    const pins = supportedInstances(LOCAL_INSTANCE_PINS, true);
    expect(Object.isFrozen(pins[0])).toBe(true);
  });

  test("minimum/maximum start and expiry-at-start are inclusive", () => {
    expect(() => validateCreationTiming(timing, timing.buildTime)).not.toThrow();
    expect(() => validateCreationTiming({ ...timing, tradingStart: timing.buildTime + 86400n }, timing.buildTime)).not.toThrow();
    expect(() => validateCreationTiming({ ...timing, executionExpiry: timing.buildTime + 1n }, timing.buildTime)).not.toThrow();
  });

  for (const delta of [0n, 299n, 86401n]) {
    test(`start delta ${delta} refuses without rewriting`, () => {
      const input = { ...timing, tradingStart: timing.buildTime + delta };
      expect(() => validateCreationTiming(input, timing.buildTime)).toThrow("invalid_trading_start");
      expect(input.tradingStart).toBe(timing.buildTime + delta);
    });
  }

  test("expiry is after build, no later than start, and refused at fresh expiry", () => {
    expect(() => validateCreationTiming({ ...timing, executionExpiry: timing.buildTime }, timing.buildTime)).toThrow("invalid_execution_expiry");
    expect(() => validateCreationTiming({ ...timing, executionExpiry: timing.tradingStart + 1n }, timing.buildTime)).toThrow("invalid_execution_expiry");
    expect(() => validateCreationTiming(timing, timing.executionExpiry)).toThrow("expired_or_future_plan");
    expect(() => validateCreationTiming(timing, timing.buildTime - 1n)).toThrow("expired_or_future_plan");
  });

  test("unsigned domains and checked upper-bound addition reject overflow", () => {
    const maximum = (1n << 64n) - 1n;
    expect(() => unsigned(-1n, 64)).toThrow("unsigned_domain");
    expect(() => unsigned(maximum + 1n, 64)).toThrow("unsigned_domain");
    expect(() => validateCreationTiming({ buildTime: maximum - 300n, tradingStart: maximum, executionExpiry: maximum }, maximum - 300n)).toThrow("unsigned_domain");
  });

  test("metadata uses 31 UTF-8 bytes, not character count", () => {
    expect(() => validateMetadata("x".repeat(31))).not.toThrow();
    expect(() => validateMetadata("x".repeat(32))).toThrow("metadata_too_long");
    expect(() => validateMetadata("é".repeat(15) + "x")).not.toThrow();
    expect(() => validateMetadata("é".repeat(16))).toThrow("metadata_too_long");
    expect(() => validateMetadata("😀".repeat(8))).toThrow("metadata_too_long");
  });

  test("claim sink set is exactly zero/Core/extension/periphery/token0/token1", () => {
    const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
    const sinks = { core: address("1"), extension: address("2"), periphery: address("6"), token0: address("3"), token1: address("4") };
    for (const recipient of [zeroAddress, ...Object.values(sinks)]) {
      expect(() => validateClaimRecipient(recipient, sinks)).toThrow("invalid_recipient");
    }
    expect(() => validateClaimRecipient(address("5"), sinks)).not.toThrow();
  });

  test("sinks with checksum letters are refused in any casing", () => {
    const pin = LOCAL_INSTANCE_PINS[0];
    const sinks = { core: pin.core as Address, extension: pin.extension as Address, periphery: pin.periphery as Address,
      token0: NATIVE_QUOTE as Address, token1: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Address };
    for (const recipient of Object.values(sinks)) {
      expect(() => validateClaimRecipient(recipient, sinks)).toThrow("invalid_recipient");
      expect(() => validateClaimRecipient(recipient.toUpperCase().replace("0X", "0x") as Address, sinks)).toThrow("invalid_recipient");
    }
  });

  test("uncalibrated quote estimate cannot authorize executable use", () => {
    expect(refuseExecutableUse).toThrow("executable_budget_not_proven");
  });
});
