import policy from "./jurisdiction-policy.json";

/**
 * Jurisdiction metadata for tradable assets, policy
 * `ekubo-token-jurisdictions-v2` (CLO decision EKU-853).
 *
 * Board direction (EKU-862, EKU-873, 2026-10-06): this server only informs.
 * It never refuses a request on jurisdiction grounds, never reads the
 * connection's country, and says nothing about the user. The agent verifies
 * the user's jurisdiction, asking the user when it is not already known, and
 * does not proceed for a user in a listed jurisdiction.
 *
 * The policy data lives in `jurisdiction-policy.json`, generated in
 * EkuboProtocol/default-tokens (`scripts/jurisdiction-policy.ts`) and vendored
 * byte-for-byte here and into the Ekubo interface; all three pin its SHA-256
 * in a test.
 *
 * Country codes are ISO 3166-1 alpha-2: https://www.iso.org/obp/ui/#search
 */



/** One asset a caller asked this server to build a transaction around. */
export interface RestrictableAsset {
  chainId: string | bigint;
  token: string | bigint | undefined;
  side: AssetSide;
}

/**
 * Which way an asset moves in the transaction being prepared.
 *
 * `sell` means the caller gives the asset up: the swap input, the TWAMM or
 * auction sell token, a claimed fee balance being swapped away. `buy` means the
 * caller ends up holding it. Anything that is neither — a pool pair being
 * rebalanced, a token whose oracle capacity is being extended — is `buy`.
 * Policy v2 lists the same jurisdictions for both sides; the side is reported
 * so the agent can see which way each asset moves.
 */
export type AssetSide = "sell" | "buy";

export const JURISDICTION_POLICY_VERSION = policy.policy_version;

/**
 * SHA-256 of `jurisdiction-policy.json`, reported in metadata so a consumer
 * can tell exactly which policy produced it. A test recomputes it from the
 * file.
 */
export const JURISDICTION_POLICY_DIGEST =
  "2897e242c7030f9d0c5b99a548bb62bfefc91f4b665785814bbeca8a41eb776a";

export type AssetClassification =
  | "rhj_stock_token"
  | "non_class"
  | "unknown"
  | "out_of_scope";

export interface Provenance {
  source: string;
  ref: string;
  observed_at: string;
}

interface ChainPolicy {
  readonly rhjStockTokens: ReadonlyMap<bigint, readonly Provenance[]>;
  readonly nonClass: ReadonlyMap<bigint, readonly Provenance[]>;
}

const OFFERING_EXCLUSIONS: readonly string[] = [
  ...policy.classes.rhj_stock_token.offering_exclusions,
].sort();
const ISSUER_PROHIBITED_INVESTOR: readonly string[] = [
  ...policy.classes.rhj_stock_token.issuer_prohibited_investor,
].sort();
const RHJ_STOCK_TOKEN_COUNTRIES: readonly string[] = [
  ...OFFERING_EXCLUSIONS,
  ...ISSUER_PROHIBITED_INVESTOR,
].sort();

/** ISO 3166-1 English short names for every code the policy can report. */
const JURISDICTION_NAMES: Readonly<Record<string, string>> = {
  AE: "United Arab Emirates",
  BY: "Belarus",
  CA: "Canada",
  CH: "Switzerland",
  CU: "Cuba",
  GB: "United Kingdom of Great Britain and Northern Ireland",
  IR: "Iran (Islamic Republic of)",
  KP: "Korea (Democratic People's Republic of)",
  MM: "Myanmar",
  RU: "Russian Federation",
  SD: "Sudan",
  SG: "Singapore",
  SS: "South Sudan",
  SY: "Syrian Arab Republic",
  UA: "Ukraine",
  US: "United States of America",
  VE: "Venezuela (Bolivarian Republic of)",
};

for (const code of RHJ_STOCK_TOKEN_COUNTRIES) {
  if (JURISDICTION_NAMES[code] === undefined) {
    throw new Error(`jurisdiction policy: no name for ${code}`);
  }
}

const CHAIN_POLICIES: ReadonlyMap<bigint, ChainPolicy> = new Map(
  Object.entries(policy.chains).map(([chainId, chain]) => {
    if (chain.unknown !== "hold") {
      throw new Error(`jurisdiction policy: chain ${chainId} must hold unknown assets`);
    }
    return [
      BigInt(chainId),
      {
        rhjStockTokens: new Map(
          chain.rhj_stock_token.map((entry) => [BigInt(entry.address), entry.provenance]),
        ),
        nonClass: new Map(
          chain.non_class.map((entry) => [BigInt(entry.address), entry.provenance]),
        ),
      },
    ];
  }),
);

export interface AssetClass {
  classification: AssetClassification;
  /** Where the classification comes from; empty for `unknown` and `out_of_scope`. */
  provenance: readonly Provenance[];
}

export function classifyAsset(
  chainId: string | bigint,
  token: string | bigint,
): AssetClass {
  const chain = CHAIN_POLICIES.get(BigInt(chainId));
  if (chain === undefined) return { classification: "out_of_scope", provenance: [] };
  const address = BigInt(token);
  const member = chain.rhjStockTokens.get(address);
  if (member !== undefined) return { classification: "rhj_stock_token", provenance: member };
  const nonClass = chain.nonClass.get(address);
  if (nonClass !== undefined) return { classification: "non_class", provenance: nonClass };
  return { classification: "unknown", provenance: [] };
}

