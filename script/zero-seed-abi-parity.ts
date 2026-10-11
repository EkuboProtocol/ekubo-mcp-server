import { createHash } from "node:crypto";
import { type Abi, type Address, encodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import { zeroSeedAbi } from "../src/launchpad/zero-seed/abi.js";
import { abiParameters, type ParametersInput } from "../src/launchpad/zero-seed/installation.js";
import { ABI_SHA256 } from "../src/launchpad/zero-seed/policy.js";

// Offline comparison against the exact accepted full ABI; not a provider read.
const path = process.argv[2];
if (!path) throw new Error("Pass artifacts/eku-1528/ZeroSeedLaunch.abi.json");
const bytes = await Bun.file(path).arrayBuffer();
const digest = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
if (digest !== ABI_SHA256) throw new Error(`Frozen full ABI mismatch: ${digest}`);
const frozen = JSON.parse(new TextDecoder().decode(bytes)) as Abi;
const creator = "0x0000000000000000000000000000000000000123" as Address;
const config = `0x${"00".repeat(32)}` as Hex;
const parameters: ParametersInput = {
  quoteToken: "0xffffffffffffffffffffffffffffffffffffffff", name: "Local λ", symbol: "LOC", decimals: 18,
  supply: "1000000000000000000000000000", liquidity: "1111119116089565312897934", askTick: -13815500,
  upperTick: -9210300, tickSpacing: 100, tradingStart: "1300", feeDuration: 3600,
  initialFee: "922337203685477580", finalFee: "55340232221128654", salt: config,
};
const tuple = abiParameters(parameters);
const poolKey = { token0: creator, token1: tuple.quoteToken, config };
let controls = 0;
function same(a: string, b: string, label: string) {
  if (a !== b) throw new Error(`${label} encoding mismatch`);
  controls++;
}
for (const abi of [zeroSeedAbi, frozen]) {
  const create = encodeFunctionData({ abi, functionName: "create", args: [tuple] });
  same(create, encodeFunctionData({ abi: frozen, functionName: "create", args: [tuple] }), "create");
  same(create.slice(0, 10), "0xe11b98da", "create selector");
  const preview = encodeFunctionData({ abi, functionName: "previewInstallation", args: [creator, tuple] });
  same(preview, encodeFunctionData({ abi: frozen, functionName: "previewInstallation", args: [creator, tuple] }), "preview");
  same(preview.slice(0, 10), "0xcd1632b3", "preview selector");
  const claim = encodeFunctionData({ abi, functionName: "claimFees", args: [poolKey, creator] });
  same(claim, encodeFunctionData({ abi: frozen, functionName: "claimFees", args: [poolKey, creator] }), "claim");
  same(claim.slice(0, 10), "0x6906b4c0", "claim selector");
  const installation = { token: creator, poolKey, positionId: config, initialTick: -13815500,
    liquidity: tuple.liquidity, installedSupply: tuple.supply };
  const result = encodeFunctionResult({ abi, functionName: "previewInstallation", result: installation });
  same(result, encodeFunctionResult({ abi: frozen, functionName: "previewInstallation", result: installation }), "preview result");
}
console.log(JSON.stringify({ scope: "offline-ABI-subset-parity", abiSha256: digest, controls,
  executable: false, fullCompiledAbiModified: false }));
