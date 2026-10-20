import { createHash } from "node:crypto";
import { type Abi, type Address, encodeEventTopics, encodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import { CLAIM_SELECTOR, CREATE_SELECTOR, extensionAbi, peripheryAbi, PREVIEW_SELECTOR,
  TRANSFER_SELECTOR } from "../src/launchpad/zero-seed/abi.js";
import { abiParameters, type ParametersInput } from "../src/launchpad/zero-seed/installation.js";
import { EXTENSION_ABI_SHA256, PERIPHERY_ABI_SHA256 } from "../src/launchpad/zero-seed/policy.js";

// Offline comparison against the exact full compiled ABIs; not a provider read. Pass each as the compact,
// key-sorted JSON without a trailing newline: `jq -cS .abi <artifact> | tr -d '\n'`.
const [extensionPath, peripheryPath] = process.argv.slice(2);
if (!extensionPath || !peripheryPath) throw new Error("Pass the ZeroSeedLaunch and ZeroSeedLaunchPeriphery ABIs");
async function load(path: string, expected: string) {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expected) throw new Error(`Frozen full ABI mismatch for ${path}: ${digest}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as Abi;
}
const extension = await load(extensionPath, EXTENSION_ABI_SHA256);
const periphery = await load(peripheryPath, PERIPHERY_ABI_SHA256);

const owner = "0x0000000000000000000000000000000000000123" as Address;
const config = `0x${"00".repeat(32)}` as Hex;
const parameters: ParametersInput = {
  name: "Local λ", symbol: "LOC", decimals: 18, supply: "1000000000000000000000000000", liquidity: "1111119116089565312897934",
  askTick: -13815500, upperTick: -9210300, tickSpacing: 100, tradingStart: "1300", feeDuration: 3600,
  initialFee: "922337203685477580", finalFee: "55340232221128654", salt: config,
};
const tuple = abiParameters(parameters);
const poolKey = { token0: "0x0000000000000000000000000000000000000000" as Address, token1: owner, config };
let controls = 0;
function same(a: unknown, b: unknown, label: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} encoding mismatch`);
  controls++;
}
for (const abi of [peripheryAbi, periphery]) {
  const create = encodeFunctionData({ abi, functionName: "create", args: [tuple] });
  same(create, encodeFunctionData({ abi: periphery, functionName: "create", args: [tuple] }), "create");
  same(create.slice(0, 10), CREATE_SELECTOR, "create selector");
  const preview = encodeFunctionData({ abi, functionName: "previewInstallation", args: [owner, tuple] });
  same(preview, encodeFunctionData({ abi: periphery, functionName: "previewInstallation", args: [owner, tuple] }), "preview");
  same(preview.slice(0, 10), PREVIEW_SELECTOR, "preview selector");
  const claim = encodeFunctionData({ abi, functionName: "claimFees", args: [poolKey, owner] });
  same(claim, encodeFunctionData({ abi: periphery, functionName: "claimFees", args: [poolKey, owner] }), "claim");
  same(claim.slice(0, 10), CLAIM_SELECTOR, "claim selector");
  const transfer = encodeFunctionData({ abi, functionName: "transferLaunch", args: [config, owner] });
  same(transfer, encodeFunctionData({ abi: periphery, functionName: "transferLaunch", args: [config, owner] }), "transfer");
  same(transfer.slice(0, 10), TRANSFER_SELECTOR, "transfer selector");
  const installation = { token: owner, poolKey, positionId: config, initialTick: -13815500,
    liquidity: tuple.liquidity, installedSupply: tuple.supply };
  const result = encodeFunctionResult({ abi, functionName: "previewInstallation", result: installation });
  same(result, encodeFunctionResult({ abi: periphery, functionName: "previewInstallation", result: installation }), "preview result");
  for (const eventName of ["LaunchOwnerChanged", "LaunchFeesClaimed"] as const) {
    same(encodeEventTopics({ abi, eventName }), encodeEventTopics({ abi: periphery, eventName }), eventName);
  }
}
for (const abi of [extensionAbi, extension]) {
  for (const eventName of ["LaunchCreated", "LaunchSwapped", "CreatorFeesClaimed"] as const) {
    same(encodeEventTopics({ abi, eventName }), encodeEventTopics({ abi: extension, eventName }), eventName);
  }
  same(encodeFunctionData({ abi, functionName: "quoteToken" }), encodeFunctionData({ abi: extension, functionName: "quoteToken" }), "quoteToken");
}
console.log(JSON.stringify({ scope: "offline-ABI-subset-parity", extensionAbiSha256: EXTENSION_ABI_SHA256,
  peripheryAbiSha256: PERIPHERY_ABI_SHA256, controls, executable: false, fullCompiledAbiModified: false }));
