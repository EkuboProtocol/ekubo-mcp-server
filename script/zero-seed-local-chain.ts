// Local, fork-free run of the zero-seed launch on anvil: deploys the 4f1a306 artifacts the way a launcher would
// (extension at a mined CREATE2 address, then its periphery), then drives every MCP producer and owner decoder
// against that chain and executes exactly the calls they produced. It writes the fixture the tests replay.
//
//   anvil --port 8546 --chain-id 31337 --timestamp 1800000000 --base-fee 0 --gas-price 0
//   EVM_CONTRACTS=<evm-contracts checkout at 4f1a306, built with forge build> RPC_URL=http://127.0.0.1:8546 \
//     bun script/zero-seed-local-chain.ts test/fixtures/launchpad/zero-seed-native-local-chain.json
//
// Local evidence only: no fork, no live instance, no UserOp, bundler, paymaster or real quoter.
import { MAX_SQRT_RATIO, MIN_SQRT_RATIO, YUL_ROUTER_ABI, encodeRoutes } from "@ekubo/yul-router-sdk";
import { readFileSync, writeFileSync } from "node:fs";
import {
  type Address, type BaseError, concat, createPublicClient, createTestClient, createWalletClient, decodeEventLog, decodeFunctionResult,
  encodeAbiParameters, encodeFunctionData, getContractAddress, type Hex, http, keccak256, numberToHex, parseAbi,
  zeroAddress,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { storeArtifact } from "../src/artifact-store.js";
import type { Env } from "../src/core.js";
import { extensionAbi, peripheryAbi } from "../src/launchpad/zero-seed/abi.js";
import { feeAt } from "../src/launchpad/zero-seed/fee.js";
import type { ParametersInput } from "../src/launchpad/zero-seed/installation.js";
import { decodeOwnerClaim, decodeOwnerCreate, localClaimBody, localCreateBody, poolIdOf } from "../src/launchpad/zero-seed/owner.js";
import { CONTRACTS_COMMIT, EXTENSION_ABI_SHA256, type InstancePin, LOCAL_INSTANCE_PINS, NATIVE_QUOTE,
  PERIPHERY_ABI_SHA256, samePin } from "../src/launchpad/zero-seed/policy.js";
import { localInstallationPreview, type SyntheticPreviewWallet } from "../src/launchpad/zero-seed/preview.js";
import { verifyExtensionRuntime, verifyPeripheryRuntime } from "../src/launchpad/zero-seed/runtime.js";
import { localSwapFromQuote, ZERO_SEED_ROUTER } from "../src/launchpad/zero-seed/swap.js";

const ROOT = process.env.EVM_CONTRACTS;
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8546";
const OUT = process.argv[2];
if (!ROOT || !OUT) throw new Error("set EVM_CONTRACTS and pass the output path");

const CORE = "0x00000000000014aa86c5d3c41765bb24e11bd701" as Address;
const CORE_CODEHASH = "0xc5f90c9d0dbc5037f8f9e248f4bb292e7c1824f584eb6550cb4cad525b38c71a";
const ROUTER_CODEHASH = "0x32ba8475c95ee5d9f7807f4ad9dce849929c992df9c68e9030e986d1854e726f";
const WETH_CODEHASH = "0x8a3a1f6a9f9dce633117adee5b458245835a8645a8c8726a26382a4622508b1c";
const ERC20_QUOTE = "0xffffffffffffffffffffffffffffffffffffffff" as Address;
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920ca78fbf26c0b4956c" as Address;
const MNEMONIC = "test test test test test test test test test test test junk";
const [launcher, owner, buyer, recipient, newOwner] = [0, 1, 2, 3, 4].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
const lower = (a: string) => a.toLowerCase() as Address;

const transport = http(RPC);
const chain = { ...foundry, id: 31337 };
const pub = createPublicClient({ chain, transport });
const test = createTestClient({ chain, transport, mode: "anvil" });
const wallet = (account: typeof launcher) => createWalletClient({ chain, transport, account });

const artifact = (name: string) => JSON.parse(readFileSync(`${ROOT}/out/${name}.sol/${name}.json`, "utf8"));
const fixtureHex = (name: string) => `0x${readFileSync(`${ROOT}/test/fixtures/${name}`, "utf8").trim().replace(/^0x/, "")}` as Hex;

let clock = 1800000000n;
async function at(time: bigint) {
  if (time < clock) throw new Error("time runs forward");
  clock = time;
  await test.setNextBlockTimestamp({ timestamp: time });
}
async function send(account: typeof launcher, tx: { to?: Address; data: Hex; value?: bigint }, time: bigint) {
  await at(time);
  const hash = await wallet(account).sendTransaction({ ...tx, gasPrice: 0n, chain } as never);
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

// --- deployment, as a launcher would do it -------------------------------------------------------------------------
const deployed: Record<string, unknown> = {};
async function deployCore() {
  const receipt = await send(launcher, { data: artifact("Core").bytecode.object }, clock + 1n);
  const code = await pub.getCode({ address: receipt.contractAddress! });
  await test.setCode({ address: CORE, bytecode: code! });
  if (keccak256((await pub.getCode({ address: CORE }))!) !== CORE_CODEHASH) throw new Error("Core runtime");
  await test.setCode({ address: ZERO_SEED_ROUTER, bytecode: fixtureHex("yul-router-0x03c8-base-52449112.hex") });
  if (keccak256((await pub.getCode({ address: ZERO_SEED_ROUTER }))!) !== ROUTER_CODEHASH) throw new Error("router runtime");
  await test.setCode({ address: ERC20_QUOTE, bytecode: fixtureHex("weth9-0x4200-base-52449112.hex") });
  if (keccak256((await pub.getCode({ address: ERC20_QUOTE }))!) !== WETH_CODEHASH) throw new Error("WETH runtime");
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

async function deployInstance(quote: Address): Promise<InstancePin> {
  const args = encodeAbiParameters([{ type: "address" }, { type: "address" }], [CORE, quote]);
  const initCode = concat([artifact("ZeroSeedLaunch").bytecode.object, args]);
  const salt = mineSalt(initCode);
  const extensionReceipt = await send(launcher, { to: CREATE2_DEPLOYER, data: concat([salt, initCode]) }, clock + 1n);
  const extension = lower(getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt, bytecodeHash: keccak256(initCode) }));
  const peripheryArgs = encodeAbiParameters([{ type: "address" }, { type: "address" }], [CORE, extension]);
  const peripheryReceipt = await send(launcher, {
    data: concat([artifact("ZeroSeedLaunchPeriphery").bytecode.object, peripheryArgs]),
  }, clock + 1n);
  const periphery = lower(peripheryReceipt.contractAddress!);
  const extensionCode = (await pub.getCode({ address: extension }))!;
  const peripheryCode = (await pub.getCode({ address: periphery }))!;
  const native = quote === NATIVE_QUOTE;
  const pin: InstancePin = {
    chainId: "31337", core: CORE, extension, periphery, quote: lower(quote), quoteKind: native ? "native" : "erc20",
    quoteRuntime: native ? null : keccak256((await pub.getCode({ address: quote }))!),
    extensionRuntime: verifyExtensionRuntime(extensionCode, { core: CORE, quote }),
    peripheryRuntime: verifyPeripheryRuntime(peripheryCode, { core: CORE, extension }),
    extensionAbiSha256: EXTENSION_ABI_SHA256, peripheryAbiSha256: PERIPHERY_ABI_SHA256,
  };
  const readQuote = await pub.readContract({ address: extension, abi: extensionAbi, functionName: "quoteToken" });
  const readLaunch = await pub.readContract({ address: periphery, abi: peripheryAbi, functionName: "LAUNCH" });
  if (lower(readQuote) !== lower(quote) || lower(readLaunch) !== extension) throw new Error("instance identity");
  deployed[pin.quoteKind] = {
    create2_deployer: CREATE2_DEPLOYER, extension_salt: salt, extension_init_code_keccak256: keccak256(initCode),
    extension_transaction: extensionReceipt.transactionHash, periphery_transaction: peripheryReceipt.transactionHash,
    launcher: lower(launcher.address), extension_code: extensionCode, periphery_code: peripheryCode,
  };
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
const FEE_03 = "55340232221128654";
function parameters(label: string, tradingStart: bigint): ParametersInput {
  return {
    name: `Zero Seed ${label}`, symbol: label.toUpperCase(), decimals: 18, supply: "1000000000000000000000000000",
    liquidity: "0", askTick: -13815500, upperTick: -9210300, tickSpacing: 100, tradingStart: tradingStart.toString(),
    feeDuration: 3600, initialFee: FEE_5, finalFee: FEE_03, salt: `0x${"00".repeat(31)}01`,
  };
}

function decodeLogs(logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[]) {
  const out = [];
  for (const log of logs) {
    for (const [abi, name] of [[peripheryAbi, "periphery"], [extensionAbi, "extension"]] as const) {
      try {
        const event = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        out.push({ emitter: lower(log.address), source: name, event: event.eventName,
          args: JSON.parse(JSON.stringify(event.args, (_, v) => (typeof v === "bigint" ? v.toString() : typeof v === "string" ? v.toLowerCase() : v))) });
        break;
      } catch { /* not this ABI */ }
    }
  }
  return out;
}

async function createLaunch(pin: InstancePin, label: string) {
  const build = await mineAt(clock + 10n);
  const buildTime = build.timestamp;
  const request = parameters(label, buildTime + 600n);
  const buildContext = {
    buildTime: buildTime.toString(), executionExpiry: (buildTime + 300n).toString(),
    blockNumber: build.number.toString(), blockHash: build.hash, blockTime: buildTime.toString(),
  };
  const preview = await localInstallationPreview({ owner: lower(owner.address), request, pin, build: buildContext },
    previewWallet, () => buildTime + 1n);
  const sealed = localCreateBody(preview);
  const body = JSON.parse(sealed.body);
  const summary = decodeOwnerCreate(sealed, { pin, owner: lower(owner.address), requested: request }, buildTime + 1n);
  const lastFresh = decodeOwnerCreate(sealed, { pin, owner: lower(owner.address), requested: request }, buildTime + 299n);
  if (JSON.stringify(summary) !== JSON.stringify(lastFresh)) throw new Error("summary depends on fresh time");
  const withValue = await revertSelector({ account: owner.address, to: body.target, data: body.data, value: 1n });
  const simulated = await pub.call({ account: owner.address, to: body.target, data: body.data });
  const receipt = await send(owner, { to: body.target, data: body.data }, buildTime + 60n);
  const installation = decodeFunctionResult({ abi: peripheryAbi, functionName: "create", data: simulated.data! });
  if (lower(installation.token) !== preview.installation.token) throw new Error("installed token != preview");
  return {
    label, request, build: buildContext, preview: { raw: preview.preview.raw, installation: preview.installation },
    sealed, owner_summary: summary, create_with_value: withValue, simulation_return: simulated.data,
    receipt: { block_number: receipt.blockNumber.toString(), block_hash: receipt.blockHash, transaction_hash: receipt.transactionHash,
      timestamp: (buildTime + 60n).toString(), status: receipt.status },
    events: decodeLogs(receipt.logs),
  };
}

const erc20 = parseAbi([
  "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function deposit() payable",
]);
const balance = async (token: Address, who: Address, blockNumber?: bigint) => token === NATIVE_QUOTE
  ? pub.getBalance({ address: who, blockNumber })
  : pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [who], blockNumber });

