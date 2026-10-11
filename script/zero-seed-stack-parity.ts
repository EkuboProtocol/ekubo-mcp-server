import assert from "node:assert/strict";
import { type Address, decodeFunctionData, encodeFunctionResult, type Hex, keccak256 } from "viem";
import { storeArtifact } from "../src/artifact-store.js";
import type { Env } from "../src/core.js";
import { zeroSeedAbi } from "../src/launchpad/zero-seed/abi.js";
import { MINTABLE_ERC20_CREATION_KECCAK } from "../src/launchpad/zero-seed/mintable-erc20.js";
import { decodeOwnerClaim, decodeOwnerCreate, localClaimBody, localCreateBody } from "../src/launchpad/zero-seed/owner.js";
import { LOCAL_INSTANCE_PINS, type InstancePin } from "../src/launchpad/zero-seed/policy.js";
import { localInstallationPreview, PREVIEW_ID, type SyntheticPreviewWallet } from "../src/launchpad/zero-seed/preview.js";
import { localSwapFromQuote } from "../src/launchpad/zero-seed/swap.js";
import { predictLaunchToken } from "../src/launchpad/zero-seed/token.js";

// Cross-source parity over accepted, hash-pinned LOCAL artifacts: actual API handler goldens,
// the accepted quoter's router vectors, the emitted local chain, contract vectors and pins.
// No provider, wallet, API server, quoter or chain is contacted.
const root = Bun.argv[2];
if (!root) throw new Error("Pass the artifacts directory (/home/moody/Work/ekubo/artifacts)");
const PINNED = {
  "eku-1523/actual-handler-golden.json": "5e8e93cef1f23e02f8f54336fdcf0a7a81a3b36bb4984ed57cb991e5783df351",
  "eku-1522/final-router/router-vectors.json": "672177cb8b8d4bcf8515755408489c69240eb158d88f75af4d4ecdb33d8cc0d7",
  "eku-1522/final-router/regenerated-local-chain.json": "41d416cebdc78845f022f504ed72c86789890f3009f37e2dccf62f2d0f9ca9d4",
  "eku-1528/delivery/test/vectors/zero-seed-launch.json": "0a136d132d37de2d775e7f50b6bba413d2fda1cfd5c63e294d6bd060e28e8127",
  "eku-1528/pins.json": "f78c349e1403ecf89d2bc1b7be208752ec4e8692729d8bc727227b93525ab881",
} as const;
let checks = 0;
const ok = () => { checks++; };

async function load(name: keyof typeof PINNED) {
  const bytes = new Uint8Array(await Bun.file(`${root}/${name}`).arrayBuffer());
  assert.equal(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), PINNED[name], name); ok();
  return JSON.parse(new TextDecoder().decode(bytes));
}
const api = await load("eku-1523/actual-handler-golden.json");
const router = await load("eku-1522/final-router/router-vectors.json");
const chain = await load("eku-1522/final-router/regenerated-local-chain.json");
const contract = await load("eku-1528/delivery/test/vectors/zero-seed-launch.json");
const pins = await load("eku-1528/pins.json");
assert.equal(pins.MintableERC20.creation.keccak, MINTABLE_ERC20_CREATION_KECCAK); ok();

const fixture = await Bun.file(new URL("../test/fixtures/launchpad/zero-seed-router-vectors.json", import.meta.url)).json();
assert.equal(fixture.source_sha256, PINNED["eku-1522/final-router/router-vectors.json"]);
assert.deepEqual(fixture.vectors.map((v: any) => [v.calldata, v.response]), router.vectors.map((v: any) => [v.calldata, v.quote.response])); ok();

const creator = chain.addresses.creator.toLowerCase() as Address;
const lower = (value: string) => value.toLowerCase();
const blocks = new Map<number, { hash: string; timestamp: number }>(
  Object.values(chain.branches).flatMap((b: any) => b.blocks).map((b: any) => [b.number, b]),
);
// l1: launch token is token0 under the high WETH instance; l3: token1 under the low WETH instance.
const ORDERS = [
  { label: "l1", pin: LOCAL_INSTANCE_PINS[0], detail: api.detail, row: "t0", buildBlock: 3 },
  { label: "l3", pin: LOCAL_INSTANCE_PINS[1], detail: api.lowWeth, row: "t1", buildBlock: 7 },
] as const;

