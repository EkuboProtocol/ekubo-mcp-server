/**
 * Owner-summary statements for the draft exponential creator-fee decay. Version 3 replaces the linear-decay
 * wording of version 2 and is a draft, not approved copy. The only interpolated values are integers,
 * addresses, times and percentages the decoder derived from calldata itself; launch metadata is never
 * interpolated.
 */
export const DISCLOSURE_CODES = [
  "zero_initial_bid",
  "buyer_funded_quote_reserve",
  "permanent_principal_lock",
  "creator_fee_recipient_and_rate",
  "creator_fee_recapture",
  "high_initial_fee",
  "exact_output_gross_up",
  "no_exit_guarantee",
] as const;
export type DisclosureCode = (typeof DISCLOSURE_CODES)[number];
export const DISCLOSURE_VERSION = 3;
export const DISCLOSURE_STATUS = "draft_not_approved";

export interface CreateStatementInput {
  installedSupply: string;
  initialFeePercent: string;
  finalFeePercent: string;
  feeDuration: string;
  /** ISO-8601 UTC trading start. */
  tradingStart: string;
  /** The literal encoded Q0.64 factor, decimal. */
  decayFactor: string;
  /** First elapsed second at which the excess over the final fee is at most half, or "none" for a flat fee. */
  excessHalvingSeconds: string;
  /** 2^64 / (2^64 - initial fee), two decimals: the exact-output input multiplier at the initial fee. */
  exactOutputMultiplier: string;
  creator: string;
}

const shape = (input: CreateStatementInput) => input.excessHalvingSeconds === "none"
  ? `The fee is flat: initial and final are both ${input.finalFeePercent}.`
  : `It is not linear and ${input.decayFactor} is not a half-life: the excess over ${input.finalFeePercent} first falls to half or less ${input.excessHalvingSeconds} s after trading start.`;

const TEMPLATES: Record<DisclosureCode, (input: CreateStatementInput) => string> = {
  zero_initial_bid: () =>
    "Zero initial bid: the pool starts with no quote token. Until someone buys, selling the launch token fills nothing.",
  buyer_funded_quote_reserve: () =>
    "Buyer-funded quote reserve: the only quote in the pool is what buyers pay in. Sells can withdraw only that quote.",
  permanent_principal_lock: ({ installedSupply }) =>
    `Permanent principal lock: the whole supply (${installedSupply} raw units) goes into one position that nobody, including you, can withdraw, rebalance, migrate or refund. Quote that buyers pay in is locked in it too.`,
  creator_fee_recipient_and_rate: (input) =>
    `Creator fee: ${input.initialFeePercent} at trading start ${input.tradingStart}, decaying along an exponential rescaled to reach exactly ${input.finalFeePercent} after ${input.feeDuration} s, then ${input.finalFeePercent} for good. The curve is set by the literal per-second factor ${input.decayFactor} / 2^64. ${shape(input)} The fee is taken on the calculated side of every swap and goes to a separate fee ledger that only ${input.creator} (this account) can claim and cannot transfer.`,
  creator_fee_recapture: (input) =>
    `Creator recapture: every fee goes to ${input.creator}. When the creator, or anyone buying for it, trades, it gets that fee back through its claim: on an exact-input buy at ${input.initialFeePercent} it can end up with the whole pre-fee output, while anyone else making the same trade gets only the net. The fee cannot tell creators, snipers and honest buyers apart.`,
  high_initial_fee: (input) =>
    `High early fee: near ${input.initialFeePercent}, a swap can deliver a negligible or zero amount after the fee, and an immediate round trip pays the fee twice plus price impact. A high starting fee is not protection against snipers and does not promise that anyone avoids a loss.`,
  exact_output_gross_up: (input) =>
    `Exact-output gross-up: for a fixed output, the input paid is the pre-fee input times 1 / (1 - fee), about ${input.exactOutputMultiplier}x at ${input.initialFeePercent}, which grows much faster than the fee itself. Large amounts at high fees revert on overflow. Always set a minimum output or a maximum input.`,
  no_exit_guarantee: () =>
    "No exit guarantee: there is no buyer of last resort, no refund and no admin rescue. The price can fall back to the ask.",
};

export function createStatements(input: CreateStatementInput): string[] {
  return DISCLOSURE_CODES.map((code) => TEMPLATES[code](input));
}

export function claimStatements(recipient: string): string[] {
  return [
    `Withdraws the whole two-asset creator fee ledger of this launch to ${recipient}. It never touches the locked principal.`,
    "Only the creator account can claim; the fee right cannot be transferred.",
  ];
}

const PLACEHOLDERS: CreateStatementInput = {
  installedSupply: "<installed supply>", initialFeePercent: "<initial fee>", finalFeePercent: "<final fee>",
  feeDuration: "<fee duration>", tradingStart: "<trading start>", decayFactor: "<decay factor>",
  excessHalvingSeconds: "<excess halving time>", exactOutputMultiplier: "<exact-output multiplier>", creator: "<creator>",
};

export function disclosuresDocument() {
  return {
    version: DISCLOSURE_VERSION,
    status: DISCLOSURE_STATUS,
    disclosures: DISCLOSURE_CODES.map((code) => ({
      code,
      template: TEMPLATES[code](PLACEHOLDERS),
    })),
  };
}
