// Builds the producer-to-wallet handoff fixture for the tick_rate_v2 launch artifacts: unsigned, local and
// non-executable. Everything is derived from the recorded local chains and the current producer and decoders, so the
// test can rebuild it byte for byte (script/zero-seed-wallet-fixtures.ts writes it). Nothing is signed or sent.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Address, decodeFunctionData, type Hex, keccak256, stringToHex } from "viem";
import { ZodError } from "zod";
import { CLAIM_SELECTOR, CREATE_SELECTOR, CREATE_SELECTOR_V1, LAUNCH_CREATED_TOPIC, LAUNCH_CREATED_TOPIC_V1, peripheryAbi,
  PREVIEW_SELECTOR, PREVIEW_SELECTOR_V1 } from "../../src/launchpad/zero-seed/abi.js";
import { DISCLOSURE_VERSION } from "../../src/launchpad/zero-seed/disclosures.js";
import { decodeLaunchCreated, launchCreator, type RawLog } from "../../src/launchpad/zero-seed/events.js";
import { DEFAULT_DECAY_RATE_X32, HALF_LIFE_X32_E30, MAX_DECAY_PRODUCT } from "../../src/launchpad/zero-seed/fee.js";
import { type ParametersInput, resolveParameters, validateParameters } from "../../src/launchpad/zero-seed/installation.js";
import { decodeOwnerClaim, decodeOwnerCreate, localClaimBody, OWNER_SUMMARY_VERSION,
  type Sealed } from "../../src/launchpad/zero-seed/owner.js";
import { ABI_SHA256, CONTRACTS_COMMITS, type InstancePin } from "../../src/launchpad/zero-seed/policy.js";
import { readBundle } from "../../src/launchpad/zero-seed/preview.js";
import { EXTENSION_RUNTIME, PERIPHERY_RUNTIME } from "../../src/launchpad/zero-seed/runtime.js";
import { chain, pin, v1Chain, v1Pin } from "./zero-seed-fixture.js";

const sha256 = (path: string) => createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex");
type Launch = (typeof chain.launches)[keyof typeof chain.launches];

function refusal(run: () => unknown): { code: string; message?: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof ZodError) {
      return { code: "invalid_argument", message: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    }
    return { code: (error as { code?: string }).code ?? String(error) };
  }
  throw new Error("expected a refusal");
}

function modelPin(model: InstancePin["feeModel"]) {
  return {
    fee_model: model, contracts_commit: CONTRACTS_COMMITS[model],
    create_selector: model === "tick_rate_v2" ? CREATE_SELECTOR : CREATE_SELECTOR_V1,
    preview_selector: model === "tick_rate_v2" ? PREVIEW_SELECTOR : PREVIEW_SELECTOR_V1,
    launch_created_topic: model === "tick_rate_v2" ? LAUNCH_CREATED_TOPIC : LAUNCH_CREATED_TOPIC_V1,
    claim_selector: CLAIM_SELECTOR,
    abi_sha256: ABI_SHA256[model],
    runtime_template_keccak256: { extension: EXTENSION_RUNTIME[model].templateKeccak256, periphery: PERIPHERY_RUNTIME[model].templateKeccak256 },
    decay_field: model === "tick_rate_v2" ? "uint64 decayRateX32 (10th LaunchParameters field)" : "uint32 feeDuration (10th LaunchParameters field)",
    produces: model === "tick_rate_v2" ? ["preview", "create", "claimFees"] : ["claimFees"],
  };
}

/** One create case: the preview read the wallet answers, the sealed create, its owner summary and the chain's record. */
function createCase(name: string, launch: Launch) {
  const request = launch.request as ParametersInput;
  const summary = decodeOwnerCreate(launch.sealed as Sealed, { pin, owner: chain.accounts.owner as Address, requested: request },
    BigInt(launch.build.buildTime) + 1n);
  if (JSON.stringify(summary) !== JSON.stringify(launch.owner_summary)) throw new Error(`${name}: summary drift`);
  const { summary_keccak256: hash, ...unhashed } = summary;
  if (keccak256(stringToHex(JSON.stringify(unhashed))) !== hash) throw new Error(`${name}: summary hash`);
  const body = JSON.parse(launch.sealed.body);
  const decoded = decodeFunctionData({ abi: peripheryAbi, data: body.data as Hex });
  if (decoded.functionName !== "create") throw new Error("create");
  const created = launchCreator(launch.logs as RawLog[], pin, true);
  return {
    case: name,
    decay_rate_x32: request.decayRateX32,
    half_life_seconds: summary.fields.fee_schedule.half_life_seconds,
    saturation_elapsed_seconds: summary.fields.fee_schedule.saturation_elapsed_seconds,
    preview_read: {
      read_calls_body: readBundle(chain.accounts.owner as Address, request, pin, launch.build),
      block: { number: launch.build.blockNumber, hash: launch.build.blockHash, time: launch.build.blockTime },
      result_data: launch.preview.raw, installation: launch.preview.installation, supply: launch.preview.supply,
    },
    create_artifact: launch.sealed,
    create_call: { target: body.target, value: body.value, selector: body.data.slice(0, 10), data: body.data,
      decoded_parameters: JSON.parse(JSON.stringify(decoded.args[0], (_, v) => (typeof v === "bigint" ? v.toString() : v))) },
    owner_summary: summary,
    summary_keccak256: hash,
    local_chain_execution: { transaction_hash: launch.receipt.transaction_hash, block_number: launch.receipt.block_number,
      status: launch.receipt.status, launch_created: created },
  };
}

