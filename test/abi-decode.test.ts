import { describe, expect, it } from "bun:test";
import { erc20Abi, parseAbi } from "viem";
import {
  functionResultBytesArrayDecodePlan,
  EKUBO_SQRT_RATIO_FLOAT_CODEC,
  functionReadCall,
  functionResultDecodePlan,
  readCallsBundle,
  semanticValueDecodePlan,
  sqrtRatioFloatSemanticCodec,
} from "../src/abi-decode.js";
import { walletBatchEthCallInputSchema } from "../src/wallet-compatibility.js";

describe("local ABI decode plans", () => {
  it("builds an exact wallet_batch_eth_call argument object", () => {
    const abi = parseAbi([
      "function state() view returns (uint256 amount,bytes payload)",
    ]);
    const decode = functionResultDecodePlan(abi, "state");
    const bundle = readCallsBundle({
      chainId: "4663",
      calls: [
        {
          id: "state",
          to: "0x0000000000000000000000000000000000000001",
          data: "0x12345678",
          decode,
        },
      ],
    });

    expect(decode).toEqual({
      kind: "function_result",
      abi,
      function_name: "state",
      required: true,
    });
    expect(bundle).toEqual({
      chain_id: "4663",
      block_parameter: "pending",
      calls: [
        {
          id: "state",
          to: "0x0000000000000000000000000000000000000001",
          data: "0x12345678",
          include_raw: true,
          decode,
        },
      ],
    });
    // The bundle is the exact stored body a wallet executes verbatim, so it
    // must validate against the strict wallet boundary schema.
    expect(walletBatchEthCallInputSchema.safeParse(bundle).success).toBe(true);
  });

  it("accepts 4096 calls and nested results but rejects 4097", () => {
    const abi = parseAbi([
      "function state() view returns (uint256 amount)",
    ]);
    const childDecode = functionResultDecodePlan(abi, "state");
    const nested = functionResultBytesArrayDecodePlan(
      parseAbi([
        "function multicall(bytes[] data) view returns (bytes[] results)",
      ]),
      "multicall",
      Array.from({ length: 4_096 }, (_, index) => ({
        index,
        decode: childDecode,
      })),
      { expectedResultCount: 4_096 },
    );
    const call = {
      to: "0x0000000000000000000000000000000000000001",
      data: "0x12345678",
      include_raw: true,
    };
    expect(nested.results).toHaveLength(4_096);
    const atLimit = {
      chain_id: "4663",
      block_parameter: "pending",
      calls: Array.from({ length: 4_096 }, () => call),
    };
    expect(walletBatchEthCallInputSchema.safeParse(atLimit).success).toBe(true);
    expect(
      walletBatchEthCallInputSchema.safeParse({
        ...atLimit,
        calls: [...atLimit.calls, call],
      }).success,
    ).toBe(false);
    expect(() =>
      functionResultBytesArrayDecodePlan(
        parseAbi([
          "function multicall(bytes[] data) view returns (bytes[] results)",
        ]),
        "multicall",
        [{ index: 4_096, decode: childDecode }],
        { expectedResultCount: 4_097 },
      ),
    ).toThrow();
  });

  it("wraps one function read with its decode plan", () => {
    const abi = [
      {
        type: "function",
        name: "state",
        inputs: [],
        outputs: [{ name: "value", type: "uint256" }],
        stateMutability: "view",
      },
    ] as const;
    const call = functionReadCall({
      id: "state",
      to: "0x0000000000000000000000000000000000000001",
      data: "0x12345678",
      abi,
      functionName: "state",
    });
    expect(call).toEqual({
      id: "state",
      to: "0x0000000000000000000000000000000000000001",
      data: "0x12345678",
      decode: functionResultDecodePlan(abi, "state"),
    });
    expect(() =>
      readCallsBundle({ chainId: "4663", calls: [call] }),
    ).not.toThrow();
  });

  it("rejects Viem event ABIs that Alloy cannot parse", () => {
    expect(() => functionResultDecodePlan(erc20Abi, "balanceOf")).toThrow(
      "wallet-compatible event ABI entries require boolean anonymous",
    );
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
