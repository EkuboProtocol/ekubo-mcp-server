import { describe, expect, test } from "bun:test";
import { YUL_ROUTER_ADDRESS } from "@ekubo/yul-router-sdk";
import { type Address, decodeFunctionData, erc20Abi, getAddress, type Hex, hexToBigInt, slice, zeroAddress } from "viem";
import { peripheryAbi } from "../../src/launchpad/zero-seed/abi.js";
import { packOne, poolIdOf } from "../../src/launchpad/zero-seed/codec.js";
import lifecycle from "../fixtures/launchpad/local-lifecycle.json";

// Decodes every plan the local lifecycle executed, independently of the producing code: periphery calls with the
// frozen ABI, approvals with the ERC-20 ABI, and the router's packed route header byte by byte.
type Plan = { label: string; tool: string; arguments: Record<string, any>; details: Record<string, any>; steps: { kind: string; to: Address; data: Hex; value: string }[] };
const plans = lifecycle.plans as unknown as Plan[];
const deployment = lifecycle.deployment as Record<string, Address>;

function routeHeader(data: Hex) {
  const flags = Number(hexToBigInt(slice(data, 0, 1)));
  const header = {
    flags,
    multiHops: Number(hexToBigInt(slice(data, 1, 2))) + 1,
    specified: getAddress(slice(data, 2, 22)),
    calculated: getAddress(slice(data, 22, 42)),
    threshold: BigInt.asIntN(128, hexToBigInt(slice(data, 42, 58))),
  };
  let offset = 58;
  const recipient = (flags & 1) === 1 ? getAddress(slice(data, offset, (offset += 20))) : null;
  const deadline = (flags & 2) === 2 ? Number(hexToBigInt(slice(data, offset, offset + 4))) : null;
  return { ...header, recipient, deadline };
}

describe("decoded calldata of the executed local lifecycle", () => {
  test("covers every action", () => {
    expect(plans.map((plan) => plan.tool)).toEqual([
      "launchpad_prepare_create", "launchpad_prepare_create", "launchpad_prepare_trade", "launchpad_prepare_trade", "launchpad_prepare_trade",
      "launchpad_prepare_claim_fees", "launchpad_prepare_transfer_launch", "launchpad_prepare_trade", "launchpad_prepare_claim_fees",
    ]);
  });

  test("create: the exact LaunchParameters tuple and the logo as the second argument", () => {
    for (const plan of plans.filter((entry) => entry.tool === "launchpad_prepare_create")) {
      expect(plan.steps).toHaveLength(1);
      const [step] = plan.steps;
      expect([step.to, step.value]).toEqual([deployment.periphery, "0"]);
      expect(step.data.slice(0, 10)).toBe("0x9a09bd5d");
      const decoded = decodeFunctionData({ abi: peripheryAbi, data: step.data });
      expect(decoded.functionName).toBe("create");
      const [parameters, logo] = decoded.args as unknown as [Record<string, any>, string];
      const args = plan.arguments;
      expect(parameters.name).toBe(packOne(args.name));
      expect(parameters.symbol).toBe(packOne(args.symbol));
      expect(parameters.supply).toBe(BigInt(args.total_supply) * 10n ** 18n);
      expect(getAddress(parameters.quoteToken)).toBe(getAddress(args.quote_token ?? zeroAddress));
      expect(parameters.tradingStart).toBe(BigInt(args.trading_start));
      expect([parameters.initialFee, parameters.finalFee, parameters.decayRateX32]).toEqual([9223372036854775808n, 55340232221128654n, 68913100933n]);
      expect(parameters.salt).toBe(args.salt.toLowerCase());
      if (args.ask_tick !== undefined) expect([parameters.askTick, parameters.upperTick]).toEqual([args.ask_tick, args.upper_tick]);
      expect(logo).toBe(args.logo_url ?? "");
    }
  });

  test("trade: exact input, minimum output, deadline, value and approvals", () => {
    for (const plan of plans.filter((entry) => entry.tool === "launchpad_prepare_trade")) {
      const execution = plan.steps.at(-1)!;
      expect(execution.to).toBe(getAddress(YUL_ROUTER_ADDRESS));
      const header = routeHeader(execution.data);
      const details = plan.details;
      expect(header.multiHops).toBe(1);
      expect([header.specified, header.calculated]).toEqual([details.token_in, details.token_out]);
      expect(header.threshold).toBe(BigInt(details.minimum_amount_out));
      expect(header.threshold).toBe(BigInt(details.expected_amount_out) * 10_000n / (10_000n + BigInt(details.slippage_bps)) || 1n);
      expect(header.deadline).toBe(Number(details.deadline));
      expect(header.recipient).toBeNull();
      expect(execution.value).toBe(details.token_in === zeroAddress ? plan.arguments.amount : "0");
      if (details.token_in === zeroAddress) {
        expect(plan.steps).toHaveLength(1);
      } else {
        const approval = decodeFunctionData({ abi: erc20Abi, data: plan.steps[0].data });
        expect([plan.steps[0].kind, plan.steps[0].to, approval.functionName]).toEqual(["approval", details.token_in, "approve"]);
        expect(approval.args).toEqual([getAddress(YUL_ROUTER_ADDRESS), BigInt(plan.arguments.amount)]);
      }
    }
  });

  test("claim and transfer: owner calls on the periphery", () => {
    for (const plan of plans.filter((entry) => entry.tool === "launchpad_prepare_claim_fees")) {
      const decoded = decodeFunctionData({ abi: peripheryAbi, data: plan.steps[0].data });
      expect(decoded.functionName).toBe("claimFees");
      const [key, recipient] = decoded.args as unknown as [{ token0: Address; token1: Address; config: Hex }, Address];
      expect(poolIdOf(key)).toBe(plan.arguments.pool_id);
      expect(recipient).toBe(getAddress(plan.arguments.sender));
      expect(plan.steps[0].to).toBe(deployment.periphery);
    }
    const transfer = plans.find((entry) => entry.tool === "launchpad_prepare_transfer_launch")!;
    const decoded = decodeFunctionData({ abi: peripheryAbi, data: transfer.steps[0].data });
    expect(decoded.functionName).toBe("transferLaunch");
    expect(decoded.args).toEqual([transfer.arguments.pool_id, getAddress(transfer.arguments.new_owner)]);
  });
});
