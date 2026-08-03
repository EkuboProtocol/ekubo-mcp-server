import { describe, expect, it } from "bun:test";
import { parseAbi } from "viem";
import {
  EKUBO_SQRT_RATIO_FLOAT_CODEC,
  functionResultDecodePlan,
  localWalletDecoderHandoff,
  semanticValueDecodePlan,
  sqrtRatioFloatSemanticCodec,
} from "../src/abi-decode.js";

describe("local ABI decode plans", () => {
  it("describes JSON-safe function decoding without executing it remotely", () => {
    const abi = parseAbi([
      "function state() view returns (uint256 amount,bytes payload)",
    ]);
    const decode = functionResultDecodePlan(abi, "state");
    const handoff = localWalletDecoderHandoff({
      chainId: "4663",
      id: "state",
      to: "0x0000000000000000000000000000000000000001",
      data: "0x12345678",
      decode,
    });

    expect(decode).toEqual({
      kind: "function_result",
      abi,
      function_name: "state",
      required: true,
    });
    expect(handoff).toMatchObject({
      trust_boundary: "execute_and_decode_on_user_device",
      call_id: "state",
      network: { chain_id: "4663", caip2_chain_id: "eip155:4663" },
    });
    expect(handoff.instruction).toContain("wallet_batch_eth_call");
    expect(handoff.instruction).toContain("local_decode_plan");
  });

  it("never restates the calldata or ABI it was built from", () => {
    const abi = [
      {
        type: "function",
        name: "state",
        inputs: [],
        outputs: [{ name: "value", type: "uint256" }],
        stateMutability: "view",
      },
    ] as const;
    const decode = functionResultDecodePlan(abi, "state");
    const handoff = localWalletDecoderHandoff({
      chainId: "4663",
      id: "state",
      to: "0x0000000000000000000000000000000000000001",
      data: "0x12345678",
      decode,
    });
    // The caller already emits rpc_request and local_decode_plan. Repeating
    // either one here is what made multi-position responses unreadable.
    const serialized = JSON.stringify(handoff);
    expect(serialized).not.toContain("0x12345678");
    expect(serialized).not.toContain("function_result");
  });

  it("pins npm explicitly while keeping semantic codec identity portable", () => {
    expect(EKUBO_SQRT_RATIO_FLOAT_CODEC).toEqual({
      semantic_type: "ekubo.sqrt_ratio_float",
      codec: {
        id: "ekubo.sqrt_ratio_float_to_q128",
        version: 1,
        implementations: [
          {
            ecosystem: "npm",
            registry: "https://registry.npmjs.org",
            package_url: "pkg:npm/%40ekubo/sdk@0.0.10-alpha.0",
            export_name: "floatSqrtRatioToFixed",
            integrity:
              "sha512-1koNXODon0kaQBX5CbYRyfvj5viEBmyxZFlOTWPlK79gItDoIEeJIUYM8IlTu3YTT8m2xb3XcvNXUCEXuCi0rw==",
          },
        ],
      },
    });
    expect(sqrtRatioFloatSemanticCodec("sqrtRatio")).toEqual({
      path: "sqrtRatio",
      required: true,
      ...EKUBO_SQRT_RATIO_FLOAT_CODEC,
    });
  });

  it("can send a non-ABI byte payload directly to an allowlisted codec", () => {
    expect(
      semanticValueDecodePlan(EKUBO_SQRT_RATIO_FLOAT_CODEC),
    ).toEqual({
      kind: "semantic_value",
      required: true,
      ...EKUBO_SQRT_RATIO_FLOAT_CODEC,
    });
  });
});
