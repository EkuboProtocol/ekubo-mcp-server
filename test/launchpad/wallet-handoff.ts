// Builds test/fixtures/launchpad/wallet-handoff-final.json from the plans the local lifecycle executed: the sealed
// owner-review artifacts and owner summaries exactly as the tools returned them, the calls the wallet stores, and
// negative cases derived from them with the refusal code the Cloud Wallet's verifier is expected to emit.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { keccak256, stringToHex } from "viem";
import provenance from "../../src/launchpad/zero-seed/frozen/provenance.json";

type Json = Record<string, any>;
interface Sealed { body: string; integrity: string; bytes: number }

const reseal = (body: string): Sealed => ({ body, integrity: keccak256(stringToHex(body)), bytes: new TextEncoder().encode(body).length });
const edit = (sealed: Sealed, change: (body: Json) => void): Sealed => {
  const body = JSON.parse(sealed.body);
  change(body);
  return reseal(JSON.stringify(body));
};
const flip = (hex: string) => `${hex.slice(0, -1)}${hex.endsWith("0") ? "1" : "0"}`;
const sha256 = (path: URL) => createHash("sha256").update(readFileSync(path)).digest("hex");

function storedCall(plan: Json) {
  const step = plan.steps.find((entry: Json) => entry.kind === "execution");
  return { to: step.to.toLowerCase(), value: step.value, data: step.data.toLowerCase() };
}

function expectedOf(plan: Json, quotes: Json[], body: Json) {
  return { pin: { ...body.pin, chainId: Number(body.pin.chainId) }, quotes, owner: body.sender, call: storedCall(plan),
    ...(body.requested === undefined ? {} : { requested: body.requested }) };
}

function entry(plan: Json, kind: string, quotes: Json[]) {
  const review = plan.owner_review;
  const body = JSON.parse(review.artifact.body);
  return {
    case: plan.label, tool: plan.tool, arguments: plan.arguments,
    [`${kind}_artifact`]: review.artifact,
    ...(review.preview_read === undefined ? {} : { preview_read: review.preview_read }),
    [`${kind}_call`]: { target: storedCall(plan).to, value: storedCall(plan).value, selector: storedCall(plan).data.slice(0, 10), data: storedCall(plan).data },
    expected: expectedOf(plan, quotes, body),
    fresh_time: body.build.buildTime,
    owner_summary: review.owner_summary,
    summary_keccak256: review.owner_summary.summary_keccak256,
    local_chain_execution: { receipts: plan.receipts, events: plan.events },
  };
}

type Refusal = { case: string; verifier: "create" | "claim"; artifact: Sealed; expected: Json; fresh_time: string; refusal: { code: string } };

function refusals(create: Json, erc20: Json, claim: Json, other: Json): Refusal[] {
  const c = create.create_artifact as Sealed;
  const base = (name: string, artifact: Sealed, code: string, change: { expected?: Json; fresh_time?: string } = {}, source = create): Refusal => ({
    case: name, verifier: source === claim ? "claim" : "create", artifact, expected: change.expected ?? source.expected,
    fresh_time: change.fresh_time ?? source.fresh_time, refusal: { code },
  });
  const body = JSON.parse(c.body);
  const claimBody = JSON.parse(claim.claim_artifact.body);
  return [
    base("create_tampered_body", { ...c, body: c.body.replace('"executable":false', '"executable":fals0') }, "artifact_tampered"),
    base("create_truncated_length", { ...c, bytes: c.bytes - 1 }, "artifact_length_mismatch"),
    base("create_noncanonical_whitespace", reseal(JSON.stringify(body, null, 1)), "artifact_noncanonical"),
    base("create_superseded_schema_v5", edit(c, (b) => { b.schema_version = "zero-seed-local-create/v5"; }), "artifact_schema_mismatch"),
    base("create_expired", c, "expired_or_future_plan", { fresh_time: body.build.executionExpiry }),
    base("create_before_build", c, "expired_or_future_plan", { fresh_time: (BigInt(body.build.buildTime) - 1n).toString() }),
    base("create_wrong_owner", c, "owner_mismatch", { expected: { ...create.expected, owner: other.owner } }),
    base("create_pin_runtime_mismatch", c, "pin_mismatch", { expected: { ...create.expected, pin: { ...create.expected.pin, peripheryRuntime: flip(body.pin.peripheryRuntime) } } }),
    base("create_pin_deployment_block_mismatch", c, "pin_mismatch", { expected: { ...create.expected, pin: { ...create.expected.pin, deploymentBlock: String(Number(body.pin.deploymentBlock) + 1) } } }),
    base("create_stored_call_mismatch", c, "stored_call_mismatch", { expected: { ...create.expected, call: { ...create.expected.call, data: erc20.expected.call.data } } }),
    base("create_requested_mismatch", c, "requested_mismatch", { expected: { ...create.expected, requested: { ...create.expected.requested, supply: "1" } } }),
    base("create_preview_liquidity_mismatch", edit(c, (b) => { b.installation.liquidity = (BigInt(b.installation.liquidity) + 1n).toString(); }), "invalid_installation_amounts"),
    base("create_preview_geometry_mismatch", edit(c, (b) => { b.installation.positionId = flip(b.installation.positionId); }), "preview_geometry_mismatch"),
    base("create_preview_token_mismatch", edit(c, (b) => { b.installation.token = flip(b.installation.token); }), "preview_token_mismatch"),
    base("erc20_create_unreviewed_quote", erc20.create_artifact, "unsupported_quote", { expected: { ...erc20.expected, quotes: [] } }, erc20),
    base("claim_tampered_body", { ...claim.claim_artifact, body: claim.claim_artifact.body.replace('"value":"0"', '"value":"1"') }, "artifact_tampered", {}, claim),
    base("claim_expired", claim.claim_artifact, "expired_or_future_plan", { fresh_time: claimBody.build.executionExpiry }, claim),
    base("claim_wrong_owner", claim.claim_artifact, "owner_mismatch", { expected: { ...claim.expected, owner: other.owner } }, claim),
    base("claim_owner_check_not_sender", edit(claim.claim_artifact, (b) => { b.owner_check.launch_owner = other.owner; }), "not_launch_owner", {}, claim),
    base("claim_owner_check_other_pool", edit(claim.claim_artifact, (b) => { b.owner_check.pool_id = flip(b.owner_check.pool_id); }), "owner_check_pool_mismatch", {}, claim),
    base("claim_pin_mismatch", claim.claim_artifact, "pin_mismatch", { expected: { ...claim.expected, pin: { ...claim.expected.pin, extensionRuntime: flip(claimBody.pin.extensionRuntime) } } }, claim),
  ];
}

