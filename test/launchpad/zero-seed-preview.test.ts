import { describe, expect, test } from "bun:test";
import { decodeFunctionData, zeroAddress } from "viem";
import { peripheryAbi } from "../../src/launchpad/zero-seed/abi.js";
import { abiParameters, createData, Parameters } from "../../src/launchpad/zero-seed/installation.js";
import { type InstancePin, LOCAL_INSTANCE_PINS } from "../../src/launchpad/zero-seed/policy.js";
import { PREVIEW_ID } from "../../src/launchpad/zero-seed/preview.js";
import { build, ERC20_QUOTE, fixture, KINDS, owner, request } from "./zero-seed-fixture.js";

const B = BigInt(build().buildTime);
const at = (offset: bigint) => (B + offset).toString();

// Contract vectors (evm-contracts 40af6cb, test/vectors/zero-seed-launch.json) at supply 1e27, 18/18 decimals,
// ask -13815500, upper -9210300, spacing 100: the native launch token is token1, the ERC-20 launch token0.
const EXPECTED = {
  native: { requested: "1000000000000000000000000000", installed: "999999999999999999999999422", sink: "578",
    liquidity: "1111119116089565312898036", token1: true },
  erc20: { requested: "1000000000000000000000000000", installed: "999999999999999999999999210", sink: "790",
    liquidity: "1111119116089565312897934", token1: false },
} as const;

const QUOTES = {
  native: { kind: "native", address: zeroAddress, runtime: null },
  erc20: { kind: "erc20", address: ERC20_QUOTE, runtime: "0xe8ccd7c4eb891208d5e04a27a31dfaf2b9bce01e083d7b36f10b6dd6ea643e63" },
} as const;

describe("single installation preview through the periphery (not executable evidence)", () => {
  for (const kind of KINDS) test(`${kind} quote: requested, installed and sink supply are exact and separate`, async () => {
    const f = fixture(kind);
    const preview = await f.run();
    const e = EXPECTED[kind];
    expect(preview.supply).toEqual({ requested: e.requested, installed: e.installed, sink: e.sink, sink_holder: zeroAddress });
    expect(BigInt(preview.supply.requested) - BigInt(preview.supply.installed)).toBe(BigInt(preview.supply.sink));
    expect(preview.liquidity).toBe(e.liquidity);
    expect(preview.installation.installedSupply).toBe(e.installed);
    expect(preview.installation.poolKey.token1 === preview.installation.token).toBe(e.token1);
    // The request is kept as submitted: the supply is never rewritten to the installed amount.
    expect(preview.requested).toEqual(request(kind));
    expect(preview.requested.supply).toBe(e.requested);
    expect(preview).not.toHaveProperty("actual");
    expect(preview.quote).toEqual(QUOTES[kind]);
  });

  for (const kind of KINDS) test(`${kind} quote: one read, the recorded bytes, nothing executable`, async () => {
    const f = fixture(kind);
    const preview = await f.run();
    expect(preview.owner).toBe(owner);
    expect(preview.preview.raw).toBe(f.raw);
    expect(preview.installation).toEqual(f.recorded.preview.installation);
    expect(preview.executionGuaranteed).toBe(false);
    expect(preview.scope).toBe("synthetic-local-non-executable");
    expect(preview).not.toHaveProperty("execution_plan");
    expect(preview).not.toHaveProperty("execution_plan_reference");
    expect(f.counts()).toEqual({ calls: 1, stores: 1 });
  });

  for (const kind of KINDS) test(`${kind} quote: create calldata decodes to the requested supply, never the installed`, async () => {
    const preview = await fixture(kind).run();
    const call = decodeFunctionData({ abi: peripheryAbi, data: createData(preview.requested) });
    if (call.functionName !== "create") throw new Error("create");
    expect(call.args[0].supply).toBe(BigInt(EXPECTED[kind].requested));
    expect(call.args[0].supply).not.toBe(BigInt(preview.supply.installed));
    expect(call.args[0].quoteToken.toLowerCase()).toBe(preview.quote.address);
    expect(abiParameters(preview.requested).supply).toBe(BigInt(EXPECTED[kind].requested));
  });

  test("the quote defaults to native ETH and is part of the tuple", () => {
    const { quoteToken: _, ...withoutQuote } = request("native");
    expect(Parameters.parse(withoutQuote).quoteToken).toBe(zeroAddress);
    expect(Parameters.parse(withoutQuote)).toEqual(request("native"));
  });

  test("native quote: the launch token is token1 and address(0) is token0", async () => {
    const preview = await fixture("native").run();
    expect(preview.installation.poolKey.token0).toBe(zeroAddress);
    expect(preview.installation.poolKey.token1).toBe(preview.installation.token);
  });

  test("ERC-20 quote above the launch token: the launch token is token0", async () => {
    const preview = await fixture("erc20").run();
    expect(preview.installation.poolKey).toMatchObject({ token0: preview.installation.token, token1: ERC20_QUOTE });
  });

  for (const kind of KINDS) test(`a ${kind} preview with the pair reversed refuses`, async () => {
    const f = fixture(kind);
    const i = f.installation;
    f.setInstallation({ ...i, poolKey: { ...i.poolKey, token0: i.poolKey.token1, token1: i.poolKey.token0 } });
    await expect(f.run()).rejects.toThrow("preview_pair_mismatch");
  });

  test("a preview paired with another quote than the launch's own refuses", async () => {
    const f = fixture("native");
    const i = f.installation;
    f.setInstallation({ ...i, poolKey: { ...i.poolKey, token0: "0x0000000000000000000000000000000000000001" } });
    await expect(f.run()).rejects.toThrow("preview_pair_mismatch");
  });

});

