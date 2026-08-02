import { type Address, getAddress, type Hex, numberToHex } from "viem";

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
}

export interface ExecutionPlanStepInput {
  kind:
    | "approval"
    | "execution"
    | "allowance_cleanup"
    | "signature_dependent_execution";
  transaction: PreparedTransaction;
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
}: ExecutionPlanFromStepsInput) {
  if (inputSteps.length === 0) {
    throw new Error(
      "internal execution plan error: at least one step is required",
    );
  }
  const normalizedSender = getAddress(sender);
  const steps = inputSteps.map(
    ({ kind, transaction, submitCondition }, index) => {
      const prepared = transaction;
      assertPreparedTransaction(chainId, prepared);
      const eip1193Transaction = {
        from: normalizedSender,
        to: getAddress(prepared.to),
        data: prepared.data,
        value: rpcQuantity(prepared.value, "value"),
      };
      return {
        step: index + 1,
        kind,
        submit_condition: submitCondition,
        transaction: {
          chain_id: chainId,
          from: normalizedSender,
          to: getAddress(prepared.to),
          data: prepared.data,
          value: prepared.value,
          ...(prepared.gas === undefined ? {} : { gas: prepared.gas }),
        },
        eip1193: {
          simulate: {
            method: "eth_call",
            params: [eip1193Transaction, "latest"],
          },
          estimate_gas: {
            method: "eth_estimateGas",
            params: [eip1193Transaction],
          },
          submit: {
            method: "eth_sendTransaction",
            params: [eip1193Transaction],
          },
        },
      };
    },
  );

  return {
    schema_version: "1",
    chain_id: chainId,
    caip2_chain_id: `eip155:${chainId}`,
    sender: normalizedSender,
    ordered_steps: steps,
    execution_policy: {
      atomic_batch_required: atomicBatchRequired,
      sequential: true,
      stop_on_failure: true,
      revalidate_and_estimate_immediately_before_each_submission: true,
      wait_for_successful_receipt_before_next_step: true,
      do_not_submit_cleanup_before_execution_success: true,
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
    adapters: {
      mcp_wallet:
        "Preferred when available: pass this complete execution_plan to the separately trusted wallet MCP's simulation and execution APIs after verifying that its connected chain and account exactly match chain_id and sender. Do not ask for a separate agent-level confirmation; the wallet presents the simulated result and collects authorization or signature.",
      cast_fallback:
        "Use only when the user selected Cast or no compatible wallet abstraction is available. For cast call use transaction.data with --data. For cast estimate and cast send pass transaction.data as the positional SIG argument. Always pass --from for preflight and the exact transaction.value with --value; select the signer only at send time.",
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