export function walletHandoff(recorded: Json[], mcpCommit: string) {
  const by = (label: string) => recorded.find((plan) => plan.label === label)!;
  const erc20Body = JSON.parse(by("erc20 quote, logo").owner_review.artifact.body);
  const quotes = [{ chainId: Number(erc20Body.chain_id), address: erc20Body.quote.address, runtime: erc20Body.quote.runtime }];
  const creates = recorded.filter((plan) => plan.tool === "launchpad_prepare_create").map((plan) => entry(plan, "create", quotes));
  const claims = recorded.filter((plan) => plan.tool === "launchpad_prepare_claim_fees").map((plan) => entry(plan, "claim", quotes));
  const transfers = recorded.filter((plan) => plan.tool === "launchpad_prepare_transfer_launch").map((plan) => {
    const body = JSON.parse(plan.owner_review.artifact.body);
    return { ...entry(plan, "transfer", quotes), decoded: { method: "transferLaunch", poolId: body.pool_id, newOwner: body.new_owner } };
  });
  const trades = recorded.filter((plan) => plan.tool === "launchpad_prepare_trade").map((plan) => ({
    case: plan.label, arguments: plan.arguments, steps: plan.steps, details: plan.details, owner_review: null,
    local_chain_execution: { receipts: plan.receipts, events: plan.events },
  }));
  const owner = { owner: transfers[0].decoded.newOwner };
  const lifecycle = new URL("../fixtures/launchpad/local-lifecycle.json", import.meta.url);
  return {
    scope: "UNSIGNED, LOCAL, NON-EXECUTABLE owner-review artifacts for wallet verifier replay. The plans were prepared by the launchpad tools through worker.fetch against a local anvil chain (no fork) running the frozen final contracts and executed there with anvil dev keys; nothing was signed by a wallet. No final deployment exists and hosted launch support is disabled.",
    provenance: {
      mcp_commit: mcpCommit,
      contracts_commit: provenance.source_commit,
      abi_sha256: provenance.sha256,
      lifecycle: { file: "test/fixtures/launchpad/local-lifecycle.json", sha256: sha256(lifecycle) },
    },
    contract: {
      owner_summary_schema_version: "zero-seed-launch-owner-summary/v6",
      create_body_schema_version: "zero-seed-local-create/v6",
      claim_body_schema_version: "zero-seed-local-claim/v5",
      transfer_body_schema_version: "zero-seed-local-transfer/v1 (proposed; no wallet verifier yet)",
      preview_read_schema_version: "zero-seed-preview-read/v1",
      disclosure_version: 7,
      fee_model: "tick_rate_final",
      artifact_integrity: "keccak256(utf8(body)); bytes = utf8 length of body; body is canonical JSON (re-serialising the parsed body reproduces it)",
      summary_keccak256: "keccak256(utf8(JSON.stringify(summary without summary_keccak256))), key order exactly as in owner_summary",
      preview_read: "create preview.read_integrity / read_bytes are the seal of the preview_read record: the one previewInstallation eth_call (to, data, result) at block_number/block_hash, pinned by block hash",
      review_window_seconds: "300: build.executionExpiry = build.buildTime + 300 (create, claim, transfer); buildTime = blockTime = the latest block's timestamp the plan was built on",
      pin: "chainId, feeModel, lowercase core/extension/periphery, keccak256 of the extension's and periphery's deployed runtime, deployment_block of the periphery, and the SHA-256 of the frozen ABI files",
    },
    pins: { tick_rate_final: JSON.parse(creates[0].create_artifact.body).pin },
    reviewed_quotes: quotes,
    creates, claims, transfers, trades,
    refusals: refusals(creates[0], creates[1], claims[0], owner),
  };
}
