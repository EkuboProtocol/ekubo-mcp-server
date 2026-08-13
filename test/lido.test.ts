import { describe, expect, it } from "bun:test";
import { decodeFunctionData } from "viem";
import {
  LIDO_ABI,
  LIDO_MAINNET_DEPLOYMENT,
  WITHDRAWAL_QUEUE_ABI,
  WSTETH_ABI,
  getLidoDeployment,
  prepareLidoStake,
  prepareLidoWithdrawalClaim,
  prepareLidoWithdrawalRequest,
  prepareLidoWrap,
} from "../src/lido.js";
import { planStepKinds, planTargets, planTransactions } from "./plan-helpers.js";

const sender = "0x1111111111111111111111111111111111111111";

describe("Lido preparations", () => {
  it("returns fixed canonical deployment and queue risk", () => {
    const result = getLidoDeployment();
    expect(result.network_access).toBe("none");
    expect(result.deployment).toEqual(LIDO_MAINNET_DEPLOYMENT);
    expect(result.agent_market_data_discovery.skill_resource).toBe("ekubo://skills/use-lido");
    expect(result.limitations.queue).toContain("asynchronous");
  });

  it("encodes native ETH staking with exact value", () => {
    const result = prepareLidoStake({ chainId: "1", sender, amount: "1000000000000000000" });
    const transaction = planTransactions(result)[0];
    expect(transaction.value).toBe("1000000000000000000");
    expect(decodeFunctionData({ abi: LIDO_ABI, data: transaction.data }).functionName).toBe("submit");
  });

  it("wraps with exact approval and cleanup", () => {
    const result = prepareLidoWrap({ chainId: "1", sender, amount: "1" });
    expect(planStepKinds(result)).toEqual(["approval", "execution", "allowance_cleanup"]);
    expect(planTargets(result)).toEqual([
      LIDO_MAINNET_DEPLOYMENT.steth,
      LIDO_MAINNET_DEPLOYMENT.wsteth,
      LIDO_MAINNET_DEPLOYMENT.steth,
    ]);
    expect(decodeFunctionData({ abi: WSTETH_ABI, data: planTransactions(result)[1].data }).functionName).toBe("wrap");
  });

  it("bounds and encodes asynchronous withdrawal requests", () => {
    const result = prepareLidoWithdrawalRequest({ chainId: "1", sender, amounts: ["100", "1000000000000000000000"] });
    expect(planStepKinds(result)).toEqual(["approval", "execution", "allowance_cleanup"]);
    expect(decodeFunctionData({ abi: WITHDRAWAL_QUEUE_ABI, data: planTransactions(result)[1].data }).functionName).toBe("requestWithdrawals");
    expect(result.details).toMatchObject({ asynchronous: true, irreversible_request: true });
    expect(() => prepareLidoWithdrawalRequest({ chainId: "1", sender, amounts: ["99"] })).toThrow("between 100 wei and 1000 stETH");
  });

  it("claims one finalized request through the no-hint method", () => {
    const result = prepareLidoWithdrawalClaim({ chainId: "1", sender, requestId: "7" });
    const decoded = decodeFunctionData({ abi: WITHDRAWAL_QUEUE_ABI, data: planTransactions(result)[0].data });
    expect(decoded.functionName).toBe("claimWithdrawal");
    expect(decoded.args).toEqual([7n]);
  });
});
