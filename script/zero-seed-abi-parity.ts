import { createHash } from "node:crypto";
import { type Abi, type Address, encodeErrorResult, encodeEventTopics, encodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import { CLAIM_SELECTOR, type FeeModel, MODEL_ABIS, TRANSFER_SELECTOR } from "../src/launchpad/zero-seed/abi.js";
import { ABI_SHA256 } from "../src/launchpad/zero-seed/policy.js";

// Offline comparison of each fee model's ABI subset against the exact full compiled ABIs of its revision; not a
// provider read. Pass one or both revisions as extension/periphery pairs, each the compact, key-sorted JSON without
// a trailing newline: `jq -cS .abi <artifact> | tr -d '\n'`. The model of each pair is identified by its SHA-256:
//   bun script/zero-seed-abi-parity.ts ext-3d6378f.json per-3d6378f.json [ext-43d6628.json per-43d6628.json]
const paths = process.argv.slice(2);
if (paths.length === 0 || paths.length % 2 !== 0) throw new Error("Pass ZeroSeedLaunch and ZeroSeedLaunchPeriphery ABI pairs");

async function load(path: string) {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return { digest: createHash("sha256").update(bytes).digest("hex"), abi: JSON.parse(new TextDecoder().decode(bytes)) as Abi };
}

const owner = "0x0000000000000000000000000000000000000123" as Address;
const config = `0x${"00".repeat(32)}` as Hex;
const MAX = (1n << 64n) - 1n;
const base = {
  name: "Local λ", symbol: "LOC", decimals: 18, supply: 1000000000000000000000000000n,
  quoteToken: "0xffffffffffffffffffffffffffffffffffffffff" as Address,
  askTick: -13815500, upperTick: -9210300, tickSpacing: 100, tradingStart: 1300n,
  initialFee: 922337203685477580n, finalFee: 55340232221128654n, salt: config,
};
/** The model's tuple: the 10th field is feeDuration (v1) or decayRateX32 (v2), at its extremes too. */
function tuples(model: FeeModel) {
  const decay = model === "tick_rate_v2"
    ? [{ decayRateX32: 68913100933n }, { decayRateX32: 0n }, { decayRateX32: MAX }]
    : [{ feeDuration: 3600 }, { feeDuration: 1 }, { feeDuration: 4294967295 }];
  return decay.flatMap((d) => [{ ...base, ...d }, { ...base, ...d, initialFee: MAX, finalFee: MAX }]);
}

const poolKey = { token0: "0x0000000000000000000000000000000000000000" as Address, token1: owner, config };
let controls = 0;
function same(a: unknown, b: unknown, label: string) {
  if (JSON.stringify(a, (_, v) => (typeof v === "bigint" ? v.toString() : v)) !==
    JSON.stringify(b, (_, v) => (typeof v === "bigint" ? v.toString() : v))) throw new Error(`${label} encoding mismatch`);
  controls++;
}

function checkPeriphery(model: FeeModel, periphery: Abi) {
  const subset = MODEL_ABIS[model];
  for (const tuple of tuples(model)) {
    const create = encodeFunctionData({ abi: subset.periphery as Abi, functionName: "create", args: [tuple] });
    same(create, encodeFunctionData({ abi: periphery, functionName: "create", args: [tuple] }), `${model} create`);
    same(create.slice(0, 10), subset.createSelector, `${model} create selector`);
    const preview = encodeFunctionData({ abi: subset.periphery as Abi, functionName: "previewInstallation", args: [owner, tuple] });
    same(preview, encodeFunctionData({ abi: periphery, functionName: "previewInstallation", args: [owner, tuple] }), `${model} preview`);
    same(preview.slice(0, 10), subset.previewSelector, `${model} preview selector`);
  }
  const claim = encodeFunctionData({ abi: subset.periphery as Abi, functionName: "claimFees", args: [poolKey, owner] });
  same(claim, encodeFunctionData({ abi: periphery, functionName: "claimFees", args: [poolKey, owner] }), `${model} claim`);
  same(claim.slice(0, 10), CLAIM_SELECTOR, `${model} claim selector`);
  const transfer = encodeFunctionData({ abi: subset.periphery as Abi, functionName: "transferLaunch", args: [config, owner] });
  same(transfer, encodeFunctionData({ abi: periphery, functionName: "transferLaunch", args: [config, owner] }), `${model} transfer`);
  same(transfer.slice(0, 10), TRANSFER_SELECTOR, `${model} transfer selector`);
  const installation = { token: owner, poolKey, positionId: config, initialTick: -13815500,
    liquidity: 1111119116089565312897934n, installedSupply: 999999999999999999999999210n };
  same(encodeFunctionResult({ abi: subset.periphery as Abi, functionName: "previewInstallation", result: installation }),
    encodeFunctionResult({ abi: periphery, functionName: "previewInstallation", result: installation }), `${model} preview result`);
  for (const eventName of ["LaunchOwnerChanged", "LaunchFeesClaimed"] as const) {
    same(encodeEventTopics({ abi: subset.periphery as Abi, eventName }), encodeEventTopics({ abi: periphery, eventName }), eventName);
  }
}

function checkExtension(model: FeeModel, extension: Abi) {
  const subset = MODEL_ABIS[model];
  for (const eventName of ["LaunchCreated", "LaunchSwapped", "CreatorFeesClaimed"] as const) {
    same(encodeEventTopics({ abi: subset.extension as Abi, eventName }), encodeEventTopics({ abi: extension, eventName }), eventName);
  }
  same(encodeEventTopics({ abi: extension, eventName: "LaunchCreated" })[0], subset.launchCreatedTopic, `${model} LaunchCreated topic`);
  for (const errorName of ["UnsupportedQuoteToken", "ZeroLiquidity", "InvalidFeeSchedule"] as const) {
    same(encodeErrorResult({ abi: subset.extension as Abi, errorName }), encodeErrorResult({ abi: extension, errorName }), errorName);
  }
  same(encodeErrorResult({ abi: subset.extension as Abi, errorName: "LiquidityAboveTickCap", args: [1n, 2n] }),
    encodeErrorResult({ abi: extension, errorName: "LiquidityAboveTickCap", args: [1n, 2n] }), "LiquidityAboveTickCap");
  // Removed at 40af6cb: the constructor quote's getter and the exact-installable-supply error. Removed at 550afc4: the
  // fee ceiling's FeeTooHigh error. InvalidFeeSchedule remains the only fee refusal in both revisions.
  for (const name of ["quoteToken", "SupplyNotExactlyInstallable", "FeeTooHigh"]) {
    if (extension.some((entry) => "name" in entry && entry.name === name)) throw new Error(`${name} is still in the compiled ABI`);
    controls++;
  }
}

const checked: Record<string, { extensionAbiSha256: string; peripheryAbiSha256: string }> = {};
for (let i = 0; i < paths.length; i += 2) {
  const [extension, periphery] = [await load(paths[i]), await load(paths[i + 1])];
  const model = (Object.keys(ABI_SHA256) as FeeModel[]).find((m) => ABI_SHA256[m].extension === extension.digest);
  if (model === undefined || ABI_SHA256[model].periphery !== periphery.digest) {
    throw new Error(`Frozen full ABI mismatch: ${extension.digest} / ${periphery.digest}`);
  }
  checkPeriphery(model, periphery.abi);
  checkExtension(model, extension.abi);
  checked[model] = { extensionAbiSha256: extension.digest, peripheryAbiSha256: periphery.digest };
}
console.log(JSON.stringify({ scope: "offline-ABI-subset-parity", checked, controls, executable: false, fullCompiledAbiModified: false }));