function requested(detail: any, pin: InstancePin) {
  const fee = detail.fee_schedule;
  return {
    quoteToken: pin.quote, name: detail.token.name, symbol: detail.token.symbol, decimals: detail.token.decimals,
    supply: chain.installations[detail.token.symbol.toLowerCase()].requestedSupply, liquidity: "0",
    askTick: detail.ask_tick, upperTick: detail.upper_tick, tickSpacing: detail.pool_key.tick_spacing,
    tradingStart: String(fee.trading_start), feeDuration: fee.fee_duration, initialFee: fee.initial_fee,
    finalFee: fee.final_fee, salt: `0x${"00".repeat(31)}01`,
  };
}

function identity(order: (typeof ORDERS)[number]) {
  const { detail, pin, label } = order;
  const launch = chain.launches[label];
  const install = chain.installations[label];
  const row = contract.create.find((r: any) => r.order === order.row && r.dec === "18/18");
  assert.equal(detail.pool_key.extension, pin.address);
  assert.equal(lower(launch.extension), pin.address);
  assert.equal(detail.quote_token.address, pin.quote);
  assert.equal(detail.pool_id, launch.poolId);
  assert.equal(detail.token.address, lower(launch.token));
  assert.equal(detail.launch_token_is_token1, label === "l3"); ok();
  // The fixture generator searched salts from 1; salt 1 reproduces both emitted tokens.
  assert.equal(predictLaunchToken(pin.address as Address, creator, requested(detail, pin)), detail.token.address); ok();
  for (const installed of [install.actualInstalledSupply, row.installed]) assert.equal(detail.principal.installed_supply, installed);
  for (const liquidity of [install.actualLiquidity, row.liquidity]) assert.equal(detail.principal.liquidity, liquidity);
  assert.equal(detail.principal.tick_lower, Number(row.tickLower));
  assert.equal(detail.principal.tick_upper, Number(row.tickUpper)); ok();
}

function previewWallet(order: (typeof ORDERS)[number], build: { blockNumber: string; blockHash: string; blockTime: string }) {
  const storage = new Map<string, string>();
  const env = { ARTIFACT_STORE: { put: async (key: string, body: string) => { storage.set(key, body); } } } as unknown as Env;
  const { detail } = order;
  const installation = {
    token: detail.token.address as Address,
    poolKey: { token0: detail.pool_key.token0 as Address, token1: detail.pool_key.token1 as Address, config: detail.pool_key.config as Hex },
    positionId: detail.principal.position_id as Hex, initialTick: detail.launch_token_is_token1 ? detail.principal.tick_upper : detail.principal.tick_lower,
    liquidity: BigInt(detail.principal.liquidity), installedSupply: BigInt(detail.principal.installed_supply),
  };
  const wallet: SyntheticPreviewWallet = {
    storeRead: (body) => storeArtifact(env, "https://synthetic.invalid", { artifactType: "read_calls", body }),
    async read(reference) {
      const body = JSON.parse(storage.get(new URL(reference.url).pathname.slice(1))!);
      assert.equal(decodeFunctionData({ abi: zeroSeedAbi, data: body.calls[0].data }).functionName, "previewInstallation");
      const data = encodeFunctionResult({ abi: zeroSeedAbi, functionName: "previewInstallation", result: installation });
      return { chainId: order.pin.chainId, ...build, results: [{ id: PREVIEW_ID, success: true, data }] };
    },
  };
  return wallet;
}

async function decoder(order: (typeof ORDERS)[number]) {
  const { detail, pin } = order;
  const header = blocks.get(order.buildBlock)!;
  const build = { buildTime: String(header.timestamp), executionExpiry: String(header.timestamp + 60), blockNumber: String(order.buildBlock),
    blockHash: header.hash, blockTime: String(header.timestamp) };
  const request = requested(detail, pin);
  const preview = await localInstallationPreview({ creator, request, pin, build }, previewWallet(order, build), () => BigInt(header.timestamp));
  const summary = decodeOwnerCreate(localCreateBody(preview), { pin, creator, requested: request }, BigInt(header.timestamp));
  const f = summary.fields;
  assert.deepEqual(
    [f.creator, f.binding.token, f.supply, f.liquidity, f.ask_tick, f.upper_tick, f.trading_start, f.fee_duration, f.initial_fee, f.final_fee],
    [detail.creator, detail.token.address, detail.principal.installed_supply, detail.principal.liquidity, detail.ask_tick,
      detail.upper_tick, detail.fee_schedule.trading_start, detail.fee_schedule.fee_duration, detail.fee_schedule.initial_fee, detail.fee_schedule.final_fee],
  );
  assert.deepEqual(f.binding.pool_key, { token0: detail.pool_key.token0, token1: detail.pool_key.token1, config: detail.pool_key.config });
  assert.equal(f.binding.position_id, detail.principal.position_id);
  assert.equal(f.binding.launch_token_is_token1, detail.launch_token_is_token1); ok();
  const claimBuild = { buildTime: build.buildTime, executionExpiry: build.executionExpiry };
  const poolKey = summary.fields.binding.pool_key;
  const claim = decodeOwnerClaim(localClaimBody({ creator, pin, poolKey, recipient: api.claims.data[0].recipient, build: claimBuild }),
    { pin, creator }, BigInt(header.timestamp));
  assert.equal(claim.fields.recipient, api.claims.data[0].recipient); ok();
}

