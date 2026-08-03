import {
  type Address,
  getAddress,
  type Hex,
  keccak256,
  numberToHex,
  stringToHex,
} from "viem";
import { assertWalletExecutionPlan } from "./wallet-compatibility.js";

type RevertDecodePlan = Record<string, unknown>;

export interface PreparedTransaction {
  chain_id: string;
  to: Address;
  data: Hex;
  value: string;
  gas?: string;
}

interface ExecutionPlanInput {
  chainId: string;
  sender: Address;
  approvals?: PreparedTransaction[];
  transaction: PreparedTransaction;
  postExecutionTransactions?: PreparedTransaction[];
  atomicBatchRequired?: boolean;
  simulationFailurePolicy?: SimulationFailurePolicy;
  revertDecode?: RevertDecodePlan;
}

export interface SimulationFailurePolicy {
  rpc_error: SimulationFailureDirective;
  execution_reverted: SimulationFailureDirective;
  simulation_setup_error: SimulationFailureDirective;
}

interface SimulationFailureDirective {
  action: "retry_same_plan" | "reprepare_plan" | "user_review";
  instruction: string;
}

export interface ExecutionPlanStepInput {
  kind:
    | "approval"
    | "execution"
    | "allowance_cleanup"
    | "signature_dependent_execution";
  transaction: PreparedTransaction;
  revertDecode?: RevertDecodePlan;
  submitCondition:
    | "if_required_by_current_allowance"
    | "after_prior_required_steps_have_successful_receipts"
    | "after_execution_has_successful_receipt_if_allowance_remains"
    | "after_required_signature_is_supplied";
}

interface ExecutionPlanFromStepsInput {
  chainId: string;
  sender: Address;
  steps: ExecutionPlanStepInput[];
  atomicBatchRequired?: boolean;
  simulationFailurePolicy?: SimulationFailurePolicy;
}

/**
 * Produce one signer-neutral handoff that can be consumed by wallet tooling,
 * including a wallet exposed through MCP. A direct Cast adapter remains an
 * optional fallback when no higher-level wallet abstraction is available.
 * The Ekubo MCP server still never signs or submits any of these requests.
 */
export function executionPlan({
  chainId,
  sender,
  approvals = [],
  transaction,
  postExecutionTransactions = [],
  atomicBatchRequired = false,
  simulationFailurePolicy,
  revertDecode,
}: ExecutionPlanInput) {
  return executionPlanFromSteps({
    chainId,
    sender,
    steps: [
      ...approvals.map((prepared) => ({
        kind: "approval" as const,
        transaction: prepared,
        submitCondition: "if_required_by_current_allowance" as const,
      })),
      {
        kind: "execution" as const,
        transaction,
        ...(revertDecode === undefined ? {} : { revertDecode }),
        submitCondition:
          "after_prior_required_steps_have_successful_receipts" as const,
      },
      ...postExecutionTransactions.map((prepared) => ({
        kind: "allowance_cleanup" as const,
        transaction: prepared,
        submitCondition:
          "after_execution_has_successful_receipt_if_allowance_remains" as const,
      })),
    ],
    atomicBatchRequired,
    simulationFailurePolicy,
  });
}

/**
 * Build a wallet handoff for UI actions that contain more than one top-level
 * transaction. Keeping these steps explicit avoids forcing wallet tooling to
 * infer a batch, invent calldata, or decide the submission order. Actions that
 * mirror an interface `forceAtomic` submission mark the entire plan atomic.
 */
export function executionPlanFromSteps({
  chainId,
  sender,
  steps: inputSteps,
  atomicBatchRequired = false,
  simulationFailurePolicy = defaultSimulationFailurePolicy(),
}: ExecutionPlanFromStepsInput) {
  if (inputSteps.length === 0) {
    throw new Error(
      "internal execution plan error: at least one step is required",
    );
  }
  const normalizedSender = getAddress(sender);
  const steps = inputSteps.map(
    ({ kind, transaction, submitCondition, revertDecode }, index) => {
      const prepared = transaction;
      assertPreparedTransaction(chainId, prepared);
      const stepTransaction = {
        chain_id: chainId,
        from: normalizedSender,
        to: getAddress(prepared.to),
        data: prepared.data,
        value: prepared.value,
        ...(prepared.gas === undefined ? {} : { gas: prepared.gas }),
      };
      return {
        step: index + 1,
        kind,
        submit_condition: submitCondition,
        transaction: stepTransaction,
        ...(revertDecode === undefined
          ? {}
          : { revert_decode: revertDecode }),
      };
    },
  );

  const plan = {
    schema_version: "1",
    chain_id: chainId,
    caip2_chain_id: `eip155:${chainId}`,
    sender: normalizedSender,
    ordered_steps: steps,
    simulation_failure_policy: simulationFailurePolicy,
    execution_policy: {
      atomic_batch_required: atomicBatchRequired,
      ordered_execution_required: true,
      wallet_atomic_batch_allowed: true,
      stop_on_failure: true,
      sequential_adapter_requires_revalidation_and_successful_receipts: true,
      cleanup_must_follow_successful_execution: true,
      agent_confirmation_required: false,
      wallet_must_simulate_before_authorization: true,
      wallet_collects_authorization_on_simulated_result: true,
      ...(atomicBatchRequired
        ? {
            atomic_batch_instruction:
              "Submit every required ordered step as one wallet-level atomic batch. If the wallet cannot guarantee atomic execution, do not submit this plan.",
          }
        : {}),
    },
  };
  assertWalletExecutionPlan(plan);
  return plan;
}

