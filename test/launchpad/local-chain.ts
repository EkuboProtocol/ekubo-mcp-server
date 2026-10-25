// Local, fork-free lifecycle of the final zero-seed launch on anvil, driven only through the MCP boundary
// (worker.fetch tools/call) and the plans it stores. Deploys the frozen evm-contracts 853b608 init code (extension by
// CREATE2 with a 0x51 call-point prefix, periphery bound to it), Core's frozen runtime at the canonical address, the
// production Yul router runtime at its canonical address, and the contracts' plain TestToken as an ERC-20 quote.
// The indexed launch API is replaced by a mock built from the chain's own LaunchCreated logs. Local anvil dev keys
// only; nothing here touches a live chain.
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { YUL_ROUTER_ADDRESS } from "@ekubo/yul-router-sdk";
import {
  type Address, concatHex, createPublicClient, createTestClient, createWalletClient, decodeEventLog, defineChain,
  encodeAbiParameters, erc20Abi, getAddress, getContractAddress, type Hex, http, keccak256, numberToHex, type PublicClient,
  stringToHex, type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import worker from "../../src/index.js";
import { extensionAbi, launchTokenAbi, peripheryAbi } from "../../src/launchpad/zero-seed/abi.js";
import { unpackOne } from "../../src/launchpad/zero-seed/codec.js";
import { fakeArtifactStore } from "../fake-r2.js";

const dir = new URL("../fixtures/launchpad/local-chain/", import.meta.url);
const hex = (name: string) => readFileSync(new URL(name, dir), "utf8").trim() as Hex;

export const CORE = getAddress("0x00000000000014aa86c5d3c41765bb24e11bd701");
const CREATE2_DEPLOYER = getAddress("0x4e59b44847b379578588920cA78FbF26c0B4956C");
export const API = "https://launch-api.test";
export const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3faf9a8f7f6a5b0e",
] as const;
export const ACCOUNTS = KEYS.map((key) => privateKeyToAccount(key));

export interface LocalChain {
  rpcUrl: string;
  pub: PublicClient;
  test: ReturnType<typeof createTestClient>;
  extension: Address;
  periphery: Address;
  quote: Address;
  env: Record<string, unknown>;
  stop: () => void;
}

async function waitFor(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("anvil did not start");
}

export async function startChain(port: number): Promise<LocalChain> {
  const child: ChildProcess = spawn("anvil", ["--port", String(port), "--chain-id", "31337", "--hardfork", "osaka",
    "--timestamp", "1800000000", "--silent"], { stdio: "ignore" });
  const rpcUrl = `http://127.0.0.1:${port}`;
  await waitFor(rpcUrl);
  const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const transport = http(rpcUrl);
  const pub = createPublicClient({ chain, transport }) as PublicClient;
  const test = createTestClient({ chain, transport, mode: "anvil" });
  const wallet = createWalletClient({ chain, transport, account: ACCOUNTS[0] });
  await test.setCode({ address: CORE, bytecode: hex("Core.runtime.expected.hex") });
  await test.setCode({ address: YUL_ROUTER_ADDRESS, bytecode: hex("YulRouter.runtime.hex") });
  const init = hex("ZeroSeedLaunch.initcode.hex");
  const initHash = keccak256(init);
  let salt: Hex = "0x";
  let extension: Address = CORE;
  for (let i = 0n; ; i++) {
    salt = numberToHex(i, { size: 32 });
    extension = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt, bytecodeHash: initHash });
    if (extension.toLowerCase().startsWith("0x51")) break;
  }
  await mined(pub, await wallet.sendTransaction({ to: CREATE2_DEPLOYER, data: concatHex([salt, init]) }));
  const peripheryInit = hex("ZeroSeedLaunchPeriphery.initcode.hex");
  const creation = peripheryInit.slice(0, peripheryInit.length - 128) as Hex;
  const peripheryReceipt = await mined(pub, await wallet.deployContract({
    abi: [], bytecode: concatHex([creation, encodeAbiParameters([{ type: "address" }, { type: "address" }], [CORE, extension])]),
  } as never));
  const quoteReceipt = await mined(pub, await wallet.deployContract({
    abi: [], bytecode: concatHex([hex("TestToken.creation.hex"), encodeAbiParameters([{ type: "address" }], [ACCOUNTS[0].address])]),
  } as never));
  const periphery = getAddress(peripheryReceipt.contractAddress!);
  const quote = getAddress(quoteReceipt.contractAddress!);
  const env = {
    ARTIFACT_STORE: fakeArtifactStore(),
    EKUBO_API_URL: "https://api.test", EKUBO_QUOTER_URL: "https://quoter.test",
    ZERO_X_API_KEY: "unused", ACROSS_API_KEY: "unused", ACROSS_INTEGRATOR_ID: "unused", LAYER_ZERO_API_KEY: "unused",
    LI_FI_API_KEY: "unused", DUNE_API_KEY: "unused",
    LAUNCHPAD_API_URL: API,
    LAUNCHPAD_DEPLOYMENTS: JSON.stringify([{ chain_id: "31337", rpc_url: rpcUrl, core: CORE, extension, periphery, router: YUL_ROUTER_ADDRESS }]),
  };
  return { rpcUrl, pub, test, extension: getAddress(extension), periphery, quote, env, stop: () => child.kill() };
}

