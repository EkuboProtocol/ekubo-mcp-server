// Local, fork-free run of the zero-seed launch on anvil: deploys the 3d6378f (tick_rate_v2) artifacts the way a launcher would
// (one extension at a mined CREATE2 address and its periphery, both through the deterministic deployer, in block 2,
// exactly as the indexer's replay fixture generator does), then drives every MCP producer and owner decoder against
// that chain, executes exactly the create and claim calls they produced, and swaps through the checkout's compiled
// test/LaunchTestRouter.sol. Launches with a native-ETH quote and with the plain test ERC-20 quote share the one
// extension. It also creates launches at the default one-day half-life (50% -> 0.3%), at decay rates 1, 0 and
// 2^64 - 1 and at the maximum uint64 fee, from the producer's own create, and swaps on each, plus two token0
// launches whose exact installation differs from the shared liquidity helper (a low-price range and the full width
// at spacing 1). It writes the fixture the tests replay. The fixed_base_duration_v1 fixture
// (zero-seed-native-local-chain.json) was written by this script at the 43d6628 revision and is kept as recorded:
// no create is produced for that model any more.
//
//   anvil --port 8546 --chain-id 31337 --hardfork osaka --timestamp 1800000000 --base-fee 0 --gas-price 0 \
//     --gas-limit 60000000
//   EVM_CONTRACTS=<evm-contracts checkout at 3d6378f, built with forge build> RPC_URL=http://127.0.0.1:8546 \
//     bun script/zero-seed-local-chain.ts test/fixtures/launchpad/zero-seed-tick-rate-local-chain.json
//
// Local evidence only: no fork, no live instance, no UserOp, bundler, paymaster or real quoter.
import { readFileSync, writeFileSync } from "node:fs";
import {
  type Abi, type Address, type BaseError, concat, createPublicClient, createTestClient, createWalletClient, decodeEventLog,
  decodeFunctionResult, encodeAbiParameters, encodeFunctionData, encodePacked, getContractAddress, type Hex, http,
  keccak256, maxUint256, numberToHex, pad, parseAbi, toHex, zeroAddress,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { storeArtifact } from "../src/artifact-store.js";
import type { Env } from "../src/core.js";
import { CREATE_SELECTOR, extensionAbi, peripheryAbi, peripheryAbiV1 } from "../src/launchpad/zero-seed/abi.js";
import { launchCreator } from "../src/launchpad/zero-seed/events.js";
import { tickRateFeeAt } from "../src/launchpad/zero-seed/fee.js";
import { createData, type ParametersInput } from "../src/launchpad/zero-seed/installation.js";
import { decodeOwnerClaim, decodeOwnerCreate, localClaimBody, localCreateBody, poolIdOf } from "../src/launchpad/zero-seed/owner.js";
import { CONTRACTS_COMMIT, EXTENSION_ABI_SHA256, type InstancePin, launchQuote, LOCAL_INSTANCE_PINS, NATIVE_QUOTE,
  PERIPHERY_ABI_SHA256, samePin, verifyQuoteRuntime } from "../src/launchpad/zero-seed/policy.js";
import { localInstallationPreview, type SyntheticPreviewWallet } from "../src/launchpad/zero-seed/preview.js";
import { verifyExtensionRuntime, verifyPeripheryRuntime } from "../src/launchpad/zero-seed/runtime.js";

const ROOT = process.env.EVM_CONTRACTS;
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8546";
const OUT = process.argv[2];
if (!ROOT || !OUT) throw new Error("set EVM_CONTRACTS and pass the output path");

const CORE = "0x00000000000014aa86c5d3c41765bb24e11bd701" as Address;
const CORE_CODEHASH = "0xc5f90c9d0dbc5037f8f9e248f4bb292e7c1824f584eb6550cb4cad525b38c71a";
const ROUTER_CODEHASH = "0xd0d3dba8a252b72111c54a393908198cc93c30540123931049fc72b39b9a40dc";
const ERC20_QUOTE = "0xffffffffffffffffffffffffffffffffffffffff" as Address;
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920ca78fbf26c0b4956c" as Address;
const MNEMONIC = "test test test test test test test test test test test junk";
const [launcher, owner, buyer, recipient, newOwner] = [0, 1, 2, 3, 4].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
const lower = (a: string) => a.toLowerCase() as Address;
const ROUTER = lower(getContractAddress({ from: launcher.address, nonce: 0n }));

const transport = http(RPC);
const chain = { ...foundry, id: 31337 };
const pub = createPublicClient({ chain, transport, cacheTime: 0 });
const test = createTestClient({ chain, transport, mode: "anvil" });
const wallet = (account: typeof launcher) => createWalletClient({ chain, transport, account });

interface Artifact { abi: Abi; bytecode: { object: Hex }; deployedBytecode: { object: Hex } }
const artifact = (name: string): Artifact => JSON.parse(readFileSync(`${ROOT}/out/${name}.sol/${name}.json`, "utf8"));
const CORE_BUILD = artifact("Core");
const ROUTER_BUILD = artifact("LaunchTestRouter");
const QUOTE_BUILD = artifact("TestToken");

let clock = 1800000000n;
async function at(time: bigint) {
  if (time < clock) throw new Error("time runs forward");
  clock = time;
  await test.setNextBlockTimestamp({ timestamp: time });
}
async function send(account: typeof launcher, tx: { to?: Address; data: Hex; value?: bigint }, time: bigint) {
  await at(time);
  const hash = await wallet(account).sendTransaction({ ...tx, gas: 10_000_000n, gasPrice: 0n, chain } as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`reverted: ${hash}`);
  return receipt;
}
async function mineAt(time: bigint) {
  await at(time);
  await test.mine({ blocks: 1 });
  return pub.getBlock({ blockTag: "latest" });
}
async function revertSelector(call: { account: Address; to: Address; data: Hex; value?: bigint }): Promise<string> {
  try {
    await pub.call({ ...call, account: call.account });
    return "success";
  } catch (error) {
    const found = (error as BaseError).walk((e) => typeof (e as { data?: unknown }).data === "string") as { data?: Hex } | null;
    const data = found?.data ?? "0x";
    return data === "0x" ? "revert_without_data" : data.slice(0, 10);
  }
}

const erc20 = parseAbi([
  "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)", "event Transfer(address indexed from, address indexed to, uint256 amount)",
]);
const balance = async (token: Address, who: Address, blockNumber?: bigint) => token === NATIVE_QUOTE
  ? pub.getBalance({ address: who, blockNumber })
  : pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [who], blockNumber });

