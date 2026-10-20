import { describe, expect, test } from "bun:test";
import { abiParameters } from "../../src/launchpad/zero-seed/installation.js";
import { LOCAL_INSTANCE_PINS, type InstancePin } from "../../src/launchpad/zero-seed/policy.js";
import { PREVIEW_ID } from "../../src/launchpad/zero-seed/preview.js";
import { build, creator, fixture, request } from "./zero-seed-fixture.js";

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
    expect(preview.actual.name).toBe("Zero Seed l1");
    expect(preview.build.executionExpiry).toBe("1299");
    expect(preview.pin.runtime).toBe(f.pin.runtime);
  });
  for (const patch of [
    { supply: "0" }, { supply: (1n << 127n).toString() }, { liquidity: (1n << 127n).toString() },
    { initialFee: "18262276632972456100" }, { finalFee: "922337203685477581" }, { decayFactor: "0" },
    { decayFactor: "18446744073709551616" },
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
