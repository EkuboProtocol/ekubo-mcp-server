import { type Abi, type AbiEvent, type Address, decodeEventLog, encodeAbiParameters, encodeEventTopics, type Hex, maxInt128,
  zeroAddress } from "viem";
import { MODEL_ABIS } from "./abi.js";
import { poolIdOf } from "./owner.js";
import { type InstancePin, launchQuote, ZeroSeedError } from "./policy.js";
import { poolConfig, positionIdOf } from "./preview.js";

export interface RawLog {
  address: string;
  topics: readonly string[];
  data: string;
}

const lower = (value: string) => value.toLowerCase();

/** Strict decoding: exactly the event's topics and canonical data, without trailing bytes. */
function decode<T>(abi: Abi, log: RawLog, eventName: string): T {
  const item = abi.find((entry): entry is AbiEvent => entry.type === "event" && entry.name === eventName)!;
  let args: Record<string, unknown>;
  try {
    const event = decodeEventLog({ abi, eventName, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], strict: true });
    args = event.args as unknown as Record<string, unknown>;
  } catch {
    throw new ZeroSeedError("launch_event_invalid");
  }
  const data = item.inputs.filter((input) => !input.indexed);
  const indexed = item.inputs.filter((input) => input.indexed).length;
  if (log.topics.length !== indexed + 1 ||
    encodeAbiParameters(data, data.map((input) => args[input.name!])) !== lower(log.data)) {
    throw new ZeroSeedError("launch_event_invalid");
  }
  return args as T;
}

interface CreatedArgs {
  poolId: Hex; token: Address; controller: Address; poolKey: { token0: Address; token1: Address; config: Hex };
  positionId: Hex; liquidity: bigint;
  parameters: { name: string; symbol: string; decimals: number; supply: bigint; quoteToken: Address; askTick: number;
    upperTick: number; tickSpacing: number; tradingStart: bigint; initialFee: bigint; finalFee: bigint; salt: Hex } &
    ({ feeDuration: number; decayRateX32?: undefined } | { decayRateX32: bigint; feeDuration?: undefined });
}

/** The 10th LaunchParameters field as its model defines it: v1 seconds as a number, v2 the rate as a decimal string. */
function decayField(p: CreatedArgs["parameters"]) {
  return p.decayRateX32 === undefined ? { feeDuration: p.feeDuration } : { decayRateX32: p.decayRateX32.toString() };
}

/**
 * Decodes one LaunchCreated log of a pinned extension with exactly its pin's fee model: the 43d6628 tuple
 * (`uint32 feeDuration`) for fixed_base_duration_v1 and the 3d6378f tuple (`uint64 decayRateX32`) for tick_rate_v2.
 * The two have different topics; a log with the other model's topic is refused, never re-decoded with the other ABI.
 * It is checked against the contract's own rules: the emitter is the extension, the pool pairs the
 * token with the launch's quote (native ETH always token0), the pool id, fee 0 and spacing, the position bounds, a
 * nonzero liquidity and a requested supply in 1..int128.max. `parameters.salt` is the salt the extension received:
 * the periphery's owner-namespaced keccak256(abi.encode(owner, userSalt)). `quote` is the launch's quote only when it is native
 * or a reviewed ERC-20; every launch of the extension decodes, whatever its quote.
 */
