import { describe, expect, test } from "bun:test";
import { type Address, decodeFunctionData, encodeFunctionData, type Hex, keccak256, parseAbi, stringToHex, zeroAddress } from "viem";
import { zeroSeedAbi } from "../../src/launchpad/zero-seed/abi.js";
import { claimStatements, createStatements } from "../../src/launchpad/zero-seed/disclosures.js";
import { decodeOwnerClaim, decodeOwnerCreate, feePercent, localClaimBody, localCreateBody, type Sealed } from "../../src/launchpad/zero-seed/owner.js";
import { excessHalvingTime, feeAt } from "../../src/launchpad/zero-seed/fee.js";
import { abiParameters } from "../../src/launchpad/zero-seed/installation.js";
import { LOCAL_INSTANCE_PINS } from "../../src/launchpad/zero-seed/policy.js";
import { creator, fixture, request } from "./zero-seed-fixture.js";

const reseal = (body: string): Sealed =>
  ({ body, integrity: keccak256(stringToHex(body)), bytes: new TextEncoder().encode(body).length });
const edit = (sealed: Sealed, change: (body: Record<string, any>) => void) => {
  const body = JSON.parse(sealed.body);
  change(body);
  return reseal(JSON.stringify(body));
};

async function created(pin = LOCAL_INSTANCE_PINS[0]) {
  const f = fixture(pin);
  const preview = await f.run();
  return { f, preview, sealed: localCreateBody(preview), expected: { pin, creator, requested: request(pin) } };
}

describe("opaque owner decoder: create (synthetic local, non-executable)", () => {
  for (const pin of LOCAL_INSTANCE_PINS) test(`summarizes the installed pair from calldata, quote ${pin.quote}`, async () => {
    const { f, sealed, expected } = await created(pin);
    const summary = decodeOwnerCreate(sealed, expected, 1000n);
    expect(summary).toMatchObject({ schema_version: "zero-seed-launch-owner-summary/v2", chain_id: "31337",
      target: pin.address, selector: "0xd5f50468", method: "create", disclosure: { version: 3, status: "draft_not_approved" } });
    const installed = f.installation.installedSupply.toString();
    expect(summary.fields).toMatchObject({ creator, supply: installed, liquidity: f.installation.liquidity.toString(),
      trading_start: 1300, initial_fee_percent: "5.0000%", final_fee_percent: "0.3000%", decay_factor: "18425445863997925462" });
    expect(summary.fields.binding).toMatchObject({ requested_supply: request(pin).supply, installed_supply: installed,
      launch_token_is_token1: BigInt(f.installation.token) > BigInt(pin.quote), preview_count: 1, execution_guaranteed: false });
    expect(summary.fields.rounding.upper_residue.claimable_principal).toBe(false);
    expect(summary.fields.rounding.core_unbooked_dust.per_asset).toEqual(["launch_token", "quote_token"]);
    expect(summary.statements).toHaveLength(8);
    expect(summary.statements[2]).toContain(`(${installed} raw units)`);
    const call = decodeFunctionData({ abi: zeroSeedAbi, data: JSON.parse(sealed.body).data as Hex });
    expect(call.functionName === "create" && call.args[0].supply).toBe(f.installation.installedSupply);
    expect(JSON.parse(sealed.body)).toMatchObject({ scope: "synthetic-local-non-executable", executable: false });
    expect(sealed.body).not.toContain("execution_plan");
  });

  test("tampered, truncated or relabelled bytes refuse", async () => {
    const { sealed, expected } = await created();
    expect(() => decodeOwnerCreate({ ...sealed, body: sealed.body.replace("31337", "313370") }, expected, 1000n)).toThrow("artifact_length_mismatch");
    expect(() => decodeOwnerCreate({ ...sealed, body: sealed.body.replace('"0"', '"1"') }, expected, 1000n)).toThrow("artifact_tampered");
    expect(() => decodeOwnerCreate({ ...sealed, bytes: sealed.bytes + 1 }, expected, 1000n)).toThrow("artifact_length_mismatch");
    expect(() => decodeOwnerCreate(reseal(` ${sealed.body}`), expected, 1000n)).toThrow("artifact_noncanonical");
    for (const change of [(b: any) => { b.executable = true; }, (b: any) => { b.extra = 1; },
      (b: any) => { b.schema_version = "zero-seed-local-create/v1"; }, (b: any) => { b.disclosure_version = 2; },
      (b: any) => { delete b.disclosure_version; }, (b: any) => { delete b.requested.decayFactor; }, (b: any) => { b.preview.count = 2; }]) {
      expect(() => decodeOwnerCreate(edit(sealed, change), expected, 1000n)).toThrow("artifact_schema_mismatch");
    }
  });

  test("calldata that differs from the bound installation refuses", async () => {
    const { f, sealed, expected } = await created();
    const other = localCreateBody({ ...(await f.run()), actual: { ...request(f.pin), supply: "5", liquidity: "7" } });
    const swapped = edit(sealed, (b) => { b.data = JSON.parse(other.body).data; });
    expect(() => decodeOwnerCreate(swapped, expected, 1000n)).toThrow("calldata_summary_mismatch");
    const trailing = edit(sealed, (b) => { b.data = `${b.data}00`; });
    expect(() => decodeOwnerCreate(trailing, expected, 1000n)).toThrow("calldata_noncanonical");
  });

  test("requested intent, creator, pin and pair are bound", async () => {
    const { f, sealed, expected } = await created();
    expect(() => decodeOwnerCreate(sealed, { ...expected, requested: { ...expected.requested, supply: "1" } }, 1000n)).toThrow("requested_mismatch");
    expect(() => decodeOwnerCreate(sealed, { ...expected, requested: { ...expected.requested, tradingStart: "1301" } }, 1000n)).toThrow("requested_mismatch");
    expect(() => decodeOwnerCreate(sealed, { ...expected, creator: zeroAddress }, 1000n)).toThrow("creator_mismatch");
    expect(() => decodeOwnerCreate(sealed, { ...expected, pin: LOCAL_INSTANCE_PINS[1] }, 1000n)).toThrow("pin_mismatch");
    expect(() => decodeOwnerCreate(edit(sealed, (b) => { b.pin.runtime = `0x${"00".repeat(32)}`; }), expected, 1000n)).toThrow("launch_support_disabled");
    const pair = edit(sealed, (b) => { b.installation.poolKey = { ...b.installation.poolKey, token0: b.installation.poolKey.token1, token1: b.installation.poolKey.token0 }; });
    expect(() => decodeOwnerCreate(pair, expected, 1000n)).toThrow("preview_pair_mismatch");
    const supply = edit(sealed, (b) => { b.installation.installedSupply = (f.installation.installedSupply - 1n).toString(); });
    expect(() => decodeOwnerCreate(supply, expected, 1000n)).toThrow("calldata_summary_mismatch");
  });

  for (const now of [999n, 1299n, 1300n]) test(`fresh time ${now} outside [build, expiry) refuses`, async () => {
    const { sealed, expected } = await created();
    expect(() => decodeOwnerCreate(sealed, expected, now)).toThrow("expired_or_future_plan");
  });
  test("last fresh second before expiry accepts", async () => {
    const { sealed, expected } = await created();
    expect(decodeOwnerCreate(sealed, expected, 1298n).method).toBe("create");
  });
});

