/**
 * Copy for the launchpad resources and the landing page.
 *
 * ONBOARDING_BLOCK is section A of the CMO's onboarding document on EKU-642
 * (v5), including the expired-reference lines required by security gate A4,
 * with the tool names and steps changed for the contracts 40e5bb1 tool list
 * (EKU-828): reads from the data API, trades through quoter-service, the
 * LaunchRouter creator as fee claimant, and the simulate-then-send wallet
 * flow. The CMO document needs the same change before this ships.
 * DISCLOSURE_TEXT is section 6 of the CLO assessment on EKU-644, verbatim: the
 * three paragraphs of proposed risk copy, without the creator addendum or the
 * drafting note. Edit neither here; change the source document and copy it
 * again, raising DISCLOSURE_VERSION when the disclosure changes.
 */

export const ONBOARDING_PREREQUISITES =
  "Prerequisites: an MCP client with the Ekubo MCP server and a Cloud Wallet connection. Nothing to install beyond that; all value movement is owner-approved in the Cloud Wallet dashboard.";

export const ONBOARDING_BLOCK = "# 1. Discover the Ekubo launchpad integration in your wallet\n# In your agent: call wallet_list_integrations, then connect the Ekubo MCP\n# server in your MCP client per its returned instructions.\n\n# 2. Find a launch \u2014 always resolve to an exact chain + address first\nlaunchpad_list_launches(chain_id=<chain_id>, status=<optional>)\n# (list_tokens/get_token remain for non-launch canonical tokens.)\n# If several launches share a symbol, STOP and ask the user to pick the exact\n# address. Never buy, sell, or launch based on a symbol alone.\n\n# 3. Analyze before acting\n# Ask your agent: \"Show launchpad_get_launch state and provenance (creator as\n# recorded by LaunchRouter, extension code hash against the manifest) and\n# launchpad_get_stats swap counts and volume, with their as_of times.\"\n# NOTE: the creator is the account that signed the launch; it is NOT proof of\n# who is behind the token. Locker counts are contracts, not people.\n\n# 4. Trade preparation (unsigned; wallet simulates + owner approves)\n# For launch tokens: launchpad_prepare_trade (sender and slippage_bps are\n# required on every preparation call; slippage has no default). It routes\n# through quoter-service and the production Ekubo router.\n# Your agent passes the returned execution_plan_reference UNCHANGED to\n# wallet_simulate_execution_plan, then sends that simulation, and you approve\n# in the Cloud Wallet dashboard. Poll wallet_get_execution_status until\n# confirmed.\n# If an execution_plan_reference has expired or is missing, call the same\n# launchpad_prepare_* tool again for a new one. Your agent never builds or\n# edits calldata itself.\n\n# 5. Launching a token (prototype)\n# launchpad_prepare_create(chain_id, sender, <launch config>) returns an unsigned\n# LaunchRouter.create plan. Creation moves no funds. Your agent reads the exact\n# fields from the tool schema: name, symbol, supply, start and end time, fee\n# schedule, price range and migration bounds. The quote asset is native ETH.\n# The signing wallet becomes the creator, the only account that can claim\n# creator fees, with launchpad_prepare_claim_fees.\n# Check progress with launchpad_get_launch. Anyone can move a launch forward\n# with launchpad_prepare_advance, which after the end time completes it and\n# migrates liquidity to a locked pool.\n";

/** Stays until the security review on EKU-661 is in and both PR heads are reported. */
export const DRAFT_CAVEAT =
  "Draft: tool field names and encodings are provisional; creation semantics locked per ruling (whole supply minted to the extension, creator receives no allocation, linear release between start/end time, declining creator fee capped provisionally at 10%→1%, migration to a locked full-range TWAMM pool at `final_fee`, advance callable by anyone after end_time, migration may stay pending outside the configured migration bounds).";

export const STATUS_LINE =
  "Prototype stage: contracts 40e5bb1 on a local fork; the Base manifest is a proposal and nothing is deployed. Not evidence of production readiness. No parity or advantage claims yet.";

export const DISCLOSURE_VERSION = 1;

export const DISCLOSURE_STATUS = "draft_not_approved";

export const DISCLOSURE_TEXT = "Use your authenticated agent to inspect tokens and prepare requests. Identify assets by chain and contract address, not name or symbol. Creator metadata is untrusted. Provenance shows the stated verification method; it is not an endorsement, proof of IP rights or a promise that a token is safe. Analytics are snapshots with method-specific limitations and may include coordinated wallets or manipulated activity.\n\nTokens can lose all value. Liquidity may disappear; creator or contract powers may change supply or transfer behavior as disclosed. You pay the displayed service/protocol/creator fees and network costs; slippage, MEV and failed-transaction costs may apply. No profit, liquidity, token reward or future fee entitlement is promised. This service is not a substitute for your legal or financial advice, and that statement does not waive applicable consumer rights.\n\nInspect the exact plan, privileges, fee recipients and simulated effects. Your agent cannot bypass wallet policy or required owner review. An approval authorizes only its specified action; a submitted transaction is not confirmed. Hosted service restrictions and delisting do not necessarily prevent direct onchain interactions. Read the versioned terms, risk information and privacy notice before granting authority. Do not use the service for impersonation, unlawful content, manipulation or prohibited transactions.";

export function onboardingMarkdown(): string {
  return [
    "# Ekubo launchpad onboarding (prototype)",
    "",
    DRAFT_CAVEAT,
    "",
    ONBOARDING_PREREQUISITES,
    "",
    "```",
    ONBOARDING_BLOCK.trimEnd(),
    "```",
    "",
    STATUS_LINE,
    "",
  ].join("\n");
}

export function disclosuresDocument() {
  return { version: DISCLOSURE_VERSION, status: DISCLOSURE_STATUS, text: DISCLOSURE_TEXT };
}
