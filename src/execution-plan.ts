import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  numberToHex,
} from "viem";
import {
  decodeApproval,
  nonzeroApprovalSpender,
  requiresAllowanceReset,
} from "./allowance-reset.js";
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
  steps: requestedSteps,
  atomicBatchRequired = false,
  simulationFailurePolicy = defaultSimulationFailurePolicy(),
}: ExecutionPlanFromStepsInput) {
  if (requestedSteps.length === 0) {
    throw new Error(
      "internal execution plan error: at least one step is required",
    );
  }
  const inputSteps = withAllowanceCleanups(
    withAllowanceResets(chainId, requestedSteps),
  );
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

/**
 * Prefix each approval of a reset-requiring token with a zero approval.
 *
 * This server queries no allowance state, so it cannot know whether the sender
 * already has a standing approval — and for these tokens a standing one makes
 * the exact approval revert. The reset is therefore unconditional: it costs one
 * cheap call in the batch when the allowance was already zero, and it is the
 * difference between a working plan and a reverting one when it was not.
 *
 * Applying it here rather than at each preparation site covers every plan this
 * server emits, including the swap plans that reach `executionPlanFromSteps`
 * through `executionPlan`. Callers that hash their own step list before
 * building the plan, as the LP deposit does, will not see the injected step in
 * that hash; the injection is a pure function of the steps they already hashed,
 * so the plan ID still identifies exactly one plan.
 */
function withAllowanceResets(
  chainId: string,
  steps: ExecutionPlanStepInput[],
): ExecutionPlanStepInput[] {
  return steps.flatMap((step) => {
    if (step.kind !== "approval") return [step];
    const spender = nonzeroApprovalSpender(step.transaction.data);
    if (spender === null) return [step];
    if (!requiresAllowanceReset(chainId, step.transaction.to)) return [step];
    return [
      {
        kind: "approval" as const,
        // Built field by field rather than spread from the approval it
        // precedes: a `gas` estimate carried over from that call would be
        // attached to a different one.
        transaction: {
          chain_id: step.transaction.chain_id,
          to: step.transaction.to,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [spender, 0n],
          }),
          value: "0",
        },
      },
      step,
    ];
  });
}

/**
 * End every plan with the allowances it granted returned to zero.
 *
 * `allowance-reset.ts` states this as an invariant -- "every plan this server
 * builds ends by returning the allowance to zero, so within its own flows the
 * second approval never collides" -- and the reset logic depends on it: for a
 * token that refuses to replace a nonzero allowance, a remainder left behind
 * by one tool is what makes the *next* tool's approval revert. Mainnet USDT is
 * the obvious case, but there are 91 of them.
 *
 * Several tools honored it by hand and several did not, so it is applied here
 * instead. A tool that grants an allowance no longer has to remember to clear
 * it, and a new one cannot forget.
 *
 * Only allowances still outstanding at the end are cleared: an approval a tool
 * already zeroed itself is not zeroed twice, and the zero approvals that
 * `withAllowanceResets` prefixes are not mistaken for grants. Approvals that
 * an action is expected to consume exactly are cleared too, because "expected"
 * is not "guaranteed" -- a router that refunds, rounds, or partially fills
 * leaves a remainder that is invisible from here.
 *
 * Tools that clear their own allowances keep doing so, and should: an explicit
 * cleanup can sit immediately after the action that used it, where this one
 * can only append to the end. This is the floor, not the mechanism.
 *
 * As with the reset, callers that hash their own step list before building the
 * plan will not see the appended steps in that hash. The append is a pure
 * function of the steps they already hashed, so the plan ID still identifies
 * exactly one plan.
 */
function withAllowanceCleanups(
  steps: ExecutionPlanStepInput[],
): ExecutionPlanStepInput[] {
  const outstanding = new Map<
    string,
    { chainId: string; token: Address; spender: Address }
  >();
  for (const step of steps) {
    if (step.kind !== "approval" && step.kind !== "allowance_cleanup") continue;
    const approval = decodeApproval(step.transaction.data);
    if (approval === null) continue;
    const token = getAddress(step.transaction.to);
    const spender = getAddress(approval.spender);
    const key = `${token.toLowerCase()}:${spender.toLowerCase()}`;
    if (approval.amount === 0n) {
      outstanding.delete(key);
      continue;
    }
    outstanding.set(key, {
      chainId: step.transaction.chain_id,
      token,
      spender,
    });
  }
  if (outstanding.size === 0) return steps;
  return [
    ...steps,
    ...[...outstanding.values()].map(
      ({ chainId, token, spender }): ExecutionPlanStepInput => ({
        kind: "allowance_cleanup",
        transaction: {
          chain_id: chainId,
          to: token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [spender, 0n],
          }),
          value: "0",
        },
      }),
    ),
  ];
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
