import type { Address } from "viem";
import { feePercent } from "./encoding.js";

/**
 * The `fees` list every preparation output carries (legal gate L2): each fee,
 * its rate and its recipient. Entries are fixed templates; only the rates and
 * addresses vary, and those come from validated input or chain reads.
 */

const rate = (q64: bigint) => ({ q64: q64.toString(), percent: feePercent(q64) });

const NO_PROTOCOL_FEE = { fee: "protocol_fee", rate: "none", recipient: null };
const NO_HOSTED_FEE = { fee: "hosted_service_fee", rate: "none", recipient: null };

function terminalPoolFee(finalFee: bigint, lockedLiquidity: Address, beneficiary: Address) {
  return {
    fee: "terminal_pool_fee",
    rate: rate(finalFee),
    applies_to: "swaps in the terminal pool after migration",
    recipient: {
      role: "liquidity_providers",
      locked_position: lockedLiquidity,
      locked_position_fees_claimable_by: beneficiary,
      note: "Fees accrue to every liquidity provider in the terminal pool in proportion to liquidity; the locked launch position is one of them.",
    },
  };
}

export function creationFees(input: {
  initialFee: bigint;
  finalFee: bigint;
  beneficiary: Address;
  lockedLiquidity: Address;
}) {
  return [
    {
      fee: "creator_fee",
      rate: { initial: rate(input.initialFee), final: rate(input.finalFee), schedule: "declines linearly from start_time to end_time" },
      applies_to: "launch-phase swaps, on the calculated side",
      recipient: { role: "beneficiary", address: input.beneficiary },
    },
    terminalPoolFee(input.finalFee, input.lockedLiquidity, input.beneficiary),
    NO_PROTOCOL_FEE,
    NO_HOSTED_FEE,
  ];
}

export function launchTradeFees(input: { feeAtBlock: bigint; beneficiary: Address }) {
  return [
    {
      fee: "creator_fee",
      rate: rate(input.feeAtBlock),
      applies_to: "this swap, at the quoted block; included in the quoted amounts",
      recipient: { role: "beneficiary", address: input.beneficiary },
    },
    NO_PROTOCOL_FEE,
    NO_HOSTED_FEE,
  ];
}

export function terminalTradeFees(input: { poolFee: bigint; lockedLiquidity: Address; beneficiary: Address }) {
  return [
    { ...terminalPoolFee(input.poolFee, input.lockedLiquidity, input.beneficiary), applies_to: "this swap; included in the quoted amounts" },
    NO_PROTOCOL_FEE,
    NO_HOSTED_FEE,
  ];
}

export function advanceFees() {
  return [
    { fee: "creator_fee", rate: "not_charged_by_this_call", recipient: null },
    NO_PROTOCOL_FEE,
    NO_HOSTED_FEE,
  ];
}
