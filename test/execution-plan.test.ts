import { describe, expect, it } from "bun:test";
import { encodeFunctionData, erc20Abi } from "viem";
import {
  executionPlan,
  executionPlanFromSteps,
} from "../src/execution-plan.js";
import { walletExecutionPlanSchema } from "../src/wallet-compatibility.js";

const sender = "0x2222222222222222222222222222222222222222" as const;
const token = "0x1111111111111111111111111111111111111111" as const;
const router = "0x3333333333333333333333333333333333333333" as const;
const LDO = "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32" as const;
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as const;
const CRV = "0xD533a949740bb3306d119CC777fa900bA034cd52" as const;
// Bridged USDT is a separate contract on every chain and none carry the guard.
const ARBITRUM_USDT = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" as const;
const OPTIMISM_USDT = "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58" as const;

function approvalCalldata(amount: bigint) {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [router, amount],
  });
}

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

describe("allowance resets for tokens that reject an overwrite", () => {
  function planApproving(chainId: string, approved: `0x${string}`) {
    return executionPlan({
      chainId,
      sender,
      approvals: [
        {
          chain_id: chainId,
          to: approved,
          data: approvalCalldata(1_000n),
          value: "0",
          gas: "60000",
        },
      ],
      transaction: { chain_id: chainId, to: router, data: "0x1234", value: "0" },
      postExecutionTransactions: [
        {
          chain_id: chainId,
          to: approved,
          data: approvalCalldata(0n),
          value: "0",
        },
      ],
      atomicBatchRequired: true,
    });
  }

  // The user hitting this has a standing allowance granted somewhere else —
  // the interface approves the Positions contract for an unlimited amount —
  // and LDO, an Aragon MiniMe token, reverts rather than overwriting it.
  it("zeroes an LDO allowance before approving an exact amount", () => {
    const steps = planApproving("1", LDO).ordered_steps;
    expect(steps.map((step) => step.kind)).toEqual([
      "approval",
      "approval",
      "execution",
      "allowance_cleanup",
    ]);
    expect(steps[0].transaction.to).toBe(LDO);
    expect(steps[0].transaction.data).toBe(approvalCalldata(0n));
    expect(steps[1].transaction.data).toBe(approvalCalldata(1_000n));
    expect(steps.map((step) => step.step)).toEqual([1, 2, 3, 4]);
  });

  it("zeroes a mainnet USDT allowance too", () => {
    const steps = planApproving("1", USDT).ordered_steps;
    expect(steps.map((step) => step.transaction.data)).toEqual([
      approvalCalldata(0n),
      approvalCalldata(1_000n),
      "0x1234",
      approvalCalldata(0n),
    ]);
  });

  // A gas figure prepared for the approval describes that call, not the reset
  // that now precedes it.
  it("does not carry the approval's gas estimate onto the reset", () => {
    const steps = planApproving("1", LDO).ordered_steps;
    expect(steps[0].transaction).not.toHaveProperty("gas");
    expect(steps[1].transaction.gas).toBe("60000");
  });

  it("leaves ordinary tokens with a single approval", () => {
    expect(planApproving("1", token).ordered_steps.map((step) => step.kind)).toEqual([
      "approval",
      "execution",
      "allowance_cleanup",
    ]);
  });

  // Only the mainnet deployments carry the guard; the bridged ones are
  // ordinary ERC-20s and must not pay for a step they do not need.
  it("leaves the same address on another chain alone", () => {
    expect(planApproving("4663", LDO).ordered_steps).toHaveLength(3);
  });

  // Found by probing the chain rather than by report: Curve's Vyper ERC20
  // asserts the same condition mainnet USDT and LDO do.
  it("zeroes a CRV allowance", () => {
    expect(
      planApproving("1", CRV).ordered_steps.map((step) => step.kind),
    ).toEqual(["approval", "approval", "execution", "allowance_cleanup"]);
  });

  it("leaves every bridged USDT with a single approval", () => {
    expect(planApproving("42161", ARBITRUM_USDT).ordered_steps).toHaveLength(3);
    expect(planApproving("10", OPTIMISM_USDT).ordered_steps).toHaveLength(3);
  });

  // FUN carries the guard but reverts on approve(0) as well, so prefixing a
  // reset would only add a step that fails.
  it("omits the tokens no reset can recover", () => {
    const fun = "0x419d0d8bDD9aF5e606Ae2232ed285Aff190E711b" as const;
    expect(planApproving("1", fun).ordered_steps).toHaveLength(3);
  });

  it("does not prefix a revocation with another zero approval", () => {
    const result = executionPlanFromSteps({
      chainId: "1",
      sender,
      steps: [
        {
          kind: "approval",
          transaction: {
            chain_id: "1",
            to: LDO,
            data: approvalCalldata(0n),
            value: "0",
          },
        },
      ],
    });
    expect(result.ordered_steps).toHaveLength(1);
  });

  it("stays valid at the wallet boundary with the reset injected", () => {
    expect(() =>
      walletExecutionPlanSchema.parse(planApproving("1", LDO)),
    ).not.toThrow();
  });

  /**
   * A step's kind is a label the producing tool chose; the calldata is what the
   * chain sees. A tool that emits an approval as an execution step must not
   * silently lose its reset and ship a plan that reverts for these tokens only.
   */
  it("resets a mislabeled approval, because the calldata is the trigger", () => {
    const result = executionPlanFromSteps({
      chainId: "1",
      sender,
      steps: [
        {
          kind: "execution",
          transaction: {
            chain_id: "1",
            to: USDT,
            data: approvalCalldata(1_000n),
            value: "0",
          },
        },
      ],
    });
    expect(result.ordered_steps.map((step) => step.transaction.data)).toEqual([
      approvalCalldata(0n),
      approvalCalldata(1_000n),
    ]);
  });

  /**
   * The swap path builds its own zero approval when a provider reports a
   * standing allowance. Adding a second one on top would just be a wasted call.
   */
  it("adds no second reset when the caller already zeroed the allowance", () => {
    const result = executionPlanFromSteps({
      chainId: "1",
      sender,
      steps: [
        {
          kind: "approval",
          transaction: {
            chain_id: "1",
            to: USDT,
            data: approvalCalldata(0n),
            value: "0",
          },
        },
        {
          kind: "approval",
          transaction: {
            chain_id: "1",
            to: USDT,
            data: approvalCalldata(1_000n),
            value: "0",
          },
        },
      ],
    });
    expect(result.ordered_steps.map((step) => step.transaction.data)).toEqual([
      approvalCalldata(0n),
      approvalCalldata(1_000n),
    ]);
  });

  /**
   * The dedup is deliberately narrow: only a zero approval standing
   * *immediately* before counts. A zero approval for a different spender leaves
   * the one this approval needs untouched.
   */
  it("still resets when the preceding zero approval is for another spender", () => {
    const otherSpender = "0x5555555555555555555555555555555555555555" as const;
    const zeroForOther = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [otherSpender, 0n],
    });
    const result = executionPlanFromSteps({
      chainId: "1",
      sender,
      steps: [
        {
          kind: "approval",
          transaction: {
            chain_id: "1",
            to: USDT,
            data: zeroForOther,
            value: "0",
          },
        },
        {
          kind: "approval",
          transaction: {
            chain_id: "1",
            to: USDT,
            data: approvalCalldata(1_000n),
            value: "0",
          },
        },
      ],
    });
    expect(result.ordered_steps.map((step) => step.transaction.data)).toEqual([
      zeroForOther,
      approvalCalldata(0n),
      approvalCalldata(1_000n),
    ]);
  });
});