describe("owner summary binds the encoded fee schedule (draft exponential decay)", () => {
  test("factor, fees and duration come from the calldata, with the exact schedule", async () => {
    const { sealed, expected } = await created();
    const summary = decodeOwnerCreate(sealed, expected, 1000n);
    const call = decodeFunctionData({ abi: zeroSeedAbi, data: JSON.parse(sealed.body).data as Hex });
    if (call.functionName !== "create") throw new Error("create");
    const p = call.args[0];
    expect([summary.fields.decay_factor, summary.fields.initial_fee, summary.fields.final_fee, summary.fields.fee_duration])
      .toEqual([p.decayFactor.toString(), p.initialFee.toString(), p.finalFee.toString(), p.feeDuration]);
    const schedule = { tradingStart: p.tradingStart, feeDuration: BigInt(p.feeDuration), initialFee: p.initialFee,
      finalFee: p.finalFee, decayFactor: p.decayFactor };
    const fee = summary.fields.fee_schedule;
    expect(fee).toMatchObject({ curve: "endpoint_normalized_exponential", decay_factor: p.decayFactor.toString(),
      effective_cliff: false, exact_output_multiplier_at_initial: "1.05",
      current: { evaluated_at: 1000, phase: "before_trading_start", fee_q64: p.initialFee.toString(), fee_percent: "5.0000%" } });
    expect(fee.excess_halving_seconds).toBe(Number(excessHalvingTime(schedule)));
    expect(fee.samples.map((s) => s.elapsed)).toEqual([0, 1, 10, 60, 600, 1800, 3599, 3600]);
    for (const sample of fee.samples) expect(sample.fee_q64).toBe(feeAt(schedule, p.tradingStart + BigInt(sample.elapsed)).toString());
    expect(fee.samples.at(-1)!.fee_q64).toBe(p.finalFee.toString());
    expect(summary.statements[3]).toContain(`factor ${p.decayFactor} / 2^64`);
    expect(summary.statements[3]).toContain(`falls to half or less ${fee.excess_halving_seconds} s`);
    expect(summary.fields.binding.calldata_keccak256).toBe(keccak256(JSON.parse(sealed.body).data));
    const { summary_keccak256: hash, ...rest } = summary;
    expect(hash).toBe(keccak256(stringToHex(JSON.stringify(rest))));
  });

  test("a different factor, fee or duration in the calldata refuses", async () => {
    const { f, sealed, expected } = await created();
    const preview = await f.run();
    for (const change of [{ decayFactor: "18319323104848571946" }, { initialFee: "922337203685477581" }, { feeDuration: 600 }]) {
      const other = localCreateBody({ ...preview, actual: { ...preview.actual, ...change } });
      expect(() => decodeOwnerCreate(edit(sealed, (b) => { b.data = JSON.parse(other.body).data; }), expected, 1000n)).toThrow("calldata_summary_mismatch");
    }
    expect(() => decodeOwnerCreate(sealed, { ...expected, requested: { ...expected.requested, decayFactor: "1" } }, 1000n)).toThrow("requested_mismatch");
  });

  test("old-tuple calldata cannot be accepted as the new encoding", async () => {
    const { sealed, expected } = await created();
    const legacy = parseAbi(["function create((address,string,string,uint8,uint128,uint128,int32,int32,uint32,uint64,uint32,uint64,uint64,bytes32))"]);
    const { decayFactor: _, ...old } = abiParameters(request(LOCAL_INSTANCE_PINS[0]));
    const data = encodeFunctionData({ abi: legacy, functionName: "create", args: [Object.values(old) as never] });
    expect(data.slice(0, 10)).toBe("0xe11b98da");
    expect(() => decodeOwnerCreate(edit(sealed, (b) => { b.data = data; }), expected, 1000n)).toThrow("unsupported_selector");
  });

  test("summaries for different factors differ in hash and statements", async () => {
    const one = await created();
    const s1 = decodeOwnerCreate(one.sealed, one.expected, 1000n);
    const pin = LOCAL_INSTANCE_PINS[0];
    const requested = { ...request(pin), decayFactor: "18319323104848571946" };
    const f = fixture(pin);
    const preview = await f.run(requested);
    const s2 = decodeOwnerCreate(localCreateBody(preview), { pin, creator, requested }, 1000n);
    expect(s2.summary_keccak256).not.toBe(s1.summary_keccak256);
    expect(s2.statements[3]).not.toBe(s1.statements[3]);
  });
});

