import { z } from "zod";
import { ServiceError } from "./core.js";
import policy from "./jurisdiction-policy.json";

/**
 * Jurisdiction restrictions on tradable assets, policy
 * `ekubo-token-jurisdictions-v2` (CLO decision EKU-853, 2026-10-06).
 *
 * The country lists are a minimum product-policy floor, not a legal
 * determination. The policy data lives in `jurisdiction-policy.json`, generated
 * in EkuboProtocol/default-tokens (`scripts/jurisdiction-policy.ts`) and
 * vendored byte-for-byte here and into the Ekubo interface
 * (`src/util/common/jurisdictionPolicy.json`); all three pin its SHA-256 in a
 * test so they cannot drift silently. The interface disables its action
 * buttons; this server refuses to produce an execution plan at all, which is
 * the equivalent control for a caller that has no UI to disable. Discovery is
 * deliberately untouched: `list_tokens`, `get_token`, and the opportunity
 * tools still list and price every asset.
 *
 * The rule is a class rule, not an address list that happens to be complete:
 *
 * - On a chain the policy covers, every token is classified. A Robinhood Stock
 *   Token (`rhj_stock_token`) is restricted for the class's jurisdictions on
 *   both sides; there is no disposal exemption. An exact address verified not
 *   to be one (`non_class`) is not restricted by this rule.
 * - Any other token on that chain is `unknown` and held: every tool that
 *   builds an execution plan, swap quotes with plans included, refuses it with
 *   `unclassified_asset` from every country before any upstream quote is
 *   requested. A new issuer listing therefore fails closed until classified.
 * - A chain the policy does not cover is `out_of_scope`.
 *
 * Country codes are ISO 3166-1 alpha-2: https://www.iso.org/obp/ui/#search
 */

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
const RHJ_STOCK_TOKEN_COUNTRY_SET: ReadonlySet<string> = new Set(
  RHJ_STOCK_TOKEN_COUNTRIES,
);

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

/**
 * The requesting country, or null when the edge did not resolve one.
 *
 * Null is not "allowed": for an asset that is actually restricted somewhere it
 * fails closed, because an unresolved origin cannot be shown to be outside the
 * restricted set. It is scoped to those assets only — an unresolved country
 * must never restrict trading generally.
 */
export type RequestCountry = string | null;

/**
 * Normalize an edge country code: an ISO 3166-1 alpha-2 code in upper case, or
 * null. Cloudflare reports `XX` when it cannot place an IP and `T1` for Tor;
 * neither names a jurisdiction, and anything that is not two letters cannot be
 * compared against the restricted set, so all of them are unresolved. The
 * interface applies the same rule in `resolvedCountryCode`.
 */
export function normalizeCountry(country: unknown): RequestCountry {
  if (typeof country !== "string") return null;
  const code = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  return code === "XX" || code === "T1" ? null : code;
}

/**
 * Read the country Cloudflare inferred from the connecting IP.
 *
 * `request.cf` is set by the edge and cannot be supplied by the client, which
 * is why the client-controlled `x-forwarded-for`-style headers are not
 * consulted here — the same reasoning `rateLimitActor` applies to
 * `cf-connecting-ip`. This must be called with the *original* Request:
 * `admitMcpRequest` replays a POST through `new Request(url, init)`, which
 * carries the headers over but drops `cf`.
 *
 * The connection country is a signal about the connection, not the user's
 * legal domicile, residence, US-person status, or eligibility.
 */
export function requestCountry(request: Request): RequestCountry {
  return normalizeCountry(
    (request as Request & { cf?: { country?: unknown } }).cf?.country,
  );
}

/**
 * Whether this server refuses to prepare a plan that moves the token for a
 * caller connecting from `country`.
 *
 * Unknown assets on a covered chain are held for every country, because an
 * empty restriction list for them would be a false negative.
 */