type Claim = (typeof chain)["first_claim"];
function claimCase(name: string, claim: Claim, claimPin: InstancePin, claimer: string, launch: { request: { quoteToken: string };
  preview: { installation: { poolKey: { token0: string; token1: string; config: string } } } }) {
  const body = JSON.parse(claim.sealed.body);
  const build = body.build ?? { buildTime: (BigInt(claim.receipt.timestamp) - 1n).toString(),
    executionExpiry: (BigInt(claim.receipt.timestamp) + 299n).toString() };
  const sealed = localClaimBody({ owner: claimer as Address, pin: claimPin, quoteToken: launch.request.quoteToken as Address,
    poolKey: launch.preview.installation.poolKey, recipient: body.recipient, ownerCheck: claim.owner_check, build });
  const summary = decodeOwnerClaim(sealed, { pin: claimPin, owner: claimer as Address }, BigInt(build.buildTime) + 1n);
  const data = JSON.parse(sealed.body).data;
  if (data !== body.data) throw new Error(`${name}: claim calldata differs from the executed one`);
  return {
    case: name, fee_model: claimPin.feeModel, claim_artifact: sealed,
    claim_call: { target: JSON.parse(sealed.body).target, value: "0", selector: data.slice(0, 10), data },
    owner_summary: summary, summary_keccak256: summary.summary_keccak256,
    local_chain_execution: { transaction_hash: claim.receipt.transaction_hash, block_number: claim.receipt.block_number,
      paid: claim.deltas },
  };
}

function refusals() {
  const v2 = chain.launches.native;
  const v1 = v1Chain.launches.native;
  const v1Log = (v1.logs as RawLog[]).find((log) => log.topics[0] === LAUNCH_CREATED_TOPIC_V1)!;
  const v2Log = (v2.logs as RawLog[]).find((log) => log.topics[0] === LAUNCH_CREATED_TOPIC)!;
  const request = v2.request as ParametersInput;
  const { decayRateX32: _rate, ...toolInput } = request;
  return [
    { case: "create_on_fixed_base_duration_v1_pin", input: { pin: v1Pin, parameters: request },
      refusal: refusal(() => validateParameters(request, v1Pin)) },
    { case: "fixed_base_duration_v1_create_artifact_read_as_v5", input: { sealed: v1.sealed },
      refusal: refusal(() => decodeOwnerCreate(v1.sealed as Sealed, { pin: v1Pin, owner: v1Chain.accounts.owner as Address,
        requested: v1.request as never }, BigInt(v1.build.buildTime) + 1n)) },
    { case: "fixed_base_duration_v1_create_calldata_under_tick_rate_pin",
      input: { data: JSON.parse(v1.sealed.body).data.slice(0, 10) },
      refusal: refusal(() => decodeOwnerCreate({ ...(() => {
        const body = JSON.parse(v2.sealed.body);
        body.data = JSON.parse(v1.sealed.body).data;
        const text = JSON.stringify(body);
        return { body: text, integrity: keccak256(stringToHex(text)), bytes: new TextEncoder().encode(text).length };
      })() }, { pin, owner: chain.accounts.owner as Address, requested: request }, BigInt(v2.build.buildTime) + 1n)) },
    { case: "v1_launch_created_topic_on_tick_rate_pin", input: { topic: v1Log.topics[0], emitter: pin.extension },
      refusal: refusal(() => decodeLaunchCreated({ ...v1Log, address: pin.extension }, pin, true)) },
    { case: "tick_rate_launch_created_on_fixed_base_pin", input: { topic: v2Log.topics[0], emitter: v1Pin.extension },
      refusal: refusal(() => decodeLaunchCreated({ ...v2Log, address: v1Pin.extension }, v1Pin, true)) },
    { case: "decay_rate_2_pow_64", input: { decayRateX32: "18446744073709551616" },
      refusal: refusal(() => resolveParameters({ ...toolInput, decayRateX32: "18446744073709551616" })) },
    { case: "decay_rate_json_number", input: { decayRateX32: 68913100933 },
      refusal: refusal(() => resolveParameters({ ...toolInput, decayRateX32: 68913100933 as never })) },
    { case: "half_life_with_rate_above_uint64", input: { halfLifeSeconds: "0.000322" },
      refusal: refusal(() => resolveParameters({ ...toolInput, halfLifeSeconds: "0.000322" })) },
    { case: "fee_duration_on_tick_rate", input: { feeDuration: 3600 },
      refusal: refusal(() => resolveParameters({ ...toolInput, feeDuration: 3600 } as never)) },
  ];
}

