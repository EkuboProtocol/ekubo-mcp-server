/**
 * Owner-summary statements, worded as the frozen owner-summary examples in
 * the EKU-1513 API/error/owner schema (SHA-256 ed47d9a4…e095a). The only
 * interpolated values are integers, addresses and percentages the decoder
 * derived from calldata itself; launch metadata is never interpolated.
 */
export const DISCLOSURE_CODES = [
  "zero_initial_bid",
  "buyer_funded_quote_reserve",
  "permanent_principal_lock",
  "creator_fee_recipient_and_rate",
  "no_exit_guarantee",
] as const;
export type DisclosureCode = (typeof DISCLOSURE_CODES)[number];
export const DISCLOSURE_VERSION = 2;
export const DISCLOSURE_STATUS = "draft_not_approved";

export interface CreateStatementInput {
  installedSupply: string;
  initialFeePercent: string;
  finalFeePercent: string;
  feeDuration: string;
  /** ISO-8601 UTC trading start. */
  tradingStart: string;
  creator: string;
}

const TEMPLATES: Record<DisclosureCode, (input: CreateStatementInput) => string> = {
  zero_initial_bid: () =>
    "Zero initial bid: the pool starts with no quote token. Until someone buys, selling the launch token fills nothing.",
  buyer_funded_quote_reserve: () =>
    "Buyer-funded quote reserve: the only quote in the pool is what buyers pay in. Sells can withdraw only that quote.",
  permanent_principal_lock: ({ installedSupply }) =>
    `Permanent principal lock: the whole supply (${installedSupply} raw units) goes into one position that nobody, including you, can withdraw, rebalance, migrate or refund. Quote that buyers pay in is locked in it too.`,
  creator_fee_recipient_and_rate: (input) =>
    `Creator fee: ${input.initialFeePercent} falling linearly to ${input.finalFeePercent} over ${input.feeDuration} s from trading start ${input.tradingStart}, then ${input.finalFeePercent} for good. It goes to a separate fee ledger that only ${input.creator} (this account) can claim and cannot transfer.`,
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
  feeDuration: "<fee duration>", tradingStart: "<trading start>", creator: "<creator>",
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