// --- deployment, as a launcher would do it -------------------------------------------------------------------------
/** Solady ERC20 balance slot: keccak256(owner ++ 8 zero bytes ++ 0x87a211a2), and its total-supply slot. */
const soladyBalanceSlot = (account: Address) => keccak256(encodePacked(["address", "uint64", "uint32"], [account, 0n, 0x87a211a2]));
const SOLADY_TOTAL_SUPPLY_SLOT = pad("0x05345cdf77eb68f44c", { size: 32 });

/** Core at its canonical address and the plain test ERC-20 (no immutables) relocated to 0xff..ff, funded for the buyer. */
async function placeCoreAndQuote() {
  await test.setCode({ address: CORE, bytecode: CORE_BUILD.deployedBytecode.object });
  if (keccak256((await pub.getCode({ address: CORE }))!) !== CORE_CODEHASH) throw new Error("Core runtime");
  await test.setCode({ address: ERC20_QUOTE, bytecode: QUOTE_BUILD.deployedBytecode.object });
  const max = toHex(maxUint256, { size: 32 });
  await test.setStorageAt({ address: ERC20_QUOTE, index: soladyBalanceSlot(buyer.address), value: max });
  await test.setStorageAt({ address: ERC20_QUOTE, index: SOLADY_TOTAL_SUPPLY_SLOT, value: max });
  verifyQuoteRuntime(launchQuote("31337", ERC20_QUOTE, true), keccak256((await pub.getCode({ address: ERC20_QUOTE }))!));
}

/** The first salt (counting from zero) whose CREATE2 address starts with the call-points byte 0x51. */
function mineSalt(initCode: Hex): Hex {
  const hash = keccak256(initCode);
  for (let i = 0n; ; i++) {
    const salt = numberToHex(i, { size: 32 });
    const address = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt, bytecodeHash: hash });
    if (address.toLowerCase().startsWith("0x51")) return salt;
  }
}

