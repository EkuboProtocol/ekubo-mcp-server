import { describe, expect, test } from "bun:test";
import { type Address, decodeFunctionData, encodeFunctionResult, type Hex, keccak256, numberToHex, stringToHex } from "viem";
import { storeArtifact } from "../../src/artifact-store.js";
import type { Env } from "../../src/core.js";
import { zeroSeedAbi } from "../../src/launchpad/zero-seed/abi.js";
import { abiParameters, type BuildInput, type ParametersInput } from "../../src/launchpad/zero-seed/installation.js";
import { LOCAL_INSTANCE_PINS, type InstancePin } from "../../src/launchpad/zero-seed/policy.js";
import { localInstallationPreview, PREVIEW_ID, type SyntheticPreviewWallet } from "../../src/launchpad/zero-seed/preview.js";

const creator = "0x0000000000000000000000000000000000000123" as Address;
const build: BuildInput = {
  buildTime: "1000", executionExpiry: "1299", blockTime: "1000", blockNumber: "42", blockHash: `0x${"ab".repeat(32)}`,
};
const request = (pin: InstancePin): ParametersInput => ({
  quoteToken: pin.quote, name: "Local λ", symbol: "LOC", decimals: 18,
  supply: "1000000000000000000000000000", liquidity: "0", askTick: -13815500, upperTick: -9210300,
  tickSpacing: 100, tradingStart: "1300", feeDuration: 3600, initialFee: "922337203685477580",
  finalFee: "55340232221128654", salt: `0x${"00".repeat(32)}`,
});

function fixture(pin = LOCAL_INSTANCE_PINS[0]) {
  const token = "0x1000000000000000000000000000000000000000" as Address;
  const tokenIs0 = BigInt(token) < BigInt(pin.quote);
  const [lower, upper] = tokenIs0 ? [-13815500, -9210300] : [9210300, 13815500];
  const installation = {
    token, poolKey: {
      token0: (tokenIs0 ? token : pin.quote) as Address, token1: (tokenIs0 ? pin.quote : token) as Address,
      config: numberToHex((BigInt(pin.address) << 96n) | 0x80000064n, { size: 32 }),
    },
    positionId: numberToHex((BigInt.asUintN(32, BigInt(lower)) << 32n) | BigInt.asUintN(32, BigInt(upper)), { size: 32 }),
    initialTick: tokenIs0 ? lower : upper, liquidity: 1111119116089565312897934n,
    installedSupply: 999999999999999999999999210n,
  };
  let raw = encodeFunctionResult({ abi: zeroSeedAbi, functionName: "previewInstallation", result: installation });
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
      expect(body.calls[0].data.slice(0, 10)).toBe("0xcd1632b3");
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
      if (decoded.functionName === "previewInstallation") expect(decoded.args[0]).toBe(creator);
      afterRead?.();
      return { chainId: pin.chainId, blockNumber: build.blockNumber, blockHash, blockTime: build.blockTime,
        results: ids.map((id) => ({ id, success, data: raw })) };
    },
  };
  return {
    run: (input = request(pin), context = build, instance = pin) => localInstallationPreview({ creator, request: input,
      build: context, pin: instance }, wallet, () => now),
    setRaw: (value: Hex) => { raw = value; }, setIds: (value: string[]) => { ids = value; },
    setFailed: () => { success = false; }, setHash: () => { blockHash = `0x${"cd".repeat(32)}`; },
    setTime: (value: bigint) => { now = value; },
    afterRead: (action: () => void) => { afterRead = action; },
    setInstallation: (value: typeof installation) => {
      raw = encodeFunctionResult({ abi: zeroSeedAbi, functionName: "previewInstallation", result: value });
    },
    counts: () => ({ calls, stores }), installation, raw, pin,
  };
}

