import { type Address, decodeFunctionData, encodeFunctionData, type Hex, keccak256, stringToHex, toFunctionSelector } from "viem";
import { z } from "zod";
import { zeroSeedAbi } from "./abi.js";
import { claimStatements, createStatements } from "./disclosures.js";
import { address, BuildContext, bytes32, createData, decimal, Parameters, type ParametersInput,
  requireLocalPin, validateBuild, validateParameters } from "./installation.js";
import { Installation, type InstallationInput, validateInstallation } from "./preview.js";
import { type InstancePin, validateClaimRecipient, ZeroSeedError } from "./policy.js";

// Local, explicitly non-executable bodies. They are sealed with the artifact
// envelope's digest and length rules but never stored as an execution_plan.
const SCOPE = "synthetic-local-non-executable";
const Pin = z.strictObject({
  chainId: decimal, address, core: address, quote: address, runtime: bytes32, quoteRuntime: bytes32, abiSha256: z.string(),
});
const PoolKey = z.strictObject({ token0: address, token1: address, config: bytes32 });
const hex = z.string().regex(/^0x([0-9a-f]{2})*$/);
const Envelope = {
  scope: z.literal(SCOPE), executable: z.literal(false),
  chain_id: decimal, sender: address, target: address, data: hex, value: z.literal("0"), pin: Pin,
};
export const LocalCreateBody = z.strictObject({
  schema_version: z.literal("zero-seed-local-create/v1"), ...Envelope,
  build: BuildContext, requested: Parameters, installation: Installation,
  preview: z.strictObject({ count: z.literal(1), read_integrity: bytes32, read_bytes: z.number().int().positive() }),
});
export const LocalClaimBody = z.strictObject({
  schema_version: z.literal("zero-seed-local-claim/v1"), ...Envelope,
  pool_key: PoolKey, recipient: address, build: z.strictObject({ buildTime: decimal, executionExpiry: decimal }),
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

function samePin(a: InstancePin, b: InstancePin): boolean {
  return (Object.keys(b) as (keyof InstancePin)[]).every((key) => a[key] === b[key]) && Object.keys(a).length === Object.keys(b).length;
}

function sameParameters(a: ParametersInput, b: ParametersInput): boolean {
  return (Object.keys(Parameters.shape) as (keyof ParametersInput)[]).every((key) => a[key] === b[key]);
}

function checkEnvelope(body: CreateBody | ClaimBody, expected: { pin: InstancePin; creator: Address }): void {
  requireLocalPin(body.pin);
  if (!samePin(body.pin, expected.pin)) throw new ZeroSeedError("pin_mismatch");
  if (body.chain_id !== expected.pin.chainId || body.target !== expected.pin.address) throw new ZeroSeedError("target_mismatch");
  if (body.sender !== expected.creator.toLowerCase()) throw new ZeroSeedError("creator_mismatch");
}

/** Q0.64 fee as a percentage to four decimals, rounding half up. */
export function feePercent(q64: bigint): string {
  const scaled = (q64 * 1_000_000n + (1n << 63n)) >> 64n;
  return `${scaled / 10_000n}.${(scaled % 10_000n).toString().padStart(4, "0")}%`;
}

function decodedParameters(data: Hex): ParametersInput {
  const call = decodeFunctionData({ abi: zeroSeedAbi, data });
  if (call.functionName !== "create") throw new ZeroSeedError("calldata_method_mismatch");
  if (encodeFunctionData({ abi: zeroSeedAbi, functionName: "create", args: call.args }) !== data) {
    throw new ZeroSeedError("calldata_noncanonical");
  }
  const p = call.args[0];
  return {
    quoteToken: p.quoteToken.toLowerCase(), name: p.name, symbol: p.symbol, decimals: p.decimals,
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
  validateInstallation(body.installation, body.requested, body.pin);
  const actual = { ...body.requested, supply: body.installation.installedSupply, liquidity: body.installation.liquidity };
  if (!sameParameters(decodedParameters(body.data as Hex), actual)) throw new ZeroSeedError("calldata_summary_mismatch");
  return actual;
}

/** Local producer: the create body for exactly the one bound preview. Never executable. */
export function localCreateBody(preview: {
  creator: Address; pin: InstancePin; build: z.infer<typeof BuildContext>; requested: ParametersInput;
  actual: ParametersInput; installation: InstallationInput; preview: { reference: { integrity: { value: Hex }; bytes: number } };
}): Sealed {
  return seal(LocalCreateBody.parse({
    schema_version: "zero-seed-local-create/v1", scope: SCOPE, executable: false,
    chain_id: preview.pin.chainId, sender: preview.creator.toLowerCase(), target: preview.pin.address,
    data: createData(preview.actual), value: "0", pin: { ...preview.pin }, build: preview.build,
    requested: preview.requested, installation: preview.installation,
    preview: { count: 1, read_integrity: preview.preview.reference.integrity.value, read_bytes: preview.preview.reference.bytes },
  }));
}

function createFields(body: CreateBody, actual: ParametersInput) {
  const tokenIs1 = body.installation.poolKey.token1 === body.installation.token;
  return {
    creator: body.sender, quote_token: actual.quoteToken, name: actual.name, symbol: actual.symbol,
    decimals: actual.decimals, supply: actual.supply, liquidity: actual.liquidity, ask_tick: actual.askTick,
    upper_tick: actual.upperTick, tick_spacing: actual.tickSpacing, trading_start: Number(actual.tradingStart),
    fee_duration: actual.feeDuration, initial_fee: actual.initialFee, final_fee: actual.finalFee,
    initial_fee_percent: feePercent(BigInt(actual.initialFee)), final_fee_percent: feePercent(BigInt(actual.finalFee)),
    salt: actual.salt,
    binding: {
      requested_supply: body.requested.supply, installed_supply: actual.supply, installed_liquidity: actual.liquidity,
      token: body.installation.token, launch_token_is_token1: tokenIs1, pool_key: body.installation.poolKey,
      position_id: body.installation.positionId, initial_tick: body.installation.initialTick,
      execution_expiry: Number(body.build.executionExpiry), preview_count: 1, execution_guaranteed: false,
    },
    rounding: {
      upper_residue: { asset: "launch_token", known_at_creation: false, claimable_principal: false, creator_fee: false },
      core_unbooked_dust: { per_asset: ["launch_token", "quote_token"], known_at_creation: false, claimable_principal: false, creator_fee: false },
    },
  };
}

/** Opaque owner decoder: verifies the sealed bytes, then summarizes only what the calldata says. */
export function decodeOwnerCreate(sealed: Sealed, expected: {
  pin: InstancePin; creator: Address; requested: ParametersInput;
}, freshTime: bigint) {
  const body = unseal(sealed, LocalCreateBody);
  checkEnvelope(body, expected);
  const actual = bindActual(body, expected.requested);
  validateBuild(actual, body.build, freshTime);
  const fields = createFields(body, actual);
  return {
    schema_version: "zero-seed-launch-owner-summary/v1" as const, chain_id: body.chain_id, target: body.target,
    selector: toFunctionSelector("create((address,string,string,uint8,uint128,uint128,int32,int32,uint32,uint64,uint32,uint64,uint64,bytes32))"),
    method: "create" as const, fields,
    statements: createStatements({
      installedSupply: actual.supply, initialFeePercent: fields.initial_fee_percent, finalFeePercent: fields.final_fee_percent,
      feeDuration: String(actual.feeDuration), tradingStart: new Date(Number(actual.tradingStart) * 1000).toISOString(),
      creator: body.sender,
    }),
  };
}

const claimSelector = toFunctionSelector("claimFees((address,address,bytes32),address)");

/** Local producer for the atomic full two-asset claim. Never executable. */
export function localClaimBody(input: {
  creator: Address; pin: InstancePin; poolKey: z.infer<typeof PoolKey>; recipient: Address;
  build: { buildTime: string; executionExpiry: string };
}): Sealed {
  const body = LocalClaimBody.parse({
    schema_version: "zero-seed-local-claim/v1", scope: SCOPE, executable: false,
    chain_id: input.pin.chainId, sender: input.creator.toLowerCase(), target: input.pin.address,
    data: encodeFunctionData({ abi: zeroSeedAbi, functionName: "claimFees", args: [
      { token0: input.poolKey.token0 as Address, token1: input.poolKey.token1 as Address, config: input.poolKey.config as Hex },
      input.recipient,
    ] }).toLowerCase(), value: "0", pin: { ...input.pin }, pool_key: input.poolKey, recipient: input.recipient.toLowerCase(),
    build: input.build,
  });
  checkClaim(body);
  return seal(body);
}

function checkClaim(body: ClaimBody): void {
  requireLocalPin(body.pin);
  const { token0, token1, config } = body.pool_key;
  if (token0 !== body.pin.quote && token1 !== body.pin.quote) throw new ZeroSeedError("unsupported_quote");
  if (BigInt(config) >> 96n !== BigInt(body.pin.address)) throw new ZeroSeedError("pool_extension_mismatch");
  validateClaimRecipient(body.recipient as Address, {
    core: body.pin.core as Address, extension: body.pin.address as Address, token0: token0 as Address, token1: token1 as Address,
  });
  const call = decodeFunctionData({ abi: zeroSeedAbi, data: body.data as Hex });
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

export function decodeOwnerClaim(sealed: Sealed, expected: { pin: InstancePin; creator: Address }, freshTime: bigint) {
  const body = unseal(sealed, LocalClaimBody);
  checkEnvelope(body, expected);
  checkClaim(body);
  checkClaimTime(body.build, freshTime);
  return {
    schema_version: "zero-seed-launch-owner-summary/v1" as const, chain_id: body.chain_id, target: body.target,
    selector: claimSelector, method: "claimFees" as const,
    fields: {
      pool_key: body.pool_key, recipient: body.recipient,
      settlement: { atomic: true, assets: ["token0", "token1"], partial_claim: false,
        on_revert: "nothing moves; prepare a fresh claim", execution_guaranteed: false },
    },
    statements: claimStatements(body.recipient),
  };
}
