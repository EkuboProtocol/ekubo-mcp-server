// Synthetic local preview wallet shared by zero-seed tests; never a provider or connected wallet.
import { expect } from "bun:test";
import { type Address, decodeFunctionData, encodeFunctionResult, type Hex, keccak256, numberToHex, stringToHex } from "viem";
import { storeArtifact } from "../../src/artifact-store.js";
import type { Env } from "../../src/core.js";
import { zeroSeedAbi } from "../../src/launchpad/zero-seed/abi.js";
import { type BuildInput, type ParametersInput } from "../../src/launchpad/zero-seed/installation.js";
import { LOCAL_INSTANCE_PINS, type InstancePin } from "../../src/launchpad/zero-seed/policy.js";
import { localInstallationPreview, PREVIEW_ID, type SyntheticPreviewWallet } from "../../src/launchpad/zero-seed/preview.js";
import { predictLaunchToken } from "../../src/launchpad/zero-seed/token.js";

// Actual fixture creator/metadata/salt and the installed pair the draft b1cbb1c
// contract's previewInstallation returned for l1 (token0) and l3 (token1) in the
// regenerated local chain. Timing here is synthetic boundary context.
export const creator = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as Address;
export const build: BuildInput = {
  buildTime: "1000", executionExpiry: "1299", blockTime: "1000", blockNumber: "42", blockHash: `0x${"ab".repeat(32)}`,
};
const label = (pin: InstancePin) => (pin.address === LOCAL_INSTANCE_PINS[0].address ? "l1" : "l3");
export const CAPTURED = {
  l1: { token: "0x4845fa093a3bf10b31a943a81e230aac5d201ff7", liquidity: 1111119116089565312897934n, installedSupply: 999999999999999999999999210n },
  l3: { token: "0xd0fd0e218e2a98d1ce1bae8bf49d5d80d0b956b6", liquidity: 1111119116089565312898036n, installedSupply: 999999999999999999999999422n },
} as const;
export const request = (pin: InstancePin): ParametersInput => ({
  quoteToken: pin.quote, name: `Zero Seed ${label(pin)}`, symbol: label(pin).toUpperCase(), decimals: 18,
  supply: "1000000000000000000000000000", liquidity: "0", askTick: -13815500, upperTick: -9210300,
  tickSpacing: 100, tradingStart: "1300", feeDuration: 3600, initialFee: "922337203685477580",
  finalFee: "55340232221128654", decayFactor: "18425445863997925462", salt: `0x${"00".repeat(31)}01`,
});

function installationFor(pin: InstancePin, token: Address, captured: { liquidity: bigint; installedSupply: bigint }) {
  const tokenIs0 = BigInt(token) < BigInt(pin.quote);
  const [lower, upper] = tokenIs0 ? [-13815500, -9210300] : [9210300, 13815500];
  return {
    token, poolKey: {
      token0: (tokenIs0 ? token : pin.quote) as Address, token1: (tokenIs0 ? pin.quote : token) as Address,
      config: numberToHex((BigInt(pin.address) << 96n) | 0x80000064n, { size: 32 }),
    },
    positionId: numberToHex((BigInt.asUintN(32, BigInt(lower)) << 32n) | BigInt.asUintN(32, BigInt(upper)), { size: 32 }),
    initialTick: tokenIs0 ? lower : upper, liquidity: captured.liquidity, installedSupply: captured.installedSupply,
  };
}

export function fixture(pin = LOCAL_INSTANCE_PINS[0]) {
  const captured = CAPTURED[label(pin)];
  const installation = installationFor(pin, captured.token as Address, captured);
  let raw: Hex | undefined;
  let override: typeof installation | undefined;
  let calls = 0;
  let stores = 0;
  let ids = [PREVIEW_ID];
  let success = true;
  let blockHash = build.blockHash;
  let now = 1000n;
  let afterRead: (() => void) | undefined;
  const storage = new Map<string, string>();
  const env = { ARTIFACT_STORE: { put: async (key: string, body: string) => { storage.set(key, body); } } } as unknown as Env;
  const wallet: SyntheticPreviewWallet = {
    async storeRead(body) {
      stores++;
      expect(body.calls).toHaveLength(1);
      expect(body.block_parameter).toBe("0x2a");
      expect(body.from).toBe(creator);
      expect(body.calls[0].data.slice(0, 10)).toBe("0x5283ac38");
      return storeArtifact(env, "https://synthetic.invalid", { artifactType: "read_calls", body });
    },
    async read(reference) {
      calls++;
      expect(reference.artifact_type).toBe("read_calls");
      const body = storage.get(new URL(reference.url).pathname.slice(1))!;
      expect(new TextEncoder().encode(body).length).toBe(reference.bytes);
      expect(keccak256(stringToHex(body))).toBe(reference.integrity.value);
      const stored = JSON.parse(body);
      const decoded = decodeFunctionData({ abi: zeroSeedAbi, data: stored.calls[0].data });
      expect(decoded.functionName).toBe("previewInstallation");
      if (decoded.functionName === "previewInstallation") expect(decoded.args[0].toLowerCase()).toBe(creator);
      afterRead?.();
      // Like the contract, the token follows creator/salt/metadata; supply/L stay the captured pair.
      const params = decoded.functionName === "previewInstallation" ? decoded.args[1] : undefined;
      const token = predictLaunchToken(pin.address as Address, creator, params!);
      const data = raw ?? encodeFunctionResult({ abi: zeroSeedAbi, functionName: "previewInstallation",
        result: override ?? installationFor(pin, token, captured) });
      return { chainId: pin.chainId, blockNumber: build.blockNumber, blockHash, blockTime: build.blockTime,
        results: ids.map((id) => ({ id, success, data })) };
    },
  };
  return {
    run: (input = request(pin), context = build, instance = pin) => localInstallationPreview({ creator, request: input,
      build: context, pin: instance }, wallet, () => now),
    setRaw: (value: Hex) => { raw = value; }, setIds: (value: string[]) => { ids = value; },
    setFailed: () => { success = false; }, setHash: () => { blockHash = `0x${"cd".repeat(32)}`; },
    setTime: (value: bigint) => { now = value; },
    afterRead: (action: () => void) => { afterRead = action; },
    setInstallation: (value: typeof installation) => { override = value; },
    counts: () => ({ calls, stores }), installation, pin,
    raw: encodeFunctionResult({ abi: zeroSeedAbi, functionName: "previewInstallation", result: installation }),
  };
}
