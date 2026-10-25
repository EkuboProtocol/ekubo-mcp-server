import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type Address, decodeFunctionData, encodeEventTopics, getContractAddress, type Hex, keccak256, toEventSelector,
  toFunctionSelector, zeroAddress } from "viem";
import { CLAIM_SELECTOR, CREATE_SELECTOR, CREATE_SIGNATURE, extensionAbi, LAUNCH_CREATED_TOPIC, LAUNCH_OWNER_SELECTOR,
  peripheryAbi, peripheryAbiV1, PREVIEW_SELECTOR, TRANSFER_SELECTOR } from "../../src/launchpad/zero-seed/abi.js";
import { decodeLaunchCreated, launchCreator, type RawLog } from "../../src/launchpad/zero-seed/events.js";
import { feePercent, tickRateFeeAt, tickRatePhase } from "../../src/launchpad/zero-seed/fee.js";
import { createData, type ParametersInput } from "../../src/launchpad/zero-seed/installation.js";
import { decodeOwnerClaim, decodeOwnerCreate, localClaimBody, poolIdOf, type Sealed } from "../../src/launchpad/zero-seed/owner.js";
import { CONTRACTS_COMMIT, samePin } from "../../src/launchpad/zero-seed/policy.js";
import { EXTENSION_RUNTIME, PERIPHERY_RUNTIME, verifyExtensionRuntime, verifyPeripheryRuntime } from "../../src/launchpad/zero-seed/runtime.js";
import { chain, ERC20_QUOTE, pin, v1Pin } from "./zero-seed-fixture.js";

// The tick_rate_v2 local chain: script/zero-seed-local-chain.ts over the compiled evm-contracts 3d6378f artifacts on
// a fresh anvil chain (two runs byte-identical). Every create and claim the chain executed is the MCP producer's own
// calldata; every swap's emitted fee rate is checked here against the integer tick-rate schedule.
const vectors = JSON.parse(readFileSync(new URL("../fixtures/launchpad/zero-seed-launch-vectors-3d6378f.json", import.meta.url), "utf8"));
type Launch = (typeof chain.launches)["native"];
const LAUNCHES = Object.entries(chain.launches) as [keyof typeof chain.launches, Launch][];
const scheduleOf = (request: { tradingStart: string; decayRateX32: string; initialFee: string; finalFee: string }) => ({
  tradingStart: BigInt(request.tradingStart), decayRateX32: BigInt(request.decayRateX32), initialFee: BigInt(request.initialFee),
  finalFee: BigInt(request.finalFee),
});
const owner = chain.accounts.owner as Address;
const deployed = chain.deployed;

