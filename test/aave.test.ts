import { describe, expect, it } from "bun:test";
import { decodeFunctionData } from "viem";
import {
  AAVE_V3_MARKETS,
  AAVE_V3_POOL_ABI,
  getAaveV3Markets,
  prepareAaveV3Borrow,
  prepareAaveV3Collateral,
  prepareAaveV3EMode,
  prepareAaveV3Repay,
  prepareAaveV3Supply,
  prepareAaveV3Withdraw,
} from "../src/aave.js";
import {
  planStepKinds,
  planTargets,
  planTransactions,
} from "./plan-helpers.js";

const sender = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";

describe("Aave V3 fixed-market preparations", () => {
  const ethereum = AAVE_V3_MARKETS.find((market) => market.chain_id === "1")!;
  const usdc = ethereum.reserves.find((reserve) => reserve.symbol === "USDC")!;

  it("discovers a bounded local catalog and points agents at Aave directly", () => {
    const result = getAaveV3Markets();
    expect(result.network_access).toBe("none");
    expect(result.markets).toHaveLength(6);
    expect(result.agent_market_data_discovery).toMatchObject({
      server_involvement: "none",
      graphql_endpoint: "https://api.v3.aave.com/graphql",
    });
    expect(getAaveV3Markets({ chainId: "8453" }).markets).toHaveLength(1);
    expect(getAaveV3Markets({ chainId: "4663" }).markets).toBeEmpty();
  });

  it("prepares supply with an exact approval and cleanup", () => {
    const result = prepareAaveV3Supply({
      chainId: "1",
      sender,
      asset: usdc.underlying,
      amount: "1000000",
      onBehalfOf: recipient,
    });

    expect(planStepKinds(result)).toEqual([
      "approval",
      "execution",
      "allowance_cleanup",
    ]);
    expect(planTargets(result)).toEqual([
      usdc.underlying,
      ethereum.pool,
      usdc.underlying,
    ]);
    const supply = decodeFunctionData({
      abi: AAVE_V3_POOL_ABI,
      data: planTransactions(result)[1].data,
    });
    expect(supply.functionName).toBe("supply");
    expect(supply.args).toEqual([usdc.underlying, 1_000_000n, recipient, 0]);
    expect(result.execution_plan.required_capabilities).toEqual([
      "atomic_batch",
    ]);
  });

  it("encodes direct withdraw, variable borrow, collateral, and eMode calls", () => {
    const withdraw = prepareAaveV3Withdraw({
      chainId: "1",
      sender,
      asset: usdc.underlying,
      amount: ((1n << 256n) - 1n).toString(),
    });
    const borrow = prepareAaveV3Borrow({
      chainId: "1",
      sender,
      asset: usdc.underlying,
      amount: "500000",
    });
    const collateral = prepareAaveV3Collateral({
      chainId: "1",
      sender,
      asset: usdc.underlying,
      useAsCollateral: false,
    });
    const emode = prepareAaveV3EMode({
      chainId: "1",
      sender,
      categoryId: 1,
    });
    const decoded = [withdraw, borrow, collateral, emode].map((result) =>
      decodeFunctionData({
        abi: AAVE_V3_POOL_ABI,
        data: planTransactions(result)[0].data,
      }),
    );

    expect(decoded.map((item) => item.functionName)).toEqual([
      "withdraw",
      "borrow",
      "setUserUseReserveAsCollateral",
      "setUserEMode",
    ]);
    expect(decoded[1].args?.[2]).toBe(2n);
  });

  it("supports underlying repayment cleanup and approval-free aToken repayment", () => {
    const underlying = prepareAaveV3Repay({
      chainId: "1",
      sender,
      asset: usdc.underlying,
      amount: "1000000",
      fundingSource: "underlying",
    });
    const aToken = prepareAaveV3Repay({
      chainId: "1",
      sender,
      asset: usdc.underlying,
      amount: "1000000",
      fundingSource: "a_token",
    });

    expect(planStepKinds(underlying)).toEqual([
      "approval",
      "execution",
      "allowance_cleanup",
    ]);
    expect(planStepKinds(aToken)).toEqual(["execution"]);
    expect(
      decodeFunctionData({
        abi: AAVE_V3_POOL_ABI,
        data: planTransactions(aToken)[0].data,
      }).functionName,
    ).toBe("repayWithATokens");
  });

  it("rejects reserves outside the fixed discovery set", () => {
    expect(() =>
      prepareAaveV3Borrow({
        chainId: "1",
        sender,
        asset: recipient,
        amount: "1",
      }),
    ).toThrow("fixed major-reserve set");
  });
});
