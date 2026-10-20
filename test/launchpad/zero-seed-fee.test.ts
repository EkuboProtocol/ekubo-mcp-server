import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Address, encodeFunctionData, keccak256 } from "viem";
import { zeroSeedAbi } from "../../src/launchpad/zero-seed/abi.js";
import {
  exactInputFee, exactOutputMultiplier, exactOutputPaid, excessHalvingTime, feeAt, feeInclusiveDelta, MAX_CREATOR_FEE,
  powQ64, Q64, STUDY_DECAY_FACTORS,
} from "../../src/launchpad/zero-seed/fee.js";
import { abiParameters, createData, previewData, validateParameters } from "../../src/launchpad/zero-seed/installation.js";
import { LOCAL_INSTANCE_PINS } from "../../src/launchpad/zero-seed/policy.js";
import { localSwapFromQuote } from "../../src/launchpad/zero-seed/swap.js";
import router from "../fixtures/launchpad/zero-seed-router-vectors.json";
import { request } from "./zero-seed-fixture.js";

// Canonical protocol vectors: the fee sections of evm-contracts b1cbb1c test/vectors/zero-seed-launch.json and
// the parsed VEC rows of its fee-curve tests (also consumed verbatim by the draft Rust SDK).
const fixture = (name: string) => {
  const bytes = readFileSync(new URL(`../fixtures/launchpad/${name}`, import.meta.url));
  return { sha256: createHash("sha256").update(bytes).digest("hex"), json: JSON.parse(bytes.toString("utf8")) };
};
const vectors = fixture("zero-seed-fee-vectors.json");
const rows = fixture("zero-seed-fee-curve-rows.json");
const curve = vectors.json.fee_curve;
const RATES: Record<string, bigint> = Object.fromEntries(Object.entries(curve.rates_q64 as Record<string, string>)
  .map(([key, value]) => [key, BigInt(value)]));
const FINAL = BigInt(curve.final_fee_q64);
const schedule = (initialFee: bigint, feeDuration: bigint, decayFactor: bigint, finalFee = FINAL, tradingStart = 1000n) =>
  ({ tradingStart, feeDuration, initialFee, finalFee, decayFactor });

describe("canonical vector provenance", () => {
  test("fixtures are the pinned protocol exports", () => {
    expect(rows.sha256).toBe("bf3d3098c9b77befd35166c974793ec1ecdeccaa03adf5cf0b9888c67cac6320");
    expect(vectors.json.source_sha256).toBe("303055e5fe7bcb67755e2723036e408048c8761d9b7e118185a7c118da6e1723");
    expect(vectors.json.max_creator_fee_q64).toBe(MAX_CREATOR_FEE.toString());
    expect(MAX_CREATOR_FEE).toBe((99n * Q64) / 100n);
    for (const [duration, factor] of Object.entries(vectors.json.fee_decay_factors_q64)) {
      expect(STUDY_DECAY_FACTORS[Number(duration) as 600 | 3600].toString()).toBe(factor as string);
    }
  });
});

