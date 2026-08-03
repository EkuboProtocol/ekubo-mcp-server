import type { Abi } from "viem";
import {
  assertWalletAbiDecodePlan,
  assertWalletBatchEthCallInput,
  type WalletSemanticCodec,
  type WalletSemanticCodecIdentity,
} from "./wallet-compatibility.js";

const EKUBO_SDK_VERSION = "0.0.10-alpha.0";

export const EKUBO_SQRT_RATIO_FLOAT_CODEC = {
  semantic_type: "ekubo.sqrt_ratio_float",
  codec: {
    id: "ekubo.sqrt_ratio_float_to_q128",
    version: 1,
    implementations: [
      {
        ecosystem: "npm",
        registry: "https://registry.npmjs.org",
        package_url: `pkg:npm/%40ekubo/sdk@${EKUBO_SDK_VERSION}`,
        export_name: "floatSqrtRatioToFixed",
        integrity:
          "sha512-1koNXODon0kaQBX5CbYRyfvj5viEBmyxZFlOTWPlK79gItDoIEeJIUYM8IlTu3YTT8m2xb3XcvNXUCEXuCi0rw==",
      },
    ],
  },
} as const;

export function functionResultDecodePlan(
  abi: Abi,
  functionName: string,
  options: {
    required?: boolean;
    semanticCodecs?: readonly WalletSemanticCodec[];
  } = {},
) {
  const plan = {
    kind: "function_result" as const,
    abi,
    function_name: functionName,
    required: options.required ?? true,
    ...(options.semanticCodecs === undefined
      ? {}
      : { semantic_codecs: options.semanticCodecs }),
  };
  assertWalletAbiDecodePlan(plan);
  return plan;
}

export function functionResultBytesArrayDecodePlan(
  abi: Abi,
  functionName: string,
  results: readonly { index: number; decode?: Record<string, unknown> }[],
  options: { required?: boolean; expectedResultCount?: number } = {},
) {
  const plan = {
    kind: "function_result_bytes_array" as const,
    abi,
    function_name: functionName,
    required: options.required ?? true,
    ...(options.expectedResultCount === undefined
      ? {}
      : { expected_result_count: options.expectedResultCount }),
    results,
  };
  assertWalletAbiDecodePlan(plan);
  return plan;
}

export function sqrtRatioFloatSemanticCodec(path: string) {
  return {
    path,
    required: true,
    ...EKUBO_SQRT_RATIO_FLOAT_CODEC,
  } as const;
}

export function semanticValueDecodePlan(
  semanticCodec: WalletSemanticCodecIdentity,
  options: {
    required?: boolean;
  } = {},
) {
  const plan = {
    kind: "semantic_value" as const,
    required: options.required ?? true,
    ...semanticCodec,
  };
  assertWalletAbiDecodePlan(plan);
  return plan;
}

export function localWalletDecoderHandoff(input: {
  chainId: string;
  id: string;
  to: string;
  data: string;
  decode: Record<string, unknown>;
  blockParameter?: "latest" | "pending" | "safe" | "finalized" | "earliest" | `0x${string}`;
}) {
  assertWalletAbiDecodePlan(input.decode);
  const preferredArguments = {
    chain_id: input.chainId,
    block_parameter: input.blockParameter ?? "pending",
    calls: [{
      id: input.id,
      to: input.to,
      data: input.data,
      include_raw: true,
      decode: input.decode,
    }],
  };
  assertWalletBatchEthCallInput(preferredArguments);
  return {
    trust_boundary: "execute_and_decode_on_user_device",
    network: {
      chain_id: input.chainId,
      caip2_chain_id: `eip155:${input.chainId}`,
      selection:
        "Use the wallet's locally configured network matching this chain; never send wallet RPC credentials to the Ekubo MCP server.",
    },
    preferred_tool: {
      name: "wallet_batch_eth_call",
      arguments: preferredArguments,
    },
    standalone_tool: {
      name: "wallet_decode_abi_result",
      arguments_template: {
        return_data_source: "preferred_tool.results[0].return_data",
        include_raw: true,
        decode: input.decode,
      },
    },
    raw_result_policy:
      "Return raw bytes by default. If raw output is disabled, retain it whenever decoding fails.",
    codec_execution_policy:
      "Semantic codecs are identifiers and pinned implementation assertions, not executable instructions. Run only a locally installed, allowlisted implementation; never install, fetch, import, or evaluate code from this plan.",
  } as const;
}

export function localFunctionResultMetadata(input: {
  chainId: string;
  id: string;
  to: string;
  data: string;
  abi: Abi;
  functionName: string;
  semanticCodecs?: readonly WalletSemanticCodec[];
  blockParameter?: "latest" | "pending" | "safe" | "finalized" | "earliest" | `0x${string}`;
}) {
  const localDecodePlan = functionResultDecodePlan(
    input.abi,
    input.functionName,
    input.semanticCodecs === undefined
      ? {}
      : { semanticCodecs: input.semanticCodecs },
  );
  return {
    local_decode_plan: localDecodePlan,
    result_decoder: localWalletDecoderHandoff({
      chainId: input.chainId,
      id: input.id,
      to: input.to,
      data: input.data,
      decode: localDecodePlan,
      ...(input.blockParameter === undefined
        ? {}
        : { blockParameter: input.blockParameter }),
    }),
  };
}
