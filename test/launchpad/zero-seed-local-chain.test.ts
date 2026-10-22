import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Address, decodeFunctionData, encodeAbiParameters, encodeEventTopics, getContractAddress, type Hex, keccak256, parseAbi, toEventSelector,
  toFunctionSelector, zeroAddress } from "viem";
import { CLAIM_SELECTOR, CREATE_SELECTOR, CREATE_SIGNATURE, extensionAbi, LAUNCH_CREATED_TOPIC, LAUNCH_OWNER_SELECTOR,
  peripheryAbi, PREVIEW_SELECTOR, TRANSFER_SELECTOR } from "../../src/launchpad/zero-seed/abi.js";
import { decodeLaunchCreated, launchCreator, type RawLog } from "../../src/launchpad/zero-seed/events.js";
import type { ParametersInput } from "../../src/launchpad/zero-seed/installation.js";
import { decodeOwnerCreate, poolIdOf, type Sealed } from "../../src/launchpad/zero-seed/owner.js";
import { CONTRACTS_COMMIT, EXTENSION_ABI_SHA256, LOCAL_INSTANCE_PINS, PERIPHERY_ABI_SHA256,
  samePin } from "../../src/launchpad/zero-seed/policy.js";
import { launchSalts } from "../../src/launchpad/zero-seed/token.js";
import { EXTENSION_RUNTIME, PERIPHERY_RUNTIME, verifyExtensionRuntime, verifyPeripheryRuntime } from "../../src/launchpad/zero-seed/runtime.js";
import iface from "../fixtures/launchpad/zero-seed-interface-43d6628.json";
import { chain, ERC20_QUOTE, KINDS, type Kind, pin, quoteOf } from "./zero-seed-fixture.js";

const deployed = chain.deployed;
const flip = (code: string, offset: number) => {
  const at = 2 + offset * 2 + 62;
  return `${code.slice(0, at)}${code[at] === "f" ? "e" : "f"}${code.slice(at + 1)}` as Hex;
};
const SINK = { native: "578", erc20: "790" } as const;
const INSTALLED = { native: "999999999999999999999999422", erc20: "999999999999999999999999210" } as const;
const REQUESTED = "1000000000000000000000000000";