describe("the tick_rate_v2 ABI of evm-contracts 3d6378f", () => {
  test("selectors, topics and errors equal the contract's frozen vector file", () => {
    const abi = vectors.abi;
    expect(chain.contracts_commit).toBe(CONTRACTS_COMMIT);
    expect(CONTRACTS_COMMIT).toBe("3d6378f585591dc7eabeea6976932c30524bb8ea");
    expect(toFunctionSelector(CREATE_SIGNATURE)).toBe(CREATE_SELECTOR);
    expect(abi.ZeroSeedLaunchPeriphery.selectors[CREATE_SIGNATURE]).toBe(CREATE_SELECTOR);
    const fn = (name: string) => toFunctionSelector((peripheryAbi as readonly { type: string; name?: string }[])
      .find((e) => e.type === "function" && e.name === name) as never);
    expect([fn("create"), fn("previewInstallation"), fn("claimFees"), fn("transferLaunch"), fn("launchOwner")])
      .toEqual([CREATE_SELECTOR, PREVIEW_SELECTOR, CLAIM_SELECTOR, TRANSFER_SELECTOR, LAUNCH_OWNER_SELECTOR]);
    expect([CREATE_SELECTOR, PREVIEW_SELECTOR]).toEqual(["0xf91810d2", "0xb665ec4d"]);
    expect(Object.values(abi.ZeroSeedLaunchPeriphery.selectors)).toEqual(expect.arrayContaining([CREATE_SELECTOR, PREVIEW_SELECTOR,
      CLAIM_SELECTOR, TRANSFER_SELECTOR, LAUNCH_OWNER_SELECTOR]));
    const topics = { ...abi.ZeroSeedLaunch.topics, ...abi.ZeroSeedLaunchPeriphery.topics } as Record<string, string>;
    for (const entry of [...peripheryAbi, ...extensionAbi]) {
      if (entry.type === "event") expect(topics[entry.name]).toBe(toEventSelector(entry));
    }
    for (const entry of extensionAbi) {
      if (entry.type !== "error") continue;
      const signature = `${entry.name}(${entry.inputs.map((i) => i.type).join(",")})`;
      expect(abi.ZeroSeedLaunch.errors[signature]).toBe(toFunctionSelector(`function ${signature}`));
    }
    // The periphery's errors are unchanged from 43d6628 (the periphery source file is unchanged).
    for (const [name, selector] of [["OwnerOnly()", "0x596dcdb8"], ["InvalidRecipient()", "0x9c8d2cd2"]]) {
      expect(toFunctionSelector(`function ${name}`) as string).toBe(selector);
    }
    expect(topics.LaunchCreated).toBe(LAUNCH_CREATED_TOPIC);
    expect(abi.changed_from_previous_revision["create(LaunchParameters)"]).toEqual({ previous: "0x662af306", current: CREATE_SELECTOR });
    expect(abi.changed_from_previous_revision["LaunchCreated topic"].current).toBe(LAUNCH_CREATED_TOPIC);
    expect(abi.LaunchParameters).toBe("(string name,string symbol,uint8 decimals,uint128 supply,address quoteToken,int32 askTick,int32 upperTick,uint32 tickSpacing,uint64 tradingStart,uint64 decayRateX32,uint64 initialFee,uint64 finalFee,bytes32 salt)");
    expect(abi.ZeroSeedLaunch.errors["InvalidFeeSchedule()"]).toBe("0xf75a271a");
  });
});

describe("the launcher-deployed tick_rate_v2 local instance", () => {
  test("the pin equals the deployment, its runtimes, its immutables and its block", () => {
    expect(samePin(chain.pin as never, pin)).toBe(true);
    expect(pin.feeModel).toBe("tick_rate_v2");
    expect(verifyExtensionRuntime(deployed.extension_code as Hex, pin)).toBe(pin.extensionRuntime as Hex);
    expect(verifyPeripheryRuntime(deployed.periphery_code as Hex, pin)).toBe(pin.peripheryRuntime as Hex);
    const extension = getContractAddress({ opcode: "CREATE2", from: deployed.create2_deployer as Address,
      salt: deployed.extension_salt as Hex, bytecodeHash: deployed.extension_init_code_keccak256 as Hex });
    expect(extension.toLowerCase()).toBe(pin.extension);
    expect(pin.extension.slice(0, 4)).toBe("0x51");
    expect(deployed.deployment_block).toBe(pin.deploymentBlock);
  });

  test("the extension runtime and init code are the freeze's pins; the instance is the indexer's v2 replay instance", () => {
    expect(pin.extensionRuntime).toBe(vectors.pins.runtime.ZeroSeedLaunch.keccak256);
    expect((deployed.extension_code.length - 2) / 2).toBe(vectors.pins.runtime.ZeroSeedLaunch.bytes);
    expect((deployed.periphery_code.length - 2) / 2).toBe(vectors.pins.runtime.ZeroSeedLaunchPeriphery.bytes);
    // indexer 7f373e5, tests/fixtures/zero-seed-launch/local-chain-v2.json, instances[0]
    expect(pin).toMatchObject({ extension: "0x5135fd3e9a6056937eaf6b99454bbc2198c2263d", periphery: "0xfb2e7927d3e4984dca3e390526d43c6f5a3461e9",
      deploymentBlock: "2", extensionRuntime: "0xe08ad382497fc9825956c2b4e9ccf463014c4ed65baf50c0a59db8d7b7aedfc3",
      peripheryRuntime: "0xf72d3cd6b99e1b64f0b08c0f6933b4f8adb92464ded48c51bfb7d2805c09d667" });
    expect(deployed.extension_salt).toBe("0x000000000000000000000000000000000000000000000000000000000000020a");
    expect(EXTENSION_RUNTIME.tick_rate_v2.templateKeccak256).toBe("0xae9245361f958f479a4ff1a85ca242f6adf3ae21b3e1f3696317368ba8c47c3b");
    expect(PERIPHERY_RUNTIME.tick_rate_v2.templateKeccak256).toBe("0x1fa935c3de39691b912dd3db3ef84d7e66cc0e54dddef3740aeb1d453e6ad3f8");
  });

  test("the tick-rate code is not the fixed-base template, and a v1 pin of the same addresses is refused", () => {
    expect(() => verifyExtensionRuntime(deployed.extension_code as Hex, { core: pin.core, feeModel: "fixed_base_duration_v1" }))
      .toThrow("extension_runtime_mismatch");
    expect(() => verifyPeripheryRuntime(deployed.periphery_code as Hex, { core: pin.core, extension: pin.extension,
      feeModel: "fixed_base_duration_v1" })).toThrow("periphery_runtime_mismatch");
    expect(samePin(pin, v1Pin)).toBe(false);
  });
});

