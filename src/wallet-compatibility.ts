import { getAddress, isAddress } from "viem";
import { z } from "zod";

// Strict producer-side mirror of the public Ekubo wallet MCP boundary. Keep
// this fail-closed: preparation must reject drift before emitting a handoff.

const decimalQuantity = z.string().regex(/^(0|[1-9][0-9]*)$/).refine(
  (value) => BigInt(value) < 1n << 256n,
  "must fit uint256",
);
const positiveChainId = z.string().regex(/^[1-9][0-9]*$/);
const address = z.string().refine(isAddress, "invalid EVM address").transform((value) => getAddress(value));
const hexData = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);
const abiEntry = z.record(z.string(), z.unknown()).superRefine((entry, ctx) => {
  // Alloy's JSON ABI boundary requires this field even when it is false.
  // Viem permits it to be omitted, so reject that incompatible representation
  // before a read bundle can be stored and handed to the wallet.
  if (entry.type === "event" && typeof entry.anonymous !== "boolean") {
    ctx.addIssue({
      code: "custom",
      message: "wallet-compatible event ABI entries require boolean anonymous",
      path: ["anonymous"],
    });
  }
});

const codecImplementationSchema = z.object({
  ecosystem: z.literal("npm"),
  registry: z.string().url().max(256),
  package_url: z.string().min(1).max(256),
  export_name: z.string().min(1).max(128),
  integrity: z.string().min(1).max(256),
}).strict();

const semanticCodecIdentityFields = {
  semantic_type: z.string().min(1).max(128),
  codec: z.object({
    id: z.string().min(1).max(128),
    version: z.number().int().positive(),
    implementations: z.array(codecImplementationSchema).min(1).max(4),
  }).strict(),
};

export interface WalletSemanticCodecIdentity {
  readonly semantic_type: string;
  readonly codec: {
    readonly id: string;
    readonly version: number;
    readonly implementations: readonly {
      readonly ecosystem: "npm";
      readonly registry: string;
      readonly package_url: string;
      readonly export_name: string;
      readonly integrity: string;
    }[];
  };
}
export type WalletSemanticCodec = WalletSemanticCodecIdentity & {
  readonly path: string;
  readonly required?: boolean;
};

const abiParameterSchema: z.ZodType<Record<string, unknown>> = z.lazy(() => z.object({
  name: z.string().max(128).optional(),
  type: z.string().min(1).max(128),
  internalType: z.string().max(256).optional(),
  components: z.array(abiParameterSchema).max(2_048).optional(),
}).strict());

const sharedDecodeFields = { required: z.boolean().default(false) };
const semanticCodecSchema = z.object({
  path: z.string().min(1).max(512),
  ...semanticCodecIdentityFields,
  required: z.boolean().default(true),
}).strict();

export const walletAbiDecodePlanSchema: z.ZodType<Record<string, unknown>> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("function_result"),
    abi: z.array(abiEntry).min(1).max(128),
    function_name: z.string().min(1).max(256),
    semantic_codecs: z.array(semanticCodecSchema).max(32).optional(),
    ...sharedDecodeFields,
  }).strict(),
  z.object({
    kind: z.literal("abi_parameters"),
    parameters: z.array(abiParameterSchema).max(2_048),
    semantic_codecs: z.array(semanticCodecSchema).max(32).optional(),
    ...sharedDecodeFields,
  }).strict(),
  z.object({
    kind: z.literal("error_result"),
    abi: z.array(abiEntry).min(1).max(128),
    ...sharedDecodeFields,
  }).strict(),
  z.object({
    kind: z.literal("semantic_value"),
    ...semanticCodecIdentityFields,
    ...sharedDecodeFields,
  }).strict(),
  z.object({
    kind: z.literal("multicall3"),
    abi: z.array(abiEntry).min(1).max(128),
    function_name: z.string().min(1).max(256),
    expected_result_count: z.number().int().min(0).max(128).optional(),
    results: z.array(z.object({
      index: z.number().int().min(0).max(127),
      required_success: z.boolean().default(false),
      decode: walletAbiDecodePlanSchema.optional(),
    }).strict()).max(128).default([]),
    ...sharedDecodeFields,
  }).strict(),
  z.object({
    kind: z.literal("function_result_bytes_array"),
    abi: z.array(abiEntry).min(1).max(128),
    function_name: z.string().min(1).max(256),
    expected_result_count: z.number().int().min(0).max(128).optional(),
    results: z.array(z.object({
      index: z.number().int().min(0).max(127),
      decode: walletAbiDecodePlanSchema.optional(),
    }).strict()).max(128).default([]),
    ...sharedDecodeFields,
  }).strict(),
]));

