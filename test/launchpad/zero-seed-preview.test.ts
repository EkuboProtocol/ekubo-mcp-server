import { describe, expect, test } from "bun:test";
import { abiParameters } from "../../src/launchpad/zero-seed/installation.js";
import { LOCAL_INSTANCE_PINS, type InstancePin } from "../../src/launchpad/zero-seed/policy.js";
import { PREVIEW_ID } from "../../src/launchpad/zero-seed/preview.js";
import { build, fixture, owner, request } from "./zero-seed-fixture.js";

const B = BigInt(build().buildTime);
const at = (offset: bigint) => (B + offset).toString();

describe("single installation preview through the periphery (not executable evidence)", () => {
  for (const pin of LOCAL_INSTANCE_PINS) test(`bind the recorded chain's installed pair (${pin.quoteKind} quote)`, async () => {
    const f = fixture(pin);
    const preview = await f.run();
    expect(preview.requested.supply).toBe(request(pin).supply);
    expect(preview.actual.supply).toBe(f.installation.installedSupply.toString());
    expect(preview.actual.liquidity).toBe(f.installation.liquidity.toString());
    expect(preview.owner).toBe(owner);
    expect(preview.preview.raw).toBe(f.raw);
    expect(preview.installation).toEqual(f.recorded.preview.installation);
    expect(preview.executionGuaranteed).toBe(false);
    expect(preview.scope).toBe("synthetic-local-non-executable");
    expect(preview).not.toHaveProperty("execution_plan");
    expect(preview).not.toHaveProperty("execution_plan_reference");
    expect(f.counts()).toEqual({ calls: 1, stores: 1 });
    expect(abiParameters(preview.actual).supply).toBe(f.installation.installedSupply);
  });

  test("native quote: the launch token is token1 and address(0) is token0", async () => {
    const preview = await fixture(LOCAL_INSTANCE_PINS[0]).run();
    expect(preview.installation.poolKey.token0).toBe("0x0000000000000000000000000000000000000000");
    expect(preview.installation.poolKey.token1).toBe(preview.installation.token);
  });

  test("a native preview whose launch token is token0 refuses", async () => {
    const f = fixture(LOCAL_INSTANCE_PINS[0]);
    const i = f.installation;
    f.setInstallation({ ...i, poolKey: { ...i.poolKey, token0: i.token, token1: i.poolKey.token0 } });
    await expect(f.run()).rejects.toThrow(/preview_(pair|token)_mismatch/);
  });

  for (const key of Object.keys(LOCAL_INSTANCE_PINS[0]) as (keyof InstancePin)[]) {
    test(`refuse changed ${key} pin before reading`, async () => {
      const f = fixture();
      const changed = { ...f.pin, [key]: key === "quoteRuntime" ? `0x${"00".repeat(32)}` : "mismatch" } as InstancePin;
      await expect(f.run(request(f.pin), build(), changed)).rejects.toThrow("launch_support_disabled");
      expect(f.counts()).toEqual({ calls: 0, stores: 0 });
    });
  }
  test("the native pin's extension with the ERC-20 pin's periphery refuses", async () => {
    const f = fixture();
    const crossed = { ...f.pin, periphery: LOCAL_INSTANCE_PINS[1].periphery };
    await expect(f.run(request(f.pin), build(), crossed)).rejects.toThrow("launch_support_disabled");
    expect(f.counts().calls).toBe(0);
  });
  test("an earlier tuple with a quote token refuses before reading", async () => {
    const f = fixture();
    await expect(f.run({ ...request(f.pin), quoteToken: f.pin.quote } as never)).rejects.toThrow();
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
  test("a token predicted for another owner refuses", async () => {
    const f = fixture();
    f.setInstallation({ ...f.installation, token: "0x00000000000000000000000000000000000000aa" });
    await expect(f.run()).rejects.toThrow("preview_token_mismatch");
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
  for (const tradingStart of [at(299n), at(86401n), at(0n)]) test(`start ${tradingStart} refuses`, async () => {
    const f = fixture();
    await expect(f.run({ ...request(f.pin), tradingStart })).rejects.toThrow("invalid_trading_start");
    expect(f.counts().calls).toBe(0);
  });
  test("inclusive start ceiling accepted unchanged", async () => {
    const f = fixture();
    expect((await f.run({ ...request(f.pin), tradingStart: at(86400n) })).actual.tradingStart).toBe(at(86400n));
  });
  for (const now of [B - 1n, B + 300n, B + 301n]) test(`fresh time ${now} outside [build, expiry) refuses`, async () => {
    const f = fixture(); f.setTime(now);
    await expect(f.run()).rejects.toThrow("expired_or_future_plan");
    expect(f.counts().calls).toBe(0);
  });
  test("snapshot time must equal build time", async () => {
    const f = fixture();
    await expect(f.run(request(f.pin), { ...build(), blockTime: at(-1n) })).rejects.toThrow("build_snapshot_mismatch");
  });
  test("UTF-8 metadata limit enforced before read", async () => {
    const f = fixture();
    await expect(f.run({ ...request(f.pin), name: "λ".repeat(16) })).rejects.toThrow("metadata_too_long");
    expect(f.counts().calls).toBe(0);
  });
  test("fresh expiry is rechecked after the one read", async () => {
    const f = fixture(); f.afterRead(() => f.setTime(B + 300n));
    await expect(f.run()).rejects.toThrow("expired_or_future_plan");
    expect(f.counts()).toEqual({ calls: 1, stores: 1 });
  });
  test("caller mutation across await cannot rewrite signed start, metadata or pin", async () => {
    const f = fixture(); const input = request(f.pin); const context = build(); const pin = { ...f.pin };
    f.afterRead(() => {
      input.tradingStart = at(86400n); input.name = "changed"; context.executionExpiry = at(86400n); pin.periphery = "changed";
    });
    const preview = await f.run(input, context, pin);
    expect(preview.actual.tradingStart).toBe(request(f.pin).tradingStart);
    expect(preview.actual.name).toBe(request(f.pin).name);
    expect(preview.build.executionExpiry).toBe(build().executionExpiry);
    expect(preview.pin.periphery).toBe(f.pin.periphery);
  });
  for (const patch of [
    { supply: "0" }, { supply: (1n << 127n).toString() }, { liquidity: (1n << 127n).toString() },
    { initialFee: "18262276632972456100" }, { finalFee: "922337203685477581" }, { feeDuration: 0 },
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
    const preview = await f.run(request(f.pin), { ...build(), executionExpiry: request(f.pin).tradingStart });
    expect(preview.build.executionExpiry).toBe(preview.actual.tradingStart);
  });
  for (const executionExpiry of [at(0n), at(601n)]) test(`invalid expiry ${executionExpiry} refuses`, async () => {
    const f = fixture();
    await expect(f.run(request(f.pin), { ...build(), executionExpiry })).rejects.toThrow("invalid_execution_expiry");
    expect(f.counts().calls).toBe(0);
  });
  test("uint64 build arithmetic overflow refuses before read", async () => {
    const f = fixture(); const time = ((1n << 64n) - 300n).toString();
    f.setTime(BigInt(time));
    await expect(f.run({ ...request(f.pin), tradingStart: ((1n << 64n) - 1n).toString() }, {
      ...build(), buildTime: time, blockTime: time, executionExpiry: ((1n << 64n) - 2n).toString(),
    })).rejects.toThrow("unsigned_domain");
    expect(f.counts().calls).toBe(0);
  });
});
