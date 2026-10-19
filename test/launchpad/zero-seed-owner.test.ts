import { describe, expect, test } from "bun:test";
import { type Address, decodeFunctionData, type Hex, keccak256, stringToHex, zeroAddress } from "viem";
import { zeroSeedAbi } from "../../src/launchpad/zero-seed/abi.js";
import { claimStatements, createStatements } from "../../src/launchpad/zero-seed/disclosures.js";
import { decodeOwnerClaim, decodeOwnerCreate, feePercent, localClaimBody, localCreateBody, type Sealed } from "../../src/launchpad/zero-seed/owner.js";
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
    expect(summary).toMatchObject({ schema_version: "zero-seed-launch-owner-summary/v1", chain_id: "31337",
      target: pin.address, selector: "0xe11b98da", method: "create" });
    const installed = f.installation.installedSupply.toString();
    expect(summary.fields).toMatchObject({ creator, supply: installed, liquidity: f.installation.liquidity.toString(),
      trading_start: 1300, initial_fee_percent: "5.0000%", final_fee_percent: "0.3000%" });
    expect(summary.fields.binding).toMatchObject({ requested_supply: request(pin).supply, installed_supply: installed,
      launch_token_is_token1: BigInt(f.installation.token) > BigInt(pin.quote), preview_count: 1, execution_guaranteed: false });
    expect(summary.fields.rounding.upper_residue.claimable_principal).toBe(false);
    expect(summary.fields.rounding.core_unbooked_dust.per_asset).toEqual(["launch_token", "quote_token"]);
    expect(summary.statements).toHaveLength(5);
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
      (b: any) => { b.schema_version = "zero-seed-local-create/v0"; }, (b: any) => { b.preview.count = 2; }]) {
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

describe("owner statements and rates", () => {
  test("Q0.64 rates round half up to four decimals", () => {
    expect(feePercent(922337203685477580n)).toBe("5.0000%");
    expect(feePercent(55340232221128654n)).toBe("0.3000%");
    expect(feePercent(0n)).toBe("0.0000%");
    expect(feePercent((1n << 64n) - 1n)).toBe("100.0000%");
    expect(feePercent(922337203685477n)).toBe("0.0050%");
  });

  test("statements match the frozen owner-summary examples byte for byte", () => {
    expect(createStatements({ installedSupply: "999999999999999999999999210", initialFeePercent: "5.0000%",
      finalFeePercent: "0.3000%", feeDuration: "3600", tradingStart: new Date(1800000100 * 1000).toISOString(),
      creator: "0x00000000000000000000000000000000c0ffee01" })).toEqual([
      "Zero initial bid: the pool starts with no quote token. Until someone buys, selling the launch token fills nothing.",
      "Buyer-funded quote reserve: the only quote in the pool is what buyers pay in. Sells can withdraw only that quote.",
      "Permanent principal lock: the whole supply (999999999999999999999999210 raw units) goes into one position that nobody, including you, can withdraw, rebalance, migrate or refund. Quote that buyers pay in is locked in it too.",
      "Creator fee: 5.0000% falling linearly to 0.3000% over 3600 s from trading start 2027-01-15T08:01:40.000Z, then 0.3000% for good. It goes to a separate fee ledger that only 0x00000000000000000000000000000000c0ffee01 (this account) can claim and cannot transfer.",
      "No exit guarantee: there is no buyer of last resort, no refund and no admin rescue. The price can fall back to the ask.",
    ]);
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
