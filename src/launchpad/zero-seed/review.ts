import { type Address, encodeAbiParameters, type Hex, keccak256, stringToHex, zeroAddress } from "viem";
import provenance from "./frozen/provenance.json";
import { type PoolKey, poolIdOf } from "./codec.js";
import type { ChainContext } from "./context.js";
import {
  claimStatements, createStatements, disclosureHeader, DISCLOSURE_VERSION, quoteText, type StatementInput, transferStatements,
} from "./disclosures.js";
import {
  exactOutputMultiplier, excessHalvingSeconds, feeAt, feePercent, feePhase, type FeeSchedule, halfLifeSeconds, saturationSeconds,
} from "./fee.js";
import type { Block } from "./rpc.js";

// Sealed owner-review artifacts for the Cloud Wallet: canonical JSON bodies describing exactly the call in the
// execution plan, never executable themselves. Shapes and key order are the wallet's (create v6, claim v5, owner
// summary v6); transfer v1 follows the claim v5 conventions. Every address and hex value is lowercase, every
// integer that may exceed 2^53 a decimal string.

const SCOPE = "synthetic-local-non-executable";
/** A create or owner action must execute within this many seconds of the block it was built on. */
export const REVIEW_WINDOW_SECONDS = 300n;
const OWNER_SUMMARY_VERSION = "zero-seed-launch-owner-summary/v6";
const lc = (value: string) => value.toLowerCase();

export interface Sealed { body: string; integrity: Hex; bytes: number }

/** keccak256 of the UTF-8 body and its byte length; the body is the canonical JSON.stringify of the value. */
export function seal(value: unknown): Sealed {
  const body = JSON.stringify(value);
  return { body, integrity: keccak256(stringToHex(body)), bytes: new TextEncoder().encode(body).length };
}

/** keccak256 of the canonical summary JSON without this field, appended last. */
function withSummaryHash<T extends object>(summary: T): T & { summary_keccak256: Hex } {
  return { ...summary, summary_keccak256: keccak256(stringToHex(JSON.stringify(summary))) };
}

export type ReviewQuote = { kind: "native"; address: string; runtime: null } | { kind: "erc20"; address: string; runtime: Hex };

/** The launch's quote: native ETH, or an ERC-20 bound to the keccak256 of its deployed runtime. */
export async function reviewQuote(context: ChainContext, address: Address, code?: Hex): Promise<ReviewQuote> {
  if (BigInt(address) === 0n) return { kind: "native", address: zeroAddress, runtime: null };
  return { kind: "erc20", address: lc(address), runtime: keccak256(code ?? await context.rpc.code(address)) };
}

/** The deployment as the wallet pins it: addresses, deployed runtime hashes, deployment block and frozen ABI hashes. */
export function reviewPin(context: ChainContext) {
  const d = context.deployment;
  return {
    chainId: d.chainId, feeModel: "tick_rate_final" as const, core: lc(d.core), extension: lc(d.extension), periphery: lc(d.periphery),
    extensionRuntime: context.runtimes.extension, peripheryRuntime: context.runtimes.periphery, deploymentBlock: d.deploymentBlock,
    extensionAbiSha256: provenance.sha256["ZeroSeedLaunch.abi.json"], peripheryAbiSha256: provenance.sha256["ZeroSeedLaunchPeriphery.abi.json"],
  };
}
type Pin = ReturnType<typeof reviewPin>;

function envelope(context: ChainContext, sender: Address, data: Hex) {
  return {
    scope: SCOPE, executable: false, chain_id: context.deployment.chainId, sender: lc(sender), target: lc(context.deployment.periphery),
    data: lc(data), value: "0", pin: reviewPin(context),
  };
}

function instanceFields(pin: Pin, quote: ReviewQuote) {
  return {
    instance: {
      fee_model: pin.feeModel, core: pin.core, extension: pin.extension, periphery: pin.periphery, controller: pin.periphery,
      extension_runtime: pin.extensionRuntime, periphery_runtime: pin.peripheryRuntime, deployment_block: pin.deploymentBlock,
    },
    quote: quote.kind === "native"
      ? { kind: "native" as const, address: quote.address, decimals: 18, runtime: null, wrapping: false, approval: false }
      : { kind: "erc20" as const, address: quote.address, decimals: null, runtime: quote.runtime, wrapping: false, approval: true },
  };
}

const lowerKey = (key: PoolKey) => ({ token0: lc(key.token0), token1: lc(key.token1), config: lc(key.config) });

