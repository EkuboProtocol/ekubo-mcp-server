import {
  type Address,
  getAddress,
  type Hex,
  numberToHex,
} from "viem";

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
}

/**
 * Produce one signer-neutral handoff that can be consumed by an EIP-1193 wallet
 * (including a wallet exposed through MCP) or translated directly to Cast.
 * The Ekubo MCP server still never signs or submits any of these requests.
 */
export function executionPlan({
  chainId,
  sender,
  approvals = [],
  transaction,
  postExecutionTransactions = [],
}: ExecutionPlanInput) {
  const normalizedSender = getAddress(sender);
  const steps = [
    ...approvals.map((prepared) => ({
      kind: "approval" as const,
      prepared,
      submitCondition: "if_required_by_current_allowance" as const,
    })),
    {
      kind: "execution" as const,
      prepared: transaction,
      submitCondition: "after_prior_required_steps_confirm" as const,
    },
    ...postExecutionTransactions.map((prepared) => ({
      kind: "allowance_cleanup" as const,
      prepared,
      submitCondition:
        "after_execution_confirms_success_if_allowance_remains" as const,
    })),
  ].map(({ kind, prepared, submitCondition }, index) => {
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
  });

  return {
    schema_version: "1",
    chain_id: chainId,
    caip2_chain_id: `eip155:${chainId}`,
    sender: normalizedSender,
    ordered_steps: steps,
    execution_policy: {
      sequential: true,
      stop_on_failure: true,
      revalidate_and_estimate_immediately_before_each_submission: true,
      wait_for_successful_receipt_before_next_step: true,
      do_not_submit_cleanup_before_execution_success: true,
      require_explicit_user_confirmation_before_signing: true,
    },
    adapters: {
      mcp_wallet:
        "Use each ordered step's EIP-1193 request with the separately trusted wallet MCP, after verifying that its connected chain and account exactly match chain_id and sender.",
      local_cast:
        "For cast call use transaction.data with --data. For cast estimate and cast send pass transaction.data as the positional SIG argument. Always pass --from for preflight and the exact transaction.value with --value; select the signer only at send time.",
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
    throw new Error("internal execution plan error: transaction data is invalid");
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
