import { type Address, decodeFunctionData, encodeAbiParameters, encodeFunctionData, type Hex, keccak256, stringToHex } from "viem";
import { z } from "zod";
import { CLAIM_SELECTOR, CREATE_SELECTOR, peripheryAbi } from "./abi.js";
import { claimStatements, createStatements, DISCLOSURE_STATUS, DISCLOSURE_VERSION, quoteText } from "./disclosures.js";
import { decayQ128, exactOutputMultiplier, excessHalvingTime, FEE_HALF_LIFE_SECONDS, feeAt, feePercent, feePhase,
  type FeeSchedule } from "./fee.js";
import { address, BuildContext, bytes32, createData, decimal, Parameters, type ParametersInput,
  requireLocalPin, validateBuild, validateParameters } from "./installation.js";
import { Installation, type InstallationInput, validateInstallation } from "./preview.js";
import { type InstancePin, NATIVE_DECIMALS, samePin, validateClaimRecipient, ZeroSeedError } from "./policy.js";
import { launchSalts } from "./token.js";

// Local, explicitly non-executable bodies. They are sealed with the artifact
// envelope's digest and length rules but never stored as an execution_plan.
const SCOPE = "synthetic-local-non-executable";
const Pin = z.strictObject({
  chainId: decimal, core: address, extension: address, periphery: address, quote: address,
  quoteKind: z.enum(["native", "erc20"]), quoteRuntime: bytes32.nullable(), extensionRuntime: bytes32,
  peripheryRuntime: bytes32, extensionAbiSha256: z.string(), peripheryAbiSha256: z.string(),
});
const PoolKey = z.strictObject({ token0: address, token1: address, config: bytes32 });
const hex = z.string().regex(/^0x([0-9a-f]{2})*$/);
/** Create and claim are periphery calls that never carry value: the periphery cannot receive ETH. */
const Envelope = {
  scope: z.literal(SCOPE), executable: z.literal(false),
  chain_id: decimal, sender: address, target: address, data: hex, value: z.literal("0"), pin: Pin,
};
// v3: the target is the periphery, the tuple has no quote token or decay factor, and the pin binds both contracts.
export const LocalCreateBody = z.strictObject({
  schema_version: z.literal("zero-seed-local-create/v3"), ...Envelope, disclosure_version: z.literal(DISCLOSURE_VERSION),
  build: BuildContext, requested: Parameters, installation: Installation,
  preview: z.strictObject({ count: z.literal(1), read_integrity: bytes32, read_bytes: z.number().int().positive() }),
});
/** The launchOwner(poolId) read the claim was built on; the periphery checks the same owner at execution. */
const OwnerCheck = z.strictObject({ block_number: decimal, block_hash: bytes32, pool_id: bytes32, launch_owner: address });
export const LocalClaimBody = z.strictObject({
  schema_version: z.literal("zero-seed-local-claim/v2"), ...Envelope,
  pool_key: PoolKey, recipient: address, owner_check: OwnerCheck,
  build: z.strictObject({ buildTime: decimal, executionExpiry: decimal }),
});
type CreateBody = z.infer<typeof LocalCreateBody>;
type ClaimBody = z.infer<typeof LocalClaimBody>;

export interface Sealed { body: string; integrity: Hex; bytes: number }

export function seal(body: CreateBody | ClaimBody): Sealed {
  const text = JSON.stringify(body);
  return { body: text, integrity: keccak256(stringToHex(text)), bytes: new TextEncoder().encode(text).length };
}

function unseal<T>(sealed: Sealed, schema: z.ZodType<T>): T {
  if (new TextEncoder().encode(sealed.body).length !== sealed.bytes) throw new ZeroSeedError("artifact_length_mismatch");
  if (keccak256(stringToHex(sealed.body)) !== sealed.integrity) throw new ZeroSeedError("artifact_tampered");
  let parsed: T;
  try {
    parsed = schema.parse(JSON.parse(sealed.body));
  } catch {
    throw new ZeroSeedError("artifact_schema_mismatch");
  }
  if (JSON.stringify(parsed) !== sealed.body) throw new ZeroSeedError("artifact_noncanonical");
  return parsed;
}

function sameParameters(a: ParametersInput, b: ParametersInput): boolean {
  return (Object.keys(Parameters.shape) as (keyof ParametersInput)[]).every((key) => a[key] === b[key]);
}

function checkEnvelope(body: CreateBody | ClaimBody, expected: { pin: InstancePin; owner: Address }): void {
  requireLocalPin(body.pin);
  if (!samePin(body.pin, expected.pin)) throw new ZeroSeedError("pin_mismatch");
  if (body.chain_id !== expected.pin.chainId || body.target !== expected.pin.periphery) throw new ZeroSeedError("target_mismatch");
  if (body.sender !== expected.owner.toLowerCase()) throw new ZeroSeedError("owner_mismatch");
}