const deployed: Record<string, unknown> = {};
/** Block 1: the router. Block 2: the extension (constructor (core)) and its periphery (core, extension), nothing else. */
async function deployInstance(): Promise<InstancePin> {
  const routerReceipt = await send(launcher, {
    data: concat([ROUTER_BUILD.bytecode.object, encodeAbiParameters([{ type: "address" }], [CORE])]),
  }, clock + 5n);
  if (lower(routerReceipt.contractAddress!) !== ROUTER || routerReceipt.blockNumber !== 1n) throw new Error("router address");
  if (keccak256((await pub.getCode({ address: ROUTER }))!) !== ROUTER_CODEHASH) throw new Error("router runtime");
  const initCode = concat([artifact("ZeroSeedLaunch").bytecode.object, encodeAbiParameters([{ type: "address" }], [CORE])]);
  const salt = mineSalt(initCode);
  const extension = lower(getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt, bytecodeHash: keccak256(initCode) }));
  const peripheryInit = concat([artifact("ZeroSeedLaunchPeriphery").bytecode.object,
    encodeAbiParameters([{ type: "address" }, { type: "address" }], [CORE, extension])]);
  const peripherySalt = pad("0x", { size: 32 });
  const periphery = lower(getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt: peripherySalt,
    bytecodeHash: keccak256(peripheryInit) }));
  await test.setAutomine(false);
  const hashes = [];
  for (const data of [concat([salt, initCode]), concat([peripherySalt, peripheryInit])]) {
    hashes.push(await wallet(launcher).sendTransaction({ to: CREATE2_DEPLOYER, data, gas: 10_000_000n, gasPrice: 0n, chain } as never));
  }
  const block = await mineAt(clock + 5n);
  await test.setAutomine(true);
  const receipts = await Promise.all(hashes.map((hash) => pub.getTransactionReceipt({ hash })));
  if (receipts.some((r) => r.status !== "success" || r.blockNumber !== block.number) || block.number !== 2n) throw new Error("deployment block");
  const extensionCode = (await pub.getCode({ address: extension }))!;
  const peripheryCode = (await pub.getCode({ address: periphery }))!;
  const pin: InstancePin = {
    chainId: "31337", feeModel: "tick_rate_v2", core: CORE, extension, periphery,
    extensionRuntime: verifyExtensionRuntime(extensionCode, { core: CORE, feeModel: "tick_rate_v2" }),
    peripheryRuntime: verifyPeripheryRuntime(peripheryCode, { core: CORE, extension, feeModel: "tick_rate_v2" }),
    deploymentBlock: block.number.toString(), extensionAbiSha256: EXTENSION_ABI_SHA256, peripheryAbiSha256: PERIPHERY_ABI_SHA256,
  };
  const readLaunch = await pub.readContract({ address: periphery, abi: peripheryAbi, functionName: "LAUNCH" });
  if (lower(readLaunch) !== extension) throw new Error("instance identity");
  Object.assign(deployed, {
    create2_deployer: CREATE2_DEPLOYER, extension_salt: salt, extension_init_code_keccak256: keccak256(initCode),
    periphery_salt: peripherySalt, periphery_init_code_keccak256: keccak256(peripheryInit),
    extension_transaction: hashes[0], periphery_transaction: hashes[1], deployment_block: block.number.toString(),
    launcher: lower(launcher.address), router_transaction: routerReceipt.transactionHash,
    extension_code: extensionCode, periphery_code: peripheryCode,
  });
  return pin;
}

// --- MCP producers over this chain ---------------------------------------------------------------------------------
const storage = new Map<string, string>();
const env = { ARTIFACT_STORE: { put: async (key: string, body: string) => { storage.set(key, body); } } } as unknown as Env;
const previewWallet: SyntheticPreviewWallet = {
  storeRead: (body) => storeArtifact(env, "https://local.invalid", { artifactType: "read_calls", body }),
  async read(reference) {
    const body = JSON.parse(storage.get(new URL(reference.url).pathname.slice(1))!);
    const block = await pub.getBlock({ blockNumber: BigInt(body.block_parameter) });
    const results = [];
    for (const call of body.calls) {
      const { data } = await pub.call({ account: body.from, to: call.to, data: call.data, blockNumber: block.number });
      results.push({ id: call.id, success: true, data: data! });
    }
    return { chainId: "31337", blockNumber: block.number.toString(), blockHash: block.hash, blockTime: block.timestamp.toString(), results };
  },
};

const FEE_5 = "922337203685477580";
const FEE_50 = "9223372036854775808";
const FEE_03 = "55340232221128654";
/** type(uint64).max: the largest creator fee, just under 100%. */
const FEE_MAX = ((1n << 64n) - 1n).toString();
const REQUESTED_SUPPLY = "1000000000000000000000000000";
/** decayRateX32 of a one-day (the default) and a 600 s half-life, and the extremes. */
const RATE_DAY = "68913100933";
const RATE_600 = "9923486534471";
const RATE_MAX = FEE_MAX;
type FeeSchedule = Pick<ParametersInput, "decayRateX32" | "initialFee" | "finalFee">;
const FIXTURE_SCHEDULE: FeeSchedule = { decayRateX32: RATE_600, initialFee: FEE_5, finalFee: FEE_03 };
type Geometry = Pick<ParametersInput, "supply" | "askTick" | "upperTick" | "tickSpacing">;
const FIXTURE_GEOMETRY: Geometry = { supply: REQUESTED_SUPPLY, askTick: -13815500, upperTick: -9210300, tickSpacing: 100 };
/**
 * Token0 geometries where the exact installation differs from the shared helper's floor(lower * upper / 2^128) first
 * step: the low-price range at 1e30 (the helper installed 106052588672 and sank 7.84%), and the full width at spacing
 * 1 with a supply the exact maximum pays for completely (no sink mint; the helper was one liquidity unit short).
 */
const LOW_PRICE_GEOMETRY: Geometry = { supply: "1000000000000000000000000000000", askTick: -88080384, upperTick: -85983232,
  tickSpacing: 524288 };
