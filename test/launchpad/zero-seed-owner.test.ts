import { describe, expect, test } from "bun:test";
import { type Address, decodeFunctionData, encodeFunctionData, type Hex, keccak256, parseAbi, stringToHex, zeroAddress } from "viem";
import { peripheryAbi } from "../../src/launchpad/zero-seed/abi.js";
import { claimStatements, createStatements, transferStatements } from "../../src/launchpad/zero-seed/disclosures.js";
import { decayQ128, excessHalvingTime, feeAt } from "../../src/launchpad/zero-seed/fee.js";
import { abiParameters, createData } from "../../src/launchpad/zero-seed/installation.js";
import { decodeOwnerClaim, decodeOwnerCreate, feePercent, localClaimBody, localCreateBody, poolIdOf,
  type Sealed } from "../../src/launchpad/zero-seed/owner.js";
import { launchSalts } from "../../src/launchpad/zero-seed/token.js";
import { chain, ERC20_QUOTE, fixture, freshTime, KINDS, type Kind, launchOf, owner, pin, quoteOf, request } from "./zero-seed-fixture.js";

const reseal = (body: string): Sealed =>
  ({ body, integrity: keccak256(stringToHex(body)), bytes: new TextEncoder().encode(body).length });
const edit = (sealed: Sealed, change: (body: Record<string, any>) => void) => {
  const body = JSON.parse(sealed.body);
  change(body);
  return reseal(JSON.stringify(body));
};

async function created(kind: Kind = "native") {
  const f = fixture(kind);
  const preview = await f.run();
  return { f, preview, sealed: localCreateBody(preview), expected: { pin, owner, requested: request(kind) } };
}
const B = BigInt(launchOf("native").build.buildTime);
const SINK = { native: "578", erc20: "790" } as const;