describe("normalized exponential schedule parity (bit-exact)", () => {
  test("powQ64 follows the frozen floor-after-each-multiply order", () => {
    expect(powQ64(STUDY_DECAY_FACTORS[3600], 0n)).toBe(Q64);
    expect(powQ64(STUDY_DECAY_FACTORS[3600], 1n)).toBe(STUDY_DECAY_FACTORS[3600]);
    const b = STUDY_DECAY_FACTORS[600];
    // 3 = 0b11: r = floor(Q*b/Q) = b, then b2 = floor(b*b/Q), r = floor(b*b2/Q).
    expect(powQ64(b, 3n)).toBe((b * ((b * b) / Q64)) / Q64);
    expect(powQ64(1n, 2n)).toBe(0n);
    expect(powQ64(Q64 - 1n, 1n << 40n)).toBeLessThan(Q64);
  });

  for (const duration of [600, 3600] as const) {
    for (const [label, initial] of Object.entries(RATES)) {
      test(`every second of D${duration} at ${label}: digest, endpoints, bounds, monotone`, () => {
        const s = schedule(initial, BigInt(duration), STUDY_DECAY_FACTORS[duration]);
        let digest = Buffer.alloc(32);
        let previous = initial;
        for (let t = 0n; t <= BigInt(duration); t++) {
          const fee = feeAt(s, s.tradingStart + t);
          expect(fee <= previous && fee >= FINAL && fee <= initial).toBe(true);
          const word = Buffer.alloc(8);
          word.writeBigUInt64BE(fee);
          digest = createHash("sha256").update(Buffer.concat([digest, word])).digest();
          previous = fee;
        }
        expect(feeAt(s, s.tradingStart)).toBe(initial);
        expect(previous).toBe(FINAL);
        expect(digest.toString("hex")).toBe(curve.all_second_digests_sha256[String(duration)][label]);
      });
    }
  }

  test("the 18 contract fee rows, including pre-start and uint64-offset saturation", () => {
    expect(vectors.json.fee).toHaveLength(18);
    const start = BigInt(vectors.json.trading_start);
    for (const row of vectors.json.fee) {
      const s = schedule(RATES["5"], BigInt(row.duration), BigInt(row.decay_factor_q64), FINAL, start);
      expect(feeAt(s, start + BigInt(row.t_minus_start)).toString()).toBe(row.fee_q64);
    }
  });

  test("all five integer-chord counterexamples reproduce, exponential above the linear chord", () => {
    const exceptions = curve.integer_chord_exceptions.rows;
    expect(exceptions).toHaveLength(5);
    for (const row of exceptions) {
      const s = schedule(BigInt(row.initial), BigInt(row.duration), BigInt(row.factor), BigInt(row.final));
      const exponential = feeAt(s, s.tradingStart + BigInt(row.elapsed));
      const linear = BigInt(row.initial) - ((BigInt(row.initial) - BigInt(row.final)) * BigInt(row.elapsed)) / BigInt(row.duration);
      expect(exponential.toString()).toBe(row.exponential);
      expect(linear.toString()).toBe(row.linear);
      expect((exponential - linear).toString()).toBe(row.excess_q64);
    }
  });

  test("addendum example (maximum duration) reproduces, not corrected", () => {
    const s = schedule(Q64 - 1n, 4294967295n, 18446744073709551608n, 14193599660735192734n, 0n);
    expect(feeAt(s, 4028198074n)).toBe(14457771176879541746n);
  });

  test("equal-half-life comparator values at the maximum duration", () => {
    const h = curve.half_life_fixture;
    const s = schedule(BigInt(h.initial_q64), BigInt(h.duration), BigInt(h.factor_q64), BigInt(h.final_q64));
    for (const point of h.values) expect(feeAt(s, s.tradingStart + BigInt(point.t)).toString()).toBe(point.fee_q64);
  });

  test("excess halving time is read from the integer schedule, not the factor", () => {
    const s = schedule(RATES["50"], 3600n, STUDY_DECAY_FACTORS[3600]);
    const t = excessHalvingTime(s)!;
    const half = (RATES["50"] - FINAL);
    expect(2n * (feeAt(s, s.tradingStart + t) - FINAL)).toBeLessThanOrEqual(half);
    expect(2n * (feeAt(s, s.tradingStart + t - 1n) - FINAL)).toBeGreaterThan(half);
    expect(t).toBeLessThan(1800n);
    expect(excessHalvingTime(schedule(FINAL, 3600n, STUDY_DECAY_FACTORS[3600]))).toBeNull();
    // A degenerate factor of 1 is a cliff after the first second.
    expect(excessHalvingTime(schedule(RATES["50"], 3600n, 1n))).toBe(1n);
  });

  test("invalid indexed schedules refuse instead of guessing", () => {
    expect(() => feeAt(schedule(RATES["5"], 3600n, 0n), 2000n)).toThrow("invalid_fee_schedule");
    expect(() => feeAt(schedule(RATES["5"], 0n, 1n), 2000n)).toThrow("invalid_fee_schedule");
    expect(() => feeAt(schedule(FINAL, 3600n, 1n, RATES["5"]), 2000n)).toThrow("invalid_fee_schedule");
    expect(() => feeAt(schedule(Q64, 3600n, 1n), 2000n)).toThrow("unsigned_domain");
    expect(() => feeAt(schedule(RATES["5"], 3600n, Q64), 2000n)).toThrow("unsigned_domain");
  });
});