export { feePercent };

function decodeCall(data: Hex) {
  try {
    return decodeFunctionData({ abi: peripheryAbi, data });
  } catch {
    // Includes earlier create selectors: an old tuple never decodes as the current encoding.
    throw new ZeroSeedError("unsupported_selector");
  }
}

function decodedParameters(data: Hex): ParametersInput {
  const call = decodeCall(data);
  if (call.functionName !== "create") throw new ZeroSeedError("calldata_method_mismatch");
  if (encodeFunctionData({ abi: peripheryAbi, functionName: "create", args: call.args }) !== data) {
    throw new ZeroSeedError("calldata_noncanonical");
  }
  const p = call.args[0];
  return {
    name: p.name, symbol: p.symbol, decimals: p.decimals,
    supply: p.supply.toString(), liquidity: p.liquidity.toString(), askTick: p.askTick, upperTick: p.upperTick,
    tickSpacing: p.tickSpacing, tradingStart: p.tradingStart.toString(), feeDuration: p.feeDuration,
    initialFee: p.initialFee.toString(), finalFee: p.finalFee.toString(), salt: p.salt.toLowerCase(),
  };
}

/** Requested intent and the one preview's installed pair stay separate; only supply/L may differ. */
function bindActual(body: CreateBody, requested: ParametersInput): ParametersInput {
  if (!sameParameters(body.requested, requested)) throw new ZeroSeedError("requested_mismatch");
  validateParameters(body.requested, body.pin);
  if (body.requested.liquidity !== "0") throw new ZeroSeedError("preview_liquidity_must_be_zero");
  validateInstallation(body.installation, body.requested, body.pin, body.sender as Address);
  const actual = { ...body.requested, supply: body.installation.installedSupply, liquidity: body.installation.liquidity };
  if (!sameParameters(decodedParameters(body.data as Hex), actual)) throw new ZeroSeedError("calldata_summary_mismatch");
  return actual;
}

/** Local producer: the periphery create body for exactly the one bound preview. Never executable. */
export function localCreateBody(preview: {
  owner: Address; pin: InstancePin; build: z.infer<typeof BuildContext>; requested: ParametersInput;
  actual: ParametersInput; installation: InstallationInput; preview: { reference: { integrity: { value: Hex }; bytes: number } };
}): Sealed {
  return seal(LocalCreateBody.parse({
    schema_version: "zero-seed-local-create/v3", scope: SCOPE, executable: false,
    chain_id: preview.pin.chainId, sender: preview.owner.toLowerCase(), target: preview.pin.periphery,
    data: createData(preview.actual), value: "0", pin: { ...preview.pin }, disclosure_version: DISCLOSURE_VERSION,
    build: preview.build,
    requested: preview.requested, installation: preview.installation,
    preview: { count: 1, read_integrity: preview.preview.reference.integrity.value, read_bytes: preview.preview.reference.bytes },
  }));
}

function scheduleOf(actual: ParametersInput): FeeSchedule {
  return {
    tradingStart: BigInt(actual.tradingStart), feeDuration: BigInt(actual.feeDuration),
    initialFee: BigInt(actual.initialFee), finalFee: BigInt(actual.finalFee),
  };
}

const SAMPLE_SECONDS = [0n, 1n, 10n, 60n, 600n, 3600n];

/** The exact integer schedule; nothing here assumes a linear shape. */
function feeScheduleFields(actual: ParametersInput, buildTime: bigint) {
  const schedule = scheduleOf(actual);
  const duration = schedule.feeDuration;
  const elapsed = [...new Set([...SAMPLE_SECONDS, duration / 2n, duration - 1n, duration]
    .filter((t) => t >= 0n && t <= duration).map(String))].map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const point = (time: bigint) => {
    const fee = feeAt(schedule, time);
    return { fee_q64: fee.toString(), fee_percent: feePercent(fee) };
  };
  const halving = excessHalvingTime(schedule);
  const afterOne = feeAt(schedule, schedule.tradingStart + 1n);
  return {
    curve: "fixed_half_life_endpoint_normalized" as const,
    half_life_seconds: FEE_HALF_LIFE_SECONDS,
    endpoint_decay_q128: decayQ128(duration).toString(),
    excess_halving_seconds: halving === null ? null : Number(halving),
    effective_cliff: duration > 1n && schedule.initialFee !== schedule.finalFee && afterOne === schedule.finalFee,
    exact_output_multiplier_at_initial: exactOutputMultiplier(schedule.initialFee),
    current: { evaluated_at: Number(buildTime), phase: feePhase(schedule, buildTime), ...point(buildTime) },
    samples: elapsed.map((t) => ({ elapsed: Number(t), ...point(schedule.tradingStart + t) })),
  };
}