/** The router's own quote at block S, shaped as the quoter's QuoteResponse. Not real quoter output. */
async function routerQuote(pin: InstancePin, poolKey: { token0: Address; token1: Address; config: Hex }, specified: Address,
  other: Address, amount: bigint, block: { number: bigint; hash: Hex; timestamp: bigint }) {
  const inputIs0 = (amount > 0n ? specified : other) === poolKey.token0;
  const limit = inputIs0 ? MIN_SQRT_RATIO : MAX_SQRT_RATIO;
  const route = encodeRoutes({
    specifiedToken: specified, calculatedToken: other, calculatedAmountThreshold: amount > 0n ? 1n : -(1n << 127n) + 1n,
    recipient: buyer.address, multiHops: [{ specifiedAmount: amount, hops: [{ type: "forwarded", forwardee: pin.extension as Address,
      skipAhead: 0, poolKey, sqrtRatioLimit: limit }] }],
  });
  const { data } = await pub.call({ account: buyer.address, to: ZERO_SEED_ROUTER, blockNumber: block.number, value: 0n,
    data: encodeFunctionData({ abi: YUL_ROUTER_ABI, functionName: "quote", args: [route] }) });
  const [, , , calculated] = decodeFunctionResult({ abi: YUL_ROUTER_ABI, functionName: "quote", data: data! });
  const total = (calculated < 0n ? -calculated : calculated).toString();
  return {
    block_number: Number(block.number), block_hash: block.hash, estimated_gas_cost: 0, price_impact: null, total_calculated: total,
    splits: [{ amount_specified: amount.toString(), amount_calculated: total, route: [{ swap: {
      type: "forwarded", forwardee: pin.extension, skip_ahead: 0, sqrt_ratio_limit: `0x${limit.toString(16)}`,
      pool_key: { token0: poolKey.token0, token1: poolKey.token1, config: poolKey.config },
    } }] }],
  };
}