describe("every create is the producer's request, decoded with the tick-rate tuple", () => {
  for (const [key, launch] of LAUNCHES) test(`${key}: summary reproduced from the sealed body; calldata, chain and summary agree`, () => {
    const request = launch.request as ParametersInput;
    const expected = { pin, owner, requested: request };
    const summary = decodeOwnerCreate(launch.sealed as Sealed, expected, BigInt(launch.build.buildTime) + 1n);
    expect(JSON.stringify(summary)).toBe(JSON.stringify(launch.owner_summary));
    const body = JSON.parse(launch.sealed.body);
    expect(body.data).toBe(createData(request));
    expect(body.data.slice(0, 10)).toBe(CREATE_SELECTOR);
    const decoded = decodeFunctionData({ abi: peripheryAbi, data: body.data });
    if (decoded.functionName !== "create") throw new Error("create");
    expect(decoded.args[0].decayRateX32).toBe(BigInt(request.decayRateX32));
    expect(() => decodeFunctionData({ abi: peripheryAbiV1, data: body.data })).toThrow();
    const created = launchCreator(launch.logs as RawLog[], pin, true);
    expect(created).toEqual(launch.created as never);
    expect(created.fee_model).toBe("tick_rate_v2");
    expect(created.parameters).toMatchObject({ decayRateX32: request.decayRateX32, initialFee: request.initialFee,
      finalFee: request.finalFee, tradingStart: request.tradingStart });
    expect(created.parameters).not.toHaveProperty("feeDuration");
    expect(created.creator).toBe(owner);
    expect(summary.fields.decay_rate_x32).toBe(request.decayRateX32);
    expect(summary.fields.fee_schedule.model).toBe("tick_rate_v2");
    expect(summary.fields.binding.calldata_keccak256).toBe(keccak256(body.data));
    expect(launch.create_with_value).toBe("revert_without_data");
    expect(JSON.stringify(summary)).not.toContain("100.0000%");
  });

  test("the rates span the default, 600 s, 1, 0 and 2^64 - 1; the summaries state half-life and saturation, not an end", () => {
    const want: Record<string, [string, string | null, string | null]> = {
      native: ["9923486534471", "600.000000", "38399"], default_schedule: ["68913100933", "86400.000001", "5529597"],
      min_rate: ["1", "5954091920683119.788732", "381061679028371455"], zero_rate: ["0", null, null],
      max_rate: ["18446744073709551615", "0.000322", "0"],
    };
    for (const [key, [rate, halfLife, saturation]] of Object.entries(want)) {
      const fee = chain.launches[key as keyof typeof chain.launches].owner_summary.fields.fee_schedule;
      expect([fee.decay_rate_x32, fee.half_life_seconds, fee.saturation_elapsed_seconds]).toEqual([rate, halfLife, saturation]);
    }
    expect(chain.launches.zero_rate.owner_summary.statements[3]).toContain("constant: the decay rate is 0");
    expect(chain.launches.max_rate.owner_summary.fields.fee_schedule.samples[1]).toMatchObject({ elapsed: "1", fee_percent: "0.3000%" });
    for (const [, launch] of LAUNCHES) expect(launch.owner_summary.statements.join(" ")).not.toMatch(/for good|after \d+ s, then|fee_end/);
  });
});