describe("owner statements and rates", () => {
  test("Q0.64 rates round half up to four decimals", () => {
    expect(feePercent(922337203685477580n)).toBe("5.0000%");
    expect(feePercent(55340232221128654n)).toBe("0.3000%");
    expect(feePercent(0n)).toBe("0.0000%");
    expect(feePercent((1n << 64n) - 1n)).toBe("100.0000%");
    expect(feePercent(922337203685477n)).toBe("0.0050%");
  });

  test("v3 draft statements for the 50% study candidate, byte for byte", () => {
    expect(createStatements({ installedSupply: "999999999999999999999999210", initialFeePercent: "50.0000%",
      finalFeePercent: "0.3000%", feeDuration: "3600", tradingStart: new Date(1800000100 * 1000).toISOString(),
      decayFactor: "18425445863997925462", excessHalvingSeconds: "587", exactOutputMultiplier: "2.00",
      creator: "0x00000000000000000000000000000000c0ffee01" })).toEqual([
      "Zero initial bid: the pool starts with no quote token. Until someone buys, selling the launch token fills nothing.",
      "Buyer-funded quote reserve: the only quote in the pool is what buyers pay in. Sells can withdraw only that quote.",
      "Permanent principal lock: the whole supply (999999999999999999999999210 raw units) goes into one position that nobody, including you, can withdraw, rebalance, migrate or refund. Quote that buyers pay in is locked in it too.",
      "Creator fee: 50.0000% at trading start 2027-01-15T08:01:40.000Z, decaying along an exponential rescaled to reach exactly 0.3000% after 3600 s, then 0.3000% for good. The curve is set by the literal per-second factor 18425445863997925462 / 2^64. It is not linear and 18425445863997925462 is not a half-life: the excess over 0.3000% first falls to half or less 587 s after trading start. The fee is taken on the calculated side of every swap and goes to a separate fee ledger that only 0x00000000000000000000000000000000c0ffee01 (this account) can claim and cannot transfer.",
      "Creator recapture: every fee goes to 0x00000000000000000000000000000000c0ffee01. When the creator, or anyone buying for it, trades, it gets that fee back through its claim: on an exact-input buy at 50.0000% it can end up with the whole pre-fee output, while anyone else making the same trade gets only the net. The fee cannot tell creators, snipers and honest buyers apart.",
      "High early fee: near 50.0000%, a swap can deliver a negligible or zero amount after the fee, and an immediate round trip pays the fee twice plus price impact. A high starting fee is not protection against snipers and does not promise that anyone avoids a loss.",
      "Exact-output gross-up: for a fixed output, the input paid is the pre-fee input times 1 / (1 - fee), about 2.00x at 50.0000%, which grows much faster than the fee itself. Large amounts at high fees revert on overflow. Always set a minimum output or a maximum input.",
      "No exit guarantee: there is no buyer of last resort, no refund and no admin rescue. The price can fall back to the ask.",
    ]);
    const all = createStatements({ installedSupply: "1", initialFeePercent: "5.0000%", finalFeePercent: "0.3000%", feeDuration: "3600",
      tradingStart: "t", decayFactor: "1", excessHalvingSeconds: "1", exactOutputMultiplier: "1.05", creator: "c" }).join(" ");
    for (const promise of ["linearly", "half-life of", "protects", "no loss", "guarantee"]) {
      expect(all.replace("No exit guarantee", "")).not.toContain(promise);
    }
    expect(createStatements({ installedSupply: "1", initialFeePercent: "0.3000%", finalFeePercent: "0.3000%", feeDuration: "3600",
      tradingStart: "t", decayFactor: "1", excessHalvingSeconds: "none", exactOutputMultiplier: "1.00", creator: "c" })[3])
      .toContain("The fee is flat: initial and final are both 0.3000%.");
    expect(claimStatements("0x00000000000000000000000000000000c0ffee02")).toEqual([
      "Withdraws the whole two-asset creator fee ledger of this launch to 0x00000000000000000000000000000000c0ffee02. It never touches the locked principal.",
      "Only the creator account can claim; the fee right cannot be transferred.",
    ]);
  });
});