describe("opaque owner decoder: periphery create (local, non-executable)", () => {
  for (const kind of KINDS) test(`reproduces the recorded artifact and summary byte for byte (${kind})`, async () => {
    const { sealed, expected } = await created(kind);
    expect(sealed).toEqual(launchOf(kind).sealed as Sealed);
    const summary = decodeOwnerCreate(sealed, expected, freshTime(kind));
    expect(summary).toEqual(launchOf(kind).owner_summary as never);
  });

  for (const kind of KINDS) test(`targets the periphery with the requested supply and shows the split (${kind})`, async () => {
    const { f, sealed, expected } = await created(kind);
    const summary = decodeOwnerCreate(sealed, expected, freshTime(kind));
    expect(summary).toMatchObject({ schema_version: "zero-seed-launch-owner-summary/v4", chain_id: "31337",
      target: pin.periphery, selector: "0x662af306", method: "create", disclosure: { version: 5, status: "draft_not_approved" } });
    const requested = request(kind).supply;
    const installed = f.installation.installedSupply.toString();
    expect(summary.fields.supply).toEqual({ requested, installed, sink: SINK[kind], sink_holder: zeroAddress });
    expect(summary.fields).toMatchObject({ owner, liquidity: f.installation.liquidity.toString(),
      initial_fee_percent: "5.0000%", final_fee_percent: "0.3000%",
      instance: { core: pin.core, extension: pin.extension, periphery: pin.periphery, controller: pin.periphery, deployment_block: "2" },
      ownership: { initial_owner: owner, recorded_by: pin.periphery, transferable: true, claims_by: "current_owner" },
      rounding: { supply_remainder: { asset: "launch_token", amount: SINK[kind], holder: zeroAddress, spendable: false,
        counted_in_total_supply: true } } });
    expect(summary.fields.quote).toEqual(kind === "native"
      ? { kind: "native", address: zeroAddress, decimals: 18, runtime: null, wrapping: false, approval: false }
      : { kind: "erc20", address: ERC20_QUOTE, decimals: null, runtime: chain.erc20_quote.runtime, wrapping: false, approval: true });
    expect(summary.fields).not.toHaveProperty("decay_factor");
    expect(summary.fields).not.toHaveProperty("quote_token");
    expect(summary.fields.binding).toMatchObject({ requested_supply: requested, installed_supply: installed, sink_supply: SINK[kind],
      calldata_supply: requested, installed_liquidity: f.installation.liquidity.toString(),
      launch_token_is_token1: kind === "native", pool_id: poolIdOf(f.recorded.preview.installation.poolKey), preview_count: 1,
      execution_guaranteed: false });
    const salts = launchSalts(owner, pin.periphery as Address, request(kind).salt as Hex);
    expect(summary.fields.salt).toEqual({ owner_salt: request(kind).salt, owner_namespaced: salts.ownerSalt, token_create2: salts.tokenSalt });
    expect(summary.statements).toHaveLength(9);
    expect(summary.statements[2]).toContain(`of the total supply of ${requested} raw units, ${installed} go into one position`);
    expect(summary.statements[2]).toContain(`rounding remainder of ${SINK[kind]} is minted to address(0)`);
    const call = decodeFunctionData({ abi: peripheryAbi, data: JSON.parse(sealed.body).data as Hex });
    if (call.functionName !== "create") throw new Error("create");
    expect(call.args[0].supply).toBe(BigInt(requested));
    expect(call.args[0].quoteToken.toLowerCase()).toBe(quoteOf(kind));
    expect(JSON.parse(sealed.body)).toMatchObject({ schema_version: "zero-seed-local-create/v4", scope: "synthetic-local-non-executable",
      executable: false, value: "0", quote: { address: quoteOf(kind), kind } });
    expect(sealed.body).not.toContain("execution_plan");
  });

  test("calldata carrying the installed supply instead of the requested one refuses", async () => {
    const { f, sealed, expected } = await created("native");
    const rewritten = createData({ ...request("native"), supply: f.installation.installedSupply.toString() });
    expect(() => decodeOwnerCreate(edit(sealed, (b) => { b.data = rewritten; }), expected, freshTime())).toThrow("calldata_summary_mismatch");
    const otherQuote = createData({ ...request("native"), quoteToken: ERC20_QUOTE });
    expect(() => decodeOwnerCreate(edit(sealed, (b) => { b.data = otherQuote; }), expected, freshTime())).toThrow("calldata_summary_mismatch");
  });

  test("an unreviewed or relabelled quote refuses", async () => {
    const { sealed, expected } = await created("erc20");
    const now = freshTime("erc20");
    const runtime = edit(sealed, (b) => { b.quote.runtime = `0x${"00".repeat(32)}`; });
    expect(() => decodeOwnerCreate(runtime, expected, now)).toThrow("unsupported_quote");
    const relabelled = edit(sealed, (b) => { b.quote = { kind: "native", address: zeroAddress, runtime: null }; });
    expect(() => decodeOwnerCreate(relabelled, expected, now)).toThrow("unsupported_quote");
    const foreign = { ...request("erc20"), quoteToken: "0x00000000000000000000000000000000000000aa" };
    const unreviewed = edit(sealed, (b) => { b.requested.quoteToken = foreign.quoteToken; b.data = createData(foreign); });
    expect(() => decodeOwnerCreate(unreviewed, { ...expected, requested: foreign }, now)).toThrow("unsupported_quote");
  });

  test("the summary's pool id and initial owner equal the chain's creation events", async () => {
    const { sealed, expected } = await created();
    const summary = decodeOwnerCreate(sealed, expected, freshTime());
    const events = chain.launches.native.events;
    const created_ = events.find((e) => e.event === "LaunchCreated")!;
    const ownerChanged = events.find((e) => e.event === "LaunchOwnerChanged")!;
    expect(created_.args.poolId).toBe(summary.fields.binding.pool_id);
    expect(created_.args.controller).toBe(summary.fields.instance.controller);
    expect(ownerChanged.args).toEqual({ poolId: summary.fields.binding.pool_id, previousOwner: zeroAddress, newOwner: owner });
  });

  test("tampered, truncated or relabelled bytes refuse", async () => {
    const { sealed, expected } = await created();
    const now = freshTime();
    expect(() => decodeOwnerCreate({ ...sealed, body: sealed.body.replace("31337", "313370") }, expected, now)).toThrow("artifact_length_mismatch");
    expect(() => decodeOwnerCreate({ ...sealed, body: sealed.body.replace('"value":"0"', '"value":"1"') }, expected, now)).toThrow("artifact_tampered");
    expect(() => decodeOwnerCreate({ ...sealed, bytes: sealed.bytes + 1 }, expected, now)).toThrow("artifact_length_mismatch");
    expect(() => decodeOwnerCreate(reseal(` ${sealed.body}`), expected, now)).toThrow("artifact_noncanonical");
    for (const change of [(b: any) => { b.executable = true; }, (b: any) => { b.extra = 1; },
      (b: any) => { b.schema_version = "zero-seed-local-create/v3"; }, (b: any) => { b.disclosure_version = 4; },
      (b: any) => { b.value = "1"; }, (b: any) => { b.requested.decayFactor = "1"; }, (b: any) => { b.requested.liquidity = "0"; },
      (b: any) => { b.pin.quote = zeroAddress; }, (b: any) => { delete b.quote; },
      (b: any) => { delete b.pin.periphery; }, (b: any) => { b.preview.count = 2; }]) {
      expect(() => decodeOwnerCreate(edit(sealed, change), expected, now)).toThrow("artifact_schema_mismatch");
    }
  });

  test("calldata that differs from the bound installation refuses", async () => {
    const { f, sealed, expected } = await created();
    const other = localCreateBody({ ...(await f.run()), requested: { ...request(), supply: "5" } });
    const swapped = edit(sealed, (b) => { b.data = JSON.parse(other.body).data; });
    expect(() => decodeOwnerCreate(swapped, expected, freshTime())).toThrow("calldata_summary_mismatch");
    const trailing = edit(sealed, (b) => { b.data = `${b.data}00`; });
    expect(() => decodeOwnerCreate(trailing, expected, freshTime())).toThrow("calldata_noncanonical");
  });

  test("requested intent, owner, pin and pair are bound", async () => {
    const { f, sealed, expected } = await created();
    const now = freshTime();
    expect(() => decodeOwnerCreate(sealed, { ...expected, requested: { ...expected.requested, supply: "1" } }, now)).toThrow("requested_mismatch");
    expect(() => decodeOwnerCreate(sealed, { ...expected, owner: zeroAddress }, now)).toThrow("owner_mismatch");
    expect(() => decodeOwnerCreate(sealed, { ...expected, owner: chain.accounts.buyer as Address }, now)).toThrow("owner_mismatch");
    expect(() => decodeOwnerCreate(sealed, { ...expected, pin: { ...pin, deploymentBlock: "3" } }, now)).toThrow("pin_mismatch");
    const runtime = edit(sealed, (b) => { b.pin.extensionRuntime = `0x${"00".repeat(32)}`; });
    expect(() => decodeOwnerCreate(runtime, expected, now)).toThrow("launch_support_disabled");
    const crossed = edit(sealed, (b) => { b.pin.periphery = `0x${"77".repeat(20)}`; });
    expect(() => decodeOwnerCreate(crossed, expected, now)).toThrow("launch_support_disabled");
    const target = edit(sealed, (b) => { b.target = b.pin.extension; });
    expect(() => decodeOwnerCreate(target, expected, now)).toThrow("target_mismatch");
    const pair = edit(sealed, (b) => { b.installation.poolKey = { ...b.installation.poolKey, token0: b.installation.poolKey.token1, token1: b.installation.poolKey.token0 }; });
    expect(() => decodeOwnerCreate(pair, expected, now)).toThrow("preview_pair_mismatch");
    const extension = edit(sealed, (b) => { b.installation.poolKey.config = `0x${"51".repeat(20)}${b.installation.poolKey.config.slice(42)}`; });
    expect(() => decodeOwnerCreate(extension, expected, now)).toThrow("preview_geometry_mismatch");
    // The installed amounts are display only: changing them changes the summary, never the calldata.
    const supply = edit(sealed, (b) => { b.installation.installedSupply = (BigInt(request().supply) + 1n).toString(); });
    expect(() => decodeOwnerCreate(supply, expected, now)).toThrow("invalid_installation_amounts");
    expect(f.installation.installedSupply).toBeLessThan(BigInt(request().supply));
  });

  for (const now of [B - 1n, B + 300n, B + 301n]) test(`fresh time ${now} outside [build, expiry) refuses`, async () => {
    const { sealed, expected } = await created();
    expect(() => decodeOwnerCreate(sealed, expected, now)).toThrow("expired_or_future_plan");
  });
  test("last fresh second before expiry accepts", async () => {
    const { sealed, expected } = await created();
    expect(decodeOwnerCreate(sealed, expected, B + 299n).method).toBe("create");
  });
});