function hexAddress(token: string | bigint): string {
  return `0x${BigInt(token).toString(16).padStart(40, "0")}`;
}

function withToken(
  assets: readonly RestrictableAsset[],
): (RestrictableAsset & { token: string | bigint })[] {
  return assets.filter(
    (asset): asset is RestrictableAsset & { token: string | bigint } =>
      asset.token !== undefined,
  );
}

/**
 * Public policy notice (EKU-853 §3, verbatim), independent of the caller's
 * location or domicile.
 */
export const QUOTE_JURISDICTION_NOTICE_V2 = "A quote, execution plan, simulation or wallet approval is not permission to trade. Robinhood Stock Tokens are tokenised debt securities subject to issuer restrictions and applicable law. Before requesting signatures or submitting approvals or trades, establish the user's relevant jurisdiction and eligibility, including location, residence or entity incorporation, US-person status under Regulation S, any person for whose account or benefit the transaction is made, and issuer Prohibited Investor restrictions. Never infer these facts from an agent or server IP. If required facts or asset-policy coverage are unknown, do not proceed. Only the user or an authorized representative of the actual investor may provide an explicit factual attestation; an agent must not attest on their behalf. A known prohibited fact cannot be overridden by attestation. An attestation is not a license, legal exemption or substitute for required screening. Keep the attestation client-side; do not send it to the quote API or MCP server. No blanket disposal exemption applies.";

/**
 * Jurisdiction metadata for a quote or plan.
 *
 * Every supplied asset is listed with its classification and provenance, so an
 * empty `restricted_jurisdictions` list is distinguishable from a missing one:
 * it is `[]` only when `coverage` is `"complete"`. When any asset is `unknown`
 * (on a covered chain but not yet classified) the coverage is `"unknown"`,
 * `execution_hold` is true, and the restricted lists are `null` rather than
 * empty: the metadata is not authoritative for that asset. This is a label for
 * the agent, harness or wallet to act on; the server still returns the quote
 * or plan.
 */
export interface JurisdictionAsset {
  chain_id: string;
  token: string;
  side: AssetSide;
  classification: AssetClassification;
  provenance: Provenance[];
  restricted_jurisdictions: string[] | null;
  offering_exclusions: string[] | null;
  issuer_prohibited_investor: string[] | null;
  execution_hold: boolean;
}

function assetLists(classification: AssetClassification) {
  if (classification === "unknown") {
    return { restricted_jurisdictions: null, offering_exclusions: null, issuer_prohibited_investor: null };
  }
  if (classification !== "rhj_stock_token") {
    return { restricted_jurisdictions: [], offering_exclusions: [], issuer_prohibited_investor: [] };
  }
  return {
    restricted_jurisdictions: [...RHJ_STOCK_TOKEN_COUNTRIES],
    offering_exclusions: [...OFFERING_EXCLUSIONS],
    issuer_prohibited_investor: [...ISSUER_PROHIBITED_INVESTOR],
  };
}

export function quoteJurisdiction(assets: readonly RestrictableAsset[]) {
  const entries = withToken(assets).map((asset): JurisdictionAsset => {
    const { classification, provenance } = classifyAsset(asset.chainId, asset.token);
    return {
      chain_id: BigInt(asset.chainId).toString(),
      token: hexAddress(asset.token),
      side: asset.side,
      classification,
      provenance: provenance.map((entry) => ({ ...entry })),
      ...assetLists(classification),
      execution_hold: classification === "unknown",
    };
  });
  return summarize(entries);
}

function summarize(entries: readonly JurisdictionAsset[]) {
  const hold = entries.some((asset) => asset.execution_hold);
  const restricted = hold
    ? null
    : [...new Set(entries.flatMap((asset) => asset.restricted_jurisdictions ?? []))].sort();
  const named = restricted ?? [];
  return {
    policy_version: JURISDICTION_POLICY_VERSION,
    policy_digest: JURISDICTION_POLICY_DIGEST,
    coverage: hold ? ("unknown" as const) : ("complete" as const),
    execution_hold: hold,
    restricted_jurisdictions: restricted,
    jurisdiction_names: Object.fromEntries(
      named.map((code) => [code, JURISDICTION_NAMES[code]!]),
    ),
    assets: entries,
    execution_notice:
      hold || named.length > 0 ? QUOTE_JURISDICTION_NOTICE_V2 : null,
  };
}

export type QuoteJurisdiction = ReturnType<typeof quoteJurisdiction>;

/**
 * One jurisdiction summary for a response that carries several swap plans, so
 * a caller deciding whether the whole batch can proceed reads one list instead
 * of walking every child. Coverage is the minimum over the children: an
 * unknown asset in any child makes the batch unknown.
 */
export function mergeQuoteJurisdictions(
  jurisdictions: readonly QuoteJurisdiction[],
): QuoteJurisdiction {
  return summarize(jurisdictions.flatMap((entry) => entry.assets));
}


/**
 * Attach jurisdiction metadata for the assets a preparation touches to its
 * result. This informs the agent; it never refuses.
 */
export async function withJurisdiction<T extends object>(
  result: T | Promise<T>,
  assets: readonly RestrictableAsset[],
): Promise<T & { jurisdiction: QuoteJurisdiction }> {
  return { ...(await result), jurisdiction: quoteJurisdiction(assets) };
}
