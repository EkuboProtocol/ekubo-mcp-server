import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Abi, decodeEventLog, type Hex, toEventSelector, toFunctionSelector } from "viem";
import { formatAbiItem } from "viem/utils";
import { extensionAbi, launchTokenAbi, peripheryAbi, SELECTORS } from "../../src/launchpad/zero-seed/abi.js";
import { launchRange, packOne, priceToTick, unpackOne } from "../../src/launchpad/zero-seed/codec.js";
import { DEFAULT_DECAY_RATE_X32, DEFAULT_FINAL_FEE, DEFAULT_INITIAL_FEE, decayRateForHalfLife, feeAt, halfLifeSeconds, percentToQ64,
  saturationSeconds } from "../../src/launchpad/zero-seed/fee.js";
import provenance from "../../src/launchpad/zero-seed/frozen/provenance.json";
import events from "../fixtures/launchpad/zero-seed-launch-events.json";
import installation from "../fixtures/launchpad/zero-seed-launch-installation.json";
import vectors from "../fixtures/launchpad/zero-seed-launch.json";

const sha256 = (url: URL) => createHash("sha256").update(readFileSync(url)).digest("hex");

describe("frozen 853b608 artifacts", () => {
  test("ABIs and vectors are byte-identical to the freeze", () => {
    for (const [name, digest] of Object.entries(provenance.sha256)) {
      expect(sha256(new URL(`../../src/launchpad/zero-seed/frozen/${name}`, import.meta.url))).toBe(digest);
    }
    const fixtures: Record<string, string> = {
      "zero-seed-launch.json": "e5444bf6b1f7e422238331b50b64cf0400597bd13421e281615735511274190b",
      "zero-seed-launch-events.json": "24dd5883ce242ec523517c9f38cfd5e8ca29740974aeded5740ac3608e1e7066",
      "zero-seed-launch-installation.json": "5cf44854cbf00abb700936b2e22782c27dac5e68cf892edc8f5aa7090067a555",
    };
    for (const [name, digest] of Object.entries(fixtures)) {
      expect(sha256(new URL(`../fixtures/launchpad/${name}`, import.meta.url))).toBe(digest);
    }
  });

  test("every selector, error and topic equals the generated vectors", () => {
    const check = (abi: Abi, expected: { selectors: Record<string, string>; errors: Record<string, string>; events: Record<string, string> }) => {
      const functions = abi.filter((item) => item.type === "function");
      expect(Object.fromEntries(functions.map((item) => [formatAbiItem(item).replace(/^function /, ""), toFunctionSelector(item)])))
        .toEqual(expected.selectors);
      const errors = abi.filter((item) => item.type === "error");
      expect(Object.fromEntries(errors.map((item) => [formatAbiItem(item).replace(/^error /, ""), toFunctionSelector(formatAbiItem(item).replace(/^error /, "function "))])))
        .toEqual(expected.errors);
      const logs = abi.filter((item) => item.type === "event");
      expect(Object.fromEntries(logs.map((item) => [formatAbiItem(item).replace(/^event /, ""), toEventSelector(item)]))).toEqual(expected.events);
    };
    check(extensionAbi, vectors.abi.ZeroSeedLaunch);
    check(peripheryAbi, vectors.abi.ZeroSeedLaunchPeriphery);
    check(launchTokenAbi, vectors.abi.LaunchToken);
    const all = { ...vectors.abi.ZeroSeedLaunch.selectors, ...vectors.abi.ZeroSeedLaunchPeriphery.selectors } as Record<string, string>;
    for (const selector of Object.values(SELECTORS)) expect(Object.values(all)).toContain(selector);
  });

  test("the recorded LaunchCreated logs decode with the frozen ABI, logo last", () => {
    const created = (events as unknown as { LaunchCreated: { logo: string; topics: Hex[]; data: Hex }[] }).LaunchCreated;
    expect(created.length).toBeGreaterThanOrEqual(2);
    for (const log of created) {
      const decoded = decodeEventLog({ abi: extensionAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      expect(decoded.eventName).toBe("LaunchCreated");
      const args = decoded.args as unknown as { logoUrl: string; parameters: { name: Hex; symbol: Hex } };
      expect(args.logoUrl).toBe(log.logo);
      expect(unpackOne(args.parameters.name)).toBe("Zero Seed");
      expect(unpackOne(args.parameters.symbol)).toBe("ZERO");
    }
  });
});

describe("metadata codec", () => {
  test("packOne matches the vectors and refuses instead of truncating", () => {
    for (const [value, word] of Object.entries(vectors.metadata.examples)) {
      expect(packOne(value)).toBe(word as Hex);
      expect(unpackOne(word as Hex)).toBe(value);
    }
    expect(packOne("")).toBeNull();
    expect(packOne("a".repeat(31))).not.toBeNull();
    expect(packOne("a".repeat(32))).toBeNull();
    expect(packOne("é".repeat(16))).toBeNull();
    expect(unpackOne(`0x01${"61".padEnd(62, "0")}01` as Hex)).toBeNull();
    expect(unpackOne(`0x${"0".repeat(64)}` as Hex)).toBeNull();
    expect(unpackOne(`0x20${"61".repeat(31)}` as Hex)).toBeNull();
  });
});

describe("range spacing and signed alignment", () => {
  test("all installation rows follow the final rule, no 1024 snapping", () => {
    const rows = (installation.vectors as { askTick: number; upperTick: number; tickSpacing?: number; alignedAskTick?: number; alignedUpperTick?: number }[])
      .filter((row) => row.tickSpacing !== undefined);
    expect(rows.length).toBeGreaterThan(50);
    for (const row of rows) {
      expect(launchRange(row.askTick, row.upperTick)).toEqual({
        tickSpacing: row.tickSpacing, alignedAskTick: row.alignedAskTick, alignedUpperTick: row.alignedUpperTick,
      });
    }
  });

  test("the specification table", () => {
    const table: [number, number, number, number, number][] = [
      [-13815500, -9210300, 17990, -13798330, -9210880],
      [-41446500, -36841300, 17990, -41430970, -36843520],
      [-88722835, 88722835, 693148, -88029796, 88029796],
      [-88722835, -88722834, 1, -88722835, -88722834],
      [60000000, 70000000, 39063, 60000768, 69961833],
      [-70000000, -60000000, 39063, -69961833, -60000768],
      [-5000001, 4999999, 39063, -4961001, 4961001],
    ];
    for (const [ask, upper, spacing, alignedAsk, alignedUpper] of table) {
      expect(launchRange(ask, upper)).toEqual({ tickSpacing: spacing, alignedAskTick: alignedAsk, alignedUpperTick: alignedUpper });
    }
  });

  test("prices map to economic ticks", () => {
    expect(priceToTick("1", 18)).toBe(0);
    expect(priceToTick("0.000001", 18)).toBe(-13815517);
    expect(priceToTick("0.000001", 6)).toBe(-41446552);
    expect(priceToTick("0", 18)).toBeNull();
    expect(priceToTick("1e5", 18)).toBeNull();
    expect(priceToTick("1".padEnd(60, "0"), 18)).toBeNull();
  });
});

describe("fee schedule", () => {
  test("the contract vectors", () => {
    const initialFee = BigInt(vectors.fixture.fee_initial_q64);
    const finalFee = BigInt(vectors.fixture.fee_final_q64);
    for (const row of vectors.fee) {
      const schedule = { tradingStart: 1000n, decayRateX32: BigInt(row.decayRateX32), initialFee, finalFee };
      expect(feeAt(schedule, 1000n + BigInt(row.t_minus_start)).toString()).toBe(row.fee_q64);
    }
  });

  test("the curve digests of the oracle", () => {
    for (const curve of vectors.fee_curve.digests_sha256) {
      const schedule = { tradingStart: 0n, decayRateX32: BigInt(curve.decayRateX32), initialFee: BigInt(curve.initialFee), finalFee: BigInt(curve.finalFee) };
      let h: Buffer = Buffer.alloc(32);
      for (let t = 0; t <= curve.last; t += curve.step) {
        const word = Buffer.alloc(8);
        word.writeBigUInt64BE(feeAt(schedule, BigInt(t)));
        h = createHash("sha256").update(Buffer.concat([h, word])).digest();
      }
      expect(h.toString("hex")).toBe(curve.digest);
    }
  });

  test("defaults, half-life and percent conversion", () => {
    expect(DEFAULT_DECAY_RATE_X32.toString()).toBe(vectors.fixture.fee_decay_rate_x32_default);
    expect(decayRateForHalfLife("86400")).toBe(DEFAULT_DECAY_RATE_X32);
    expect(decayRateForHalfLife("600")?.toString()).toBe(vectors.fee_curve.decay_rates_x32["600s"]);
    expect(decayRateForHalfLife("0")).toBeNull();
    expect(halfLifeSeconds(DEFAULT_DECAY_RATE_X32)).toBe("86400.000001");
    expect(saturationSeconds(DEFAULT_DECAY_RATE_X32)?.toString()).toBe(vectors.fee_curve.saturation_second.default_one_day);
    expect(percentToQ64("50")).toBe(DEFAULT_INITIAL_FEE);
    expect(percentToQ64("0.3")).toBe(DEFAULT_FINAL_FEE);
    expect(percentToQ64("5")?.toString()).toBe(vectors.fixture.fee_initial_q64);
    expect(percentToQ64("100")).toBeNull();
    const consumer = vectors.creator_fee_range.reference_schedules.consumer_default;
    expect(feeAt({ tradingStart: 0n, decayRateX32: DEFAULT_DECAY_RATE_X32, initialFee: DEFAULT_INITIAL_FEE, finalFee: DEFAULT_FINAL_FEE }, 86400n).toString())
      .toBe(consumer.fee_after_one_day_q64);
  });
});
