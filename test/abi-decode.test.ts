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
      network: { chain_id: "4663", caip2_chain_id: "eip155:4663" },
      preferred_tool: {
        name: "wallet_batch_eth_call",
        arguments: {
          chain_id: "4663",
          block_parameter: "pending",
          calls: [{ include_raw: true }],
        },
      },
      standalone_tool: {
        name: "wallet_decode_abi_result",
        arguments_template: {
          return_data_source: "preferred_tool.results[0].return_data",
          include_raw: true,
        },
      },
    });
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
