/**
 * Mechanism facts every zero-seed owner summary carries. Each is a fixed
 * string keyed by code: launch metadata is attacker-controlled and is never
 * interpolated into them. Draft wording, not approved user-facing copy.
 */
const DISCLOSURES = {
  zero_initial_bid:
    "The pool starts with no bid. Nobody buys the token at creation; the only liquidity is the launch token offered above the ask tick.",
  buyer_funded_quote_reserve:
    "Every quote asset in the pool came from buyers. Selling back can only draw on what earlier buyers paid in.",
  permanent_principal_lock:
    "The installed supply and its liquidity are locked in the pool permanently. Nobody, including the creator, can withdraw, migrate or rebalance that principal.",
  creator_fee_recipient_and_rate:
    "Creator fees accrue to the creator recorded at creation, at the stated rate schedule. Only the creator can claim them, to a recipient it chooses.",
  no_exit_guarantee:
    "Nothing guarantees that anyone can sell, at any price. A trade can fail, fill partially or move the price sharply.",
} as const;

export type DisclosureCode = keyof typeof DISCLOSURES;
export const DISCLOSURE_CODES = Object.keys(DISCLOSURES) as DisclosureCode[];
export const DISCLOSURE_VERSION = 2;
export const DISCLOSURE_STATUS = "draft_not_approved";

export function disclosures() {
  return DISCLOSURE_CODES.map((code) => ({ code, text: DISCLOSURES[code] }));
}

export function disclosuresDocument() {
  return { version: DISCLOSURE_VERSION, status: DISCLOSURE_STATUS, disclosures: disclosures() };
}