describe("amount parity with the executed high-fee rows (both orders, 18/18 and 18/6)", () => {
  const high = rows.json.highRate as Record<string, string & string[]>[];
  const rate = (row: { rate: string }) => RATES[row.rate];
  test("coverage: 50/75/90/99/max x t0/t1 x 18/18, 18/6", () => {
    expect(new Set(high.map((r) => `${r.rate}|${r.order}|${r.dec}`)).size).toBe(20);
  });
  for (const row of high.filter((r) => !r.tags.includes("dust"))) {
    test(row.raw.slice(4), () => {
      const r = rate(row as never);
      const tag = row.tags[0];
      if (tag === "oneUnit" || tag === "buyExactIn") {
        expect(exactInputFee(BigInt(row.gross), r).toString()).toBe(row.fee);
        expect((BigInt(row.gross) - BigInt(row.fee)).toString()).toBe(row.net);
        expect(feeInclusiveDelta({ calculated: -BigInt(row.gross), rate: r, exactOut: false }).withFee.toString()).toBe(`-${row.net}`.replace("-0", "0"));
      } else if (tag === "buyExactOut") {
        expect(exactOutputPaid(BigInt(row.calcQuote), r).toString()).toBe(row.paid);
        expect(feeInclusiveDelta({ calculated: BigInt(row.calcQuote), rate: r, exactOut: true })).toEqual({ fee: BigInt(row.fee), withFee: BigInt(row.paid) });
      } else {
        expect(exactInputFee(BigInt(row.grossQuote), r).toString()).toBe(row.fee);
        expect((BigInt(row.grossQuote) - BigInt(row.fee)).toString()).toBe(row.quoteOut);
      }
    });
  }

  test("helper uint128 and signed int128 limits stay distinct at every rate", () => {
    const bounds = rows.json.bounds;
    expect(bounds).toHaveLength(6);
    for (const row of bounds) {
      const r = RATES[row.rate];
      const helper = BigInt(row.helperLastValid);
      expect(() => exactOutputPaid(helper, r)).not.toThrow();
      expect(() => exactOutputPaid(helper + 1n, r)).toThrow("amount_before_fee_overflow");
      const signed = BigInt(row.signedLastValid);
      expect(() => feeInclusiveDelta({ calculated: signed, rate: r, exactOut: true })).not.toThrow();
      expect(() => feeInclusiveDelta({ calculated: signed + 1n, rate: r, exactOut: true })).toThrow("signed_delta_overflow");
    }
  });

  test("maximum-rate executed signed bound (research-only rate)", () => {
    const row = rows.json.exactOutBounds.find((r: { tags: string[] }) => r.tags.includes("signed"));
    const out = feeInclusiveDelta({ calculated: BigInt(row.calcQuote), rate: Q64 - 1n, exactOut: true });
    expect(out.withFee.toString()).toBe(row.paid);
    expect(() => feeInclusiveDelta({ calculated: BigInt(row.calcQuote) + 1n, rate: Q64 - 1n, exactOut: true })).toThrow("signed_delta_overflow");
  });

  test("exact-output multiplier is nonlinear in the rate", () => {
    expect(exactOutputMultiplier(RATES["5"])).toBe("1.05");
    expect(exactOutputMultiplier(RATES["50"])).toBe("2.00");
    expect(exactOutputMultiplier(RATES["90"])).toBe("9.99");
    expect(exactOutputMultiplier(RATES["99"])).toBe("99.99");
  });
});

describe("configured-launch validation: cap, factor and unencodable values", () => {
  const pin = LOCAL_INSTANCE_PINS[0];
  const base = request(pin);
  test("99% cap accepts; cap + 1 and the maximum encoding refuse with fee_too_high", () => {
    expect(() => validateParameters({ ...base, initialFee: MAX_CREATOR_FEE.toString() }, pin)).not.toThrow();
    expect(() => validateParameters({ ...base, initialFee: (MAX_CREATOR_FEE + 1n).toString() }, pin)).toThrow("fee_too_high");
    expect(() => validateParameters({ ...base, initialFee: (Q64 - 1n).toString() }, pin)).toThrow("fee_too_high");
  });
  test("decay factor 0 refuses; 1 and 2^64 - 1 are valid; 2^64 cannot be encoded", () => {
    expect(() => validateParameters({ ...base, decayFactor: "0" }, pin)).toThrow("invalid_fee_schedule");
    for (const factor of ["1", (Q64 - 1n).toString()]) expect(() => validateParameters({ ...base, decayFactor: factor }, pin)).not.toThrow();
    expect(() => validateParameters({ ...base, decayFactor: Q64.toString() }, pin)).toThrow("unsigned_domain");
    expect(() => encodeFunctionData({ abi: zeroSeedAbi, functionName: "create", args: [{ ...abiParameters(base), decayFactor: Q64 }] })).toThrow();
  });
});