describe("swaps: the emitted fee rate is the integer tick-rate schedule at the block", () => {
  const all = [...chain.swaps, chain.after_transfer.swap, ...chain.erc20_swaps, ...chain.rate_swaps, ...chain.max_fee_swaps];
  const launchOfPool = (poolId: string) => LAUNCHES.find(([, l]) => poolIdOf(l.preview.installation.poolKey) === poolId)![1];

  test(`all ${all.length} swaps, recomputed here from each launch's own request`, () => {
    expect(all).toHaveLength(14);
    const phases = new Set<string>();
    for (const swap of all) {
      const event = swap.events.find((e) => e.event === "LaunchSwapped")!;
      const launch = launchOfPool(event.args.poolId as string);
      const time = BigInt(swap.receipt.timestamp);
      const rate = tickRateFeeAt(scheduleOf(launch.request), time);
      expect(event.args.feeRate).toBe(rate.toString());
      expect(swap.ts_fee_rate).toBe(rate.toString());
      phases.add(tickRatePhase(scheduleOf(launch.request), time));
      expect(swap.deltas.router_eth).toBe("0");
    }
    expect(phases).toEqual(new Set(["decaying", "constant", "at_floor"]));
  });

  test("fractional accumulation: rate 1 has not reached a whole tick 30 s in; rate 2^64 - 1 is at the floor after 1 s", () => {
    const [atOne, rateOne, zero, saturated, dayLater] = chain.rate_swaps;
    expect(atOne.ts_fee_rate).toBe("9223298692930386783");
    expect(rateOne.ts_fee_rate).toBe(chain.launches.min_rate.request.initialFee);
    expect(zero.ts_fee_rate).toBe(chain.launches.zero_rate.request.initialFee);
    expect(saturated.ts_fee_rate).toBe(chain.launches.max_rate.request.finalFee);
    // One day after trading start at the default rate: the protocol table's 25.1500006743%.
    expect(BigInt(dayLater.receipt.timestamp) - BigInt(chain.launches.default_schedule.request.tradingStart)).toBe(86400n);
    expect(dayLater.ts_fee_rate).toBe(vectors.fee_curve.tables["default_one_day_50_to_0.3"].find((r: { t: string }) => r.t === "86400").fee_q64);
    expect(feePercent(BigInt(dayLater.ts_fee_rate))).toBe("25.1500%");
  });

  test("at the maximum fee the emitted rate is 2^64 - 1 and exact input nets floor(gross / 2^64)", () => {
    const [, flat] = chain.max_fee_swaps;
    expect(flat.ts_fee_rate).toBe("18446744073709551615");
    const swapped = flat.events.find((e) => e.event === "LaunchSwapped")!.args as unknown as Record<string, string>;
    const net = BigInt(flat.deltas.token);
    expect(net).toBe((net + BigInt(swapped.feeAmount)) / (1n << 64n));
  });
});

