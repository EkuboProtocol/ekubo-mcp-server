import { describe, expect, it } from "bun:test";
import {
  executionPlan,
  executionPlanFromSteps,
  executionPlanIntegrity,
  stepDigest,
} from "../src/execution-plan.js";
import { walletExecutionPlanSchema } from "../src/wallet-compatibility.js";
import { getAddress } from "viem";

const sender = "0x2222222222222222222222222222222222222222" as const;
const token = "0x1111111111111111111111111111111111111111" as const;
const router = "0x3333333333333333333333333333333333333333" as const;

describe("portable execution plan", () => {
  it("carries no field derivable from transaction", () => {
    const execution = executionPlan({
      chainId: "4663",
      sender,
      transaction: {
        chain_id: "4663",
        to: router,
        data: "0x1234",
        value: "0",
      },
    });
    // The agent is the transport between two unrelated MCP servers, so every
    // byte here costs model output. eip1193 was three copies of transaction
    // per step and adapters duplicated the top-level wallet_handoff prose.
    for (const step of execution.ordered_steps) {
      expect(step).not.toHaveProperty("eip1193");
    }
    expect(execution).not.toHaveProperty("adapters");
  });

  it("stays valid against the wallet boundary schema without the removed fields", () => {
    const execution = executionPlan({
      chainId: "4663",
      sender,
      approvals: [
        { chain_id: "4663", to: token, data: "0x095ea7b3", value: "0" },
      ],
      transaction: {
        chain_id: "4663",
        to: router,
        data: "0x1234",
        value: "0",
      },
    });
    expect(() => walletExecutionPlanSchema.parse(execution)).not.toThrow();
  });

  it("digests each step so they survive a wallet combining plans", () => {
    const first = executionPlan({
      chainId: "4663",
      sender,
      transaction: {
        chain_id: "4663",
        to: router,
        data: "0xaaaa",
        value: "0",
      },
    });
    const second = executionPlan({
      chainId: "4663",
      sender,
      transaction: {
        chain_id: "4663",
        to: router,
        data: "0xbbbb",
        value: "0",
      },
    });
    const before = [
      ...executionPlanIntegrity(first).steps,
      ...executionPlanIntegrity(second).steps,
    ].map((entry) => entry.step_digest);

    // A combining wallet concatenates the steps and renumbers them. Per-step
    // digests must be unaffected by that renumbering, which is exactly why a
    // whole-plan identifier cannot work across two unrelated servers.
    const combined = executionPlanFromSteps({
      chainId: "4663",
      sender,
      steps: [...first.ordered_steps, ...second.ordered_steps].map((step) => ({
        kind: "execution" as const,
        transaction: step.transaction,
        submitCondition:
          "after_prior_required_steps_have_successful_receipts" as const,
      })),
    });
    expect(combined.ordered_steps.map((step) => step.step)).toEqual([1, 2]);
    expect(
      executionPlanIntegrity(combined).steps.map((entry) => entry.step_digest),
    ).toEqual(before);
  });

  it("gives identical approvals an identical digest so duplicates collapse", () => {
    const approval = {
      chain_id: "4663",
      from: sender,
      to: token,
      data: "0x095ea7b3",
      value: "0",
    };
    const mixedCase = "0xaBcDeFabcdefABCDEFabcdefabcdefABCDEFabcd";
    expect(stepDigest({ ...approval, to: getAddress(mixedCase) })).toBe(
      stepDigest({ ...approval, to: mixedCase.toLowerCase() }),
    );
    expect(stepDigest(approval)).not.toBe(
      stepDigest({ ...approval, data: "0x095ea7b4" }),
    );
  });

  it("orders approvals, execution, and cleanup", () => {
    const execution = executionPlan({
      chainId: "4663",
      sender,
      approvals: [
        {
          chain_id: "4663",
          to: token,
          data: "0x095ea7b3",
          value: "0",
        },
      ],
      transaction: {
        chain_id: "4663",
        to: router,
        data: "0x1234",
        value: "1000000000000000000",
        gas: "21000",
      },
      postExecutionTransactions: [
        {
          chain_id: "4663",
          to: token,
          data: "0x095ea7b3",
          value: "0",
        },
      ],
      atomicBatchRequired: true,
    });

    expect(execution.caip2_chain_id).toBe("eip155:4663");
    expect(execution.ordered_steps.map((step) => step.kind)).toEqual([
      "approval",
      "execution",
      "allowance_cleanup",
    ]);
    expect(
      execution.ordered_steps.map((step) => step.submit_condition),
    ).toEqual([
      "if_required_by_current_allowance",
      "after_prior_required_steps_have_successful_receipts",
      "after_execution_has_successful_receipt_if_allowance_remains",
    ]);
    expect(execution.ordered_steps[1].transaction).toEqual({
      chain_id: "4663",
      from: sender,
      to: router,
      data: "0x1234",
      value: "1000000000000000000",
      gas: "21000",
    });
    expect(
      execution.execution_policy
        .sequential_adapter_requires_revalidation_and_successful_receipts,
    ).toBe(true);
    expect(execution.execution_policy.agent_confirmation_required).toBe(false);
    expect(
      execution.execution_policy
        .wallet_collects_authorization_on_simulated_result,
    ).toBe(true);
    expect(execution.execution_policy.atomic_batch_required).toBe(true);
    expect(execution.execution_policy.atomic_batch_instruction).toContain(
      "one wallet-level atomic batch",
    );
  });

  it("rejects a transaction for a different chain", () => {
    expect(() =>
      executionPlan({
        chainId: "1",
        sender,
        transaction: {
          chain_id: "4663",
          to: router,
          data: "0x",
          value: "0",
        },
      }),
    ).toThrow("does not match");
  });

  it("rejects transaction quantities that do not fit EVM uint256", () => {
    expect(() =>
      executionPlan({
        chainId: "1",
        sender,
        transaction: {
          chain_id: "1",
          to: router,
          data: "0x",
          value: (1n << 256n).toString(),
        },
      }),
    ).toThrow("exceeds uint256");
  });

  it("preserves multiple top-level UI transactions without wallet inference", () => {
    const first = {
      chain_id: "1",
      to: token,
      data: "0x095ea7b3" as const,
      value: "0",
    };
    const second = { ...first, to: router };
    const result = executionPlanFromSteps({
      chainId: "1",
      sender,
      steps: [
        {
          kind: "execution",
          transaction: first,
          submitCondition:
            "after_prior_required_steps_have_successful_receipts",
        },
        {
          kind: "execution",
          transaction: second,
          submitCondition:
            "after_prior_required_steps_have_successful_receipts",
        },
      ],
    });

    expect(result.ordered_steps.map((step) => step.transaction.to)).toEqual([
      token,
      router,
    ]);
    expect(result.execution_policy).toMatchObject({
      atomic_batch_required: false,
      ordered_execution_required: true,
      wallet_atomic_batch_allowed: true,
      stop_on_failure: true,
    });
  });
});
