import { type Address, getAddress, type Hex, numberToHex } from "viem";
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
      })),
      {
        kind: "execution" as const,
        transaction,
        ...(revertDecode === undefined ? {} : { revertDecode }),
      },
      ...postExecutionTransactions.map((prepared) => ({
        kind: "allowance_cleanup" as const,
        transaction: prepared,
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
 * mirror an interface `forceAtomic` submission require the `atomic_batch`
 * capability, which the wallet must reject if it cannot honor.
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
  const steps = inputSteps.map(({ kind, transaction, revertDecode }, index) => {
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
      transaction: stepTransaction,
      ...(revertDecode === undefined ? {} : { revert_decode: revertDecode }),
    };
  });

  const plan = {
    schema_version: "1",
    chain_id: chainId,
    caip2_chain_id: `eip155:${chainId}`,
    sender: normalizedSender,
    ordered_steps: steps,
    // A capability names behavior the wallet must implement to execute this
    // plan; a wallet rejects any plan requiring one it does not support.
    ...(atomicBatchRequired
      ? { required_capabilities: ["atomic_batch"] }
      : {}),
    simulation_failure_policy: simulationFailurePolicy,
  };
  assertWalletExecutionPlan(plan);
  return plan;
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
