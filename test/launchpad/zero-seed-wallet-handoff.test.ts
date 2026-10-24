import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decodeFunctionData, type Hex, keccak256, stringToHex } from "viem";
import { CREATE_SELECTOR, peripheryAbi, peripheryAbiV1, PREVIEW_SELECTOR } from "../../src/launchpad/zero-seed/abi.js";
import { halfLifeSeconds, saturationElapsedSeconds } from "../../src/launchpad/zero-seed/fee.js";
import { serializeHandoff, WALLET_HANDOFF_PATH } from "./zero-seed-wallet-handoff.js";

// The unsigned producer-to-wallet handoff fixture: rebuilt from the recorded chains and the current producer, and
// checked the way a wallet verifier would read it, without this repository's decoders.
type Json = any;
const text = readFileSync(new URL(`../../${WALLET_HANDOFF_PATH}`, import.meta.url), "utf8");
const handoff: Json = JSON.parse(text);
const sealedOk = (sealed: Json) => {
  expect(keccak256(stringToHex(sealed.body))).toBe(sealed.integrity);
  expect(new TextEncoder().encode(sealed.body).length).toBe(sealed.bytes);
  expect(JSON.stringify(JSON.parse(sealed.body))).toBe(sealed.body);
};
const hashOk = (summary: Json) => {
  const { summary_keccak256: hash, ...rest } = summary;
  expect(keccak256(stringToHex(JSON.stringify(rest)))).toBe(hash);
};

describe("wallet handoff fixture (unsigned, local, no sends)", () => {
  test("is exactly what the producer and decoders give today", () => {
    expect(serializeHandoff()).toBe(text);
    expect(handoff.scope).toStartWith("UNSIGNED, LOCAL, NON-EXECUTABLE");
  });

  test("creates: integrity, summary hash, the tick-rate selector and tuple, and no duration anywhere", () => {
    expect(handoff.creates.map((c: Json) => c.decay_rate_x32)).toEqual(["68913100933", "9923486534471", "9923486534471", "1", "0",
      "18446744073709551615"]);
    for (const c of handoff.creates) {
      sealedOk(c.create_artifact);
      hashOk(c.owner_summary);
      const body = JSON.parse(c.create_artifact.body);
      expect(body).toMatchObject({ schema_version: "zero-seed-local-create/v5", executable: false, value: "0",
        pin: { feeModel: "tick_rate_v2" } });
      expect(c.create_call.data).toBe(body.data);
      expect(c.create_call.selector).toBe(CREATE_SELECTOR);
      const decoded = decodeFunctionData({ abi: peripheryAbi, data: body.data as Hex });
      if (decoded.functionName !== "create") throw new Error("create");
      expect(decoded.args[0].decayRateX32.toString()).toBe(c.decay_rate_x32);
      expect(c.create_call.decoded_parameters.decayRateX32).toBe(c.decay_rate_x32);
      expect(() => decodeFunctionData({ abi: peripheryAbiV1, data: body.data as Hex })).toThrow();
      expect(c.owner_summary).toMatchObject({ schema_version: "zero-seed-launch-owner-summary/v5", selector: CREATE_SELECTOR,
        fields: { decay_rate_x32: c.decay_rate_x32, instance: { fee_model: "tick_rate_v2" },
          fee_schedule: { model: "tick_rate_v2", decay_rate_x32: c.decay_rate_x32 } } });
      expect(c.half_life_seconds).toBe(halfLifeSeconds(BigInt(c.decay_rate_x32)));
      expect(c.saturation_elapsed_seconds).toBe(saturationElapsedSeconds(BigInt(c.decay_rate_x32))?.toString() ?? null);
      expect(c.preview_read.read_calls_body.calls[0].data.slice(0, 10)).toBe(PREVIEW_SELECTOR);
      expect(c.local_chain_execution.status).toBe("success");
      expect(c.local_chain_execution.launch_created.parameters.decayRateX32).toBe(c.decay_rate_x32);
      const all = JSON.stringify(c);
      for (const stale of ["feeDuration", "fee_duration", "fee_end", "0x662af306"]) expect(all).not.toContain(stale);
    }
  });

  test("claims: same claimFees call for both models; each summary names its model", () => {
    for (const c of handoff.claims) {
      sealedOk(c.claim_artifact);
      hashOk(c.owner_summary);
      expect(c.claim_call.selector).toBe("0x6906b4c0");
      expect(JSON.parse(c.claim_artifact.body)).toMatchObject({ schema_version: "zero-seed-local-claim/v4", pin: { feeModel: c.fee_model } });
      expect(c.owner_summary.fields.instance.fee_model).toBe(c.fee_model);
    }
    expect(handoff.claims.map((c: Json) => c.fee_model)).toEqual(["tick_rate_v2", "tick_rate_v2", "tick_rate_v2", "fixed_base_duration_v1"]);
  });

  test("refusals carry a stable code before any read", () => {
    expect(Object.fromEntries(handoff.refusals.map((r: Json) => [r.case, r.refusal.code]))).toEqual({
      create_on_fixed_base_duration_v1_pin: "unsupported_fee_model",
      fixed_base_duration_v1_create_artifact_read_as_v5: "artifact_schema_mismatch",
      fixed_base_duration_v1_create_calldata_under_tick_rate_pin: "unsupported_selector",
      v1_launch_created_topic_on_tick_rate_pin: "launch_event_invalid",
      tick_rate_launch_created_on_fixed_base_pin: "launch_event_invalid",
      decay_rate_2_pow_64: "invalid_argument",
      decay_rate_json_number: "invalid_argument",
      half_life_with_rate_above_uint64: "invalid_half_life",
      fee_duration_on_tick_rate: "invalid_argument",
    });
  });

  test("the contract section names the discriminator, the constants and the per-model pins", () => {
    expect(handoff.contract).toMatchObject({ owner_summary_schema_version: "zero-seed-launch-owner-summary/v5",
      HALF_LIFE_X32_E30: "5954091920683119788732747343471285361579197626", MAX_DECAY_PRODUCT: "381061679028371455",
      default_decay_rate_x32: "68913100933", disclosure_version: 7 });
    expect(handoff.contract.models.tick_rate_v2).toMatchObject({ create_selector: "0xf91810d2", preview_selector: "0xb665ec4d",
      produces: ["preview", "create", "claimFees"] });
    expect(handoff.contract.models.fixed_base_duration_v1).toMatchObject({ create_selector: "0x662af306", produces: ["claimFees"] });
    expect(handoff.pins.tick_rate_v2.feeModel).toBe("tick_rate_v2");
  });
});