/** Pool id = keccak256(abi.encode(PoolKey)). */
export function poolIdOf(key: { token0: string; token1: string; config: string }): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "bytes32" }],
    [key.token0 as Address, key.token1 as Address, key.config as Hex]));
}

/** Instance identity and the deployment's quote provenance, shown with every summary. */
function instanceFields(pin: InstancePin) {
  return {
    instance: { core: pin.core, extension: pin.extension, periphery: pin.periphery, controller: pin.periphery,
      extension_runtime: pin.extensionRuntime, periphery_runtime: pin.peripheryRuntime },
    quote: pin.quoteKind === "native"
      ? { kind: "native" as const, address: pin.quote, decimals: NATIVE_DECIMALS, runtime: null, wrapping: false, approval: false }
      : { kind: "erc20" as const, address: pin.quote, decimals: null, runtime: pin.quoteRuntime, wrapping: false, approval: true },
  };
}

function createFields(body: CreateBody, actual: ParametersInput) {
  const tokenIs1 = body.installation.poolKey.token1 === body.installation.token;
  const salts = launchSalts(body.sender as Address, body.pin.periphery as Address, actual.salt as Hex);
  return {
    owner: body.sender, ...instanceFields(body.pin), name: actual.name, symbol: actual.symbol,
    decimals: actual.decimals, supply: actual.supply, liquidity: actual.liquidity, ask_tick: actual.askTick,
    upper_tick: actual.upperTick, tick_spacing: actual.tickSpacing, trading_start: Number(actual.tradingStart),
    fee_duration: actual.feeDuration, initial_fee: actual.initialFee, final_fee: actual.finalFee,
    initial_fee_percent: feePercent(BigInt(actual.initialFee)), final_fee_percent: feePercent(BigInt(actual.finalFee)),
    salt: { owner_salt: actual.salt, owner_namespaced: salts.ownerSalt, token_create2: salts.tokenSalt },
    fee_schedule: feeScheduleFields(actual, BigInt(body.build.buildTime)),
    ownership: {
      initial_owner: body.sender, recorded_by: body.pin.periphery, transferable: true, claims_by: "current_owner" as const,
      initial_owner_event: "LaunchOwnerChanged(poolId, 0x0, owner)" as const,
    },
    binding: {
      requested_supply: body.requested.supply, installed_supply: actual.supply, installed_liquidity: actual.liquidity,
      token: body.installation.token, launch_token_is_token1: tokenIs1, pool_key: body.installation.poolKey,
      pool_id: poolIdOf(body.installation.poolKey),
      position_id: body.installation.positionId, initial_tick: body.installation.initialTick,
      execution_expiry: Number(body.build.executionExpiry), preview_count: 1, execution_guaranteed: false,
      calldata_keccak256: keccak256(body.data as Hex), preview_read_integrity: body.preview.read_integrity,
    },
    rounding: {
      upper_residue: { asset: "launch_token", known_at_creation: false, claimable_principal: false, creator_fee: false },
      core_unbooked_dust: { per_asset: ["launch_token", "quote_token"], known_at_creation: false, claimable_principal: false, creator_fee: false },
    },
  };
}

/** Opaque owner decoder: verifies the sealed bytes, then summarizes only what the calldata and pin say. */
export function decodeOwnerCreate(sealed: Sealed, expected: {
  pin: InstancePin; owner: Address; requested: ParametersInput;
}, freshTime: bigint) {
  const body = unseal(sealed, LocalCreateBody);
  checkEnvelope(body, expected);
  const actual = bindActual(body, expected.requested);
  validateBuild(actual, body.build, freshTime);
  const fields = createFields(body, actual);
  const statements = createStatements({
    installedSupply: actual.supply, initialFeePercent: fields.initial_fee_percent, finalFeePercent: fields.final_fee_percent,
    feeDuration: String(actual.feeDuration), tradingStart: new Date(Number(actual.tradingStart) * 1000).toISOString(),
    excessHalvingSeconds: String(fields.fee_schedule.excess_halving_seconds ?? "none"),
    exactOutputMultiplier: fields.fee_schedule.exact_output_multiplier_at_initial, owner: body.sender,
    quote: quoteText(body.pin),
  });
  return withSummaryHash({
    schema_version: OWNER_SUMMARY_VERSION, chain_id: body.chain_id, target: body.target,
    selector: CREATE_SELECTOR, method: "create" as const, disclosure: DISCLOSURE, fields, statements,
  });
}

// v3: periphery targets, instance and quote provenance, transferable ownership, no decay factor.
const OWNER_SUMMARY_VERSION = "zero-seed-launch-owner-summary/v3" as const;
const DISCLOSURE = Object.freeze({ version: DISCLOSURE_VERSION, status: DISCLOSURE_STATUS });