async function swap(pin: InstancePin, launch: { token: Address; poolKey: { token0: Address; token1: Address; config: Hex } },
  schedule: { trading_start: number; fee_duration: number; initial_fee: string; final_fee: string },
  side: "buy" | "sell", exactOut: boolean, amount: bigint, time: bigint) {
  const quote = lower(pin.quote);
  const [specified, other] = side === "buy" ? (exactOut ? [launch.token, quote] : [quote, launch.token])
    : (exactOut ? [quote, launch.token] : [launch.token, quote]);
  const signed = exactOut ? -amount : amount;
  const block = await mineAt(time);
  const response = await routerQuote(pin, launch.poolKey, specified, other, signed, block);
  const quoted = BigInt(response.total_calculated);
  const guard = exactOut ? { max_input: ((quoted * 10050n) / 10000n + 1n).toString() } : { min_output: ((quoted * 9950n) / 10000n).toString() };
  const request = { amount: signed.toString(), specified_token: specified, other_token: other, extension: pin.extension,
    deadline: (time + 60n).toString(), ...guard };
  const context = { blockNumber: block.number.toString(), blockHash: block.hash, blockTime: block.timestamp.toString() };
  const plan = localSwapFromQuote({ pin, request, response, context, recipient: lower(buyer.address),
    launch: { pool_key: launch.poolKey, fee_schedule: schedule } }, time);
  if (plan.input_approval) {
    await send(buyer, { to: plan.input_approval.token as Address, data: encodeFunctionData({ abi: erc20, functionName: "approve",
      args: [ZERO_SEED_ROUTER, BigInt(plan.input_approval.amount)] }) }, time);
  }
  const pre = await mineAt(time);
  const before = { quote: await balance(quote, buyer.address), token: await balance(launch.token, buyer.address),
    router_eth: await pub.getBalance({ address: ZERO_SEED_ROUTER }) };
  const receipt = await send(buyer, { to: ZERO_SEED_ROUTER, data: plan.data, value: BigInt(plan.value) }, time);
  const after = { quote: await balance(quote, buyer.address), token: await balance(launch.token, buyer.address),
    router_eth: await pub.getBalance({ address: ZERO_SEED_ROUTER }) };
  const events = decodeLogs(receipt.logs);
  const swapped = events.find((e) => e.event === "LaunchSwapped")!;
  const rate = feeAt({ tradingStart: BigInt(schedule.trading_start), feeDuration: BigInt(schedule.fee_duration),
    initialFee: BigInt(schedule.initial_fee), finalFee: BigInt(schedule.final_fee) }, time);
  return {
    side, exact_out: exactOut, request, response, context, plan, quote_block: { number: block.number.toString(), hash: block.hash,
      timestamp: block.timestamp.toString() }, pre_block: pre.number.toString(),
    receipt: { block_number: receipt.blockNumber.toString(), transaction_hash: receipt.transactionHash, timestamp: time.toString(),
      gas_used: receipt.gasUsed.toString(), effective_gas_price: receipt.effectiveGasPrice.toString() },
    events, ts_fee_rate: rate.toString(),
    deltas: { quote: (after.quote - before.quote).toString(), token: (after.token - before.token).toString(),
      router_eth: (after.router_eth - before.router_eth).toString() },
  };
}