function ownerCheck(block: Block, poolId: Hex, owner: Address) {
  return { block_number: block.number.toString(), block_hash: lc(block.hash), pool_id: lc(poolId), launch_owner: lc(owner) };
}

const ownerBuild = (block: Block) => ({
  buildTime: block.timestamp.toString(), executionExpiry: (block.timestamp + REVIEW_WINDOW_SECONDS).toString(),
});

// ---------------------------------------------------------------------------------------------------- create

export interface CreateParameters {
  name: Hex; symbol: Hex; supply: bigint; quoteToken: Address; askTick: number; upperTick: number;
  tradingStart: bigint; decayRateX32: bigint; initialFee: bigint; finalFee: bigint; salt: Hex;
}
export interface PreviewInstallation {
  token: Address; poolKey: PoolKey; positionId: Hex; initialTick: number; liquidity: bigint; installedSupply: bigint;
  tickSpacing: number; askTick: number; upperTick: number;
}
/** The one previewInstallation eth_call the create was built on: request, block and raw result. */
export interface PreviewRead { block: Block; to: Address; data: Hex; result: Hex }

/** The preview read as a sealed record; the create artifact's preview.read_integrity/read_bytes are its seal. */
export function previewReadRecord(context: ChainContext, read: PreviewRead): Sealed {
  return seal({
    schema_version: "zero-seed-preview-read/v1", chain_id: context.deployment.chainId, block_number: read.block.number.toString(),
    block_hash: lc(read.block.hash), to: lc(read.to), data: lc(read.data), result: lc(read.result),
  });
}

const requestedOf = (p: CreateParameters) => ({
  name: lc(p.name), symbol: lc(p.symbol), supply: p.supply.toString(), quoteToken: lc(p.quoteToken), askTick: p.askTick,
  upperTick: p.upperTick, tradingStart: p.tradingStart.toString(), decayRateX32: p.decayRateX32.toString(),
  initialFee: p.initialFee.toString(), finalFee: p.finalFee.toString(), salt: lc(p.salt),
});

const installationOf = (i: PreviewInstallation) => ({
  token: lc(i.token), poolKey: lowerKey(i.poolKey), positionId: lc(i.positionId), initialTick: i.initialTick,
  liquidity: i.liquidity.toString(), installedSupply: i.installedSupply.toString(), tickSpacing: i.tickSpacing,
  askTick: i.askTick, upperTick: i.upperTick,
});

export function createBody(input: {
  context: ChainContext; sender: Address; data: Hex; quote: ReviewQuote; block: Block; parameters: CreateParameters;
  logoUrl: string; installation: PreviewInstallation; previewRead: Sealed;
}) {
  const { block } = input;
  return {
    schema_version: "zero-seed-local-create/v6" as const,
    ...envelope(input.context, input.sender, input.data),
    quote: input.quote,
    disclosure_version: DISCLOSURE_VERSION,
    build: {
      buildTime: block.timestamp.toString(), executionExpiry: (block.timestamp + REVIEW_WINDOW_SECONDS).toString(),
      blockNumber: block.number.toString(), blockHash: lc(block.hash), blockTime: block.timestamp.toString(),
    },
    requested: requestedOf(input.parameters),
    logo_url: input.logoUrl,
    installation: installationOf(input.installation),
    preview: { count: 1 as const, read_integrity: input.previewRead.integrity, read_bytes: input.previewRead.bytes },
  };
}
type CreateBody = ReturnType<typeof createBody>;

/** A packed name or symbol word as the wallet shows it: content bytes, length, lossy UTF-8 text and validity. */
function metadataFields(word: string) {
  const length = parseInt(word.slice(2, 4), 16);
  const content = word.slice(4, 4 + 2 * length);
  const bytes = Uint8Array.from(content.match(/../g) ?? [], (b) => parseInt(b, 16));
  let utf8 = true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    utf8 = false;
  }
  return { word, bytes: `0x${content}`, length, text: new TextDecoder("utf-8").decode(bytes), utf8 };
}

const namespace = (account: string, salt: string) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [account as Address, salt as Hex]));

const DAY = 86400n;
const SAMPLE_SECONDS = [0n, 1n, 60n, 3600n, DAY, 7n * DAY, 30n * DAY];