describe("preview refusals before and after the one read", () => {
  for (const quoteToken of ["0x00000000000000000000000000000000000000aa", "0xfffffffffffffffffffffffffffffffffffffffe",
    "0x4200000000000000000000000000000000000006"]) {
    test(`an ERC-20 quote outside the reviewed list (${quoteToken}) refuses before reading`, async () => {
      const f = fixture("erc20");
      await expect(f.run({ ...request("erc20"), quoteToken })).rejects.toThrow("unsupported_quote");
      expect(f.counts()).toEqual({ calls: 0, stores: 0 });
    });
  }
  test("a malformed quote token refuses before reading", async () => {
    const f = fixture("erc20");
    await expect(f.run({ ...request("erc20"), quoteToken: ERC20_QUOTE.toUpperCase().replace("0X", "0x") })).rejects.toThrow();
    expect(f.counts()).toEqual({ calls: 0, stores: 0 });
  });

  for (const key of Object.keys(LOCAL_INSTANCE_PINS[0]) as (keyof InstancePin)[]) {
    test(`refuse changed ${key} pin before reading`, async () => {
      const f = fixture();
      const changed = { ...f.pin, [key]: "mismatch" } as InstancePin;
      await expect(f.run(request(), build(), changed)).rejects.toThrow("launch_support_disabled");
      expect(f.counts()).toEqual({ calls: 0, stores: 0 });
    });
  }
  test("a pin carrying a quote (the earlier instance shape) refuses before reading", async () => {
    const f = fixture();
    const earlier = { ...f.pin, quote: zeroAddress, quoteKind: "native", quoteRuntime: null } as never;
    await expect(f.run(request(), build(), earlier)).rejects.toThrow("launch_support_disabled");
    expect(f.counts().calls).toBe(0);
  });
  test("the earlier tuple with a liquidity input refuses before reading", async () => {
    const f = fixture();
    await expect(f.run({ ...request(), liquidity: "0" } as never)).rejects.toThrow();
    await expect(f.run({ ...request(), liquidity: "1" } as never)).rejects.toThrow();
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
  test("installed supply equal to requested accepts with a zero sink; one more refuses", async () => {
    const f = fixture(); const requested = BigInt(request().supply);
    f.setInstallation({ ...f.installation, installedSupply: requested });
    expect((await f.run()).supply).toMatchObject({ installed: requested.toString(), sink: "0" });
    const g = fixture(); g.setInstallation({ ...g.installation, installedSupply: requested + 1n });
    await expect(g.run()).rejects.toThrow("invalid_installation_amounts");
  });
  test("changed position refuses", async () => {
    const f = fixture(); f.setInstallation({ ...f.installation, positionId: `0x${"00".repeat(32)}` });
    await expect(f.run()).rejects.toThrow("preview_geometry_mismatch");
  });
  for (const tradingStart of [at(299n), at(86401n), at(0n)]) test(`start ${tradingStart} refuses`, async () => {
    const f = fixture();
    await expect(f.run({ ...request(), tradingStart })).rejects.toThrow("invalid_trading_start");
    expect(f.counts().calls).toBe(0);
  });
  test("inclusive start ceiling accepted unchanged", async () => {
    const f = fixture();
    expect((await f.run({ ...request(), tradingStart: at(86400n) })).requested.tradingStart).toBe(at(86400n));
  });
  for (const now of [B - 1n, B + 300n, B + 301n]) test(`fresh time ${now} outside [build, expiry) refuses`, async () => {
    const f = fixture(); f.setTime(now);
    await expect(f.run()).rejects.toThrow("expired_or_future_plan");
    expect(f.counts().calls).toBe(0);
  });
  test("snapshot time must equal build time", async () => {
    const f = fixture();
    await expect(f.run(request(), { ...build(), blockTime: at(-1n) })).rejects.toThrow("build_snapshot_mismatch");
  });
  test("UTF-8 metadata limit enforced before read", async () => {
    const f = fixture();
    await expect(f.run({ ...request(), name: "λ".repeat(16) })).rejects.toThrow("metadata_too_long");
    expect(f.counts().calls).toBe(0);
  });
  test("fresh expiry is rechecked after the one read", async () => {
    const f = fixture(); f.afterRead(() => f.setTime(B + 300n));
    await expect(f.run()).rejects.toThrow("expired_or_future_plan");
    expect(f.counts()).toEqual({ calls: 1, stores: 1 });
  });
  test("caller mutation across await cannot rewrite signed start, metadata, quote or pin", async () => {
    const f = fixture(); const input = request(); const context = build(); const pin = { ...f.pin };
    f.afterRead(() => {
      input.tradingStart = at(86400n); input.name = "changed"; input.quoteToken = ERC20_QUOTE;
      context.executionExpiry = at(86400n); pin.periphery = "changed";
    });
    const preview = await f.run(input, context, pin);
    expect(preview.requested.tradingStart).toBe(request().tradingStart);
    expect(preview.requested.name).toBe(request().name);
    expect(preview.requested.quoteToken).toBe(zeroAddress);
    expect(preview.build.executionExpiry).toBe(build().executionExpiry);
    expect(preview.pin.periphery).toBe(f.pin.periphery);
  });
  for (const patch of [
    { supply: "0" }, { supply: (1n << 127n).toString() },
    { initialFee: "18262276632972456100" }, { finalFee: "922337203685477581" }, { feeDuration: 0 },
    { tradingStart: (1n << 64n).toString() }, { askTick: -13815499 },
  ]) test(`invalid parameters refuse before any budgeted read ${JSON.stringify(patch)}`, async () => {
    const f = fixture();
    await expect(f.run({ ...request(), ...patch })).rejects.toThrow();
    expect(f.counts()).toEqual({ calls: 0, stores: 0 });
  });
  test("largest requested supply int128.max is accepted as input", async () => {
    const f = fixture();
    // The token prediction ignores supply; the recorded amounts stay within the request.
    const preview = await f.run({ ...request(), supply: ((1n << 127n) - 1n).toString() });
    expect(preview.supply.requested).toBe(((1n << 127n) - 1n).toString());
    expect(BigInt(preview.supply.sink)).toBe((1n << 127n) - 1n - BigInt(preview.supply.installed));
  });
  test("exact liquidity cap accepts; cap+1 refuses", async () => {
    const f = fixture(); const cap = ((1n << 128n) - 1n) / ((88722835n / 100n) * 2n + 1n);
    f.setInstallation({ ...f.installation, liquidity: cap });
    expect((await f.run()).liquidity).toBe(cap.toString());
    const g = fixture(); g.setInstallation({ ...g.installation, liquidity: cap + 1n });
    await expect(g.run()).rejects.toThrow("invalid_installation_amounts");
  });
  test("exact 31-byte UTF-8 metadata accepts", async () => {
    const f = fixture(); const name = "λ".repeat(15) + "a";
    expect((await f.run({ ...request(), name })).requested.name).toBe(name);
  });
  test("expiry at signed start accepts, without changing signed start", async () => {
    const f = fixture();
    const preview = await f.run(request(), { ...build(), executionExpiry: request().tradingStart });
    expect(preview.build.executionExpiry).toBe(preview.requested.tradingStart);
  });
  for (const executionExpiry of [at(0n), at(601n)]) test(`invalid expiry ${executionExpiry} refuses`, async () => {
    const f = fixture();
    await expect(f.run(request(), { ...build(), executionExpiry })).rejects.toThrow("invalid_execution_expiry");
    expect(f.counts().calls).toBe(0);
  });
  test("uint64 build arithmetic overflow refuses before read", async () => {
    const f = fixture(); const time = ((1n << 64n) - 300n).toString();
    f.setTime(BigInt(time));
    await expect(f.run({ ...request(), tradingStart: ((1n << 64n) - 1n).toString() }, {
      ...build(), buildTime: time, blockTime: time, executionExpiry: ((1n << 64n) - 2n).toString(),
    })).rejects.toThrow("unsigned_domain");
    expect(f.counts().calls).toBe(0);
  });
});