const simulationDirectiveSchema = z.object({
  action: z.enum(["retry_same_plan", "reprepare_plan", "user_review"]),
  instruction: z.string().min(1).max(2_000),
}).strict();

const simulationFailurePolicySchema = z.object({
  rpc_error: simulationDirectiveSchema,
  execution_reverted: simulationDirectiveSchema,
  simulation_setup_error: simulationDirectiveSchema,
}).strict().superRefine((policy, ctx) => {
  for (const category of ["execution_reverted", "simulation_setup_error"] as const) {
    if (policy[category].action === "retry_same_plan") {
      ctx.addIssue({
        code: "custom",
        message: `${category} cannot recommend retrying identical calldata`,
        path: [category, "action"],
      });
    }
  }
});

/**
 * Capabilities a plan may require of the wallet that executes it. The wallet
 * rejects any plan listing a capability it does not implement, so this list
 * is the producer-side mirror of the wallet's supported set: emitting an
 * entry not in it would produce plans no deployed wallet accepts.
 */
export const WALLET_SUPPORTED_CAPABILITIES = ["atomic_batch"] as const;

export const walletExecutionPlanSchema = z.object({
  schema_version: z.literal("1"),
  chain_id: decimalQuantity,
  caip2_chain_id: z.string().regex(/^eip155:(0|[1-9][0-9]*)$/),
  sender: address,
  ordered_steps: z.array(z.object({
    step: z.number().int().positive(),
    kind: z.enum(["approval", "execution", "allowance_cleanup", "signature_dependent_execution", "other"]),
    transaction: z.object({
      chain_id: decimalQuantity,
      from: address,
      to: address,
      data: hexData,
      value: decimalQuantity,
      gas: decimalQuantity.optional(),
    }).strict(),
    revert_decode: walletAbiDecodePlanSchema.optional(),
  }).strict()).min(1).max(4_096),
  required_capabilities: z
    .array(z.enum(WALLET_SUPPORTED_CAPABILITIES))
    .max(16)
    .optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
  simulation_failure_policy: simulationFailurePolicySchema.optional(),
}).strict().superRefine((plan, ctx) => {
  if (plan.caip2_chain_id !== `eip155:${plan.chain_id}`) {
    ctx.addIssue({ code: "custom", message: "CAIP-2 chain does not match chain_id", path: ["caip2_chain_id"] });
  }
  for (const [index, step] of plan.ordered_steps.entries()) {
    if (step.step !== index + 1) {
      ctx.addIssue({ code: "custom", message: "steps must be consecutive and one-indexed", path: ["ordered_steps", index, "step"] });
    }
    if (step.transaction.chain_id !== plan.chain_id) {
      ctx.addIssue({ code: "custom", message: "transaction chain does not match plan", path: ["ordered_steps", index, "transaction", "chain_id"] });
    }
    if (step.transaction.from !== plan.sender) {
      ctx.addIssue({ code: "custom", message: "transaction sender does not match plan", path: ["ordered_steps", index, "transaction", "from"] });
    }
  }
});

// Doubles as the exact stored-body contract for read_calls artifacts: a
// read-call bundle is valid only when it is this object and nothing more.
// The wallet's body parser rejects unknown fields too, so fork_id, the
// reference envelope, and any future tool-input field stay tool-call
// decisions on both sides.
export const walletBatchEthCallInputSchema = z.object({
  chain_id: positiveChainId,
  block_parameter: z.union([
    z.enum(["latest", "pending", "safe", "finalized", "earliest"]),
    z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/),
  ]).default("latest"),
  from: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  calls: z.array(z.object({
    id: z.string().min(1).max(128).optional(),
    to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    data: hexData,
    decode: walletAbiDecodePlanSchema.optional(),
    include_raw: z.boolean().default(true),
  }).strict()).min(1).max(128),
}).strict();

export function assertWalletAbiDecodePlan(value: unknown): void {
  walletAbiDecodePlanSchema.parse(value);
}

export function assertWalletExecutionPlan(value: unknown): void {
  walletExecutionPlanSchema.parse(value);
}

export function assertWalletBatchEthCallInput(value: unknown): void {
  walletBatchEthCallInputSchema.parse(value);
}