/** keccak256 of the canonical summary JSON without this field, so a consumer can bind exactly what was shown. */
function withSummaryHash<T extends object>(summary: T): T & { summary_keccak256: Hex } {
  return { ...summary, summary_keccak256: keccak256(stringToHex(JSON.stringify(summary))) };
}

/**
 * Local producer for the atomic full two-asset claim through the periphery. The caller supplies the launchOwner
 * read the claim is built on; a claim by anyone but the current owner is refused here, as the periphery would.
 * Never executable.
 */
export function localClaimBody(input: {
  owner: Address; pin: InstancePin; poolKey: z.infer<typeof PoolKey>; recipient: Address;
  ownerCheck: z.infer<typeof OwnerCheck>; build: { buildTime: string; executionExpiry: string };
}): Sealed {
  const body = LocalClaimBody.parse({
    schema_version: "zero-seed-local-claim/v2", scope: SCOPE, executable: false,
    chain_id: input.pin.chainId, sender: input.owner.toLowerCase(), target: input.pin.periphery,
    data: encodeFunctionData({ abi: peripheryAbi, functionName: "claimFees", args: [
      { token0: input.poolKey.token0 as Address, token1: input.poolKey.token1 as Address, config: input.poolKey.config as Hex },
      input.recipient,
    ] }).toLowerCase(), value: "0", pin: { ...input.pin }, pool_key: input.poolKey, recipient: input.recipient.toLowerCase(),
    owner_check: input.ownerCheck, build: input.build,
  });
  checkClaim(body);
  return seal(body);
}

/** A pool of this instance and its quote: a native quote is always token0. */
function checkClaimPool(body: ClaimBody): void {
  const { token0, token1, config } = body.pool_key;
  const quoteIs0 = token0 === body.pin.quote;
  if (!quoteIs0 && token1 !== body.pin.quote) throw new ZeroSeedError("unsupported_quote");
  if (body.pin.quoteKind === "native" && !quoteIs0) throw new ZeroSeedError("unsupported_quote");
  if (BigInt(config) >> 96n !== BigInt(body.pin.extension)) throw new ZeroSeedError("pool_extension_mismatch");
  const check = body.owner_check;
  if (check.pool_id !== poolIdOf(body.pool_key)) throw new ZeroSeedError("owner_check_pool_mismatch");
  if (check.launch_owner !== body.sender) throw new ZeroSeedError("not_launch_owner");
}

function checkClaim(body: ClaimBody): void {
  requireLocalPin(body.pin);
  checkClaimPool(body);
  const { token0, token1, config } = body.pool_key;
  validateClaimRecipient(body.recipient as Address, {
    core: body.pin.core as Address, extension: body.pin.extension as Address, periphery: body.pin.periphery as Address,
    token0: token0 as Address, token1: token1 as Address,
  });
  const call = decodeCall(body.data as Hex);
  if (call.functionName !== "claimFees") throw new ZeroSeedError("calldata_method_mismatch");
  const [key, recipient] = call.args;
  const matches = key.token0.toLowerCase() === token0 && key.token1.toLowerCase() === token1 &&
    key.config.toLowerCase() === config && recipient.toLowerCase() === body.recipient;
  if (!matches) throw new ZeroSeedError("calldata_summary_mismatch");
}

function checkClaimTime(build: ClaimBody["build"], freshTime: bigint): void {
  const buildTime = BigInt(build.buildTime);
  const expiry = BigInt(build.executionExpiry);
  if (expiry <= buildTime || freshTime < buildTime || freshTime >= expiry) throw new ZeroSeedError("expired_or_future_plan");
}

export function decodeOwnerClaim(sealed: Sealed, expected: { pin: InstancePin; owner: Address }, freshTime: bigint) {
  const body = unseal(sealed, LocalClaimBody);
  checkEnvelope(body, expected);
  checkClaim(body);
  checkClaimTime(body.build, freshTime);
  return withSummaryHash({
    schema_version: OWNER_SUMMARY_VERSION, chain_id: body.chain_id, target: body.target,
    selector: CLAIM_SELECTOR, method: "claimFees" as const, disclosure: DISCLOSURE,
    fields: {
      owner: body.sender, ...instanceFields(body.pin), pool_key: body.pool_key, pool_id: body.owner_check.pool_id,
      recipient: body.recipient, owner_check: body.owner_check,
      settlement: { atomic: true, assets: ["token0", "token1"], partial_claim: false,
        on_revert: "nothing moves; prepare a fresh claim", execution_guaranteed: false,
        accounting: "one payout: the extension's CreatorFeesClaimed and the periphery's LaunchFeesClaimed report the same amounts" },
    },
    statements: claimStatements(body.recipient),
  });
}