export function isTokenCountryRestricted({
  chainId,
  token,
  country,
}: {
  chainId: string | bigint;
  token: string | bigint;
  country: RequestCountry;
}): boolean {
  const { classification } = classifyAsset(chainId, token);
  if (classification === "unknown") return true;
  if (classification !== "rhj_stock_token") return false;
  const code = normalizeCountry(country);
  if (code === null) return true;
  return RHJ_STOCK_TOKEN_COUNTRY_SET.has(code);
}

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
 *
 * Policy v2 restricts both sides identically (EKU-853 removed the v1 disposal
 * exemption), so the side is reported in metadata but does not change the
 * decision.
 */
export type AssetSide = "sell" | "buy";

function hexAddress(token: string | bigint): string {
  return `0x${BigInt(token).toString(16).padStart(40, "0")}`;
}

const REFUSAL_SUFFIX =
  " No execution plan was prepared. Do not retry through another network path or another Ekubo tool: the same policy applies to every path that would trade it, in either direction.";

function blockedAsset(asset: RestrictableAsset & { token: string | bigint }) {
  return {
    chain_id: BigInt(asset.chainId).toString(),
    token: hexAddress(asset.token),
    side: asset.side,
    classification: classifyAsset(asset.chainId, asset.token).classification,
  };
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
 * Refuse to build a plan around an asset the policy has not classified, from
 * every country. Call this before spending upstream quote credit.
 *
 * Assets with no token — an optional argument the caller omitted — are skipped
 * rather than treated as the native token, which would silently check the
 * wrong thing.
 */
export function assertAssetsClassified(assets: readonly RestrictableAsset[]): void {
  const unknown = withToken(assets)
    .filter((asset) => classifyAsset(asset.chainId, asset.token).classification === "unknown")
    .map(blockedAsset);
  if (unknown.length === 0) return;
  throw new ServiceError(
    "unclassified_asset",
    `This asset has no classification under ${JURISDICTION_POLICY_VERSION}, so execution is held until it is classified.${REFUSAL_SUFFIX}`,
    {
      policy_version: JURISDICTION_POLICY_VERSION,
      policy_digest: JURISDICTION_POLICY_DIGEST,
      assets: unknown,
    },
  );
}

/**
 * Refuse to prepare anything that trades an asset the policy has not
 * classified (`unclassified_asset`) or that the caller's connection country
 * restricts (`restricted_jurisdiction`). Call this before spending upstream
 * quote credit, not after: a plan that is never built is also never charged
 * for.
 */
export function assertAssetsTradable(
  assets: readonly RestrictableAsset[],
  country: RequestCountry,
): void {
  assertAssetsClassified(assets);
  const code = normalizeCountry(country);
  const blocked = withToken(assets)
    .filter((asset) => isTokenCountryRestricted({ chainId: asset.chainId, token: asset.token, country: code }))
    .map(blockedAsset);
  if (blocked.length === 0) return;

  throw new ServiceError(
    "restricted_jurisdiction",
    code === null
      ? `This asset is unavailable because the country of the requesting IP address could not be determined.${REFUSAL_SUFFIX}`
      : `This asset is unavailable in your region (${code}).${REFUSAL_SUFFIX}`,
    {
      policy_version: JURISDICTION_POLICY_VERSION,
      policy_digest: JURISDICTION_POLICY_DIGEST,
      country: code,
      restricted_assets: blocked,
    },
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
 * the coverage is `"unknown"`, `execution_hold` is true, and the restricted
 * lists are `null` rather than empty. Plan-producing tools refuse unknown
 * assets outright, so a plan never carries that state.
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

/**
 * Jurisdiction metadata for a plan or quote that trades `assets`: pass exactly
 * the list given to `assertAssetsTradable` / `assertAssetsClassified` for it.
 * `scope: "trade"` tells a wallet the plan acquires, disposes of, deposits or
 * stakes these assets (CTO decision EKU-873).
 */
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
    scope: "trade" as const,
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
 * Jurisdiction metadata for a plan that trades nothing: claims, withdrawals,
 * transfers, revocations, votes, merges, collection, pool initialization.
 *
 * `assets` lists assets acquired or disposed of by trade under the plan, and a
 * non-trading plan has none, so `[]` with `coverage: "complete"` is an
 * authoritative statement rather than an omission. The tokens such a plan
 * moves are deliberately not classified: non-trading paths stay outside the
 * class rule (CLO EKU-853), and listing an unclassified withdrawn token would
 * make a wallet hold an owner's own withdrawal. The producing tool decides the
 * scope; it is never inferred from calldata (CTO decision EKU-873).
 */
export function nonTradingJurisdiction() {
  return {
    policy_version: JURISDICTION_POLICY_VERSION,
    policy_digest: JURISDICTION_POLICY_DIGEST,
    scope: "non_trading" as const,
    coverage: "complete" as const,
    execution_hold: false as const,
    restricted_jurisdictions: [] as string[],
    jurisdiction_names: {} as Record<string, string>,
    assets: [] as JurisdictionAsset[],
    execution_notice: null,
  };
}

/** What every execution plan carries in `extensions["ekubo.jurisdiction"]`. */
export type PlanJurisdiction =
  | QuoteJurisdiction
  | ReturnType<typeof nonTradingJurisdiction>;

export const PLAN_JURISDICTION_EXTENSION = "ekubo.jurisdiction";

const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/);

/**
 * The metadata shape (EKU-853 contract §4 and §4.1). Used for tool output
 * schemas and, through `isValidPlanJurisdiction`, by the artifact store's
 * fail-closed check on every stored execution plan.
 */
export const jurisdictionMetadataSchema = z.object({
  policy_version: z.string(),
  policy_digest: z.string().regex(/^[0-9a-f]{64}$/),
  scope: z.enum(["trade", "non_trading"]),
  coverage: z.enum(["complete", "unknown"]),
  execution_hold: z.boolean(),
  restricted_jurisdictions: z.array(countryCodeSchema).nullable(),
  jurisdiction_names: z.record(z.string(), z.string()),
  assets: z.array(z.object({
    chain_id: z.string(), token: z.string(), side: z.enum(["sell", "buy"]),
    classification: z.enum(["rhj_stock_token", "non_class", "unknown", "out_of_scope"]),
    provenance: z.array(z.object({ source: z.string(), ref: z.string(), observed_at: z.string() })),
    restricted_jurisdictions: z.array(countryCodeSchema).nullable(),
    offering_exclusions: z.array(countryCodeSchema).nullable(),
    issuer_prohibited_investor: z.array(countryCodeSchema).nullable(),
    execution_hold: z.boolean(),
  })),
  execution_notice: z.string().nullable(),
});

const planJurisdictionSchema = jurisdictionMetadataSchema.strict().superRefine((value, ctx) => {
  if (value.policy_version !== JURISDICTION_POLICY_VERSION || value.policy_digest !== JURISDICTION_POLICY_DIGEST) {
    ctx.addIssue({ code: "custom", message: "metadata names a different policy than the vendored one" });
  }
  // A non-trading plan carries exactly the canonical body: no traded assets,
  // complete coverage, nothing restricted.
  if (value.scope === "non_trading" && JSON.stringify(value) !== JSON.stringify(nonTradingJurisdiction())) {
    ctx.addIssue({ code: "custom", message: "a non-trading plan reports no traded assets with complete coverage" });
  }
});

/** Whether the policy document covers this chain. */
export function isPolicyChain(chainId: string | bigint): boolean {
  try {
    return CHAIN_POLICIES.has(BigInt(chainId));
  } catch {
    return false;
  }
}

export function isValidPlanJurisdiction(value: unknown): boolean {
  return planJurisdictionSchema.safeParse(value).success;
}

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
 * Record that the connection-country check ran and let the request through.
 * It describes the MCP connection only; it says nothing about the user's
 * domicile or eligibility and is not permission to trade.
 */
export function producerCountryGate(country: RequestCountry) {
  return {
    applied: true as const,
    policy_version: JURISDICTION_POLICY_VERSION,
    country_resolved: country !== null,
  };
}
