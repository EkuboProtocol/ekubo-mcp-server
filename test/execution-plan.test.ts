import { describe, expect, it } from "bun:test";
import {
  executionPlan,
  executionPlanFromSteps,
} from "../src/execution-plan.js";

const sender = "0x2222222222222222222222222222222222222222" as const;
const token = "0x1111111111111111111111111111111111111111" as const;
const router = "0x3333333333333333333333333333333333333333" as const;

describe("portable execution plan", () => {
  it("orders approvals, execution, and cleanup with EIP-1193 requests", () => {
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
    expect(execution.ordered_steps[1].eip1193.submit).toEqual({
      method: "eth_sendTransaction",
      params: [
        {
          from: sender,
          to: router,
          data: "0x1234",
          value: "0xde0b6b3a7640000",
        },
      ],
    });
    expect(execution.ordered_steps[1].eip1193.simulate.params[1]).toBe(
      "latest",
    );
    expect(
      execution.execution_policy.wait_for_successful_receipt_before_next_step,
    ).toBe(true);
    expect(execution.execution_policy.agent_confirmation_required).toBe(false);
    expect(
      execution.execution_policy
        .wallet_collects_authorization_on_simulated_result,
    ).toBe(true);
    expect(execution.adapters.mcp_wallet).toContain("Preferred when available");
    expect(execution.adapters.cast_fallback).toContain("only when");
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
      sequential: true,
      stop_on_failure: true,
    });
  });
});