describe("interface manifest of evm-contracts 43d6628", () => {
  test("vendored verbatim from the canonical manifest", () => {
    const bytes = readFileSync(new URL("../fixtures/launchpad/zero-seed-interface-43d6628.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("7e351ef4fe1ee835f41870cbbab69a07d26b0a66ffebd5915ef4a42a18edcc6e");
    expect(iface.manifest_sha256).toBe("6be8bd0a5a54f6dd51f9f7836bd4d64922672deebff7e19a6ff821e318906629");
    expect(iface.frozen_commit).toBe(CONTRACTS_COMMIT);
    expect(iface.artifacts.ZeroSeedLaunch.abi_sha256_canonical_json).toBe(EXTENSION_ABI_SHA256);
    expect(iface.artifacts.ZeroSeedLaunchPeriphery.abi_sha256_canonical_json).toBe(PERIPHERY_ABI_SHA256);
    expect(iface.artifacts.ZeroSeedLaunch.constructor).toBe("(address core)");
  });

  test("selectors, topics and errors used here equal the manifest", () => {
    const periphery = iface.abi.ZeroSeedLaunchPeriphery;
    const extension = iface.abi.ZeroSeedLaunch;
    expect(toFunctionSelector(CREATE_SIGNATURE)).toBe(CREATE_SELECTOR);
    expect(periphery.functions[CREATE_SIGNATURE as keyof typeof periphery.functions]).toBe(CREATE_SELECTOR);
    const fn = (abi: readonly unknown[], name: string) => toFunctionSelector((abi as never[]).find((e: { type: string; name: string }) =>
      e.type === "function" && e.name === name)!);
    expect(fn(peripheryAbi, "create")).toBe(CREATE_SELECTOR);
    expect(fn(peripheryAbi, "previewInstallation")).toBe(PREVIEW_SELECTOR);
    expect(fn(peripheryAbi, "claimFees")).toBe(CLAIM_SELECTOR);
    expect(fn(peripheryAbi, "transferLaunch")).toBe(TRANSFER_SELECTOR);
    expect(fn(peripheryAbi, "launchOwner")).toBe(LAUNCH_OWNER_SELECTOR);
    expect([CREATE_SELECTOR, PREVIEW_SELECTOR]).toEqual(["0x662af306", "0x917c1163"]);
    expect(Object.values(periphery.functions)).toEqual(expect.arrayContaining([PREVIEW_SELECTOR, CLAIM_SELECTOR, TRANSFER_SELECTOR,
      LAUNCH_OWNER_SELECTOR]));
    const events = { ...periphery.events, ...extension.events } as Record<string, string>;
    for (const entry of [...peripheryAbi, ...extensionAbi]) {
      if (entry.type !== "event") continue;
      const topic = toEventSelector(entry);
      expect(Object.values(events) as string[]).toContain(topic as string);
    }
    expect(toEventSelector(extensionAbi.find((e) => e.type === "event" && e.name === "LaunchCreated")!)).toBe(LAUNCH_CREATED_TOPIC);
    const errors = periphery.errors as Record<string, string>;
    for (const name of ["OwnerOnly()", "InvalidOwner()", "InvalidRecipient()"]) {
      expect(toFunctionSelector(`function ${name}`) as string).toBe(errors[name]);
    }
    expect(iface.structs.LaunchParameters).toContain("uint128 supply,address quoteToken,int32 askTick");
    expect(iface.structs.LaunchParameters).not.toContain("liquidity");
    expect(iface.structs.LaunchParameters).not.toContain("decayFactor");
    const all = [...Object.values(extension.functions), ...Object.values(periphery.functions)];
    for (const removed of ["0x217a4b70", "0x687ba810", "0x42b9fe08"]) expect(all).not.toContain(removed);
    expect(Object.values(extension.errors)).not.toContain("0xad00b597");
    // FeeTooHigh() is gone: every uint64 fee is accepted; only InvalidFeeSchedule remains.
    expect(iface.removed_from_abi).toEqual({ "FeeTooHigh()": "0xcd4e6167" });
    expect(Object.values(extension.errors)).not.toContain("0xcd4e6167");
    expect((extension.errors as Record<string, string>)["InvalidFeeSchedule()"]).toBe("0xf75a271a");
    expect((extensionAbi as readonly { type: string; name?: string }[]).some((e) => e.type === "function" && e.name === "quoteToken")).toBe(false);
  });

  test("runtime templates and immutable offsets equal the compiler output", () => {
    const art = iface.artifacts;
    expect(EXTENSION_RUNTIME.templateKeccak256).toBe(art.ZeroSeedLaunch.runtime_template_keccak256_immutables_zero as Hex);
    expect(PERIPHERY_RUNTIME.templateKeccak256).toBe(art.ZeroSeedLaunchPeriphery.runtime_template_keccak256_immutables_zero as Hex);
    expect(EXTENSION_RUNTIME.length).toBe(art.ZeroSeedLaunch.runtime_length);
    expect(PERIPHERY_RUNTIME.length).toBe(art.ZeroSeedLaunchPeriphery.runtime_length);
    const offsets = (refs: Record<string, { start: number }[]>) => Object.values(refs).map((r) => r.map((x) => x.start)).sort();
    expect(EXTENSION_RUNTIME.immutables.map((i) => [...i.offsets]).sort())
      .toEqual(offsets(art.ZeroSeedLaunch.immutable_references));
    expect(PERIPHERY_RUNTIME.immutables.map((i) => [...i.offsets]).sort())
      .toEqual(offsets(art.ZeroSeedLaunchPeriphery.immutable_references));
    expect(EXTENSION_RUNTIME.immutables.map((i) => i.role)).toEqual(["core", "accountant"]);
  });
});

describe("the one launcher-deployed local instance", () => {
  test("the pin equals the deployment, its runtimes, its immutables and its block", () => {
    expect(samePin(chain.pin as never, pin)).toBe(true);
    expect(verifyExtensionRuntime(deployed.extension_code as Hex, pin)).toBe(pin.extensionRuntime as Hex);
    expect(verifyPeripheryRuntime(deployed.periphery_code as Hex, pin)).toBe(pin.peripheryRuntime as Hex);
    const extension = getContractAddress({ opcode: "CREATE2", from: deployed.create2_deployer as Address,
      salt: deployed.extension_salt as Hex, bytecodeHash: deployed.extension_init_code_keccak256 as Hex });
    expect(extension.toLowerCase()).toBe(pin.extension);
    const periphery = getContractAddress({ opcode: "CREATE2", from: deployed.create2_deployer as Address,
      salt: deployed.periphery_salt as Hex, bytecodeHash: deployed.periphery_init_code_keccak256 as Hex });
    expect(periphery.toLowerCase()).toBe(pin.periphery);
    expect(pin.extension.slice(0, 4)).toBe("0x51");
    expect(deployed.deployment_block).toBe(pin.deploymentBlock);
  });

  test("the same instance the indexer's replay chain deploys", () => {
    // indexer 91a7036, tests/fixtures/zero-seed-launch/local-chain.json, instances[0]
    expect(pin).toMatchObject({ extension: "0x519c5f793d3f6cf9ee439e4cc38d8285cf08211f",
      periphery: "0x0df4e2a76640b52e51479b435f52d0eb0e7e8ef4", deploymentBlock: "2",
      extensionRuntime: "0xd6b4c7ce8da56e9948fdb004a035d9b52dbd3690bcb03c1269bbf2a9981d8ed5",
      peripheryRuntime: "0x2a9329dbb064a2c031115c7c120c8b6a1f31de167f33374180e4dc73d975974b" });
  });

  test("a template-equal runtime bound to another Core or extension refuses", () => {
    const other = "0x00000000000000000000000000000000000000e1";
    expect(() => verifyExtensionRuntime(deployed.extension_code as Hex, { core: other })).toThrow("extension_immutable_mismatch");
    expect(() => verifyPeripheryRuntime(deployed.periphery_code as Hex, { core: pin.core, extension: other })).toThrow("periphery_immutable_mismatch");
    expect(() => verifyPeripheryRuntime(deployed.periphery_code as Hex, { core: other, extension: pin.extension })).toThrow("periphery_immutable_mismatch");
    for (const { offsets } of EXTENSION_RUNTIME.immutables) {
      for (const offset of offsets) {
        expect(() => verifyExtensionRuntime(flip(deployed.extension_code, offset), pin)).toThrow("extension_immutable_mismatch");
      }
    }
    expect(() => verifyExtensionRuntime(`${deployed.extension_code}00` as Hex, pin)).toThrow("extension_runtime_mismatch");
    expect(() => verifyExtensionRuntime(flip(deployed.extension_code, 100), pin)).toThrow("extension_runtime_mismatch");
    expect(() => verifyPeripheryRuntime(deployed.extension_code as Hex, { core: pin.core, extension: pin.extension })).toThrow("periphery_runtime_mismatch");
  });

  test("the ERC-20 quote is the reviewed plain test token at its pinned runtime", () => {
    expect(chain.erc20_quote).toEqual({ address: "0xffffffffffffffffffffffffffffffffffffffff",
      runtime: "0xe8ccd7c4eb891208d5e04a27a31dfaf2b9bce01e083d7b36f10b6dd6ea643e63" });
  });
});

describe("requested supply, installed supply and the sink on the local chain", () => {
  for (const kind of KINDS) test(`${kind}: totalSupply is the requested supply; the remainder is minted to address(0)`, () => {
    const launch = chain.launches[kind];
    expect(launch.request.supply).toBe(REQUESTED);
    expect(launch.request.quoteToken).toBe(quoteOf(kind));
    expect(launch.supply).toEqual({ requested: REQUESTED, installed: INSTALLED[kind], sink: SINK[kind], total_supply: REQUESTED,
      sink_balance: SINK[kind], core_quote_delta: "0", core_liquidity_delta: launch.preview.liquidity, sink_transfer: [SINK[kind]] });
    expect(launch.preview.supply).toEqual({ requested: REQUESTED, installed: INSTALLED[kind], sink: SINK[kind], sink_holder: zeroAddress });
    const created = launch.events.find((e) => e.event === "LaunchCreated")!.args as Record<string, any>;
    expect(created.parameters.supply).toBe(REQUESTED);
    expect(created.parameters.quoteToken).toBe(quoteOf(kind));
    expect(created.liquidity).toBe(launch.preview.liquidity);
    const sink = launch.events.filter((e) => e.event === "Transfer" && e.args.from === zeroAddress && e.args.to === zeroAddress);
    expect(sink.map((e) => e.args.amount)).toEqual([SINK[kind]]);
  });
});

const createdLogs = (kind: Kind) => chain.launches[kind].logs as RawLog[];
const createdLog = (kind: Kind) => createdLogs(kind).find((log) => log.topics[0] === LAUNCH_CREATED_TOPIC)!;

describe("LaunchCreated decoding and owner attribution", () => {
  for (const kind of KINDS) test(`${kind}: decodes the 43d6628 tuple and attributes the creator from the periphery`, () => {
    const launch = chain.launches[kind];
    const created = launchCreator(createdLogs(kind), pin, true);
    expect(created).toEqual(launch.created as never);
    expect(created).toMatchObject({ token: launch.preview.installation.token, controller: pin.periphery,
      pool_key: launch.preview.installation.poolKey, pool_id: poolIdOf(launch.preview.installation.poolKey),
      position_id: launch.preview.installation.positionId, launch_token_is_token1: kind === "native",
      liquidity: launch.preview.liquidity, requested_supply: REQUESTED, creator: chain.accounts.owner,
      quote_token: { address: quoteOf(kind), kind, supported: true } });
    // The extension receives the periphery's owner-namespaced salt.
    const { ownerSalt } = launchSalts(chain.accounts.owner as Address, pin.periphery as Address, launch.request.salt as Hex);
    expect(created.parameters).toEqual({ ...launch.request, salt: ownerSalt });
    // Outside the local harness the ERC-20 quote is not reviewed; the launch still decodes, marked unsupported.
    expect(decodeLaunchCreated(createdLog(kind), pin, false).quote_token.supported).toBe(kind === "native");
  });

  test("a log from another emitter, a tampered pair or pool, or the earlier tuple's topic refuses", () => {
    const log = createdLog("erc20");
    expect(() => decodeLaunchCreated({ ...log, address: pin.periphery }, pin, true)).toThrow("launch_event_emitter_mismatch");
    const oldAbi = parseAbi([
      "struct LaunchParameters { string name; string symbol; uint8 decimals; uint128 supply; uint128 liquidity; int32 askTick; int32 upperTick; uint32 tickSpacing; uint64 tradingStart; uint32 feeDuration; uint64 initialFee; uint64 finalFee; bytes32 salt; }",
      "struct PoolKey { address token0; address token1; bytes32 config; }",
      "event LaunchCreated(bytes32 indexed poolId, address indexed token, address indexed controller, PoolKey poolKey, bytes32 positionId, uint128 liquidity, LaunchParameters parameters)",
    ]);
    const [oldTopic] = encodeEventTopics({ abi: oldAbi, eventName: "LaunchCreated" });
    expect(oldTopic.slice(0, 10)).toBe("0x085ada2e");
    expect(() => decodeLaunchCreated({ ...log, topics: [oldTopic, ...log.topics.slice(1)] }, pin, true)).toThrow("launch_event_invalid");
    // The token topic swapped for the quote: the pool no longer pairs the token with its quote.
    const token = log.topics[2];
    const quoteTopic = encodeAbiParameters([{ type: "address" }], [ERC20_QUOTE as Address]);
    expect(() => decodeLaunchCreated({ ...log, topics: [log.topics[0], log.topics[1], quoteTopic, log.topics[3]] }, pin, true))
      .toThrow("launch_event_pair_mismatch");
    expect(() => decodeLaunchCreated({ ...log, topics: [log.topics[0], `0x${"00".repeat(32)}`, token, log.topics[3]] }, pin, true))
      .toThrow("launch_event_pool_mismatch");
    expect(() => decodeLaunchCreated({ ...log, data: `${log.data}00` }, pin, true)).toThrow("launch_event_invalid");
  });

  test("the creator is the zero-to-owner event of the same pool through the pinned periphery", () => {
    const logs = createdLogs("native");
    const ownerChanged = logs.filter((log) => log.address === pin.periphery);
    expect(ownerChanged).toHaveLength(1);
    expect(() => launchCreator(logs.filter((log) => log.address !== pin.periphery), pin, true)).toThrow("launch_owner_missing");
    expect(() => launchCreator([...logs, createdLog("erc20")], pin, true)).toThrow("launch_event_invalid");
    expect(() => launchCreator(logs, { ...pin, periphery: "0x00000000000000000000000000000000000000e1" }, true))
      .toThrow("launch_event_controller_mismatch");
  });
});

describe("ownership, claims and accounting on the local chain", () => {
  const key = chain.launches.native.preview.installation.poolKey;
  const poolId = poolIdOf(key);
  type Swap = { events: { event: string; args: Record<string, any> }[] };
  const fees = (swaps: readonly Swap[]) => swaps.reduce((sum, swap) => {
    const e = swap.events.find((x) => x.event === "LaunchSwapped")!.args as { feeAmount: string; feeIsToken1: boolean };
    return e.feeIsToken1 ? { ...sum, t1: sum.t1 + BigInt(e.feeAmount) } : { ...sum, t0: sum.t0 + BigInt(e.feeAmount) };
  }, { t0: 0n, t1: 0n });

  test("every swap went through LaunchTestRouter at the fee rate the integer schedule gives", () => {
    const all = [...chain.swaps, chain.after_transfer.swap, ...chain.erc20_swaps];
    expect(all).toHaveLength(7);
    for (const swap of all) {
      expect(swap.router).toBe(chain.router);
      expect(swap.events.find((e) => e.event === "LaunchSwapped")!.args.feeRate).toBe(swap.ts_fee_rate);
      expect(swap.deltas.router_eth).toBe("0");
    }
    expect(new Set(chain.swaps.map((s) => `${s.side} ${s.exact_out}`)).size).toBe(4);
  });

  test("the initial creator is the zero-to-owner event; the extension's controller is the periphery", () => {
    for (const kind of KINDS) {
      const events = chain.launches[kind].events.filter((e) => e.source !== "core" && e.source !== "erc20");
      expect(events.map((e) => `${e.source}:${e.event}`)).toEqual(["extension:LaunchCreated", "periphery:LaunchOwnerChanged"]);
    }
    const events = chain.launches.native.events.filter((e) => e.source === "extension" || e.source === "periphery");
    expect(events[0].args).toMatchObject({ poolId, controller: pin.periphery });
    expect(events[1].args).toEqual({ poolId, previousOwner: zeroAddress, newOwner: chain.accounts.owner });
  });

  test("a claim pays the whole ledger once: both events report the same amounts the recipient received", () => {
    for (const [claim, swaps, owner] of [[chain.first_claim, chain.swaps, chain.accounts.owner],
      [chain.erc20_claim, chain.erc20_swaps, chain.accounts.owner]] as const) {
      const { t0, t1 } = fees(swaps);
      const [ledger, payout] = claim.events.filter((e) => e.source === "extension" || e.source === "periphery");
      expect([ledger.source, ledger.event, payout.source, payout.event])
        .toEqual(["extension", "CreatorFeesClaimed", "periphery", "LaunchFeesClaimed"]);
      expect(ledger.args).toMatchObject({ controller: pin.periphery, amount0: t0.toString(), amount1: t1.toString() });
      expect(payout.args).toMatchObject({ owner, recipient: chain.accounts.recipient, amount0: t0.toString(), amount1: t1.toString() });
      expect(claim.deltas).toEqual({ token0: t0.toString(), token1: t1.toString() });
    }
  });

  test("a transfer moves the claim right, including fees accrued before it; the creator stays the zero-event owner", () => {
    expect(chain.transfer.events).toEqual([{ emitter: pin.periphery, source: "periphery", event: "LaunchOwnerChanged",
      args: { poolId, previousOwner: chain.accounts.owner, newOwner: chain.accounts.new_owner } }]);
    expect(chain.after_transfer.old_owner_claim).toBe("0x596dcdb8");
    const { t0, t1 } = fees([chain.after_transfer.swap]);
    const [ledger, payout] = chain.after_transfer.claim.events.filter((e) => e.source === "extension" || e.source === "periphery");
    expect(ledger.args).toMatchObject({ amount0: t0.toString(), amount1: t1.toString() });
    expect(payout.args).toMatchObject({ owner: chain.accounts.new_owner, recipient: chain.accounts.new_owner });
    expect(chain.after_transfer.claim.owner_check.launch_owner).toBe(chain.accounts.new_owner);
  });

  test("the chain refuses what the MCP refuses", () => {
    expect(chain.refusals).toEqual({
      claim_by_non_owner: "0x596dcdb8", claim_to_periphery: "0x9c8d2cd2", claim_to_zero: "0x9c8d2cd2",
      claim_with_value: "revert_without_data", swap_before_trading_start: "0xacf75be8",
      // UnsupportedQuoteToken(): a nonzero quote without code; the earlier create selector does not exist.
      quote_without_code: "0x658d8331", old_selector: "revert_without_data",
      // InvalidFeeSchedule(): a rising fee or a zero duration; the maximum fee itself creates.
      final_above_initial: "0xf75a271a", zero_fee_duration: "0xf75a271a", max_fee_create: "success",
    });
    expect(iface.abi.ZeroSeedLaunch.errors["InvalidFeeSchedule()"]).toBe("0xf75a271a");
    expect(iface.abi.ZeroSeedLaunch.errors["UnsupportedQuoteToken()"]).toBe("0x658d8331");
    for (const kind of KINDS) expect(chain.launches[kind].create_with_value).toBe("revert_without_data");
  });

  test("the create the chain executed is the request's calldata, byte for byte", () => {
    for (const kind of KINDS) {
      const body = JSON.parse(chain.launches[kind].sealed.body);
      expect(body.data.slice(0, 10)).toBe(CREATE_SELECTOR);
      expect(keccak256(body.data)).toBe(chain.launches[kind].owner_summary.fields.binding.calldata_keccak256 as Hex);
    }
  });
});

describe("the default schedule and the maximum uint64 fee on the local chain", () => {
  const MAX = "18446744073709551615";
  const cases = {
    default_schedule: { initialFee: "9223372036854775808", finalFee: "55340232221128654", feeDuration: 3600, percent: ["50.0000%", "0.3000%"] },
    max_to_final: { initialFee: MAX, finalFee: "55340232221128654", feeDuration: 3600, percent: ["99.9999%", "0.3000%"] },
    max_flat: { initialFee: MAX, finalFee: MAX, feeDuration: 1, percent: ["99.9999%", "99.9999%"] },
  } as const;
  for (const [key, want] of Object.entries(cases)) test(`${key}: the produced create carries the fees exactly and the chain created it`, () => {
    const launch = chain.launches[key as keyof typeof cases];
    const expected = { pin, owner: chain.accounts.owner as Address, requested: launch.request as ParametersInput };
    // The owner decoder reproduces the recorded summary from the sealed body, byte for byte.
    const summary = decodeOwnerCreate(launch.sealed as Sealed, expected, BigInt(launch.build.buildTime) + 1n);
    expect(JSON.stringify(summary)).toBe(JSON.stringify(launch.owner_summary));
    expect(summary.fields).toMatchObject({ initial_fee: want.initialFee, final_fee: want.finalFee, fee_duration: want.feeDuration,
      initial_fee_percent: want.percent[0], final_fee_percent: want.percent[1] });
    expect(JSON.stringify(summary)).not.toContain("100.0000%");
    const body = JSON.parse(launch.sealed.body);
    expect(body.data.slice(0, 10)).toBe(CREATE_SELECTOR);
    const decoded = decodeFunctionData({ abi: peripheryAbi, data: body.data });
    if (decoded.functionName !== "create") throw new Error("not a create");
    expect([decoded.args[0].initialFee, decoded.args[0].finalFee, decoded.args[0].feeDuration])
      .toEqual([BigInt(want.initialFee), BigInt(want.finalFee), want.feeDuration]);
    const created = launchCreator(launch.logs as RawLog[], pin, true);
    expect(created.parameters).toMatchObject({ initialFee: want.initialFee, finalFee: want.finalFee, feeDuration: want.feeDuration });
    expect(created.creator).toBe(chain.accounts.owner);
  });

  test("swaps at the maximum rate: emitted rate equals the integer schedule; exact input nets floor(gross / 2^64)", () => {
    const [decaying, flat] = chain.max_fee_swaps;
    for (const swap of chain.max_fee_swaps) {
      expect(swap.events.find((e) => e.event === "LaunchSwapped")!.args.feeRate).toBe(swap.ts_fee_rate);
    }
    expect(flat.ts_fee_rate).toBe(MAX);
    expect(BigInt(decaying.ts_fee_rate) < BigInt(MAX)).toBe(true);
    const swapped = flat.events.find((e) => e.event === "LaunchSwapped")!.args as unknown as Record<string, string>;
    const net = BigInt(flat.deltas.token);
    expect(net).toBe((net + BigInt(swapped.feeAmount)) / (1n << 64n));
  });
});

describe("exact token0 installation on the local chain", () => {
  // evm-contracts 43d6628 installs floor(supply * lower * upper / (2^128 * (upper - lower))), the largest liquidity
  // whose rounded-up debit fits the supply. The shared helper floored lower * upper / 2^128 first and installed
  // 106052588672 (low price) and 9223595582101085259 (full width) for the same requests.
  const cases = {
    low_price: { supply: "1000000000000000000000000000000", askTick: -88080384, upperTick: -85983232, tickSpacing: 524288,
      liquidity: "115073586432", installed: "999999999991410763432286846442", sink: "8589236567713153558" },
    full_width: { supply: "170141183460469231694794709727778658247", askTick: -88722835, upperTick: 88722835, tickSpacing: 1,
      liquidity: "9223595582101085260", installed: "170141183460469231694794709727778658247", sink: "0" },
  } as const;
  for (const [key, want] of Object.entries(cases)) test(`${key}: preview, sealed create, owner summary and the chain agree exactly`, () => {
    const launch = chain.launches[key as keyof typeof cases];
    expect(launch.request).toMatchObject({ supply: want.supply, askTick: want.askTick, upperTick: want.upperTick,
      tickSpacing: want.tickSpacing, quoteToken: ERC20_QUOTE });
    expect(launch.preview.installation.poolKey.token0).toBe(launch.preview.installation.token);
    expect(launch.preview.installation).toMatchObject({ liquidity: want.liquidity, installedSupply: want.installed });
    expect(launch.preview.supply).toEqual({ requested: want.supply, installed: want.installed, sink: want.sink, sink_holder: zeroAddress });
    // Core took exactly the installed supply for exactly the previewed liquidity; totalSupply is the request.
    expect(launch.supply).toEqual({ requested: want.supply, installed: want.installed, sink: want.sink, total_supply: want.supply,
      sink_balance: want.sink, core_quote_delta: "0", core_liquidity_delta: want.liquidity,
      sink_transfer: want.sink === "0" ? [] : [want.sink] });
    const expected = { pin, owner: chain.accounts.owner as Address, requested: launch.request as ParametersInput };
    const summary = decodeOwnerCreate(launch.sealed as Sealed, expected, BigInt(launch.build.buildTime) + 1n);
    expect(JSON.stringify(summary)).toBe(JSON.stringify(launch.owner_summary));
    expect(summary.fields.supply).toEqual({ requested: want.supply, installed: want.installed, sink: want.sink, sink_holder: zeroAddress });
    expect(summary.fields.liquidity).toBe(want.liquidity);
    expect(summary.fields.binding).toMatchObject({ requested_supply: want.supply, installed_supply: want.installed,
      sink_supply: want.sink, calldata_supply: want.supply, installed_liquidity: want.liquidity });
    expect(summary.statements[2]).toContain(`of the total supply of ${want.supply} raw units, ${want.installed} go into one position`);
    expect(summary.statements[2]).toContain(want.sink === "0" ? "nothing is minted to address(0)"
      : `the remainder of ${want.sink}, too small to pay for one more unit of liquidity, is minted to address(0)`);
    expect(summary.statements[9]).toStartWith(`Quote trust: quote token ${ERC20_QUOTE} is trusted across all of Core`);
    const decoded = decodeFunctionData({ abi: peripheryAbi, data: JSON.parse(launch.sealed.body).data });
    if (decoded.functionName !== "create") throw new Error("not a create");
    expect(decoded.args[0].supply).toBe(BigInt(want.supply));
    const created = launchCreator(launch.logs as RawLog[], pin, true);
    expect(created).toMatchObject({ creator: chain.accounts.owner, requested_supply: want.supply });
  });
});