describe("executed local router swaps: emitted rate and fee equal the MCP schedule", () => {
  type Vector = (typeof router.vectors)[number];
  const launchFor = (vector: Vector) => router.launches[vector.label as "l1" | "l3"];
  const scheduleFor = (vector: Vector) => {
    const l = launchFor(vector);
    return schedule(BigInt(l.initial_fee), BigInt(l.fee_duration), BigInt(l.decay_factor), BigInt(l.final_fee), BigInt(l.trading_start));
  };
  for (const vector of router.vectors) {
    test(`${vector.label} ${vector.sell ? "sell" : "buy"} ${vector.exactOut ? "exact-out" : "exact-in"}`, () => {
      const event = vector.launchSwapped;
      const rate = feeAt(scheduleFor(vector), BigInt(vector.input.time));
      expect(rate.toString()).toBe(event.rate);
      const withFee = BigInt(event.feeIsToken1 ? event.delta1 : event.delta0);
      const calculated = withFee - BigInt(event.feeAmount);
      expect(feeInclusiveDelta({ calculated, rate, exactOut: vector.exactOut })).toEqual({ fee: BigInt(event.feeAmount), withFee });

      const swap = vector.response.splits[0].route[0].swap;
      const specified = vector.input.specified_token.toLowerCase();
      const pin = LOCAL_INSTANCE_PINS[vector.label === "l1" ? 0 : 1];
      const pool = { token0: swap.pool_key.token0.toLowerCase(), token1: swap.pool_key.token1.toLowerCase(), config: swap.pool_key.config };
      const l = launchFor(vector);
      const prepared = localSwapFromQuote({
        pin, recipient: router.recipient as Address,
        request: { amount: vector.input.amount, specified_token: specified, other_token: [pool.token0, pool.token1].find((t) => t !== specified),
          extension: pin.address, ...(vector.exactOut ? { max_input: vector.response.total_calculated } : { min_output: vector.response.total_calculated }),
          deadline: String(vector.input.time) },
        response: vector.response,
        context: { blockNumber: String(vector.input.block_number), blockHash: vector.input.block_hash, blockTime: String(vector.input.time) },
        launch: { pool_key: pool, fee_schedule: { trading_start: Number(l.trading_start), fee_duration: Number(l.fee_duration),
          initial_fee: l.initial_fee, final_fee: l.final_fee, decay_factor: l.decay_factor } },
      }, BigInt(vector.input.time));
      expect(prepared.creator_fee).toMatchObject({ rate_q64: event.rate, phase: "fee_decay", evaluated_at: String(vector.input.time) });
      expect(prepared.data).toBe(vector.calldata.toLowerCase() as `0x${string}`);
    });
  }
});

describe("draft ABI encoding equals independent cast calldata", () => {
  // cast calldata of the fixture launch against the compiled b1cbb1c ABI (keccak256 pinned).
  const parameters = {
    quoteToken: "0xffffffffffffffffffffffffffffffffffffffff", name: "Zero Seed l1", symbol: "L1", decimals: 18,
    supply: "999999999999999999999999210", liquidity: "1111119116089565312897934", askTick: -13815500, upperTick: -9210300,
    tickSpacing: 100, tradingStart: "1000", feeDuration: 3600, initialFee: "922337203685477580", finalFee: "55340232221128654",
    decayFactor: "18425445863997925462", salt: `0x${"00".repeat(31)}01`,
  };
  test("create", () => {
    const data = createData(parameters);
    expect(data.slice(0, 10)).toBe("0xd5f50468");
    expect(keccak256(data)).toBe("0x38b58bea73df3a032ae0c96890e6cd31fda6bb1b6509ef3af09650dfac63ebb3");
  });
  test("previewInstallation", () => {
    const data = previewData("0x70997970c51812dc3a010c7d01b50e0d17dc79c8", parameters);
    expect(data.slice(0, 10)).toBe("0x5283ac38");
    expect(keccak256(data)).toBe("0xd255ccf1611777aac230a81aae8d29319d0e3d85a8d8a0091d4cbad4a443e94a");
  });
});
