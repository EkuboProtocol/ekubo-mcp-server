import { describe, expect, test } from "bun:test";
import { decodeFunctionData, decodeFunctionResult, keccak256, stringToHex } from "viem";
import { abiFunction, peripheryAbi } from "../../src/launchpad/zero-seed/abi.js";
import { DISCLOSURE_CODES } from "../../src/launchpad/zero-seed/disclosures.js";
import { claimOwnerSummary, createOwnerSummary, transferOwnerSummary } from "../../src/launchpad/zero-seed/review.js";
import lifecycle from "../fixtures/launchpad/local-lifecycle.json";
import handoff from "../fixtures/launchpad/wallet-handoff-final.json";

// The recorded owner-review artifacts of the local lifecycle, checked on every run: seals, canonical bodies, the
// binding to the executed call and the preview read, and owner summaries recomputed from the bodies alone.
type Json = Record<string, any>;
interface Sealed { body: string; integrity: string; bytes: number }
const plans = lifecycle.plans as Json[];
const h = handoff as Json;

function checkSeal(sealed: Sealed) {
  expect(keccak256(stringToHex(sealed.body))).toBe(sealed.integrity as `0x${string}`);
  expect(new TextEncoder().encode(sealed.body).length).toBe(sealed.bytes);
  expect(JSON.stringify(JSON.parse(sealed.body))).toBe(sealed.body);
  return JSON.parse(sealed.body);
}

const withoutHash = ({ summary_keccak256: _, ...rest }: Json) => rest;

describe("owner-review artifacts of the local lifecycle", () => {
  test("every create, claim and transfer carries one; trades carry none", () => {
    for (const plan of plans) {
      if (plan.tool === "launchpad_prepare_trade") expect(plan.owner_review).toBeUndefined();
      else expect(plan.owner_review.artifact.bytes).toBeGreaterThan(0);
    }
    expect(h.creates).toHaveLength(2);
    expect(h.claims).toHaveLength(2);
    expect(h.transfers).toHaveLength(1);
    expect(h.trades).toHaveLength(4);
  });

  test("bodies describe exactly the executed call, on the recorded pin", () => {
    for (const plan of plans.filter((entry) => entry.owner_review !== undefined)) {
      const body = checkSeal(plan.owner_review.artifact);
      const step = plan.steps.at(-1);
      expect([body.target, body.data, body.value]).toEqual([step.to.toLowerCase(), step.data.toLowerCase(), step.value]);
      expect(body.pin).toEqual(h.pins.tick_rate_final);
      expect(body.pin.extensionAbiSha256).toBe(h.provenance.abi_sha256["ZeroSeedLaunch.abi.json"]);
      expect([body.scope, body.executable]).toEqual(["synthetic-local-non-executable", false]);
      expect(BigInt(body.build.executionExpiry) - BigInt(body.build.buildTime)).toBe(300n);
    }
  });

  test("create: the preview read record decodes to the body's installation", () => {
    for (const entry of h.creates) {
      const body = checkSeal(entry.create_artifact);
      const read = checkSeal(entry.preview_read);
      expect([body.preview.read_integrity, body.preview.read_bytes]).toEqual([entry.preview_read.integrity, entry.preview_read.bytes]);
      expect([read.block_number, read.block_hash, read.to]).toEqual([body.build.blockNumber, body.build.blockHash, body.target]);
      const fn = abiFunction(peripheryAbi, "previewInstallation");
      const call = decodeFunctionData({ abi: [fn], data: read.data });
      expect((call.args as Json[])[0].toLowerCase()).toBe(body.sender);
      const result = decodeFunctionResult({ abi: [fn], functionName: fn.name, data: read.result }) as Json;
      expect(result.liquidity.toString()).toBe(body.installation.liquidity);
      expect(result.token.toLowerCase()).toBe(body.installation.token);
      expect([result.tickSpacing, result.askTick, result.upperTick]).toEqual([body.installation.tickSpacing, body.installation.askTick, body.installation.upperTick]);
    }
  });

  test("owner summaries recompute from the bodies, summary_keccak256 included", () => {
    const pairs: [Json[], string, (body: never) => Json][] = [
      [h.creates, "create_artifact", createOwnerSummary], [h.claims, "claim_artifact", claimOwnerSummary], [h.transfers, "transfer_artifact", transferOwnerSummary],
    ];
    for (const [entries, key, summarize] of pairs) {
      for (const entry of entries) {
        const summary = summarize(JSON.parse(entry[key].body) as never);
        expect(JSON.stringify(summary)).toBe(JSON.stringify(entry.owner_summary));
        expect(summary.summary_keccak256).toBe(keccak256(stringToHex(JSON.stringify(withoutHash(summary)))));
      }
    }
  });

  test("create statements: ten version-7 disclosures, ERC-20 quote trust token-wide, native isolated, no metadata", () => {
    const [native, erc20] = h.creates.map((entry: Json) => entry.owner_summary);
    for (const summary of [native, erc20]) {
      expect(summary.disclosure).toEqual({ version: 7, status: "draft_not_approved" });
      expect(summary.statements).toHaveLength(DISCLOSURE_CODES.length);
      const text = summary.statements.join("\n");
      for (const metadata of [summary.fields.name.text, summary.fields.symbol.text]) expect(text).not.toContain(metadata);
      expect(text).toContain("Permanent principal lock");
      expect(text).toContain("a long-run floor and not an end date");
      expect(text).toContain("including fees earned before a transfer");
    }
    expect(native.statements.at(-1)).toBe("Quote trust: the quote is native ETH, which Core accounts for itself. No quote token contract is trusted.");
    expect(erc20.statements.at(-1)).toContain(`Quote trust: quote token ${erc20.fields.quote.address} is trusted across all of Core, not just this pool.`);
    expect(erc20.statements.at(-1)).toContain("every pool, position and fee ledger holding it is exposed");
    expect(erc20.fields.logo_url).toEqual({ value: "https://example.org/logo.png", trusted: false, stored: false, in_identity: false });
    expect(native.fields.logo_url.value).toBe("");
  });

  test("negative cases name the refusal the wallet verifier emits", () => {
    const codes = h.refusals.map((entry: Json) => entry.refusal.code);
    for (const code of ["artifact_tampered", "artifact_noncanonical", "expired_or_future_plan", "owner_mismatch", "pin_mismatch",
      "invalid_installation_amounts", "preview_geometry_mismatch", "preview_token_mismatch", "not_launch_owner", "unsupported_quote"]) {
      expect(codes).toContain(code);
    }
  });
});