const FULL_WIDTH_GEOMETRY: Geometry = { supply: "170141183460469231694794709727778658247", askTick: -88722835, upperTick: 88722835,
  tickSpacing: 1 };
function parameters(label: string, quoteToken: Address, tradingStart: bigint, fees = FIXTURE_SCHEDULE,
  geometry = FIXTURE_GEOMETRY): ParametersInput {
  return {
    name: `Zero Seed ${label}`, symbol: label.toUpperCase(), decimals: 18, quoteToken, ...geometry,
    tradingStart: tradingStart.toString(), ...fees, salt: `0x${"00".repeat(31)}01`,
  };
}

/** The fixed_base_duration_v1 tuple of the same request (feeDuration 3600 in the 10th field), for the refusal probe. */
function abiV1(input: ParametersInput) {
  const { decayRateX32: _rate, ...rest } = input;
  return { ...rest, salt: input.salt as Hex, quoteToken: input.quoteToken as Address, supply: BigInt(input.supply),
    tradingStart: BigInt(input.tradingStart), feeDuration: 3600, initialFee: BigInt(input.initialFee), finalFee: BigInt(input.finalFee) };
}

/** The create calldata with its decayRateX32 word (tuple head slot 9) set to 2^64, which no uint64 encoder produces. */
function rateAboveUint64(data: Hex): Hex {
  // selector (4) + tuple offset (32) + 9 head words before decayRateX32.
  const at = 2 + 8 + 64 + 9 * 64;
  return `${data.slice(0, at)}${numberToHex(1n << 64n, { size: 32 }).slice(2)}${data.slice(at + 64)}` as Hex;
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value, (_, v) =>
  (typeof v === "bigint" ? v.toString() : typeof v === "string" ? v.toLowerCase() : v)));
