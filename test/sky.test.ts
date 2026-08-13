import { describe, expect, it } from "bun:test";
import { decodeFunctionData } from "viem";
import {
  SKY_SAVINGS_ABI,
  SKY_SAVINGS_DEPLOYMENT,
  getSkySavingsDeployment,
  prepareSkySavingsDeposit,
  prepareSkySavingsRedeem,
  prepareSkySavingsWithdraw,
} from "../src/sky.js";
import { planStepKinds, planTargets, planTransactions } from "./plan-helpers.js";

const sender = "0x1111111111111111111111111111111111111111";

describe("Sky savings preparations", () => {
  it("returns a fixed local deployment and direct-read guidance", () => {
    const result = getSkySavingsDeployment();
    expect(result.network_access).toBe("none");
    expect(result.deployment).toEqual(SKY_SAVINGS_DEPLOYMENT);
    expect(result.agent_market_data_discovery.skill_resource).toBe("ekubo://skills/use-sky");
  });

  it("prepares an atomic exact-approval sUSDS deposit", () => {
    const result = prepareSkySavingsDeposit({ chainId: "1", sender, amount: "1000000000000000000" });
    expect(planStepKinds(result)).toEqual(["approval", "execution", "allowance_cleanup"]);
    expect(planTargets(result)).toEqual([
      SKY_SAVINGS_DEPLOYMENT.usds,
      SKY_SAVINGS_DEPLOYMENT.susds,
      SKY_SAVINGS_DEPLOYMENT.usds,
    ]);
    expect(decodeFunctionData({ abi: SKY_SAVINGS_ABI, data: planTransactions(result)[1].data }).functionName).toBe("deposit");
  });

  it("encodes exact-asset withdrawal and exact-share redemption", () => {
    const withdraw = prepareSkySavingsWithdraw({ chainId: "1", sender, amount: "2" });
    const redeem = prepareSkySavingsRedeem({ chainId: "1", sender, shares: "3" });
    expect([withdraw, redeem].map((result) => decodeFunctionData({ abi: SKY_SAVINGS_ABI, data: planTransactions(result)[0].data }).functionName)).toEqual(["withdraw", "redeem"]);
  });

  it("rejects unsupported chains", () => {
    expect(() => prepareSkySavingsDeposit({ chainId: "8453", sender, amount: "1" })).toThrow("only for Ethereum");
  });
});