export function decodeLaunchCreated(log: RawLog, pin: InstancePin, localHarness: boolean) {
  const abis = MODEL_ABIS[pin.feeModel];
  if (abis === undefined) throw new ZeroSeedError("unsupported_fee_model");
  if (lower(log.topics[0] ?? "") !== abis.launchCreatedTopic) throw new ZeroSeedError("launch_event_invalid");
  if (lower(log.address) !== pin.extension) throw new ZeroSeedError("launch_event_emitter_mismatch");
  const args = decode<CreatedArgs>(abis.extension, log, "LaunchCreated");
  const p = args.parameters;
  const token = lower(args.token);
  const quoteToken = lower(p.quoteToken);
  const key = { token0: lower(args.poolKey.token0), token1: lower(args.poolKey.token1), config: lower(args.poolKey.config) };
  const tokenIs0 = checkPair(token, quoteToken, key);
  const [tickLower, tickUpper] = checkGeometry(args, key, pin, tokenIs0);
  if (args.liquidity === 0n || p.supply === 0n || p.supply > maxInt128) throw new ZeroSeedError("launch_event_amounts_invalid");
  return {
    fee_model: pin.feeModel, pool_id: lower(args.poolId), token, controller: lower(args.controller), pool_key: key,
    position_id: lower(args.positionId), tick_lower: tickLower, tick_upper: tickUpper,
    launch_token_is_token1: !tokenIs0, liquidity: args.liquidity.toString(), requested_supply: p.supply.toString(),
    quote_token: { address: quoteToken, kind: quoteToken === zeroAddress ? "native" as const : "erc20" as const,
      supported: supported(pin.chainId, quoteToken, localHarness) },
    parameters: {
      name: p.name, symbol: p.symbol, decimals: p.decimals, supply: p.supply.toString(), quoteToken, askTick: p.askTick,
      upperTick: p.upperTick, tickSpacing: p.tickSpacing, tradingStart: p.tradingStart.toString(), ...decayField(p),
      initialFee: p.initialFee.toString(), finalFee: p.finalFee.toString(), salt: lower(p.salt),
    },
  };
}

/** Pool config (this extension, fee 0, the launch's spacing), pool id and the position's bounds and salt. */
function checkGeometry(args: CreatedArgs, key: { token0: string; token1: string; config: string }, pin: InstancePin,
  tokenIs0: boolean): [number, number] {
  const p = args.parameters;
  if (key.config !== poolConfig(pin.extension, p.tickSpacing) || lower(args.poolId) !== poolIdOf(key)) {
    throw new ZeroSeedError("launch_event_pool_mismatch");
  }
  const bounds: [number, number] = tokenIs0 ? [p.askTick, p.upperTick] : [-p.upperTick, -p.askTick];
  if (lower(args.positionId) !== positionIdOf(...bounds)) throw new ZeroSeedError("launch_event_position_mismatch");
  return bounds;
}

/** The pool key is the sorted (token, quote) pair; returns whether the launch token is token0. */
function checkPair(token: string, quoteToken: string, key: { token0: string; token1: string }): boolean {
  const tokenIs0 = BigInt(token) < BigInt(quoteToken);
  const sorted = tokenIs0 ? [token, quoteToken] : [quoteToken, token];
  if (token === quoteToken || key.token0 !== sorted[0] || key.token1 !== sorted[1]) throw new ZeroSeedError("launch_event_pair_mismatch");
  return tokenIs0;
}

function supported(chainId: string, quoteToken: string, localHarness: boolean): boolean {
  try {
    launchQuote(chainId, quoteToken, localHarness);
    return true;
  } catch {
    return false;
  }
}

/**
 * The creator of a launch created through the pin's periphery: the LaunchOwnerChanged(poolId, 0x0, owner) the
 * periphery emits in the creation, after a LaunchCreated whose controller is that periphery.
 */
export function launchCreator(logs: readonly RawLog[], pin: InstancePin, localHarness: boolean) {
  const abis = MODEL_ABIS[pin.feeModel];
  if (abis === undefined) throw new ZeroSeedError("unsupported_fee_model");
  const createdLogs = logs.filter((log) => lower(log.topics[0] ?? "") === abis.launchCreatedTopic);
  if (createdLogs.length !== 1) throw new ZeroSeedError("launch_event_invalid");
  const created = decodeLaunchCreated(createdLogs[0], pin, localHarness);
  if (created.controller !== pin.periphery) throw new ZeroSeedError("launch_event_controller_mismatch");
  const [topic] = encodeEventTopics({ abi: abis.periphery, eventName: "LaunchOwnerChanged" });
  const owners = logs.filter((log) => lower(log.topics[0] ?? "") === topic && lower(log.address) === pin.periphery)
    .map((log) => decode<{ poolId: Hex; previousOwner: Address; newOwner: Address }>(abis.periphery, log, "LaunchOwnerChanged"))
    .filter((event) => lower(event.poolId) === created.pool_id && lower(event.previousOwner) === zeroAddress);
  if (owners.length !== 1 || lower(owners[0].newOwner) === zeroAddress) throw new ZeroSeedError("launch_owner_missing");
  return { ...created, creator: lower(owners[0].newOwner) };
}