export function walletHandoff() {
  const l = chain.launches;
  return {
    scope: "UNSIGNED, LOCAL, NON-EXECUTABLE producer artifacts for wallet decoder replay. Nothing was signed, sent or simulated by a wallet; the local_chain_execution records are of an anvil chain with no fork. Hosted launch support is disabled and no live instance pin exists.",
    sources: {
      tick_rate_chain: { file: "test/fixtures/launchpad/zero-seed-tick-rate-local-chain.json",
        sha256: sha256("../fixtures/launchpad/zero-seed-tick-rate-local-chain.json") },
      fixed_base_chain: { file: "test/fixtures/launchpad/zero-seed-native-local-chain.json",
        sha256: sha256("../fixtures/launchpad/zero-seed-native-local-chain.json") },
      contracts_vectors: { file: "test/fixtures/launchpad/zero-seed-launch-vectors-3d6378f.json",
        sha256: sha256("../fixtures/launchpad/zero-seed-launch-vectors-3d6378f.json") },
    },
    contract: {
      owner_summary_schema_version: OWNER_SUMMARY_VERSION,
      create_body_schema_version: "zero-seed-local-create/v5",
      claim_body_schema_version: "zero-seed-local-claim/v4",
      disclosure_version: DISCLOSURE_VERSION,
      summary_keccak256: "keccak256(utf8(JSON.stringify(summary without summary_keccak256))), key order exactly as in owner_summary",
      artifact_integrity: "keccak256(utf8(body)); bytes = utf8 length of body; body is canonical JSON (re-serialising the parsed body reproduces it)",
      version_discriminator: "pin.feeModel inside the sealed body and fields.instance.fee_model in the summary, together with the pin's runtime and ABI hashes; never inferred from an address or event",
      decay_rate_x32: "canonical decimal string, 0 to 18446744073709551615 (uint64 Q32.32 ticks per second); 0 is a flat fee at initialFee",
      half_life_seconds: "display only: floor(HALF_LIFE_X32_E30 * 10^6 / (rate * 10^30)) microseconds as S.uuuuuu; null for rate 0",
      saturation_elapsed_seconds: "floor(MAX_DECAY_PRODUCT / rate) as a decimal string; from the next elapsed second the fee is exactly final_fee; null for rate 0; not a schedule end",
      HALF_LIFE_X32_E30: HALF_LIFE_X32_E30.toString(),
      MAX_DECAY_PRODUCT: MAX_DECAY_PRODUCT.toString(),
      default_decay_rate_x32: DEFAULT_DECAY_RATE_X32.toString(),
      models: { tick_rate_v2: modelPin("tick_rate_v2"), fixed_base_duration_v1: modelPin("fixed_base_duration_v1") },
      fixed_base_duration_v1_policy: "No preview or create is produced for this model (unsupported_fee_model). Reads, LaunchCreated decoding and claims keep the 43d6628 ABI and math unchanged.",
    },
    pins: { tick_rate_v2: pin, fixed_base_duration_v1: v1Pin },
    creates: [
      createCase("default_one_day_half_life_50_to_0.3", l.default_schedule),
      createCase("half_life_600s_5_to_0.3_native", l.native),
      createCase("half_life_600s_5_to_0.3_erc20", l.erc20),
      createCase("decay_rate_1", l.min_rate),
      createCase("decay_rate_0_constant", l.zero_rate),
      createCase("decay_rate_max_at_floor_after_first_second", l.max_rate),
    ],
    claims: [
      claimCase("tick_rate_v2_native_claim", chain.first_claim, pin, chain.accounts.owner, l.native),
      claimCase("tick_rate_v2_erc20_claim", chain.erc20_claim as unknown as Claim, pin, chain.accounts.owner, l.erc20),
      claimCase("tick_rate_v2_claim_after_transfer", chain.after_transfer.claim as unknown as Claim, pin, chain.accounts.new_owner, l.native),
      claimCase("fixed_base_duration_v1_native_claim", v1Chain.first_claim as unknown as Claim, v1Pin, v1Chain.accounts.owner,
        v1Chain.launches.native),
    ],
    refusals: refusals(),
  };
}

export const WALLET_HANDOFF_PATH = "test/fixtures/launchpad/zero-seed-wallet-handoff-v5.json";
export const serializeHandoff = () => `${JSON.stringify(walletHandoff(), null, 1)}\n`;
