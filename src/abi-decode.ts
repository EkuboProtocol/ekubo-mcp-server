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

export function errorResultDecodePlan(abi: Abi) {
  const plan = {
    kind: "error_result" as const,
    abi,
    required: false,
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

/**
 * Describe how to run one prepared read through local wallet tooling.
 *
 * This deliberately does NOT restate the call. Earlier revisions embedded a
 * ready-made `wallet_batch_eth_call` argument object plus a second copy of the
 * decode plan for `wallet_decode_abi_result`, which meant every read shipped
 * its calldata twice and its ABI three times. On a five-position response that
 * redundancy alone was roughly half the payload, and the agent pays for it in
 * context on the way in and again in output tokens on the way out.
 *
 * The caller already emits `rpc_request` and `local_decode_plan`; assembling
 * them into wallet arguments is a mechanical join the agent can do for free.
 */
export function localWalletDecoderHandoff(input: {
  chainId: string;
  id: string;
  to: string;
  data: string;
  decode: Record<string, unknown>;
  blockParameter?: "latest" | "pending" | "safe" | "finalized" | "earliest" | `0x${string}`;
}) {
  assertWalletAbiDecodePlan(input.decode);
  const blockParameter = input.blockParameter ?? "pending";
  // Fail closed: prove the join the agent is asked to perform would validate
  // against the wallet boundary, without shipping the assembled arguments.
  assertWalletBatchEthCallInput({
    chain_id: input.chainId,
    block_parameter: blockParameter,
    calls: [{
      id: input.id,
      to: input.to,
      data: input.data,
      include_raw: true,
      decode: input.decode,
    }],
  });
  return {
    trust_boundary: "execute_and_decode_on_user_device",
    call_id: input.id,
    network: {
      chain_id: input.chainId,
      caip2_chain_id: `eip155:${input.chainId}`,
      selection:
        "Use the wallet's locally configured network matching this chain; never send wallet RPC credentials to the Ekubo MCP server.",
    },
    instruction:
      `Call wallet_batch_eth_call with chain_id, block_parameter ${blockParameter}, and one call built from this read: id=call_id, to and data taken verbatim from rpc_request.params[0], include_raw=true, and decode set to local_decode_plan exactly as supplied. Pass wallet_decode_abi_result the same local_decode_plan when decoding return data that was already fetched.`,
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