describe("opaque owner decoder: claim (synthetic local, non-executable)", () => {
  const pin = LOCAL_INSTANCE_PINS[0];
  const launch = "0x1000000000000000000000000000000000000000";
  const poolKey = { token0: launch, token1: pin.quote, config: `0x${pin.address.slice(2)}${"00".repeat(8)}80000064` };
  const recipient = "0x00000000000000000000000000000000c0ffee02" as Address;
  const build = { buildTime: "1000", executionExpiry: "1300" };
  const claim = (to: Address = recipient) => localClaimBody({ creator, pin, poolKey, recipient: to, build });

  test("summarizes an atomic full two-asset claim", () => {
    const summary = decodeOwnerClaim(claim(), { pin, creator }, 1000n);
    expect(summary).toMatchObject({ selector: "0x6906b4c0", method: "claimFees", target: pin.address,
      fields: { pool_key: poolKey, recipient, settlement: { atomic: true, partial_claim: false, execution_guaranteed: false } } });
    expect(summary.statements).toEqual(claimStatements(recipient));
  });

  test("claim sinks are exactly zero/Core/extension/token0/token1", () => {
    for (const sink of [zeroAddress, pin.core, pin.address, poolKey.token0, poolKey.token1]) {
      expect(() => claim(sink as Address)).toThrow("invalid_recipient");
    }
  });

  test("tampered recipient, foreign pool and expiry refuse", () => {
    const sealed = claim();
    expect(() => decodeOwnerClaim(edit(sealed, (b) => { b.recipient = `0x${"77".repeat(20)}`; }), { pin, creator }, 1000n)).toThrow("calldata_summary_mismatch");
    expect(() => decodeOwnerClaim(edit(sealed, (b) => { b.pool_key.config = `0x${"99".repeat(20)}${"00".repeat(8)}80000064`; }), { pin, creator }, 1000n)).toThrow("pool_extension_mismatch");
    expect(() => decodeOwnerClaim(sealed, { pin, creator }, 1300n)).toThrow("expired_or_future_plan");
    expect(() => decodeOwnerClaim(sealed, { pin, creator }, 999n)).toThrow("expired_or_future_plan");
    expect(() => decodeOwnerClaim({ ...sealed, integrity: `0x${"00".repeat(32)}` }, { pin, creator }, 1000n)).toThrow("artifact_tampered");
  });
});
