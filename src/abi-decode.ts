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

export type ReadBlockParameter =
  | "latest"
  | "pending"
  | "safe"
  | "finalized"
  | "earliest"
  | `0x${string}`;

export interface ReadCall {
  id: string;
  to: string;
  data: string;
  decode?: Record<string, unknown>;
}

/**
 * Build the exact `wallet_batch_eth_call` argument object for one or more
 * prepared reads. The result travels under a `read_calls` property, which the
 * registration walker stores server-side and replaces with a
 * `read_calls_reference` envelope: the wallet fetches, digest-verifies, and
 * executes the stored calls itself, so neither the agent nor the wallet ever
 * assembles calldata or ABIs. Validated fail-closed against the wallet
 * boundary schema before it can ship.
 */
export function readCallsBundle(input: {
  chainId: string;
  blockParameter?: ReadBlockParameter;
  from?: string;
  calls: readonly ReadCall[];
}) {
  const bundle = {
    chain_id: input.chainId,
    block_parameter: input.blockParameter ?? "pending",
    ...(input.from === undefined ? {} : { from: input.from }),
    calls: input.calls.map((call) => ({
      id: call.id,
      to: call.to,
      data: call.data,
      include_raw: true,
      ...(call.decode === undefined ? {} : { decode: call.decode }),
    })),
  };
  assertWalletBatchEthCallInput(bundle);
  return bundle;
}

/**
 * One read call whose result decodes as a single ABI function result,
 * mirroring what `localFunctionResultMetadata` used to describe — except the
 * call now ships inside the stored bundle instead of being reassembled by the
 * agent from an rpc_request/decode-plan pair.
 */
export function functionReadCall(input: {
  id: string;
  to: string;
  data: string;
  abi: Abi;
  functionName: string;
  semanticCodecs?: readonly WalletSemanticCodec[];
}): ReadCall {
  return {
    id: input.id,
    to: input.to,
    data: input.data,
    decode: functionResultDecodePlan(
      input.abi,
      input.functionName,
      input.semanticCodecs === undefined
        ? {}
        : { semanticCodecs: input.semanticCodecs },
    ),
  };
}