type Log = { address: string; data: Hex; topics: readonly Hex[] };
function decodeLogs(logs: readonly Log[]) {
  const out = [];
  for (const log of logs) {
    for (const [abi, name] of [[peripheryAbi, "periphery"], [extensionAbi, "extension"], [CORE_BUILD.abi, "core"], [erc20, "erc20"]] as const) {
      try {
        const event = decodeEventLog({ abi: abi as Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        out.push({ emitter: lower(log.address), source: name, event: event.eventName, args: json(event.args) });
        break;
      } catch { /* not this ABI */ }
    }
  }
  return out;
}
const rawLogs = (logs: readonly Log[]) => logs.map((log) => ({ address: lower(log.address), topics: log.topics.map(lower), data: lower(log.data) }));

/** delta0 is the high, delta1 the low signed 128 bits of Core's PoolBalanceUpdate. */
function deltas(update: Hex) {
  const word = BigInt(update);
  return { delta0: BigInt.asIntN(128, word >> 128n), delta1: BigInt.asIntN(128, word) };
}

type Preview = Awaited<ReturnType<typeof localInstallationPreview>>;
/**
 * The creation's split, from the chain alone: Core's PositionUpdated takes the installed supply and no quote, the
 * remainder is one Transfer(0x0, 0x0, sink), totalSupply is the requested supply and address(0) holds the sink.
 */
async function supplySplit(preview: Preview, request: ParametersInput, events: ReturnType<typeof decodeLogs>, block: bigint,
  label: string) {
  const token = preview.installation.token as Address;
  const tokenIs1 = preview.installation.poolKey.token1 === token;
  const position = events.find((e) => e.source === "core" && e.event === "PositionUpdated")!;
  const { delta0, delta1 } = deltas(position.args.balanceUpdate);
  const [tokenDelta, quoteDelta] = tokenIs1 ? [delta1, delta0] : [delta0, delta1];
  const sinkMints = events.filter((e) => e.event === "Transfer" && e.emitter === token && e.args.from === zeroAddress && e.args.to === zeroAddress);
  const supply = {
    requested: request.supply, installed: tokenDelta.toString(), sink: (BigInt(request.supply) - tokenDelta).toString(),
    total_supply: (await pub.readContract({ address: token, abi: erc20, functionName: "totalSupply", blockNumber: block })).toString(),
    sink_balance: (await balance(token, zeroAddress, block)).toString(),
    core_quote_delta: quoteDelta.toString(), core_liquidity_delta: position.args.liquidityDelta,
    sink_transfer: sinkMints.map((e) => e.args.amount),
  };
  // No sink mint when the installed liquidity takes the whole requested supply.
  const sinkTransfers = supply.sink === "0" ? [] : [supply.sink];
  const matches = [supply.installed === preview.supply.installed, supply.sink === preview.supply.sink,
    supply.total_supply === request.supply, supply.sink_balance === supply.sink, quoteDelta === 0n,
    supply.core_liquidity_delta === preview.liquidity, JSON.stringify(supply.sink_transfer) === JSON.stringify(sinkTransfers)];
  if (matches.includes(false)) throw new Error(`${label}: supply split ${JSON.stringify(supply)}`);
  return supply;
}

async function createLaunch(pin: InstancePin, quoteToken: Address, label: string, fees = FIXTURE_SCHEDULE,
  geometry = FIXTURE_GEOMETRY) {
  const build = await mineAt(clock + 10n);
  const buildTime = build.timestamp;
  const request = parameters(label, quoteToken, buildTime + 600n, fees, geometry);
  const buildContext = {
    buildTime: buildTime.toString(), executionExpiry: (buildTime + 300n).toString(),
    blockNumber: build.number.toString(), blockHash: build.hash, blockTime: buildTime.toString(),
  };
  const preview = await localInstallationPreview({ owner: lower(owner.address), request, pin, build: buildContext },
    previewWallet, () => buildTime + 1n);
  const sealed = localCreateBody(preview);
  const body = JSON.parse(sealed.body);
  if (body.data !== createData(request) || body.data.slice(0, 10) !== CREATE_SELECTOR) throw new Error("create is not the request");
  const summary = decodeOwnerCreate(sealed, { pin, owner: lower(owner.address), requested: request }, buildTime + 1n);
  const lastFresh = decodeOwnerCreate(sealed, { pin, owner: lower(owner.address), requested: request }, buildTime + 299n);
  if (JSON.stringify(summary) !== JSON.stringify(lastFresh)) throw new Error("summary depends on fresh time");
  const withValue = await revertSelector({ account: owner.address, to: body.target, data: body.data, value: 1n });
  const simulated = await pub.call({ account: owner.address, to: body.target, data: body.data });
  const receipt = await send(owner, { to: body.target, data: body.data }, buildTime + 60n);
  const installation = json(decodeFunctionResult({ abi: peripheryAbi, functionName: "create", data: simulated.data! }));
  if (JSON.stringify(installation) !== JSON.stringify(preview.installation)) throw new Error("create returned another installation");
  const events = decodeLogs(receipt.logs);
  const supply = await supplySplit(preview, request, events, receipt.blockNumber, label);
  const logs = rawLogs(receipt.logs);
  const creator = launchCreator(logs, pin, true);
  if (creator.creator !== lower(owner.address) || creator.requested_supply !== request.supply) throw new Error("creator attribution");
  return {
    label, request, build: buildContext,
    preview: { raw: preview.preview.raw, installation: preview.installation, supply: preview.supply, liquidity: preview.liquidity,
      quote: preview.quote },
    sealed, owner_summary: summary, create_with_value: withValue, simulation_return: simulated.data,
    receipt: { block_number: receipt.blockNumber.toString(), block_hash: receipt.blockHash, transaction_hash: receipt.transactionHash,
      timestamp: (buildTime + 60n).toString(), status: receipt.status },
    supply, logs, events, created: creator,
  };
}

const routerAbi = ROUTER_BUILD.abi;
type Launch = { token: Address; quote: Address; poolKey: { token0: Address; token1: Address; config: Hex } };
type Schedule = { trading_start: number; decay_rate_x32: string; initial_fee: string; final_fee: string };

/** One single-hop swap through LaunchTestRouter: exact input (amount > 0) or exact output (amount < 0), no partial fill. */
async function swap(launch: Launch, schedule: Schedule, side: "buy" | "sell", exactOut: boolean, amount: bigint, time: bigint) {
  const [specified, calculated] = side === "buy" ? (exactOut ? [launch.token, launch.quote] : [launch.quote, launch.token])
    : (exactOut ? [launch.quote, launch.token] : [launch.token, launch.quote]);
  const signed = exactOut ? -amount : amount;
  const input = side === "buy" ? launch.quote : launch.token;
  const budget = exactOut ? 10n ** 24n : amount;
  const value = input === NATIVE_QUOTE ? budget : 0n;
  const deadline = Number(time + 60n);
  const args = [launch.poolKey, specified, calculated, signed, -(1n << 127n) + 1n, false, deadline] as const;
  await at(time);
  const data = encodeFunctionData({ abi: routerAbi, functionName: "swap", args });
  const before = { quote: await balance(launch.quote, buyer.address), token: await balance(launch.token, buyer.address),
    router_eth: await pub.getBalance({ address: ROUTER }) };
  const receipt = await send(buyer, { to: ROUTER, data, value }, time);
  const after = { quote: await balance(launch.quote, buyer.address), token: await balance(launch.token, buyer.address),
    router_eth: await pub.getBalance({ address: ROUTER }) };
  const events = decodeLogs(receipt.logs);
  const rate = tickRateFeeAt({ tradingStart: BigInt(schedule.trading_start), decayRateX32: BigInt(schedule.decay_rate_x32),
    initialFee: BigInt(schedule.initial_fee), finalFee: BigInt(schedule.final_fee) }, time);
  const swapped = events.find((e) => e.event === "LaunchSwapped")!;
  if (swapped.args.feeRate !== rate.toString()) throw new Error("fee rate");
  return {
    side, exact_out: exactOut, router: ROUTER, call: { specified, calculated, amount: signed.toString(), value: value.toString(), deadline },
    receipt: { block_number: receipt.blockNumber.toString(), transaction_hash: receipt.transactionHash, timestamp: time.toString() },
    events, ts_fee_rate: rate.toString(),
    deltas: { quote: (after.quote - before.quote).toString(), token: (after.token - before.token).toString(),
      router_eth: (after.router_eth - before.router_eth).toString() },
  };
}

async function claim(pin: InstancePin, launch: Launch, claimer: typeof owner, to: Address, time: bigint) {
  const block = await mineAt(time);
  const poolId = poolIdOf(launch.poolKey);
  const current = await pub.readContract({ address: pin.periphery as Address, abi: peripheryAbi, functionName: "launchOwner",
    args: [poolId], blockNumber: block.number });
  const ownerCheck = { block_number: block.number.toString(), block_hash: block.hash, pool_id: poolId, launch_owner: lower(current) };
  const build = { buildTime: block.timestamp.toString(), executionExpiry: (block.timestamp + 300n).toString() };
  const sealed = localClaimBody({ owner: lower(claimer.address), pin, quoteToken: launch.quote, poolKey: launch.poolKey,
    recipient: lower(to), ownerCheck, build });
  const summary = decodeOwnerClaim(sealed, { pin, owner: lower(claimer.address) }, block.timestamp + 1n);
  const body = JSON.parse(sealed.body);
  const before = { token0: await balance(launch.poolKey.token0, to), token1: await balance(launch.poolKey.token1, to) };
  const receipt = await send(claimer, { to: body.target, data: body.data }, time + 1n);
  const after = { token0: await balance(launch.poolKey.token0, to), token1: await balance(launch.poolKey.token1, to) };
  return {
    sealed, owner_summary: summary, owner_check: ownerCheck,
    receipt: { block_number: receipt.blockNumber.toString(), transaction_hash: receipt.transactionHash, timestamp: (time + 1n).toString() },
    events: decodeLogs(receipt.logs),
    deltas: { token0: (after.token0 - before.token0).toString(), token1: (after.token1 - before.token1).toString() },
  };
}

// --- run --------------------------------------------------------------------------------------------------------------
if (CONTRACTS_COMMIT !== "3d6378f585591dc7eabeea6976932c30524bb8ea") throw new Error("contracts pin");
await placeCoreAndQuote();
const pin = await deployInstance();
const localPins = LOCAL_INSTANCE_PINS.filter((entry) => entry.feeModel === "tick_rate_v2");
if (localPins.length !== 1 || !samePin(localPins[0], pin)) {
  console.log(JSON.stringify({ discovered_pin: pin }, null, 2));
  throw new Error("LOCAL_INSTANCE_PINS differ from this deployment; update policy.ts and rerun");
}

const native = await createLaunch(pin, NATIVE_QUOTE, "n1");
const erc = await createLaunch(pin, ERC20_QUOTE, "e1");
const launchOf = (c: typeof native): Launch => ({ token: c.preview.installation.token as Address, quote: c.request.quoteToken as Address,
  poolKey: c.preview.installation.poolKey as never });
const scheduleOf = (c: typeof native): Schedule => ({ trading_start: Number(c.request.tradingStart),
  decay_rate_x32: c.request.decayRateX32, initial_fee: c.request.initialFee, final_fee: c.request.finalFee });

// Creation refusals the chain makes: a nonzero quote without code, the earlier 13-field tuple's selector, the
// fixed_base_duration_v1 create (0x662af306), a rising fee (InvalidFeeSchedule) and a decay rate of 2^64 (not a
// uint64: ABI decoding fails without data). A zero rate and the maximum fee and rate are accepted.
const unsupported = parameters("u1", "0x00000000000000000000000000000000000000aa", clock + 600n);
const scheduleProbe = (fees: FeeSchedule) => revertSelector({ account: owner.address, to: pin.periphery as Address,
  data: createData(parameters("f1", NATIVE_QUOTE, clock + 600n, fees)) });
const oldTuple = parseAbi(["function create((string,string,uint8,uint128,uint128,int32,int32,uint32,uint64,uint32,uint64,uint64,bytes32))"]);
const u = unsupported;
const creationRefusals = {
  quote_without_code: await revertSelector({ account: owner.address, to: pin.periphery as Address, data: createData(unsupported) }),
  old_selector: await revertSelector({ account: owner.address, to: pin.periphery as Address, data: encodeFunctionData({ abi: oldTuple,
    functionName: "create", args: [[u.name, u.symbol, u.decimals, BigInt(u.supply), 0n, u.askTick, u.upperTick, u.tickSpacing,
      BigInt(u.tradingStart), 3600, BigInt(u.initialFee), BigInt(u.finalFee), u.salt as Hex]] }) }),
  fixed_base_duration_v1_create: await revertSelector({ account: owner.address, to: pin.periphery as Address,
    data: encodeFunctionData({ abi: peripheryAbiV1, functionName: "create", args: [{ ...abiV1(parameters("v1", NATIVE_QUOTE, clock + 600n)) }] }) }),
  final_above_initial: await scheduleProbe({ decayRateX32: RATE_DAY, initialFee: (BigInt(FEE_MAX) - 1n).toString(), finalFee: FEE_MAX }),
  zero_decay_rate_create: await scheduleProbe({ decayRateX32: "0", initialFee: FEE_50, finalFee: FEE_03 }),
  max_decay_rate_create: await scheduleProbe({ decayRateX32: RATE_MAX, initialFee: FEE_50, finalFee: FEE_03 }),
  decay_rate_above_uint64: await revertSelector({ account: owner.address, to: pin.periphery as Address,
    data: rateAboveUint64(createData(parameters("f1", NATIVE_QUOTE, clock + 600n, { decayRateX32: RATE_MAX, initialFee: FEE_50, finalFee: FEE_03 }))) }),
  max_fee_create: await scheduleProbe({ decayRateX32: RATE_DAY, initialFee: FEE_MAX, finalFee: FEE_03 }),
};

await test.setBalance({ address: buyer.address, value: 10n ** 30n });
const n = launchOf(native);
const e = launchOf(erc);
const approvals = [];
for (const token of [n.token, e.token, ERC20_QUOTE]) {
  approvals.push((await send(buyer, { to: token, data: encodeFunctionData({ abi: erc20, functionName: "approve",
    args: [ROUTER, maxUint256] }) }, clock + 1n)).transactionHash);
}
const start = BigInt(native.request.tradingStart);
const early = encodeFunctionData({ abi: routerAbi, functionName: "swap",
  args: [n.poolKey, NATIVE_QUOTE, n.token, 10n ** 18n, 0n, false, Number(start)] });
const tooEarly = await revertSelector({ account: buyer.address, to: ROUTER, value: 10n ** 18n, data: early });
const swaps = [
  await swap(n, scheduleOf(native), "buy", false, 10n ** 18n, start + 30n),
  await swap(n, scheduleOf(native), "buy", true, 10n ** 23n, start + 60n),
  await swap(n, scheduleOf(native), "sell", false, 10n ** 22n, start + 90n),
  await swap(n, scheduleOf(native), "sell", true, 10n ** 16n, start + 120n),
];
const firstClaim = await claim(pin, n, owner, recipient.address, start + 200n);

// Refusals the chain itself makes, as eth_call reverts.
const poolId = poolIdOf(n.poolKey);
const claimData = (to: Address) => encodeFunctionData({ abi: peripheryAbi, functionName: "claimFees", args: [n.poolKey, to] });
const refusals = {
  claim_by_non_owner: await revertSelector({ account: buyer.address, to: pin.periphery as Address, data: claimData(buyer.address) }),
  claim_to_periphery: await revertSelector({ account: owner.address, to: pin.periphery as Address, data: claimData(pin.periphery as Address) }),
  claim_to_zero: await revertSelector({ account: owner.address, to: pin.periphery as Address, data: claimData(zeroAddress) }),
  claim_with_value: await revertSelector({ account: owner.address, to: pin.periphery as Address, data: claimData(recipient.address), value: 1n }),
  swap_before_trading_start: tooEarly,
  ...creationRefusals,
};

// Ownership transfer: the owner hands the launch to newOwner, which then holds every unclaimed fee.
const transferData = encodeFunctionData({ abi: peripheryAbi, functionName: "transferLaunch", args: [poolId, newOwner.address] });
const transferReceipt = await send(owner, { to: pin.periphery as Address, data: transferData }, start + 300n);
const afterTransferSwap = await swap(n, scheduleOf(native), "buy", false, 10n ** 18n, start + 400n);
const oldOwnerClaim = await revertSelector({ account: owner.address, to: pin.periphery as Address, data: claimData(owner.address) });
const secondClaim = await claim(pin, n, newOwner, newOwner.address, start + 500n);

const ercStart = BigInt(erc.request.tradingStart);
const ercSwaps = [
  await swap(e, scheduleOf(erc), "buy", false, 10n ** 18n, (ercStart > clock ? ercStart : clock) + 30n),
  await swap(e, scheduleOf(erc), "sell", false, 10n ** 22n, clock + 30n),
];
const ercClaim = await claim(pin, e, owner, recipient.address, clock + 30n);

// The default schedule (one-day half-life, 50% -> 0.3%), the decay-rate extremes and the maximum uint64 fee, each
// created from the producer's own create: rate 1 (about 1.89e8 years), rate 0 (constant at the initial fee), rate
// 2^64 - 1 (at the floor from the first second); max -> 0.3% at the default rate (native) and flat at the maximum
// (ERC-20). Then one buy on each.
const defaultSchedule = await createLaunch(pin, NATIVE_QUOTE, "d1", { decayRateX32: RATE_DAY, initialFee: FEE_50, finalFee: FEE_03 });
const minRate = await createLaunch(pin, NATIVE_QUOTE, "r1", { decayRateX32: "1", initialFee: FEE_50, finalFee: FEE_03 });
const zeroRate = await createLaunch(pin, ERC20_QUOTE, "z1", { decayRateX32: "0", initialFee: FEE_50, finalFee: FEE_03 });
const maxRate = await createLaunch(pin, NATIVE_QUOTE, "s1", { decayRateX32: RATE_MAX, initialFee: FEE_50, finalFee: FEE_03 });
const maxToFinal = await createLaunch(pin, NATIVE_QUOTE, "m1", { decayRateX32: RATE_DAY, initialFee: FEE_MAX, finalFee: FEE_03 });
const maxFlat = await createLaunch(pin, ERC20_QUOTE, "x1", { decayRateX32: RATE_MAX, initialFee: FEE_MAX, finalFee: FEE_MAX });
const after = (c: typeof native, seconds: bigint) => {
  const time = BigInt(c.request.tradingStart) + seconds;
  return time > clock ? time : clock + 1n;
};
const rateSwaps = [
  await swap(launchOf(defaultSchedule), scheduleOf(defaultSchedule), "buy", false, 10n ** 18n, after(defaultSchedule, 1n)),
  await swap(launchOf(minRate), scheduleOf(minRate), "buy", false, 10n ** 18n, after(minRate, 30n)),
  await swap(launchOf(zeroRate), scheduleOf(zeroRate), "buy", false, 10n ** 18n, after(zeroRate, 30n)),
  await swap(launchOf(maxRate), scheduleOf(maxRate), "buy", false, 10n ** 18n, after(maxRate, 1n)),
  await swap(launchOf(defaultSchedule), scheduleOf(defaultSchedule), "buy", false, 10n ** 18n, after(defaultSchedule, 86400n)),
];
const maxSwaps = [
  await swap(launchOf(maxToFinal), scheduleOf(maxToFinal), "buy", false, 10n ** 18n, after(maxToFinal, 1n)),
  await swap(launchOf(maxFlat), scheduleOf(maxFlat), "buy", false, 10n ** 18n, after(maxFlat, 30n)),
];

// Exact token0 installation, from the producer's own preview and create (ERC-20 quote, so the launch token is token0).
const lowPrice = await createLaunch(pin, ERC20_QUOTE, "p1", FIXTURE_SCHEDULE, LOW_PRICE_GEOMETRY);
const fullWidth = await createLaunch(pin, ERC20_QUOTE, "w1", FIXTURE_SCHEDULE, FULL_WIDTH_GEOMETRY);

const fixture = {
  scope: "LOCAL anvil chain from evm-contracts 3d6378f (tick_rate_v2) artifacts. Not a fork, live instance, UserOp, bundler or real quoter output.",
  contracts_commit: CONTRACTS_COMMIT,
  accounts: { launcher: lower(launcher.address), owner: lower(owner.address), buyer: lower(buyer.address),
    recipient: lower(recipient.address), new_owner: lower(newOwner.address) },
  core: CORE, router: ROUTER, erc20_quote: { address: ERC20_QUOTE, runtime: keccak256((await pub.getCode({ address: ERC20_QUOTE }))!) },
  pin, deployed, approvals,
  launches: { native, erc20: erc, default_schedule: defaultSchedule, min_rate: minRate, zero_rate: zeroRate,
    max_rate: maxRate, max_to_final: maxToFinal, max_flat: maxFlat, low_price: lowPrice, full_width: fullWidth },
  swaps, first_claim: firstClaim, refusals,
  transfer: { data: transferData, receipt: { block_number: transferReceipt.blockNumber.toString(), transaction_hash: transferReceipt.transactionHash },
    events: decodeLogs(transferReceipt.logs) },
  after_transfer: { swap: afterTransferSwap, old_owner_claim: oldOwnerClaim, claim: secondClaim },
  erc20_swaps: ercSwaps, erc20_claim: ercClaim, rate_swaps: rateSwaps, max_fee_swaps: maxSwaps,
};
writeFileSync(OUT, `${JSON.stringify(fixture, null, 1)}\n`);
console.log(JSON.stringify({ written: OUT, swaps: swaps.length + 1 + ercSwaps.length + rateSwaps.length + maxSwaps.length, refusals, old_owner_claim: oldOwnerClaim,
  supply: { native: native.supply, erc20: erc.supply, low_price: lowPrice.supply, full_width: fullWidth.supply } }));