export async function mined(pub: PublicClient, hash: Hex): Promise<TransactionReceipt> {
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return receipt;
}

const ABIS = [extensionAbi, peripheryAbi, launchTokenAbi];

/** Every log of the receipt decoded with the frozen ABIs (unknown logs skipped). */
export function decodeLogs(receipt: TransactionReceipt) {
  return receipt.logs.flatMap((log) => {
    for (const abi of ABIS) {
      try {
        const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        return [{ address: getAddress(log.address), logIndex: log.logIndex, eventName: decoded.eventName, args: decoded.args as Record<string, unknown> }];
      } catch {
        // another ABI
      }
    }
    return [];
  });
}

const json = (value: unknown) => new Response(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), { headers: { "content-type": "application/json" } });

/** A minimal indexed launch API over the chain's own creation and owner events. */
export function mockApi(chain: LocalChain) {
  return async (url: URL): Promise<Response> => {
    const logs = await chain.pub.getLogs({ address: chain.extension, fromBlock: 0n });
    const block = await chain.pub.getBlock();
    const launches = await Promise.all(logs.flatMap((log) => {
      try {
        const event = decodeEventLog({ abi: extensionAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        return event.eventName === "LaunchCreated" ? [row(chain, event.args as never, block.timestamp)] : [];
      } catch {
        return [];
      }
    }));
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 1) return json({ data: launches, next_cursor: null, totals: { launches: launches.length } });
    const launch = launches.find((entry) => entry.pool_id === parts[2]);
    if (launch === undefined) return new Response("{}", { status: 404 });
    if (parts.length === 3) return json(launch);
    return json({ data: [], next_cursor: null });
  };
}

async function row(chain: LocalChain, args: { poolId: Hex; token: Address; controller: Address; poolKey: { config: Hex }; parameters: Record<string, never>; logoUrl: string }, now: bigint) {
  const p = args.parameters as unknown as { name: Hex; symbol: Hex; supply: bigint; quoteToken: Address; askTick: number; upperTick: number; tradingStart: bigint; decayRateX32: bigint; initialFee: bigint; finalFee: bigint };
  const owner = await chain.pub.readContract({ address: chain.periphery, abi: peripheryAbi, functionName: "launchOwner", args: [args.poolId] }) as Address;
  const quoteDecimals = BigInt(p.quoteToken) === 0n ? 18 : await chain.pub.readContract({ address: p.quoteToken, abi: erc20Abi, functionName: "decimals" });
  return {
    chain_id: "31337", pool_id: args.poolId.toLowerCase(),
    token: { address: args.token, name: unpackOne(p.name), symbol: unpackOne(p.symbol), decimals: 18 },
    quote_token: { address: p.quoteToken, name: null, symbol: null, decimals: quoteDecimals },
    controller: args.controller, owner, creator: owner, logo_url: args.logoUrl === "" ? null : args.logoUrl,
    parameters: { supply: p.supply.toString(), initial_fee: p.initialFee.toString(), final_fee: p.finalFee.toString(), decay_rate_x32: p.decayRateX32.toString(), ask_tick: p.askTick, upper_tick: p.upperTick },
    tick_spacing: Number(BigInt(args.poolKey.config) & 0x7fffffffn), ask_tick: p.askTick, upper_tick: p.upperTick,
    trading_start: p.tradingStart.toString(), status: now >= p.tradingStart ? "trading" : "upcoming",
    market: { trades: 0 },
  };
}

/** One tools/call through the worker's MCP endpoint. */
export async function callTool(env: Record<string, unknown>, name: string, args: Record<string, unknown>) {
  const response = await worker.fetch(new Request("https://mcp.ekubo.org/mcp/launchpad", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), env as never, {} as ExecutionContext);
  const text = await response.text();
  const data = text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data:"))!.slice(5);
  return JSON.parse(data).result as { isError?: boolean; structuredContent: Record<string, any> };
}

interface PlanStep { kind: string; transaction: { from: Address; to: Address; data: Hex; value: string } }

/** Fetches the stored plan by its reference, checks integrity, and returns its ordered steps. */
export async function loadPlan(env: Record<string, unknown>, reference: { url: string; integrity: { value: Hex } }) {
  const response = await worker.fetch(new Request(reference.url), env as never, {} as ExecutionContext);
  const body = await response.text();
  if (keccak256(stringToHex(body)) !== reference.integrity.value) throw new Error("plan integrity mismatch");
  return JSON.parse(body) as { sender: Address; ordered_steps: PlanStep[] };
}

/** Sends every step of a plan from its sender (anvil dev key) and returns the receipts. */
export async function execute(chain: LocalChain, plan: { sender: Address; ordered_steps: PlanStep[] }) {
  const account = ACCOUNTS.find((entry) => entry.address === getAddress(plan.sender));
  if (account === undefined) throw new Error("plan sender is not a local dev account");
  const wallet = createWalletClient({ chain: chain.pub.chain, transport: http(chain.rpcUrl), account });
  const receipts: TransactionReceipt[] = [];
  for (const step of plan.ordered_steps) {
    const { to, data, value } = step.transaction;
    receipts.push(await mined(chain.pub, await wallet.sendTransaction({ to, data, value: BigInt(value), chain: chain.pub.chain })));
  }
  return receipts;
}
