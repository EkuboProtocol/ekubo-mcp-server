/**
 * Owner-summary statements. Version 5 describes the fixed 600 s half-life decay, the transferable launch ownership
 * recorded by the periphery, the launch's own native or ERC-20 quote, and the requested supply split into the
 * installed supply and the remainder minted to address(0). It is a draft, not approved copy. The only interpolated
 * values are integers, addresses, times and percentages the decoder derived from calldata or the pinned instance;
 * launch metadata is never interpolated.
 */
export const DISCLOSURE_CODES = [
  "zero_initial_bid",
  "buyer_funded_quote_reserve",
  "permanent_principal_lock",
  "creator_fee_recipient_and_rate",
  "transferable_launch_ownership",
  "creator_fee_recapture",
  "high_initial_fee",
  "exact_output_gross_up",
  "no_exit_guarantee",
] as const;
export type DisclosureCode = (typeof DISCLOSURE_CODES)[number];
export const DISCLOSURE_VERSION = 5;
export const DISCLOSURE_STATUS = "draft_not_approved";

export interface CreateStatementInput {
  /** Raw launch-token units: the requested supply (totalSupply), the installed part and the remainder at address(0). */
  requestedSupply: string;
  installedSupply: string;
  sinkSupply: string;
  initialFeePercent: string;
  finalFeePercent: string;
  feeDuration: string;
  /** ISO-8601 UTC trading start. */
  tradingStart: string;
  /** First elapsed second at which the excess over the final fee is at most half, or "none" for a flat fee. */
  excessHalvingSeconds: string;
  /** 2^64 / (2^64 - initial fee), two decimals: the exact-output input multiplier at the initial fee. */
  exactOutputMultiplier: string;
  /** The account calling create: the initial launch owner. */
  owner: string;
  /** "native ETH" or the quote token address. */
  quote: string;
}

const shape = (input: CreateStatementInput) => input.excessHalvingSeconds === "none"
  ? `The fee is flat: initial and final are both ${input.finalFeePercent}.`
  : `It is not linear: the excess over ${input.finalFeePercent} first falls to half or less ${input.excessHalvingSeconds} s after trading start.`;

const TEMPLATES: Record<DisclosureCode, (input: CreateStatementInput) => string> = {
  zero_initial_bid: ({ quote }) =>
    `Zero initial bid: the pool starts with no ${quote}. Until someone buys, selling the launch token fills nothing.`,
  buyer_funded_quote_reserve: ({ quote }) =>
    `Buyer-funded quote reserve: the only ${quote} in the pool is what buyers pay in. Sells can withdraw only that.`,
  permanent_principal_lock: ({ requestedSupply, installedSupply, sinkSupply }) =>
    `Permanent principal lock: of the total supply of ${requestedSupply} raw units, ${installedSupply} go into one position that nobody, including you, can withdraw, rebalance, migrate or refund, and the rounding remainder of ${sinkSupply} is minted to address(0), where nobody can ever spend it. Quote that buyers pay in is locked in the position too.`,
  creator_fee_recipient_and_rate: (input) =>
    `Creator fee: ${input.initialFeePercent} at trading start ${input.tradingStart}, decaying with a fixed 600 s half-life rescaled to reach exactly ${input.finalFeePercent} after ${input.feeDuration} s, then ${input.finalFeePercent} for good. ${shape(input)} The fee is taken on the calculated side of every swap into a separate two-asset fee ledger, never into principal.`,
  transferable_launch_ownership: ({ owner }) =>
    `Launch ownership: ${owner} (this account) becomes the launch owner. Only the current owner can claim the fee ledger, and ownership can be transferred. Whoever owns the launch when it claims receives every unclaimed fee, including fees earned before a transfer.`,
  creator_fee_recapture: (input) =>
    `Owner recapture: every fee goes to the launch owner. When the owner, or anyone buying for it, trades, it gets that fee back through its claim: on an exact-input buy at ${input.initialFeePercent} it can end up with the whole pre-fee output, while anyone else making the same trade gets only the net. The fee cannot tell owners, snipers and honest buyers apart.`,
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
    `Withdraws the whole two-asset fee ledger of this launch to ${recipient}, both assets or neither. It never touches the locked principal.`,
    "Only the current launch owner can claim. Ownership is transferable, so the right to claim follows the current owner, not the account that created the launch.",
  ];
}

export function transferStatements(newOwner: string): string[] {
  return [
    `Makes ${newOwner} the launch owner. From then on only ${newOwner} can claim, including every fee not yet claimed, and only ${newOwner} can transfer the launch again.`,
    "This does not move tokens or principal and cannot be undone by the previous owner.",
  ];
}

const PLACEHOLDERS: CreateStatementInput = {
  requestedSupply: "<requested supply>", installedSupply: "<installed supply>", sinkSupply: "<sink supply>", initialFeePercent: "<initial fee>", finalFeePercent: "<final fee>",
  feeDuration: "<fee duration>", tradingStart: "<trading start>", excessHalvingSeconds: "<excess halving time>",
  exactOutputMultiplier: "<exact-output multiplier>", owner: "<owner>", quote: "<quote>",
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

/** The quote as owner text: native ETH or the exact token address; never a symbol. */
export function quoteText(quote: { kind: "native" | "erc20"; address: string }): string {
  return quote.kind === "native" ? "native ETH" : `quote token ${quote.address}`;
}