describe("single synthetic installation preview (not executable evidence)", () => {
  for (const pin of LOCAL_INSTANCE_PINS) test(`bind actual pair in order ${pin.quote}`, async () => {
    const f = fixture(pin);
    const preview = await f.run();
    expect(preview.requested.supply).toBe(request(pin).supply);
    expect(preview.actual.supply).toBe(f.installation.installedSupply.toString());
    expect(preview.actual.liquidity).toBe(f.installation.liquidity.toString());
    expect(preview.actual.tradingStart).toBe("1300");
    expect(preview.creator).toBe(creator);
    expect(preview.executionGuaranteed).toBe(false);
    expect(preview.scope).toBe("synthetic-local-non-executable");
    expect(preview).not.toHaveProperty("execution_plan");
    expect(preview).not.toHaveProperty("execution_plan_reference");
    expect(f.counts()).toEqual({ calls: 1, stores: 1 });
    expect(abiParameters(preview.actual).supply).toBe(f.installation.installedSupply);
  });

  for (const key of Object.keys(LOCAL_INSTANCE_PINS[0]) as (keyof InstancePin)[]) {
    test(`refuse changed ${key} pin before reading`, async () => {
      const f = fixture();
      await expect(f.run(request(f.pin), build, { ...f.pin, [key]: "mismatch" })).rejects.toThrow("launch_support_disabled");
      expect(f.counts()).toEqual({ calls: 0, stores: 0 });
    });
  }
  test("wrong quote refuses before reading", async () => {
    const f = fixture();
    await expect(f.run({ ...request(f.pin), quoteToken: LOCAL_INSTANCE_PINS[1].quote })).rejects.toThrow("unsupported_quote");
    expect(f.counts().calls).toBe(0);
  });
  for (const ids of [["wrong"], [], [PREVIEW_ID, PREVIEW_ID], [PREVIEW_ID, "other"]]) {
    test(`match results locally by id; refuse ${JSON.stringify(ids)}`, async () => {
      const f = fixture(); f.setIds(ids);
      await expect(f.run()).rejects.toThrow("preview_read_failed");
      expect(f.counts().calls).toBe(1);
    });
  }
  test("failed read does not iterate", async () => {
    const f = fixture(); f.setFailed();
    await expect(f.run()).rejects.toThrow("preview_read_failed");
    expect(f.counts().calls).toBe(1);
  });
  test("wrong blockhash refuses", async () => {
    const f = fixture(); f.setHash();
    await expect(f.run()).rejects.toThrow("preview_snapshot_mismatch");
  });
  test("trailing preview bytes refuse", async () => {
    const f = fixture(); f.setRaw(`${f.raw}00`);
    await expect(f.run()).rejects.toThrow("preview_noncanonical_bytes");
  });
  for (const field of ["liquidity", "installedSupply"] as const) {
    test(`zero ${field} refuses`, async () => {
      const f = fixture(); f.setInstallation({ ...f.installation, [field]: 0n });
      await expect(f.run()).rejects.toThrow("invalid_installation_amounts");
    });
  }
  test("overcap refuses", async () => {
    const f = fixture(); f.setInstallation({ ...f.installation, liquidity: (1n << 127n) - 1n });
    await expect(f.run()).rejects.toThrow("invalid_installation_amounts");
  });
  test("installed supply greater than requested refuses", async () => {
    const f = fixture(); f.setInstallation({ ...f.installation, installedSupply: BigInt(request(f.pin).supply) + 1n });
    await expect(f.run()).rejects.toThrow("invalid_installation_amounts");
  });
  test("changed position refuses", async () => {
    const f = fixture(); f.setInstallation({ ...f.installation, positionId: `0x${"00".repeat(32)}` });
    await expect(f.run()).rejects.toThrow("preview_geometry_mismatch");
  });
  test("nonzero input L is not a second adjustment", async () => {
    const f = fixture();
    await expect(f.run({ ...request(f.pin), liquidity: "1" })).rejects.toThrow("preview_liquidity_must_be_zero");
    expect(f.counts().calls).toBe(0);
  });
  for (const tradingStart of ["1299", "87401", "1000"]) test(`start ${tradingStart} refuses`, async () => {
    const f = fixture();
    await expect(f.run({ ...request(f.pin), tradingStart })).rejects.toThrow("invalid_trading_start");
    expect(f.counts().calls).toBe(0);
  });
  test("inclusive start ceiling accepted unchanged", async () => {
    const f = fixture();
    expect((await f.run({ ...request(f.pin), tradingStart: "87400" })).actual.tradingStart).toBe("87400");
  });
  for (const now of [999n, 1299n, 1300n]) test(`fresh time ${now} refuses`, async () => {
    const f = fixture(); f.setTime(now);
    await expect(f.run()).rejects.toThrow("expired_or_future_plan");
    expect(f.counts().calls).toBe(0);
  });
  test("snapshot time must equal build time", async () => {
    const f = fixture();
    await expect(f.run(request(f.pin), { ...build, blockTime: "999" })).rejects.toThrow("build_snapshot_mismatch");
  });
  test("UTF-8 metadata limit enforced before read", async () => {
    const f = fixture();
    await expect(f.run({ ...request(f.pin), name: "λ".repeat(16) })).rejects.toThrow("metadata_too_long");
    expect(f.counts().calls).toBe(0);
  });
  test("fresh expiry is rechecked after the one read", async () => {
    const f = fixture(); f.afterRead(() => f.setTime(1299n));
    await expect(f.run()).rejects.toThrow("expired_or_future_plan");
    expect(f.counts()).toEqual({ calls: 1, stores: 1 });
  });
  test("caller mutation across await cannot rewrite signed start or metadata", async () => {
    const f = fixture(); const input = request(f.pin); const context = { ...build }; const pin = { ...f.pin };
    f.afterRead(() => { input.tradingStart = "87400"; input.name = "changed"; context.executionExpiry = "87400"; pin.runtime = "changed"; });
    const preview = await f.run(input, context, pin);
    expect(preview.actual.tradingStart).toBe("1300");
    expect(preview.actual.name).toBe("Local λ");
    expect(preview.build.executionExpiry).toBe("1299");
    expect(preview.pin.runtime).toBe(f.pin.runtime);
  });
  for (const patch of [
    { supply: "0" }, { supply: (1n << 127n).toString() }, { liquidity: (1n << 127n).toString() },
    { initialFee: "1844674407370955162" }, { finalFee: "922337203685477581" },
    { tradingStart: (1n << 64n).toString() }, { askTick: -13815499 },
  ]) test(`invalid parameters refuse before any budgeted read ${JSON.stringify(patch)}`, async () => {
    const f = fixture();
    await expect(f.run({ ...request(f.pin), ...patch })).rejects.toThrow();
    expect(f.counts()).toEqual({ calls: 0, stores: 0 });
  });
  test("exact liquidity cap accepts; cap+1 refuses", async () => {
    const f = fixture(); const cap = ((1n << 128n) - 1n) / ((88722835n / 100n) * 2n + 1n);
    f.setInstallation({ ...f.installation, liquidity: cap });
    expect((await f.run()).actual.liquidity).toBe(cap.toString());
    const g = fixture(); g.setInstallation({ ...g.installation, liquidity: cap + 1n });
    await expect(g.run()).rejects.toThrow("invalid_installation_amounts");
  });
  test("exact 31-byte UTF-8 metadata accepts", async () => {
    const f = fixture(); const name = "λ".repeat(15) + "a";
    expect((await f.run({ ...request(f.pin), name })).actual.name).toBe(name);
  });
  test("expiry at signed start accepts, without changing signed start", async () => {
    const f = fixture();
    const preview = await f.run(request(f.pin), { ...build, executionExpiry: "1300" });
    expect(preview.build.executionExpiry).toBe(preview.actual.tradingStart);
  });
  for (const executionExpiry of ["1000", "1301"]) test(`invalid expiry ${executionExpiry} refuses`, async () => {
    const f = fixture();
    await expect(f.run(request(f.pin), { ...build, executionExpiry })).rejects.toThrow("invalid_execution_expiry");
    expect(f.counts().calls).toBe(0);
  });
  test("uint64 build arithmetic overflow refuses before read", async () => {
    const f = fixture(); const time = ((1n << 64n) - 300n).toString();
    f.setTime(BigInt(time));
    await expect(f.run({ ...request(f.pin), tradingStart: ((1n << 64n) - 1n).toString() }, {
      ...build, buildTime: time, blockTime: time, executionExpiry: ((1n << 64n) - 2n).toString(),
    })).rejects.toThrow("unsigned_domain");
    expect(f.counts().calls).toBe(0);
  });
});
