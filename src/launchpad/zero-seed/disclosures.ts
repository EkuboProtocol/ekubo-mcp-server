/**
 * Owner-facing launch disclosures, version 7 (draft, not approved copy), worded byte for byte as the Cloud Wallet's
 * zero-seed owner summary renders them, so the statements this server shows and the ones the wallet shows agree.
 * They describe the final launch contract: the zero initial bid, the buyer-funded quote reserve, the permanent
 * principal lock including the supply remainder minted to address(0), the shifted-exponential creator fee that
 * approaches finalFee as a floor with no end date, transferable ownership that carries accrued fees, owner recapture,
 * the high early fee, the exact-output gross-up, no exit guarantee, and the token-wide trust an ERC-20 quote needs.
 * Only integers, addresses, times and percentages derived from calldata, the preview or the deployment are
 * interpolated; launch metadata (name, symbol, logo URL) never is.
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
  "quote_token_trust",
] as const;
export type DisclosureCode = (typeof DISCLOSURE_CODES)[number];
export const DISCLOSURE_VERSION = 7;
export const DISCLOSURE_STATUS = "draft_not_approved";

export interface StatementInput {
  /** Raw launch-token units: the requested supply (totalSupply), the installed part and the remainder at address(0). */
  requestedSupply: string;
  installedSupply: string;
  sinkSupply: string;
  initialFeePercent: string;
  finalFeePercent: string;
  /** Half-life of the excess over the final fee, seconds with 6 decimals, or "none" for decay rate 0. */
  halfLifeSeconds: string;
  /** floor(MAX_DECAY_PRODUCT / rate), or "none" for decay rate 0. */
  saturationElapsedSeconds: string;
  /** ISO-8601 UTC trading start. */
  tradingStart: string;
  /** First elapsed second the excess fee is at most half, or "none" when flat. */
  excessHalvingSeconds: string;
  /** Exact-output input multiplier at the initial fee, two decimals. */
  exactOutputMultiplier: string;
  /** The account calling create (the initial owner), or the current owner when describing an existing launch. */
  owner: string;
  /** "native ETH" or "quote token <lowercase address>". */
  quote: string;
  quoteKind: "native" | "erc20";
}

/** The quote as owner text: native ETH or the exact lowercase token address, never a symbol. */
export function quoteText(quote: { kind: "native" | "erc20"; address: string }): string {
  return quote.kind === "native" ? "native ETH" : `quote token ${quote.address.toLowerCase()}`;
}

const shape = (input: StatementInput) => input.excessHalvingSeconds === "none"
  ? `The fee is flat at ${input.initialFeePercent}.`
  : `The excess over ${input.finalFeePercent} first falls to half or less ${input.excessHalvingSeconds} s after trading start.`;

const decay = (input: StatementInput) => input.halfLifeSeconds === "none"
  ? `Creator fee: ${input.initialFeePercent} from trading start ${input.tradingStart}, constant: the decay rate is 0, so it never decays toward ${input.finalFeePercent}.`
  : `Creator fee: ${input.initialFeePercent} at trading start ${input.tradingStart}. The excess over ${input.finalFeePercent} halves about every ${input.halfLifeSeconds} s, so the fee approaches ${input.finalFeePercent}, a long-run floor and not an end date: it reaches ${input.finalFeePercent} exactly only by rounding, or once more than ${input.saturationElapsedSeconds} s have passed since trading start. ${shape(input)}`;

const remainder = ({ sinkSupply }: StatementInput) => sinkSupply === "0"
  ? "the position takes the whole supply, so nothing is minted to address(0)"
  : `the remainder of ${sinkSupply}, too small to pay for one more unit of liquidity, is minted to address(0), where nobody can ever spend it`;

const quoteTrust = ({ quote, quoteKind }: StatementInput) => quoteKind === "native"
  ? "Quote trust: the quote is native ETH, which Core accounts for itself. No quote token contract is trusted."
  : `Quote trust: ${quote} is trusted across all of Core, not just this pool. Core keeps one balance per token, so if this token misreports balances or transfers, every pool, position and fee ledger holding it is exposed, including other launches and ordinary pools on it, and an honest token paired with it can lose that pool's own reserve. A transfer fee, rebase, blocked transfer or callback breaks every pool on it the same way. Pools that do not hold this token, including native ETH and unrelated tokens, keep their own per-token accounting and are not reachable through it.`;

const TEMPLATES: Record<DisclosureCode, (input: StatementInput) => string> = {
  zero_initial_bid: ({ quote }) =>
    `Zero initial bid: the pool starts with no ${quote}. Until someone buys, selling the launch token fills nothing.`,
  buyer_funded_quote_reserve: ({ quote }) =>
    `Buyer-funded quote reserve: the only ${quote} in the pool is what buyers pay in. Sells can withdraw only that.`,
  permanent_principal_lock: (input) =>
    `Permanent principal lock: of the total supply of ${input.requestedSupply} raw units, ${input.installedSupply} go into one position that nobody, including you, can withdraw, rebalance, migrate or refund, and ${remainder(input)}. Quote that buyers pay in is locked in the position too.`,
  creator_fee_recipient_and_rate: (input) =>
    `${decay(input)} The fee is taken on the calculated side of every swap into a separate two-asset fee ledger, never into principal.`,
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
  quote_token_trust: quoteTrust,
};

/** The ten statements of a create, in code order, exactly as the wallet's owner summary words them. */
export function createStatements(input: StatementInput): { code: DisclosureCode; text: string }[] {
  return DISCLOSURE_CODES.map((code) => ({ code, text: TEMPLATES[code](input) }));
}

/**
 * The same ten statements for an existing launch. Only the ownership statement differs: it names the current owner
 * instead of the creating account; every other statement is the create wording.
 */
export function launchStatements(input: StatementInput): { code: DisclosureCode; text: string }[] {
  return createStatements(input).map((entry) => entry.code !== "transferable_launch_ownership" ? entry : {
    code: entry.code,
    text: `Launch ownership: ${input.owner} is the current launch owner. Only the current owner can claim the fee ledger, and ownership can be transferred. Whoever owns the launch when it claims receives every unclaimed fee, including fees earned before a transfer.`,
  });
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

export const disclosureHeader = () => ({ version: DISCLOSURE_VERSION, status: DISCLOSURE_STATUS });