describe("claims and refusals on the tick_rate_v2 chain", () => {
  test("each claim artifact is reproduced by the producer and pays the recorded ledger once", () => {
    for (const [claim, launch, claimer] of [[chain.first_claim, chain.launches.native, owner],
      [chain.erc20_claim, chain.launches.erc20, owner], [chain.after_transfer.claim, chain.launches.native, chain.accounts.new_owner]] as const) {
      const body = JSON.parse(claim.sealed.body);
      const T = BigInt(body.build.buildTime);
      const sealed = localClaimBody({ owner: claimer as Address, pin, quoteToken: launch.request.quoteToken as Address,
        poolKey: launch.preview.installation.poolKey, recipient: body.recipient, ownerCheck: claim.owner_check, build: body.build });
      expect(sealed).toEqual(claim.sealed as Sealed);
      expect(decodeOwnerClaim(sealed, { pin, owner: claimer as Address }, T + 1n)).toEqual(claim.owner_summary as never);
      const [ledger, payout] = claim.events.filter((e) => e.source === "extension" || e.source === "periphery");
      expect([ledger.event, payout.event]).toEqual(["CreatorFeesClaimed", "LaunchFeesClaimed"]);
      expect(claim.deltas as unknown).toEqual({ token0: payout.args.amount0, token1: payout.args.amount1 });
    }
    expect(chain.after_transfer.old_owner_claim).toBe("0x596dcdb8");
  });

  test("the chain refuses what the MCP refuses, and accepts what it accepts (rate 0 and 2^64 - 1 create)", () => {
    expect(chain.refusals).toEqual({
      claim_by_non_owner: "0x596dcdb8", claim_to_periphery: "0x9c8d2cd2", claim_to_zero: "0x9c8d2cd2",
      claim_with_value: "revert_without_data", swap_before_trading_start: "0xacf75be8", quote_without_code: "0x658d8331",
      // Neither the earlier tuple nor the fixed_base_duration_v1 create exists on the tick-rate periphery.
      old_selector: "revert_without_data", fixed_base_duration_v1_create: "revert_without_data",
      // A rising fee is the only schedule refusal; 2^64 in the rate word fails ABI decoding without data.
      final_above_initial: "0xf75a271a", zero_decay_rate_create: "success", max_decay_rate_create: "success",
      decay_rate_above_uint64: "revert_without_data", max_fee_create: "success",
    });
  });

  test("events of the tick-rate chain are not readable through the fixed-base pin", () => {
    const log = (chain.launches.native.logs as RawLog[]).find((l) => l.topics[0] === LAUNCH_CREATED_TOPIC)!;
    expect(() => decodeLaunchCreated({ ...log, address: v1Pin.extension }, v1Pin, true)).toThrow("launch_event_invalid");
    expect(() => launchCreator(chain.launches.native.logs as RawLog[], v1Pin, true)).toThrow("launch_event_invalid");
    const [topic] = encodeEventTopics({ abi: extensionAbi, eventName: "LaunchCreated" });
    expect(topic).toBe(LAUNCH_CREATED_TOPIC);
  });

  test("supply split of the native and ERC-20 launches and the exact token0 installations", () => {
    expect(chain.launches.native.supply).toMatchObject({ installed: "999999999999999999999999422", sink: "578" });
    expect(chain.launches.erc20.supply).toMatchObject({ installed: "999999999999999999999999210", sink: "790" });
    expect(chain.launches.low_price.supply).toMatchObject({ installed: "999999999991410763432286846442", sink: "8589236567713153558",
      core_liquidity_delta: "115073586432" });
    expect(chain.launches.full_width.supply).toMatchObject({ sink: "0", sink_transfer: [], core_liquidity_delta: "9223595582101085260" });
    expect(chain.launches.full_width.owner_summary.statements[2]).toContain("nothing is minted to address(0)");
    expect(chain.launches.erc20.request.quoteToken).toBe(ERC20_QUOTE);
    expect(chain.launches.native.request.quoteToken).toBe(zeroAddress);
  });
});
