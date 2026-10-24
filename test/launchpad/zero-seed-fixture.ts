// Preview wallet shared by zero-seed tests. It replays the local anvil chain of the tick_rate_v2 instance the harness
// recorded (script/zero-seed-local-chain.ts at evm-contracts 3d6378f); it is never a provider or connected wallet.
// The fixed_base_duration_v1 chain (evm-contracts 43d6628) is kept as recorded for read-only replay.
import { expect } from "bun:test";
import { type Address, decodeFunctionData, encodeFunctionResult, type Hex, keccak256, stringToHex } from "viem";
import { storeArtifact } from "../../src/artifact-store.js";
import type { Env } from "../../src/core.js";
import { peripheryAbi, PREVIEW_SELECTOR } from "../../src/launchpad/zero-seed/abi.js";
import { type BuildInput, type ParametersInput } from "../../src/launchpad/zero-seed/installation.js";
import { LOCAL_INSTANCE_PINS, NATIVE_QUOTE, type InstancePin } from "../../src/launchpad/zero-seed/policy.js";
import { localInstallationPreview, PREVIEW_ID, type SyntheticPreviewWallet } from "../../src/launchpad/zero-seed/preview.js";
import { predictLaunchToken } from "../../src/launchpad/zero-seed/token.js";
import v1Chain from "../fixtures/launchpad/zero-seed-native-local-chain.json";
import chain from "../fixtures/launchpad/zero-seed-tick-rate-local-chain.json";

export { chain, v1Chain };
export const owner = chain.accounts.owner as Address;
export const pin = LOCAL_INSTANCE_PINS.find((entry) => entry.feeModel === "tick_rate_v2")!;
export const v1Pin = LOCAL_INSTANCE_PINS.find((entry) => entry.feeModel === "fixed_base_duration_v1")!;
export const ERC20_QUOTE = chain.erc20_quote.address;
/** The two recorded launches of the one instance: native ETH (launch token1) and the test ERC-20 (launch token0). */
export const KINDS = ["native", "erc20"] as const;
export type Kind = (typeof KINDS)[number];
type Launch = typeof chain.launches.native;
export const launchOf = (kind: Kind = "native"): Launch => chain.launches[kind] as unknown as Launch;
export const quoteOf = (kind: Kind) => (kind === "native" ? NATIVE_QUOTE : ERC20_QUOTE);
export const build = (kind: Kind = "native"): BuildInput => ({ ...launchOf(kind).build });
export const request = (kind: Kind = "native"): ParametersInput => ({ ...launchOf(kind).request });
export const freshTime = (kind: Kind = "native") => BigInt(launchOf(kind).build.buildTime) + 1n;

interface Installation {
  token: Address; poolKey: { token0: Address; token1: Address; config: Hex }; positionId: Hex; initialTick: number;
  liquidity: bigint; installedSupply: bigint;
}
function installationFor(kind: Kind): Installation {
  const i = launchOf(kind).preview.installation;
  return {
    token: i.token as Address, poolKey: { token0: i.poolKey.token0 as Address, token1: i.poolKey.token1 as Address,
      config: i.poolKey.config as Hex }, positionId: i.positionId as Hex, initialTick: i.initialTick,
    liquidity: BigInt(i.liquidity), installedSupply: BigInt(i.installedSupply),
  };
}

/** The recorded installation for another token address: the pair keeps the quote and swaps in the token. */
function withToken(installation: Installation, token: Address): Installation {
  const swap = (side: Address) => (side === installation.token ? token : side);
  return { ...installation, token, poolKey: { ...installation.poolKey, token0: swap(installation.poolKey.token0),
    token1: swap(installation.poolKey.token1) } };
}

export function fixture(kind: Kind = "native") {
  const recorded = launchOf(kind);
  const installation = installationFor(kind);
  let raw: Hex | undefined;
  let override: Installation | undefined;
  let calls = 0;
  let stores = 0;
  let ids = [PREVIEW_ID];
  let success = true;
  let blockHash = recorded.build.blockHash;
  let now = freshTime(kind);
  let afterRead: (() => void) | undefined;
  const storage = new Map<string, string>();
  const env = { ARTIFACT_STORE: { put: async (key: string, body: string) => { storage.set(key, body); } } } as unknown as Env;
  const wallet: SyntheticPreviewWallet = {
    async storeRead(body) {
      stores++;
      expect(body.calls).toHaveLength(1);
      expect(body.block_parameter).toBe(`0x${BigInt(recorded.build.blockNumber).toString(16)}`);
      expect(body.from).toBe(owner);
      expect(body.calls[0].to).toBe(pin.periphery);
      expect(body.calls[0].data.slice(0, 10)).toBe(PREVIEW_SELECTOR);
      return storeArtifact(env, "https://synthetic.invalid", { artifactType: "read_calls", body });
    },
    async read(reference) {
      calls++;
      expect(reference.artifact_type).toBe("read_calls");
      const body = storage.get(new URL(reference.url).pathname.slice(1))!;
      expect(new TextEncoder().encode(body).length).toBe(reference.bytes);
      expect(keccak256(stringToHex(body))).toBe(reference.integrity.value);
      const stored = JSON.parse(body);
      const decoded = decodeFunctionData({ abi: peripheryAbi, data: stored.calls[0].data });
      expect(decoded.functionName).toBe("previewInstallation");
      if (decoded.functionName !== "previewInstallation") throw new Error("unexpected read");
      expect(decoded.args[0].toLowerCase()).toBe(owner);
      afterRead?.();
      // Like the contract, the token follows owner/periphery/salt/metadata; the amounts stay the recorded ones.
      const token = predictLaunchToken({ extension: pin.extension as Address, periphery: pin.periphery as Address }, owner, decoded.args[1]);
      const data = raw ?? encodeFunctionResult({ abi: peripheryAbi, functionName: "previewInstallation",
        result: override ?? withToken(installation, token) });
      return { chainId: pin.chainId, blockNumber: recorded.build.blockNumber, blockHash, blockTime: recorded.build.blockTime,
        results: ids.map((id) => ({ id, success, data })) };
    },
  };
  return {
    run: (input = request(kind), context = build(kind), instance: InstancePin = pin) => localInstallationPreview({ owner,
      request: input, build: context, pin: instance }, wallet, () => now),
    setRaw: (value: Hex) => { raw = value; }, setIds: (value: string[]) => { ids = value; },
    setFailed: () => { success = false; }, setHash: () => { blockHash = `0x${"cd".repeat(32)}`; },
    setTime: (value: bigint) => { now = value; },
    afterRead: (action: () => void) => { afterRead = action; },
    setInstallation: (value: Installation) => { override = value; },
    counts: () => ({ calls, stores }), installation, pin, kind, recorded,
    raw: recorded.preview.raw as Hex,
  };
}
