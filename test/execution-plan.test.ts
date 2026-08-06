import { describe, expect, it } from "bun:test";
import {
  executionPlan,
  executionPlanFromSteps,
} from "../src/execution-plan.js";
import { walletExecutionPlanSchema } from "../src/wallet-compatibility.js";

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
    // byte here costs model output. The plan carries only what the wallet
    // actually consumes: no advisory policy prose, no per-step conditions.
    for (const step of execution.ordered_steps) {
      expect(step).not.toHaveProperty("eip1193");
      expect(step).not.toHaveProperty("submit_condition");
    }
    expect(execution).not.toHaveProperty("adapters");
    expect(execution).not.toHaveProperty("execution_policy");
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
    expect(execution.ordered_steps[1].transaction).toEqual({
      chain_id: "4663",
      from: sender,
      to: router,
      data: "0x1234",
      value: "1000000000000000000",
      gas: "21000",
    });
    expect(execution.required_capabilities).toEqual(["atomic_batch"]);
  });

  it("requires no capability when atomic execution is not required", () => {
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
    expect(execution).not.toHaveProperty("required_capabilities");
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
        { kind: "execution", transaction: first },
        { kind: "execution", transaction: second },
      ],
    });

    expect(result.ordered_steps.map((step) => step.transaction.to)).toEqual([
      token,
      router,
    ]);
    expect(result.ordered_steps.map((step) => step.step)).toEqual([1, 2]);
    expect(result).not.toHaveProperty("required_capabilities");
  });
});