async function claim(pin: InstancePin, launch: { poolKey: { token0: Address; token1: Address; config: Hex } },
  claimer: typeof owner, to: Address, time: bigint) {
  const block = await mineAt(time);
  const poolId = poolIdOf(launch.poolKey);
  const current = await pub.readContract({ address: pin.periphery as Address, abi: peripheryAbi, functionName: "launchOwner",
    args: [poolId], blockNumber: block.number });
  const ownerCheck = { block_number: block.number.toString(), block_hash: block.hash, pool_id: poolId, launch_owner: lower(current) };
  const build = { buildTime: block.timestamp.toString(), executionExpiry: (block.timestamp + 300n).toString() };
  const sealed = localClaimBody({ owner: lower(claimer.address), pin, poolKey: launch.poolKey, recipient: lower(to), ownerCheck, build });
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
await deployCore();
const nativePin = await deployInstance(NATIVE_QUOTE);
const erc20Pin = await deployInstance(ERC20_QUOTE);
const pins = [nativePin, erc20Pin];
const pinned = pins.every((pin) => LOCAL_INSTANCE_PINS.some((p) => samePin(p, pin))) && LOCAL_INSTANCE_PINS.length === pins.length;
if (!pinned) {
  console.log(JSON.stringify({ discovered_pins: pins }, null, 2));
  throw new Error("LOCAL_INSTANCE_PINS differ from this deployment; update policy.ts and rerun");
}

const native = await createLaunch(nativePin, "n1");
const erc = await createLaunch(erc20Pin, "e1");
const launchOf = (c: typeof native) => ({ token: c.preview.installation.token as Address, poolKey: c.preview.installation.poolKey as never });
const scheduleOf = (c: typeof native) => ({ trading_start: Number(c.request.tradingStart), fee_duration: c.request.feeDuration,
  initial_fee: c.request.initialFee, final_fee: c.request.finalFee });

await test.setBalance({ address: buyer.address, value: 10n ** 24n });
const start = BigInt(native.request.tradingStart);
const n = launchOf(native);
const earlyRoute = encodeRoutes({ specifiedToken: NATIVE_QUOTE, calculatedToken: n.token, calculatedAmountThreshold: 1n,
  recipient: buyer.address, multiHops: [{ specifiedAmount: 10n ** 18n, hops: [{ type: "forwarded",
    forwardee: nativePin.extension as Address, skipAhead: 0, poolKey: n.poolKey, sqrtRatioLimit: MIN_SQRT_RATIO }] }] });
const tooEarly = await revertSelector({ account: buyer.address, to: ZERO_SEED_ROUTER, value: 10n ** 18n, data: earlyRoute });
const swaps = [
  await swap(nativePin, n, scheduleOf(native), "buy", false, 10n ** 18n, start + 30n),
  await swap(nativePin, n, scheduleOf(native), "buy", true, 10n ** 23n, start + 60n),
  await swap(nativePin, n, scheduleOf(native), "sell", false, 10n ** 22n, start + 90n),
  await swap(nativePin, n, scheduleOf(native), "sell", true, 10n ** 16n, start + 120n),
];
const firstClaim = await claim(nativePin, n, owner, recipient.address, start + 200n);

// Refusals the chain itself makes, as eth_call reverts.
const poolId = poolIdOf(n.poolKey);
const claimData = (to: Address) => encodeFunctionData({ abi: peripheryAbi, functionName: "claimFees", args: [n.poolKey, to] });
const refusals = {
  claim_by_non_owner: await revertSelector({ account: buyer.address, to: nativePin.periphery as Address, data: claimData(buyer.address) }),
  claim_to_periphery: await revertSelector({ account: owner.address, to: nativePin.periphery as Address, data: claimData(nativePin.periphery as Address) }),
  claim_to_zero: await revertSelector({ account: owner.address, to: nativePin.periphery as Address, data: claimData(zeroAddress) }),
  claim_with_value: await revertSelector({ account: owner.address, to: nativePin.periphery as Address, data: claimData(recipient.address), value: 1n }),
  swap_before_trading_start: tooEarly,
};

// Ownership transfer: the owner hands the launch to newOwner, which then holds every unclaimed fee.
const transferData = encodeFunctionData({ abi: peripheryAbi, functionName: "transferLaunch", args: [poolId, newOwner.address] });
const transferReceipt = await send(owner, { to: nativePin.periphery as Address, data: transferData }, start + 300n);
const afterTransferSwap = await swap(nativePin, n, scheduleOf(native), "buy", false, 10n ** 18n, start + 400n);
const oldOwnerClaim = await revertSelector({ account: owner.address, to: nativePin.periphery as Address, data: claimData(owner.address) });
const secondClaim = await claim(nativePin, n, newOwner, newOwner.address, start + 500n);

const e = launchOf(erc);
await send(buyer, { to: ERC20_QUOTE, data: encodeFunctionData({ abi: erc20, functionName: "deposit" }), value: 10n ** 21n }, start + 600n);
const ercStart = BigInt(erc.request.tradingStart);
const ercSwap = await swap(erc20Pin, e, scheduleOf(erc), "buy", false, 10n ** 18n, (ercStart > clock ? ercStart : clock) + 30n);

const fixture = {
  scope: "LOCAL anvil chain from evm-contracts 4f1a306 artifacts. Not a fork, live instance, UserOp, bundler or real quoter output.",
  contracts_commit: CONTRACTS_COMMIT,
  accounts: { launcher: lower(launcher.address), owner: lower(owner.address), buyer: lower(buyer.address),
    recipient: lower(recipient.address), new_owner: lower(newOwner.address) },
  core: CORE, router: ZERO_SEED_ROUTER, pins, deployed,
  launches: { native, erc20: erc },
  swaps, first_claim: firstClaim, refusals,
  transfer: { data: transferData, receipt: { block_number: transferReceipt.blockNumber.toString(), transaction_hash: transferReceipt.transactionHash },
    events: decodeLogs(transferReceipt.logs) },
  after_transfer: { swap: afterTransferSwap, old_owner_claim: oldOwnerClaim, claim: secondClaim },
  erc20_swap: ercSwap,
};
writeFileSync(OUT, `${JSON.stringify(fixture, null, 1)}\n`);
console.log(JSON.stringify({ written: OUT, swaps: swaps.length + 2, refusals, old_owner_claim: oldOwnerClaim }));