describe("owner summary binds the fixed-half-life fee schedule", () => {
  test("fees and duration come from the calldata, with the exact schedule", async () => {
    const { sealed, expected } = await created();
    const summary = decodeOwnerCreate(sealed, expected, freshTime());
    const call = decodeFunctionData({ abi: peripheryAbi, data: JSON.parse(sealed.body).data as Hex });
    if (call.functionName !== "create") throw new Error("create");
    const p = call.args[0];
    expect([summary.fields.initial_fee, summary.fields.final_fee, summary.fields.fee_duration])
      .toEqual([p.initialFee.toString(), p.finalFee.toString(), p.feeDuration]);
    const schedule = { tradingStart: p.tradingStart, feeDuration: BigInt(p.feeDuration), initialFee: p.initialFee, finalFee: p.finalFee };
    const fee = summary.fields.fee_schedule;
    expect(fee).toMatchObject({ curve: "fixed_half_life_endpoint_normalized", half_life_seconds: 600,
      endpoint_decay_q128: decayQ128(3600n).toString(), effective_cliff: false, exact_output_multiplier_at_initial: "1.05",
      current: { evaluated_at: Number(B), phase: "before_trading_start", fee_q64: p.initialFee.toString(), fee_percent: "5.0000%" } });
    expect(fee.excess_halving_seconds).toBe(Number(excessHalvingTime(schedule)));
    expect(fee.samples.map((s) => s.elapsed)).toEqual([0, 1, 10, 60, 600, 1800, 3599, 3600]);
    for (const sample of fee.samples) expect(sample.fee_q64).toBe(feeAt(schedule, p.tradingStart + BigInt(sample.elapsed)).toString());
    expect(fee.samples.at(-1)!.fee_q64).toBe(p.finalFee.toString());
    expect(summary.statements[3]).toContain("fixed 600 s half-life");
    expect(summary.statements[3]).toContain(`falls to half or less ${fee.excess_halving_seconds} s`);
    expect(summary.fields.binding.calldata_keccak256).toBe(keccak256(JSON.parse(sealed.body).data));
    const { summary_keccak256: hash, ...rest } = summary;
    expect(hash).toBe(keccak256(stringToHex(JSON.stringify(rest))));
  });

  test("a different fee or duration in the calldata refuses", async () => {
    const { f, sealed, expected } = await created();
    const preview = await f.run();
    for (const change of [{ initialFee: "922337203685477581" }, { feeDuration: 600 }, { salt: `0x${"00".repeat(31)}02` }]) {
      const other = localCreateBody({ ...preview, requested: { ...preview.requested, ...change } });
      expect(() => decodeOwnerCreate(edit(sealed, (b) => { b.data = JSON.parse(other.body).data; }), expected, freshTime())).toThrow("calldata_summary_mismatch");
    }
  });

  test("earlier create encodings never decode as the periphery call", async () => {
    const { sealed, expected } = await created();
    const p = abiParameters(request());
    const liquidityTuple = parseAbi(["function create((string,string,uint8,uint128,uint128,int32,int32,uint32,uint64,uint32,uint64,uint64,bytes32))"]);
    const quoteFirst = parseAbi(["function create((address,string,string,uint8,uint128,uint128,int32,int32,uint32,uint64,uint32,uint64,uint64,bytes32))"]);
    const withFactor = parseAbi(["function create((address,string,string,uint8,uint128,uint128,int32,int32,uint32,uint64,uint32,uint64,uint64,uint64,bytes32))"]);
    const tail = [p.name, p.symbol, p.decimals, p.supply, 1111119116089565312898036n, p.askTick, p.upperTick, p.tickSpacing, p.tradingStart,
      p.feeDuration, p.initialFee, p.finalFee] as const;
    const legacy = [
      encodeFunctionData({ abi: liquidityTuple, functionName: "create", args: [[...tail, p.salt]] }),
      encodeFunctionData({ abi: quoteFirst, functionName: "create", args: [[zeroAddress, ...tail, p.salt]] }),
      encodeFunctionData({ abi: withFactor, functionName: "create", args: [[zeroAddress, ...tail, 18425445863997925462n, p.salt]] }),
    ];
    expect(legacy.map((data) => data.slice(0, 10))).toEqual(["0x687ba810", "0xe11b98da", "0xd5f50468"]);
    for (const data of legacy) {
      expect(() => decodeOwnerCreate(edit(sealed, (b) => { b.data = data; }), expected, freshTime())).toThrow("unsupported_selector");
    }
    // The 40af6cb selector over the old 13-field body reads the uint128 liquidity as a quote address: another
    // launch than the requested one, so it never matches the bound request.
    const spliced = `0x662af306${legacy[0].slice(10)}` as Hex;
    expect(() => decodeOwnerCreate(edit(sealed, (b) => { b.data = spliced; }), expected, freshTime())).toThrow("calldata_summary_mismatch");
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

  test("v5 draft statements for 50% -> 0.3% on native ETH, byte for byte", () => {
    expect(createStatements({ requestedSupply: "1000000000000000000000000000", installedSupply: "999999999999999999999999422",
      sinkSupply: "578", initialFeePercent: "50.0000%",
      finalFeePercent: "0.3000%", feeDuration: "3600", tradingStart: new Date(1800000100 * 1000).toISOString(),
      excessHalvingSeconds: "587", exactOutputMultiplier: "2.00", owner: "0x00000000000000000000000000000000c0ffee01",
      quote: "native ETH" })).toEqual([
      "Zero initial bid: the pool starts with no native ETH. Until someone buys, selling the launch token fills nothing.",
      "Buyer-funded quote reserve: the only native ETH in the pool is what buyers pay in. Sells can withdraw only that.",
      "Permanent principal lock: of the total supply of 1000000000000000000000000000 raw units, 999999999999999999999999422 go into one position that nobody, including you, can withdraw, rebalance, migrate or refund, and the rounding remainder of 578 is minted to address(0), where nobody can ever spend it. Quote that buyers pay in is locked in the position too.",
      "Creator fee: 50.0000% at trading start 2027-01-15T08:01:40.000Z, decaying with a fixed 600 s half-life rescaled to reach exactly 0.3000% after 3600 s, then 0.3000% for good. It is not linear: the excess over 0.3000% first falls to half or less 587 s after trading start. The fee is taken on the calculated side of every swap into a separate two-asset fee ledger, never into principal.",
      "Launch ownership: 0x00000000000000000000000000000000c0ffee01 (this account) becomes the launch owner. Only the current owner can claim the fee ledger, and ownership can be transferred. Whoever owns the launch when it claims receives every unclaimed fee, including fees earned before a transfer.",
      "Owner recapture: every fee goes to the launch owner. When the owner, or anyone buying for it, trades, it gets that fee back through its claim: on an exact-input buy at 50.0000% it can end up with the whole pre-fee output, while anyone else making the same trade gets only the net. The fee cannot tell owners, snipers and honest buyers apart.",
      "High early fee: near 50.0000%, a swap can deliver a negligible or zero amount after the fee, and an immediate round trip pays the fee twice plus price impact. A high starting fee is not protection against snipers and does not promise that anyone avoids a loss.",
      "Exact-output gross-up: for a fixed output, the input paid is the pre-fee input times 1 / (1 - fee), about 2.00x at 50.0000%, which grows much faster than the fee itself. Large amounts at high fees revert on overflow. Always set a minimum output or a maximum input.",
      "No exit guarantee: there is no buyer of last resort, no refund and no admin rescue. The price can fall back to the ask.",
    ]);
    const all = createStatements({ requestedSupply: "2", installedSupply: "1", sinkSupply: "1", initialFeePercent: "5.0000%", finalFeePercent: "0.3000%", feeDuration: "3600",
      tradingStart: "t", excessHalvingSeconds: "1", exactOutputMultiplier: "1.05", owner: "c", quote: "q" }).join(" ");
    for (const promise of ["linearly", "cannot transfer", "protects", "no loss", "guarantee", "decay factor"]) {
      expect(all.replace("No exit guarantee", "")).not.toContain(promise);
    }
    expect(createStatements({ requestedSupply: "1", installedSupply: "1", sinkSupply: "0", initialFeePercent: "0.3000%", finalFeePercent: "0.3000%", feeDuration: "3600",
      tradingStart: "t", excessHalvingSeconds: "none", exactOutputMultiplier: "1.00", owner: "c", quote: "q" })[3])
      .toContain("The fee is flat: initial and final are both 0.3000%.");
    expect(claimStatements("0x00000000000000000000000000000000c0ffee02")).toEqual([
      "Withdraws the whole two-asset fee ledger of this launch to 0x00000000000000000000000000000000c0ffee02, both assets or neither. It never touches the locked principal.",
      "Only the current launch owner can claim. Ownership is transferable, so the right to claim follows the current owner, not the account that created the launch.",
    ]);
    expect(transferStatements("0x00000000000000000000000000000000c0ffee03")[0]).toContain("including every fee not yet claimed");
  });
});

describe("opaque owner decoder: periphery claim (local, non-executable)", () => {
  const recorded = chain.first_claim;
  const poolKey = chain.launches.native.preview.installation.poolKey;
  const check = recorded.owner_check;
  const T = BigInt(recorded.receipt.timestamp) - 1n;
  const build = { buildTime: T.toString(), executionExpiry: (T + 300n).toString() };
  const recipient = chain.accounts.recipient as Address;
  const claim = (to: Address = recipient, ownerCheck = check, from = owner, quoteToken: Address = zeroAddress) =>
    localClaimBody({ owner: from, pin, quoteToken, poolKey, recipient: to, ownerCheck, build });

  test("reproduces the recorded claim and summary, an atomic two-asset payout", () => {
    expect(claim()).toEqual(recorded.sealed as Sealed);
    const summary = decodeOwnerClaim(claim(), { pin, owner }, T + 1n);
    expect(summary).toEqual(recorded.owner_summary as never);
    expect(summary).toMatchObject({ selector: "0x6906b4c0", method: "claimFees", target: pin.periphery,
      fields: { owner, pool_key: poolKey, pool_id: poolIdOf(poolKey), recipient,
        settlement: { atomic: true, partial_claim: false, execution_guaranteed: false } } });
    expect(summary.statements).toEqual(claimStatements(recipient));
  });

  test("claim sinks are exactly zero/Core/extension/periphery/token0/token1", () => {
    for (const sink of [zeroAddress, pin.core, pin.extension, pin.periphery, poolKey.token0, poolKey.token1]) {
      expect(() => claim(sink as Address)).toThrow("invalid_recipient");
    }
  });

  test("only the current launch owner can claim, as the periphery enforces", () => {
    expect(() => claim(recipient, check, chain.accounts.buyer as Address)).toThrow("not_launch_owner");
    const transferred = { ...check, launch_owner: chain.accounts.new_owner };
    expect(() => claim(recipient, transferred)).toThrow("not_launch_owner");
    expect(() => claim(recipient, { ...check, pool_id: `0x${"00".repeat(32)}` })).toThrow("owner_check_pool_mismatch");
    const after = chain.after_transfer.claim;
    const sealed = localClaimBody({ owner: chain.accounts.new_owner as Address, pin, quoteToken: zeroAddress, poolKey,
      recipient: chain.accounts.new_owner as Address,
      ownerCheck: after.owner_check, build: { buildTime: (BigInt(after.receipt.timestamp) - 1n).toString(),
        executionExpiry: (BigInt(after.receipt.timestamp) + 299n).toString() } });
    expect(sealed).toEqual(after.sealed as Sealed);
  });

  test("the claim names the launch's own quote; another or unreviewed quote refuses", () => {
    expect(() => claim(recipient, check, owner, ERC20_QUOTE as Address)).toThrow("unsupported_quote");
    expect(() => claim(recipient, check, owner, "0x00000000000000000000000000000000000000aa")).toThrow("unsupported_quote");
    const erc = chain.erc20_claim;
    const ercKey = chain.launches.erc20.preview.installation.poolKey;
    const T2 = BigInt(erc.receipt.timestamp) - 1n;
    const sealed = localClaimBody({ owner, pin, quoteToken: ERC20_QUOTE as Address, poolKey: ercKey, recipient,
      ownerCheck: erc.owner_check, build: { buildTime: T2.toString(), executionExpiry: (T2 + 300n).toString() } });
    expect(sealed).toEqual(erc.sealed as Sealed);
    expect(decodeOwnerClaim(sealed, { pin, owner }, T2 + 1n)).toEqual(erc.owner_summary as never);
    expect(() => localClaimBody({ owner, pin, quoteToken: zeroAddress, poolKey: ercKey, recipient, ownerCheck: erc.owner_check,
      build: { buildTime: T2.toString(), executionExpiry: (T2 + 300n).toString() } })).toThrow("unsupported_quote");
  });

  test("tampered recipient, owner check, foreign pool and expiry refuse", () => {
    const sealed = claim();
    const expected = { pin, owner };
    expect(() => decodeOwnerClaim(edit(sealed, (b) => { b.recipient = `0x${"77".repeat(20)}`; }), expected, T)).toThrow("calldata_summary_mismatch");
    expect(() => decodeOwnerClaim(edit(sealed, (b) => { b.owner_check.launch_owner = chain.accounts.new_owner; }), expected, T)).toThrow("not_launch_owner");
    expect(() => decodeOwnerClaim(edit(sealed, (b) => { b.pool_key.config = `0x${"99".repeat(20)}${"00".repeat(8)}80000064`; }), expected, T)).toThrow("pool_extension_mismatch");
    expect(() => decodeOwnerClaim(edit(sealed, (b) => { b.target = pin.extension; }), expected, T)).toThrow("target_mismatch");
    expect(() => decodeOwnerClaim(sealed, { pin, owner: chain.accounts.buyer as Address }, T)).toThrow("owner_mismatch");
    expect(() => decodeOwnerClaim(sealed, expected, T + 300n)).toThrow("expired_or_future_plan");
    expect(() => decodeOwnerClaim(sealed, expected, T - 1n)).toThrow("expired_or_future_plan");
    expect(() => decodeOwnerClaim({ ...sealed, integrity: `0x${"00".repeat(32)}` }, expected, T)).toThrow("artifact_tampered");
  });
});