function stateTick(word: string): { tick: number; liquidity: bigint } {
  const value = BigInt(word);
  return { tick: Number(BigInt.asIntN(32, value >> 128n)), liquidity: value & ((1n << 128n) - 1n) };
}

function quoter(order: (typeof ORDERS)[number]) {
  const { detail, pin, label } = order;
  const vectors = router.vectors.filter((v: any) => v.label === label);
  assert.equal(vectors.length, 4);
  for (const vector of vectors) {
    const swap = vector.quote.response.splits[0].route[0].swap;
    assert.deepEqual({ token0: lower(swap.pool_key.token0), token1: lower(swap.pool_key.token1), config: swap.pool_key.config },
      { token0: detail.pool_key.token0, token1: detail.pool_key.token1, config: detail.pool_key.config });
    const specified = lower(vector.input.specified_token);
    const other = [detail.pool_key.token0, detail.pool_key.token1].find((t) => t !== specified);
    const exactIn = !vector.input.amount.startsWith("-");
    const prepared = localSwapFromQuote({
      pin, recipient: chain.addresses.trader,
      request: { amount: vector.input.amount, specified_token: specified, other_token: other, extension: pin.address,
        ...(exactIn ? { min_output: vector.quote.response.total_calculated } : { max_input: vector.quote.response.total_calculated }),
        deadline: String(vector.input.time) },
      response: vector.quote.response,
      context: { blockNumber: String(vector.input.block_number), blockHash: vector.input.block_hash, blockTime: String(vector.input.time) },
    }, BigInt(vector.input.time));
    assert.equal(prepared.data, lower(vector.calldata));
    assert.equal(keccak256(prepared.data), vector.calldataKeccak);
    // Executed one block later at the same time and pre-state: not the input blockhash.
    assert.equal(Number(vector.executionBlockNumber), vector.input.block_number + 1);
    assert.notEqual(vector.executionBlockHash, vector.input.block_hash); ok();
    const state = stateTick(vector.input.state_word);
    assert.equal(state.liquidity.toString(), detail.principal.liquidity); ok();
  }
  return stateTick(vectors[0].input.state_word);
}

const sameTime: Record<string, unknown> = {};
for (const order of ORDERS) {
  identity(order);
  await decoder(order);
  const state = quoter(order);
  const listRow = [...api.list.data, ...api.second.data].find((row: any) => row.pool_id === order.detail.pool_id);
  const input = router.vectors.find((v: any) => v.label === order.label).input;
  assert.equal(listRow.as_of.block_time, input.time); ok();
  if (order.detail.as_of.block_time === input.time) {
    // API reports the launch-token-oriented tick; flip for token1 launches.
    const apiTick = order.detail.launch_token_is_token1 ? -order.detail.inventory.price_tick : order.detail.inventory.price_tick;
    assert.equal(apiTick, state.tick); ok();
    sameTime[order.label] = { time: input.time, tick: state.tick, apiBlock: order.detail.as_of.block_number, quoterBlock: input.block_number,
      sameBlockHash: order.detail.as_of.block_hash === input.block_hash };
  } else {
    sameTime[order.label] = { time: input.time, tick: "NOT COVERED: API golden has no price tick for this launch at the quoter time" };
  }
}

console.log(JSON.stringify({
  scope: "LOCAL cross-source parity over accepted hash-pinned artifacts; no network/provider/wallet calls",
  checks, artifacts: PINNED, orders: ORDERS.map((o) => ({ label: o.label, extension: o.pin.address, token: o.detail.token.address,
    launchTokenIsToken1: o.detail.launch_token_is_token1 })),
  sameTimeState: sameTime,
  notProven: [
    "API golden and quoter router vectors are separate local runs: equal time/state where covered, not equal block hashes",
    "Execution was one block after the quote input (same pre-state/time); not identical blockhash or a mined UserOp",
    "Decoder build headers are real chain blocks; l3 preview values were captured at block 9 and replayed at block 7 header",
    "Gas: estimated_gas_cost is not read; no gas limit, UserOp budget or affordability is derived",
    "Executable use, live/hosted instances, registration, wallet simulation and release remain HOLD",
  ],
}, null, 2));