/** The exact integer schedule with samples, including the seconds at and after saturation. */
export function feeScheduleFields(s: FeeSchedule, evaluatedAt: bigint) {
  const saturation = saturationSeconds(s.decayRateX32);
  const extra = saturation === null ? [] : [saturation, saturation + 1n];
  const elapsed = [...new Set([...SAMPLE_SECONDS, ...extra].map(String))].map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const point = (time: bigint) => {
    const fee = feeAt(s, time);
    return { fee_q64: fee.toString(), fee_percent: feePercent(fee) };
  };
  const halving = excessHalvingSeconds(s);
  return {
    model: "tick_rate_final" as const,
    trading_start: Number(s.tradingStart),
    initial_fee: s.initialFee.toString(),
    final_fee: s.finalFee.toString(),
    decay_rate_x32: s.decayRateX32.toString(),
    half_life_seconds: halfLifeSeconds(s.decayRateX32),
    saturation_elapsed_seconds: saturation === null ? null : saturation.toString(),
    excess_halving_seconds: halving === null ? null : halving.toString(),
    exact_output_multiplier_at_initial: exactOutputMultiplier(s.initialFee),
    current: { evaluated_at: Number(evaluatedAt), phase: feePhase(s, evaluatedAt), ...point(evaluatedAt) },
    samples: elapsed.map((t) => ({ elapsed: t.toString(), ...point(s.tradingStart + t) })),
  };
}

/** The disclosure inputs of a launch: supply split, fee schedule, owner and quote. */
export function statementInput(s: FeeSchedule, supply: { requested: string; installed: string; sink: string },
  owner: string, quote: { kind: "native" | "erc20"; address: string }): StatementInput {
  const halving = excessHalvingSeconds(s);
  const saturation = saturationSeconds(s.decayRateX32);
  return {
    requestedSupply: supply.requested, installedSupply: supply.installed, sinkSupply: supply.sink,
    initialFeePercent: feePercent(s.initialFee), finalFeePercent: feePercent(s.finalFee),
    halfLifeSeconds: halfLifeSeconds(s.decayRateX32) ?? "none",
    saturationElapsedSeconds: saturation === null ? "none" : saturation.toString(),
    tradingStart: new Date(Number(s.tradingStart) * 1000).toISOString(),
    excessHalvingSeconds: halving === null ? "none" : halving.toString(),
    exactOutputMultiplier: exactOutputMultiplier(s.initialFee), owner: lc(owner), quote: quoteText(quote), quoteKind: quote.kind,
  };
}

const ROUNDING = (sink: string) => ({
  supply_remainder: { asset: "launch_token", amount: sink, holder: zeroAddress, spendable: false, counted_in_total_supply: true, known_at_creation: true },
  upper_residue: { asset: "launch_token", known_at_creation: false, claimable_principal: false, creator_fee: false },
  core_unbooked_dust: { per_asset: ["launch_token", "quote_token"], known_at_creation: false, claimable_principal: false, creator_fee: false },
});

function createFields(body: CreateBody) {
  const r = body.requested;
  const i = body.installation;
  const supply = { requested: r.supply, installed: i.installedSupply, sink: (BigInt(r.supply) - BigInt(i.installedSupply)).toString(), sink_holder: zeroAddress };
  const schedule: FeeSchedule = { tradingStart: BigInt(r.tradingStart), decayRateX32: BigInt(r.decayRateX32), initialFee: BigInt(r.initialFee), finalFee: BigInt(r.finalFee) };
  const ownerSalt = namespace(body.sender, r.salt);
  return {
    supply, schedule,
    fields: {
      owner: body.sender,
      ...instanceFields(body.pin, body.quote),
      name: metadataFields(r.name),
      symbol: metadataFields(r.symbol),
      decimals: 18,
      logo_url: { value: body.logo_url, trusted: false, stored: false, in_identity: false },
      supply,
      liquidity: i.liquidity,
      requested_range: { ask_tick: r.askTick, upper_tick: r.upperTick },
      installed_range: { tick_spacing: i.tickSpacing, ask_tick: i.askTick, upper_tick: i.upperTick },
      trading_start: Number(r.tradingStart),
      initial_fee: r.initialFee,
      final_fee: r.finalFee,
      decay_rate_x32: r.decayRateX32,
      initial_fee_percent: feePercent(schedule.initialFee),
      final_fee_percent: feePercent(schedule.finalFee),
      salt: { owner_salt: r.salt, owner_namespaced: ownerSalt, token_create2: namespace(body.pin.periphery, ownerSalt) },
      fee_schedule: feeScheduleFields(schedule, BigInt(body.build.buildTime)),
      ownership: {
        initial_owner: body.sender, recorded_by: body.pin.periphery, transferable: true, claims_by: "current_owner" as const,
        initial_owner_event: "LaunchOwnerChanged(poolId, 0x0, owner)" as const,
      },
      binding: {
        requested_supply: supply.requested, installed_supply: supply.installed, sink_supply: supply.sink, installed_liquidity: i.liquidity,
        calldata_supply: r.supply, token: i.token, launch_token_is_token1: i.poolKey.token1 === i.token, pool_key: i.poolKey,
        pool_id: poolIdOf(i.poolKey as PoolKey), position_id: i.positionId, initial_tick: i.initialTick,
        execution_expiry: Number(body.build.executionExpiry), preview_count: 1, execution_guaranteed: false,
        calldata_keccak256: keccak256(body.data as Hex), preview_read_integrity: body.preview.read_integrity,
      },
      rounding: ROUNDING(supply.sink),
    },
  };
}

