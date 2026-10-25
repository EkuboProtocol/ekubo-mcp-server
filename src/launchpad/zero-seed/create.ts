import { type Address, bytesToHex, decodeFunctionResult, encodeFunctionData, getAddress, type Hex, keccak256, stringToHex, zeroAddress } from "viem";
import { preparedTransaction, preparedUiAction } from "../../ui-actions.js";
import { abiFunction, peripheryAbi } from "./abi.js";
import { type ChainContext, chainContext, blockSummary, erc20Read } from "./context.js";
import { LAUNCH_DECIMALS, launchRange, MAX_SUPPLY, MAX_TICK, MIN_TICK, packOne, poolIdOf, priceToTick, tickToPrice } from "./codec.js";
import type { LaunchpadEnv } from "./deployment.js";
import { invalidArgument, LaunchpadError } from "./errors.js";
import { DEFAULT_DECAY_RATE_X32, decayRateForHalfLife, describeSchedule, feeCurve, feePercent, percentToQ64 } from "./fee.js";
import { type Block, Reverted } from "./rpc.js";

/** Producer start window: at least 5 minutes and at most one day after the latest block. */
export const MIN_START_MARGIN_SECONDS = 300n;
export const MAX_START_DELAY_SECONDS = 86_400n;
const MAX_LOGO_BYTES = 2048;

export interface CreateInput {
  chain_id: string;
  sender: string;
  name: string;
  symbol: string;
  total_supply: string;
  quote_token?: string;
  start_price?: string;
  upper_price?: string;
  ask_tick?: number;
  upper_tick?: number;
  trading_start: string;
  initial_fee_percent?: string;
  final_fee_percent?: string;
  half_life_seconds?: string;
  salt?: string;
  preview_id?: string;
  logo_url?: string;
}

interface StaticParameters {
  sender: Address;
  name: Hex;
  symbol: Hex;
  supply: bigint;
  quoteToken: Address;
  tradingStart: bigint;
  decayRateX32: bigint;
  initialFee: bigint;
  finalFee: bigint;
  salt: Hex;
}

const SUPPLY = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,18}))?$/;

function parseSupply(value: string): bigint {
  const match = SUPPLY.exec(value);
  if (match === null) throw invalidArgument("total_supply", "must be a plain decimal number of whole tokens with at most 18 decimals, for example \"1000000000\"");
  const supply = BigInt(match[1] + (match[2] ?? "").padEnd(18, "0"));
  if (supply === 0n || supply > MAX_SUPPLY) throw invalidArgument("total_supply", "must be more than 0 and at most 1000000000000 (one trillion tokens)");
  return supply;
}

function parseFee(argument: string, value: string): bigint {
  const fee = percentToQ64(value);
  if (fee === null) throw invalidArgument(argument, "must be a percentage from 0 to below 100 with at most 18 decimals, for example \"50\" or \"0.3\"");
  return fee;
}

function metadata(argument: "name" | "symbol", value: string): Hex {
  const packed = packOne(value);
  if (packed === null) throw invalidArgument(argument, "must be 1 to 31 bytes of UTF-8 (bytes, not characters); it is never truncated");
  return packed;
}