/**
 * Content digest of one prepared step. This is a pure function of the exact
 * bytes that will be broadcast, so the Ekubo server and an unrelated wallet
 * server can compute it independently without sharing any state: there is no
 * registry to look up and no plan identifier to reconcile across the two.
 *
 * The digest is deliberately per-step rather than per-plan. A wallet is free to
 * combine several prepared plans into one atomic batch, which would invalidate
 * any whole-plan identifier, but leaves every individual step digest intact.
 * A combining agent may also drop a later step whose digest exactly equals an
 * earlier one, which safely collapses repeated identical approvals without ever
 * rewriting calldata.
 */
export function stepDigest(transaction: {
  chain_id: string;
  from: string;
  to: string;
  data: string;
  value: string;
}): Hex {
  const canonical = [
    transaction.chain_id,
    getAddress(transaction.from).toLowerCase(),
    getAddress(transaction.to).toLowerCase(),
    transaction.value,
    transaction.data.toLowerCase(),
  ].join("|");
  return keccak256(stringToHex(canonical));
}

/**
 * Integrity block for a prepared plan. Callers place this next to
 * `execution_plan`, never inside it: the wallet boundary schema is strict about
 * step fields, so unknown keys must not travel within the plan itself.
 */
export function executionPlanIntegrity(plan: {
  ordered_steps: readonly {
    step: number;
    transaction: {
      chain_id: string;
      from: string;
      to: string;
      data: string;
      value: string;
    };
  }[];
}) {
  return {
    digest_algorithm:
      'keccak256(utf8("<chain_id>|<from>|<to>|<value>|<0x-data>")) with lowercase hex addresses and data, and decimal chain_id and value',
    steps: plan.ordered_steps.map((step) => ({
      step: step.step,
      step_digest: stepDigest(step.transaction),
    })),
    verification:
      "Recompute each digest from the plan actually delivered to the wallet. A mismatch means the plan was altered in transit and must not be signed. Digests are per-step so they survive a wallet combining several prepared plans into one atomic batch.",
  };
}

function defaultSimulationFailurePolicy(): SimulationFailurePolicy {
  return {
    rpc_error: {
      action: "retry_same_plan",
      instruction:
        "The failure was caused by RPC or local simulation infrastructure. Retry the same plan after the transient service recovers.",
    },
    execution_reverted: {
      action: "reprepare_plan",
      instruction:
        "The exact calldata reverted against current state. Do not retry the same plan; return to the originating Ekubo preparation tool for fresh state and calldata.",
    },
    simulation_setup_error: {
      action: "user_review",
      instruction:
        "The wallet could not establish a trustworthy simulation environment. Check the selected wallet, network, RPC chain, and delegation before continuing.",
    },
  };
}

function assertPreparedTransaction(
  chainId: string,
  transaction: PreparedTransaction,
) {
  if (transaction.chain_id !== chainId) {
    throw new Error(
      `internal execution plan error: transaction chain ${transaction.chain_id} does not match ${chainId}`,
    );
  }
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(transaction.data)) {
    throw new Error(
      "internal execution plan error: transaction data is invalid",
    );
  }
  rpcQuantity(transaction.value, "value");
  if (transaction.gas !== undefined) rpcQuantity(transaction.gas, "gas");
}

function rpcQuantity(value: string, label: string): Hex {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`internal execution plan error: ${label} is not decimal`);
  }
  const parsed = BigInt(value);
  if (parsed >= 1n << 256n) {
    throw new Error(`internal execution plan error: ${label} exceeds uint256`);
  }
  return numberToHex(parsed);
}

export function transactionIdentity(
  transaction: PreparedTransaction,
): PreparedTransaction {
  return {
    chain_id: transaction.chain_id,
    to: getAddress(transaction.to),
    data: transaction.data,
    value: transaction.value,
  };
}