/** The owner summary the wallet's verifyLaunchCreate returns for this body. */
export function createOwnerSummary(body: CreateBody) {
  const { fields, supply, schedule } = createFields(body);
  return withSummaryHash({
    schema_version: OWNER_SUMMARY_VERSION, chain_id: body.chain_id, target: body.target, selector: "0x9a09bd5d", method: "create" as const,
    disclosure: disclosureHeader(), fields,
    statements: createStatements(statementInput(schedule, supply, body.sender, body.quote)).map((s) => s.text),
  });
}

// ---------------------------------------------------------------------------------------------------- claim / transfer

export function claimBody(input: {
  context: ChainContext; sender: Address; data: Hex; quote: ReviewQuote; poolKey: PoolKey; recipient: Address; block: Block; owner: Address;
}) {
  return {
    schema_version: "zero-seed-local-claim/v5" as const,
    ...envelope(input.context, input.sender, input.data),
    quote: input.quote,
    pool_key: lowerKey(input.poolKey),
    recipient: lc(input.recipient),
    owner_check: ownerCheck(input.block, poolIdOf(input.poolKey), input.owner),
    build: ownerBuild(input.block),
  };
}

export function claimOwnerSummary(body: ReturnType<typeof claimBody>) {
  return withSummaryHash({
    schema_version: OWNER_SUMMARY_VERSION, chain_id: body.chain_id, target: body.target, selector: "0x6906b4c0", method: "claimFees" as const,
    disclosure: disclosureHeader(),
    fields: {
      owner: body.sender, ...instanceFields(body.pin, body.quote), pool_key: body.pool_key, pool_id: body.owner_check.pool_id,
      recipient: body.recipient, owner_check: body.owner_check,
      settlement: {
        atomic: true, assets: ["token0", "token1"], partial_claim: false, on_revert: "nothing moves; prepare a fresh claim",
        execution_guaranteed: false,
        accounting: "one payout: the extension's CreatorFeesClaimed and the periphery's LaunchFeesClaimed report the same amounts",
      },
    },
    statements: claimStatements(body.recipient),
  });
}

export function transferBody(input: {
  context: ChainContext; sender: Address; data: Hex; quote: ReviewQuote; poolKey: PoolKey; newOwner: Address; block: Block; owner: Address;
}) {
  const poolId = poolIdOf(input.poolKey);
  return {
    schema_version: "zero-seed-local-transfer/v1" as const,
    ...envelope(input.context, input.sender, input.data),
    quote: input.quote,
    pool_key: lowerKey(input.poolKey),
    pool_id: lc(poolId),
    new_owner: lc(input.newOwner),
    owner_check: ownerCheck(input.block, poolId, input.owner),
    build: ownerBuild(input.block),
  };
}

export function transferOwnerSummary(body: ReturnType<typeof transferBody>) {
  return withSummaryHash({
    schema_version: OWNER_SUMMARY_VERSION, chain_id: body.chain_id, target: body.target, selector: "0x8b1cb36f", method: "transferLaunch" as const,
    disclosure: disclosureHeader(),
    fields: {
      owner: body.sender, ...instanceFields(body.pin, body.quote), pool_key: body.pool_key, pool_id: body.pool_id,
      new_owner: body.new_owner, owner_check: body.owner_check,
      effect: {
        moves_tokens: false, moves_principal: false, unclaimed_fees_follow_owner: true, reversible_by_previous_owner: false,
        execution_guaranteed: false,
      },
    },
    statements: transferStatements(body.new_owner),
  });
}

const NOTE = "Sealed, non-executable owner-review artifact for the wallet: canonical JSON body, integrity = keccak256(UTF-8 body), bytes = its length. It describes exactly the call in execution_plan_reference and is not a plan; pass it unchanged, never edit or rebuild it.";

/** The owner_review block of a prepare result. */
export function ownerReview(artifact: Sealed, summary: object, extra: Record<string, Sealed> = {}) {
  return { artifact, ...extra, owner_summary: summary, note: NOTE };
}