function randomSalt(): Hex {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** Every check that needs no upstream data, in argument order. */
export function staticParameters(input: CreateInput): StaticParameters {
  const name = metadata("name", input.name);
  const symbol = metadata("symbol", input.symbol);
  const supply = parseSupply(input.total_supply);
  const prices = input.start_price !== undefined || input.upper_price !== undefined;
  const ticks = input.ask_tick !== undefined || input.upper_tick !== undefined;
  if (prices === ticks) throw invalidArgument("start_price", "give start_price and upper_price, or ask_tick and upper_tick, not both and not neither");
  checkPair(input, prices);
  return {
    sender: getAddress(input.sender), name, symbol, supply,
    quoteToken: getAddress(input.quote_token ?? zeroAddress),
    tradingStart: BigInt(input.trading_start), ...fees(input),
    salt: (input.salt?.toLowerCase() as Hex | undefined) ?? randomSalt(),
  };
}

function fees(input: CreateInput) {
  const initialFee = parseFee("initial_fee_percent", input.initial_fee_percent ?? "50");
  const finalFee = parseFee("final_fee_percent", input.final_fee_percent ?? "0.3");
  if (finalFee > initialFee) throw invalidArgument("final_fee_percent", "must be at most initial_fee_percent: the fee only decays");
  const decayRateX32 = input.half_life_seconds === undefined ? DEFAULT_DECAY_RATE_X32 : decayRateForHalfLife(input.half_life_seconds);
  if (decayRateX32 === null) throw invalidArgument("half_life_seconds", "must be a positive number of seconds with at most 6 decimals whose decay rate fits uint64, for example \"86400\"");
  return { initialFee, finalFee, decayRateX32 };
}

function checkPair(input: CreateInput, prices: boolean): void {
  if (prices) {
    if (input.start_price === undefined || input.upper_price === undefined) throw invalidArgument(input.start_price === undefined ? "start_price" : "upper_price", "give both start_price and upper_price");
    return;
  }
  if (input.ask_tick === undefined || input.upper_tick === undefined) throw invalidArgument(input.ask_tick === undefined ? "ask_tick" : "upper_tick", "give both ask_tick and upper_tick");
  if (input.ask_tick >= input.upper_tick) throw invalidArgument("upper_tick", "must be greater than ask_tick");
}

async function quoteDecimals(context: ChainContext, quote: Address, block: Block): Promise<number> {
  if (quote === zeroAddress) return 18;
  const code = await context.rpc.code(quote);
  if (code === "0x") throw invalidArgument("quote_token", "has no contract code on this chain; use the zero address for the native token or an ERC-20 address");
  try {
    return Number(await erc20Read(context, quote, "decimals", [], block));
  } catch (error) {
    if (error instanceof Reverted) throw invalidArgument("quote_token", "does not answer decimals(); it is not a usable ERC-20 quote");
    throw error;
  }
}

function economicRange(input: CreateInput, decimals: number): { ask: number; upper: number } {
  if (input.ask_tick !== undefined && input.upper_tick !== undefined) return { ask: input.ask_tick, upper: input.upper_tick };
  const ask = priceToTick(input.start_price!, decimals);
  const upper = priceToTick(input.upper_price!, decimals);
  if (ask === null) throw invalidArgument("start_price", `must be a positive plain decimal price in quote tokens per launch token whose tick is within [${MIN_TICK}, ${MAX_TICK}]`);
  if (upper === null) throw invalidArgument("upper_price", `must be a positive plain decimal price in quote tokens per launch token whose tick is within [${MIN_TICK}, ${MAX_TICK}]`);
  if (ask >= upper) throw invalidArgument("upper_price", "must be above start_price by at least one tick (0.0001%)");
  return { ask, upper };
}

function checkStart(tradingStart: bigint, block: Block): void {
  const earliest = block.timestamp + MIN_START_MARGIN_SECONDS;
  const latest = block.timestamp + MAX_START_DELAY_SECONDS;
  if (tradingStart < earliest || tradingStart > latest) {
    throw invalidArgument("trading_start", `must be Unix seconds from ${earliest} to ${latest}: 5 minutes to 24 hours after the latest block (${block.timestamp})`, { earliest: earliest.toString(), latest: latest.toString() });
  }
}

const tuple = (p: StaticParameters, ask: number, upper: number) => ({
  name: p.name, symbol: p.symbol, supply: p.supply, quoteToken: p.quoteToken, askTick: ask, upperTick: upper,
  tradingStart: p.tradingStart, decayRateX32: p.decayRateX32, initialFee: p.initialFee, finalFee: p.finalFee, salt: p.salt,
});
type Tuple = ReturnType<typeof tuple>;

interface Installation {
  token: Address;
  poolKey: { token0: Address; token1: Address; config: Hex };
  positionId: Hex;
  initialTick: number;
  liquidity: bigint;
  installedSupply: bigint;
  tickSpacing: number;
  askTick: number;
  upperTick: number;
}

const PREVIEW_ERRORS: Record<string, [string, string]> = {
  InvalidMetadata: ["name", "name and symbol must each be 1 to 31 bytes"],
  InvalidSupply: ["total_supply", "must be from 1 base unit to one trillion tokens"],
  InvalidTicks: ["start_price", "the price range is outside the tick domain or empty"],
  InvalidTradingStart: ["trading_start", "must not be in the past"],
  InvalidFeeSchedule: ["final_fee_percent", "must be at most initial_fee_percent"],
  UnsupportedQuoteToken: ["quote_token", "must be the zero address (native) or a contract"],
  ZeroLiquidity: ["total_supply", "is too small to install any liquidity across this price range; raise it or narrow the range"],
  LiquidityAboveTickCap: ["total_supply", "is too large for this price range; lower it or widen the range"],
  LaunchTokenExists: ["salt", "a launch token with this name, symbol and salt already exists; omit salt for a new random one"],
};

async function preview(context: ChainContext, sender: Address, parameters: Tuple, block: Block): Promise<Installation> {
  const fn = abiFunction(peripheryAbi, "previewInstallation");
  let data: Hex;
  try {
    data = await context.rpc.call(context.deployment.periphery,
      encodeFunctionData({ abi: [fn], functionName: fn.name, args: [sender, parameters] }), { block });
  } catch (error) {
    if (!(error instanceof Reverted)) throw error;
    const known = error.errorName === null ? undefined : PREVIEW_ERRORS[error.errorName];
    if (known !== undefined) throw invalidArgument(known[0], `the contract refused the preview with ${error.errorName}: ${known[1]}`, { contract_error: error.errorName });
    throw new LaunchpadError("preview_reverted", `previewInstallation reverted${error.errorName === null ? "" : ` with ${error.errorName}`}. Nothing was prepared; change the parameters.`, { retryable: false, contract_error: error.errorName });
  }
  return decodeFunctionResult({ abi: [fn], functionName: fn.name, data }) as unknown as Installation;
}

function installationView(installation: Installation, supply: bigint) {
  return {
    token: getAddress(installation.token),
    pool_id: poolIdOf(installation.poolKey),
    pool_key: { token0: getAddress(installation.poolKey.token0), token1: getAddress(installation.poolKey.token1), config: installation.poolKey.config },
    position_id: installation.positionId,
    initial_tick: installation.initialTick,
    liquidity: installation.liquidity.toString(),
    installed_supply: installation.installedSupply.toString(),
    uninstalled_remainder: (supply - installation.installedSupply).toString(),
    tick_spacing: installation.tickSpacing,
    installed_ask_tick: installation.askTick,
    installed_upper_tick: installation.upperTick,
  };
}

export async function buildPreview(env: LaunchpadEnv, input: CreateInput) {
  const p = staticParameters(input);
  const context = await chainContext(env, input.chain_id);
  const block = await context.rpc.latestBlock();
  const decimals = await quoteDecimals(context, p.quoteToken, block);
  const { ask, upper } = economicRange(input, decimals);
  checkStart(p.tradingStart, block);
  const parameters = tuple(p, ask, upper);
  const installation = await preview(context, p.sender, parameters, block);
  const range = launchRange(ask, upper);
  if (installation.tickSpacing !== range.tickSpacing || installation.askTick !== range.alignedAskTick || installation.upperTick !== range.alignedUpperTick) {
    throw new LaunchpadError("preview_mismatch", "The contract's installed range differs from the final spacing rule; this deployment is not the final launch contract. Nothing was prepared.", { retryable: false });
  }
  const view = {
    chain_id: input.chain_id,
    owner: p.sender,
    parameters: {
      name: input.name, symbol: input.symbol, name_bytes32: p.name, symbol_bytes32: p.symbol, decimals: LAUNCH_DECIMALS,
      supply: p.supply.toString(), quote_token: p.quoteToken, quote_decimals: decimals, ask_tick: ask, upper_tick: upper,
      trading_start: p.tradingStart.toString(), decay_rate_x32: p.decayRateX32.toString(),
      initial_fee: p.initialFee.toString(), final_fee: p.finalFee.toString(), salt: p.salt,
    },
    range: {
      tick_spacing: range.tickSpacing, installed_ask_tick: range.alignedAskTick, installed_upper_tick: range.alignedUpperTick,
      installed_start_price: tickToPrice(range.alignedAskTick, decimals), installed_upper_price: tickToPrice(range.alignedUpperTick, decimals),
    },
    installation: installationView(installation, p.supply),
    fee_schedule: { ...describeSchedule(p), curve: feeCurve(p) },
  };
  const previewId = keccak256(stringToHex(JSON.stringify({ periphery: context.deployment.periphery, ...view })));
  return { context, parameters, view, previewId, block };
}

export async function previewLaunch(env: LaunchpadEnv, input: CreateInput) {
  const { view, previewId, block } = await buildPreview(env, input);
  return {
    ...view,
    preview_id: previewId,
    block: blockSummary(block),
    next_step: "To create, call launchpad_prepare_create with exactly these arguments plus salt (parameters.salt) and preview_id. Preview is installation math at this block, not a dry run or inclusion guarantee.",
  };
}

function logoUrl(value: string | undefined): string {
  if (value === undefined || value === "") return "";
  const bytes = new TextEncoder().encode(value).length;
  let parsed: URL | null = null;
  try {
    parsed = new URL(value);
  } catch {
    parsed = null;
  }
  if (parsed === null || !["https:", "ipfs:"].includes(parsed.protocol) || bytes > MAX_LOGO_BYTES || /[\s\u0000-\u001f]/.test(value)) {
    throw invalidArgument("logo_url", `must be an https:// or ipfs:// URL of at most ${MAX_LOGO_BYTES} bytes with no whitespace, or omitted`);
  }
  return value;
}

export async function prepareCreate(env: LaunchpadEnv, input: CreateInput) {
  if (input.salt === undefined) throw invalidArgument("salt", "required: pass parameters.salt from launchpad_preview_launch");
  if (input.preview_id === undefined) throw invalidArgument("preview_id", "required: pass preview_id from launchpad_preview_launch");
  const logo = logoUrl(input.logo_url);
  const { context, parameters, view, previewId } = await buildPreview(env, input);
  if (previewId !== input.preview_id.toLowerCase()) {
    throw new LaunchpadError("preview_mismatch", "These arguments or the chain no longer produce the previewed launch. Nothing was prepared; call launchpad_preview_launch again and review the new preview.", { argument: "preview_id", retryable: false });
  }
  const data = encodeFunctionData({ abi: [abiFunction(peripheryAbi, "create")], functionName: "create", args: [parameters, logo] });
  const sender = getAddress(input.sender);
  const install = view.installation;
  return preparedUiAction({
    action: "launchpad_create",
    chainId: input.chain_id,
    sender,
    request: { chain_id: input.chain_id, sender, preview_id: previewId, logo_url: logo === "" ? null : logo },
    transaction: preparedTransaction(input.chain_id, context.deployment.periphery, data, 0n),
    details: {
      summary: `Create ${input.name} (${input.symbol}): ${view.parameters.supply} base units (18 decimals), ${install.installed_supply} installed for sale from ${view.range.installed_start_price} to ${view.range.installed_upper_price} quote per token; trading opens at Unix ${view.parameters.trading_start}; creator fee ${feePercent(parameters.initialFee)} decaying toward ${feePercent(parameters.finalFee)}. ${sender} becomes the owner. No quote deposit; principal is locked forever.`,
      token: install.token, pool_id: install.pool_id, owner: sender, logo_url: logo === "" ? null : logo,
    },
  });
}
