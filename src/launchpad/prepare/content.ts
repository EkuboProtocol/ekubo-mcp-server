/**
 * Copy for the launchpad resources and the landing page.
 *
 * ONBOARDING_BLOCK is section A of the CMO's onboarding document on EKU-642
 * (v2, with step 5 from the CTO ruling on EKU-650), plus the expired-reference
 * line required by security gate A4. DISCLOSURE_TEXT is section 6 of the CLO
 * assessment on EKU-644, verbatim: the three paragraphs of proposed risk copy,
 * without the creator addendum or the drafting note. Edit neither here; change
 * the source document and copy it again, raising DISCLOSURE_VERSION when the
 * disclosure changes.
 */

export const ONBOARDING_PREREQUISITES =
  "Prerequisites: an MCP client with the Ekubo MCP server and a Cloud Wallet connection. Nothing to install beyond that; all value movement is owner-approved in the Cloud Wallet dashboard.";

export const ONBOARDING_BLOCK = "# 1. Discover the Ekubo launchpad integration in your wallet\n# In your agent: call wallet_list_integrations, then connect the Ekubo MCP\n# server in your MCP client per its returned instructions.\n\n# 2. Find a launch — always resolve to an exact chain + address first\nlaunchpad_search(chain_id=<chain_id>, ...)\n# (list_tokens/get_token remain for non-launch canonical tokens.)\n# If several launches share a symbol, STOP and ask the user to pick the exact\n# address. Never buy, sell, or launch based on a symbol alone.\n\n# 3. Analyze before acting (provenance + analytics, pinned to a block)\n# Ask your agent: \"Show launchpad_get_analytics holder count, average/median\n# holding, top-10 share with pool/vault/burn addresses excluded; report\n# launchpad_get_provenance transaction sender, payer and fee beneficiary\n# separately; quantify first-N-block early buys — all pinned to a stated\n# block height, with confidence labels.\"\n# NOTE: the fee beneficiary address is NOT proof of who created the token —\n# any payer can name any address.\n\n# 4. Trade preparation (unsigned; wallet simulates + owner approves)\n# For launch tokens: launchpad_prepare_trade (sender and slippage_bps are\n# required on every preparation call; slippage has no default).\n# Your agent passes the returned execution_plan_reference UNCHANGED to\n# wallet_send_execution_plan with a fresh idempotency key, simulates first,\n# then you approve in the Cloud Wallet dashboard. Poll\n# wallet_get_execution_status until confirmed.\n# If an execution_plan_reference has expired or is missing, call the same\n# launchpad_prepare_* tool again for a new one. Your agent never builds or\n# edits calldata itself.\n\n# 5. Launching a token (prototype; fields may change until the contract revision is final)\n# launchpad_prepare_create(chain_id, sender, <launch config>) returns an unsigned plan.\n# Your agent reads the exact fields from the tool schema: name, symbol, supply,\n# quote asset, start and end time, fee schedule, price range, migration bounds,\n# and the fee beneficiary.\n# Pass the returned execution_plan_reference UNCHANGED to wallet_send_execution_plan.\n# The wallet simulates it and you approve it in the Cloud Wallet dashboard.\n# Check progress with launchpad_get_launch. After the end time, anyone can finish the\n# launch with launchpad_prepare_advance, which migrates liquidity to a locked pool.\n# Buy or sell a launch token with launchpad_prepare_trade, not get_quotes_with_plans:\n# the standard router cannot trade a pool that is still in its launch phase.\n";

/** Stays until the security review on EKU-661 is in and both PR heads are reported. */
export const DRAFT_CAVEAT =
  "Draft: tool field names and encodings are provisional; creation semantics locked per ruling (whole supply minted to the extension, creator receives no allocation, linear release between start/end time, declining creator fee capped provisionally at 10%→1%, migration to a locked full-range TWAMM pool at `final_fee`, advance callable by anyone after end_time, migration may stay pending outside creator bounds).";

export const STATUS_LINE =
  "Prototype stage: methodology benchmark published, results pending. No parity or advantage claims yet.";

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
