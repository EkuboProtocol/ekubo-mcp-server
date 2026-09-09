import { ServiceError } from "./core.js";

/**
 * Jurisdiction restrictions on tradable assets.
 *
 * This mirrors the Ekubo interface's `src/util/common/tokenRestrictions.ts`.
 * The interface disables its action buttons; this server refuses to produce an
 * execution plan at all, which is the equivalent control for a caller that has
 * no UI to disable. Token metadata and opportunity discovery remain available.
 * Swap quotes additionally require a signed domicile attestation; see
 * `jurisdiction-attestation.ts`.
 *
 * The restricted sets are still mirrored, but the *decision* has deliberately
 * diverged: the interface blocks both directions, so a holder in a restricted
 * region cannot use it to sell an asset they already own. That leaves no path
 * to compliance for a rule the holder is already out of step with, so this
 * server permits the disposal where the restriction is offering-based, and
 * only there. Any change to which countries that covers belongs in
 * `DISPOSAL_EXEMPT_COUNTRIES`, and the interface still needs the same carve-out
 * before the two products agree.
 *
 * Country codes are ISO 3166-1 alpha-2: https://www.iso.org/obp/ui/#search
 */

const ROBINHOOD_CHAIN_ID = 4663n;

/**
 * Countries restricted for every non-native token on a chain. The Robinhood
 * chain entry exists as the place to express a chain-wide rule and currently
 * names no countries, so it restricts nothing — see `restrictingCountries`.
 */
const RESTRICTED_CHAIN_COUNTRIES: ReadonlyMap<bigint, ReadonlySet<string>> =
  new Map([[ROBINHOOD_CHAIN_ID, new Set<string>([])]]);

/**
 * Countries that restrict the tokenized equities because the offering is not
 * registered for their residents. The asset may not be *acquired* there, but
 * disposing of one already held is the act that ends the exposure, so these
 * countries are exempt on the sell side -- see `DISPOSAL_EXEMPT_COUNTRIES`.
 */
const RHC_STOCK_OFFERING_COUNTRIES: readonly string[] = [
  "US",
  "GB",
  "CA",
  "SG",
  "AE",
  "CH",
];

/**
 * Countries under comprehensive sanctions programs. These are a different
 * regime from the offering restrictions above: a disposal is still a
 * transaction facilitated for a sanctioned jurisdiction, and no "exiting is
 * the only way to comply" argument reaches it absent a license. They are
 * deliberately NOT disposal-exempt, and nothing may be added to
 * `DISPOSAL_EXEMPT_COUNTRIES` from this list without counsel signing off.
 */
const RHC_STOCK_SANCTIONED_COUNTRIES: readonly string[] = [
  "IR",
  "KP",
  "SY",
  "CU",
  "UA",
];

const RHC_STOCK_TOKEN_COUNTRIES: ReadonlySet<string> = new Set([
  ...RHC_STOCK_OFFERING_COUNTRIES,
  ...RHC_STOCK_SANCTIONED_COUNTRIES,
]);

/**
 * Countries whose restriction is offering-based only, and which therefore do
 * not block a *disposal* of an already-held restricted asset.
 *
 * This is an allowlist rather than a subtraction from the restricted set on
 * purpose: the exemption has to fail closed. A country added to a restriction
 * map in the future is fully blocked in both directions until it is named
 * here, so forgetting to update this set can only ever be over-restrictive.
 */
const DISPOSAL_EXEMPT_COUNTRIES: ReadonlySet<string> = new Set(
  RHC_STOCK_OFFERING_COUNTRIES,
);

/** Tokenized equities on Robinhood chain mainnet. */
const RHC_STOCK_TOKEN_ADDRESSES = [
  0xd0601ce157db5bdc3162bbac2a2c8af5320d9eecn,
  0xff080c8ce2e5feadaca0da81314ae59d232d4afdn,
  0x322f0929c4625ed5bad873c95208d54e1c003b2dn,
  0xb90a19ff0af67f7779aff50a882a9cff42446400n,
  0x86923f96303d656e4aa86d9d42d1e57ad2023fdcn,
  0x117cc2133c37b721f49de2a7a74833232b3b4c0cn,
  0xe93237c50d904957cf27e7b1133b510c669c2e74n,
  0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2an,
  0xc72b96e0e48ecd4dc75e1e45396e26300bc39681n,
  0xd5f3879160bc7c32ebb4dc785f8a4f505888de68n,
  0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89fn,
  0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5n,
  0xc0d6457c16cc70d6790dd43521c899c87ce02f35n,
  0xaf3d76f1834a1d425780943c99ea8a608f8a93f9n,
  0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3n,
  0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344n,
  0x12f190a9f9d7d37a250758b26824b97ce941bf54n,
  0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3n,
  0xb0992820e760d836549ba69bc7598b4af75dee03n,
  0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eean,
  0x92fd66527192e3e61d4ddd13322aa222de86f9b5n,
  0x822cc93ffd030293e9842c30bbd678f530701867n,
  0xd917b029c761d264c6a312bbbcda868658ef86a6n,
  0x6330d8c3178a418788df01a47479c0ce7ccf450bn,
  0xad25ac6c84d497db898fa1e8387bf6af3532a1c4n,
  0x3b14c39e89d60d627b42a1a4ca45b5bb45fc12e2n,
  0x5c90450bbb4273d7b2f17cf6917aeb237a569679n,
  0x0f17206447090e464c277571124dd2688e48aea9n,
  0x8ef20885f94e3d9bc7eb3080279188bd5ed7c08cn,
  0x941ae714ec6d8130c7b75d67160ca08f1e7d11ddn,
  0x62fd0668e10d8b72339be2dcf7643001688ff13bn,
  0x59818904ab4ce163b3ce4ffb64f2d6ca02c434b4n,
  0xcf6b2d875361be807eafa57458c80f28521f9333n,
  0xec262a75e413fafd0df80480274532c79d42da09n,
  0x7c04e6a3368f2a1de3874f0e80d2e0a1a9915da6n,
  0xc583c60aef9dc401da72cec1b404743a93cea1ccn,
  0x284358abc07f9359f19f4b5b4ac91901be2597ban,
  0x0e6e67ba88e7b5d9b67636a215c76779b948de79n,
  0x58ffe4a942d3885baa22d7520691f611ef09e7aan,
  0x521cf887e6531c6f667b5bc4d896e5d9bfe8eb2en,
  0x1b0e319c6a659f002271b69db8a7df2f911c153en,
  0xf0ab0c93be6f41369d302e55db1a96b3c430212dn,
  0x4ea005168d7f09a7a0ba9d1def21a479950e44c2n,
  0xbe6702d7b70315376dc48a3293f24f0982f86386n,
  0x7dc013eb55e436f30d7ed1afe4e36d6e45e3c3f7n,
  0x75742c18bc1f1c5c5f448f4c9d9c6f66dafaaa38n,
  0xcbb95bbf36099d34da091dc6fa6f49efa257cee3n,
  0x15cd20759ce7f3285c29a319de2d1a2e098c6f43n,
  0xc01aa1fecec0605b13bc84874ff7256c0f5f562an,
  0x7f0abef0c07280f82c6a08ead09ded6bae2c13fcn,
  0x9d9c6684f596f66a64c030b93a886d51fd4d7931n,
  0x0c3260af4b8f13a69c4c2dfb84fd667890cdfa14n,
  0x1af6446f07eb1d97c546afc8c9544cbdf3ad5137n,
  0x98e75885157c80992a8d41b696d8c9c6fb30a926n,
  0x156e175dd063a8ce274c50654ef40e0032b3fbcfn,
  0xe0444ef8bf4ed74f74fd73686e2ddf4c1c5591e8n,
  0x558378e000d634a36593e338ebacdd6207640efen,
  0xb8dbf92f9741c9ac1c32115e78581f23509916fdn,
  0x47f93d52cbec7c6d2cfc080e154002370a60daean,
  0xea72ecca2d0f6bfa1394dbbcff85b52cd4233931n,
  0xf9b46d3d1b22199d4d1025a9cedb540a33f1a2d5n,
  0x408c14038a04f7bd235329e26d2bf569ee20e250n,
  0x36046893810a7e7fce501229d57dc3fc8c8716d0n,
  0x8cf07c5a878945185d327aaa6e33faa95f95e7bfn,
  0x92ef19e82bd8ff36661de838d5eae7e5cef0effen,
  0x8005d266423c7ea827372c9c864491e5786600ean,
  0x5e81213613b6b86eab4c6c50d718d34359459786n,
  0xa5d4968421ba94814be3b136b15cf422101ac1a3n,
  0xddf2266b79abf0b48898959b0ed6e6adf512be74n,
  0x56d23bee5f41a7120170b0c603dae30128e460e9n,
  0xa8eb3bccbf2017ee7cbfb652eb51cf2e1b153289n,
  0x95052ddcd5dc25641657424a8cf04834997e1730n,
  0xf53f66751b1eff985311b693531e3290f600c410n,
  0xad622320e520de39e72d41ef07438c3fd3354875n,
  0x89776d4cd68193597a2fc132cfac1fde36ccea8an,
  0x25c288e6d899b9bc30160965ad9644c67e73be0cn,
  0x4189f0c66ebbb0bfef1c31f763131361ef32f77cn,
  0x4e62068525ab11fe768e29dfd00ef909b9803016n,
  0x27c99fbde9d0d2aa4f4bfb4943f237843ddf6958n,
  0xf1953dab6fad537488d5a022361ffaa8b4c95ec6n,
  0x4d21483a44bf67a86b77e3da301411880797d452n,
  0x44c4f142009036cf477ed2d09932051843137cf1n,
  0xeb30663bdff0622ef4e4e5cbb4e975f19f33f51dn,
  0x48961813349333209994750ffa89b3c5c22ec969n,
  0x282e87451e10fa6679bc7d76c69be44cd3fc777cn,
  0xb1bf26c1d20ff267a4f93550d1e0d06ac40a114bn,
  0x39ec44bee4f6a116c6f9b8de566848a985c53c60n,
  0x05b37fb53a299a1b874a619e1c4c404d52c36f4cn,
  0x82da4646242e1d962e96e932269dc644c94a9caan,
  0x1cdad396db64bda184d5182a97dd9b3c62100b7dn,
  0x9651342cea770ae9a2969ba2a52611523146aef9n,
  0xf23250dac154d05bb671cb0d0ebef3c635c79ce2n,
  0xf0c4bf4c582cb3836e98394b1d4e7b7281101be8n,
  0xbef75684c43c4ea7bd18dd532a2244674ee8b926n,
  0x9b23573b156b52565012f5ce02cdf60afbaa70ben,
  0x666716999e75d2652398ff830bbc2e485946e140n,
  0xb02e3e1b7f68559427c2d9100566e4f3cc5b7611n,
  0x33c18e2cc8ae9ae486e785090d86b2ce632ff994n,
  0x6ddb95405db6179012bff2fff7e0f8d49cf00137n,
  0x25ee805ac369b6e3f8bf5764c682d34a37cb7175n,
] as const;

const RESTRICTED_TOKEN_COUNTRIES: ReadonlyMap<
  bigint,
  ReadonlyMap<bigint, ReadonlySet<string>>
> = new Map([
  [
    ROBINHOOD_CHAIN_ID,
    new Map(
      RHC_STOCK_TOKEN_ADDRESSES.map((address) => [
        address,
        RHC_STOCK_TOKEN_COUNTRIES,
      ]),
    ),
  ],
]);

const NATIVE_TOKEN_ADDRESS = 0n;

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
 * Read the country Cloudflare inferred from the connecting IP.
 *
 * `request.cf` is set by the edge and cannot be supplied by the client, which
 * is why the client-controlled `x-forwarded-for`-style headers are not
 * consulted here — the same reasoning `rateLimitActor` applies to
 * `cf-connecting-ip`. This must be called with the *original* Request:
 * `admitMcpRequest` replays a POST through `new Request(url, init)`, which
 * carries the headers over but drops `cf`.
 *
 * `T1` is Cloudflare's code for a request arriving from the Tor network, which
 * names no jurisdiction. It is reported as unresolved so a restricted asset
 * fails closed rather than passing an ISO country-code comparison it can never
 * match. The interface applies the same rule in `resolvedCountryCode`.
 */
export function requestCountry(request: Request): RequestCountry {
  const country = (request as Request & { cf?: { country?: string } }).cf
    ?.country;
  if (typeof country !== "string" || country.length === 0) return null;
  return country.toUpperCase() === "T1" ? null : country;
}

/**
 * A restriction entry that names no countries restricts nobody, so it must not
 * participate in the checks below. An empty Set is truthy, and treating it as a
 * live restriction would make an unresolved country fail closed for *every*
 * token on that chain rather than for the assets actually being restricted.
 */
function restrictingCountries(
  countries: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
  return countries !== undefined && countries.size > 0 ? countries : undefined;
}

export function isTokenCountryRestricted({
  chainId,
  token,
  country,
}: {
  chainId: string | bigint;
  token: string | bigint;
  country: RequestCountry;
}): boolean {
  const chain = BigInt(chainId);
  const tokenAddress = BigInt(token);
  const restrictedChainCountries = restrictingCountries(
    RESTRICTED_CHAIN_COUNTRIES.get(chain),
  );
  const restrictedCountries = restrictingCountries(
    RESTRICTED_TOKEN_COUNTRIES.get(chain)?.get(tokenAddress),
  );
  const applicableRestrictedChainCountries =
    tokenAddress === NATIVE_TOKEN_ADDRESS
      ? undefined
      : restrictedChainCountries;

  if (!applicableRestrictedChainCountries && !restrictedCountries) {
    return false;
  }

  if (country === null) {
    return true;
  }

  const normalizedCountry = country.toUpperCase();

  return (
    applicableRestrictedChainCountries?.has(normalizedCountry) === true ||
    restrictedCountries?.has(normalizedCountry) === true
  );
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
 * rebalanced, a token whose oracle capacity is being extended — is `buy`,
 * because it is not a disposal and must not inherit the disposal exemption.
 *
 * There is no default: the exemption turns on this field, so every call site is
 * made to state it rather than inherit whichever value was less work to add.
 */
export type AssetSide = "sell" | "buy";

/**
 * Whether disposing of a restricted asset is permitted from this country.
 *
 * An unresolved country is never exempt. The exemption is a claim about one
 * jurisdiction's rules, and an origin that could not be resolved has not been
 * shown to be in one — the same reasoning that makes null fail closed in
 * `isTokenCountryRestricted`.
 */
function isDisposalExempt(country: RequestCountry): boolean {
  if (country === null) return false;
  return DISPOSAL_EXEMPT_COUNTRIES.has(country.toUpperCase());
}

/**
 * Whether this server refuses to move the asset the way the caller asked.
 *
 * A restricted asset on the sell side passes when the country's restriction is
 * offering-based: continuing to hold is not a way to comply with a rule against
 * holding, so the disposal has to stay available. Acquiring it stays blocked,
 * which also settles the restricted-for-restricted case — swapping one blocked
 * equity for another is refused on the buy side without needing its own rule.
 */
function isAssetBlocked(
  asset: RestrictableAsset,
  country: RequestCountry,
): boolean {
  if (asset.token === undefined) return false;
  const restricted = isTokenCountryRestricted({
    chainId: asset.chainId,
    token: asset.token,
    country,
  });
  if (!restricted) return false;
  return !(asset.side === "sell" && isDisposalExempt(country));
}

/**
 * "Do not retry through another tool" is only true when no path exists. Where
 * the block is acquisition-side and this country may still dispose, saying so
 * is what lets an automation route itself to the exit rather than treat the
 * position as stuck.
 */
function restrictionMessage(
  restricted: readonly RestrictableAsset[],
  country: RequestCountry,
): string {
  if (country === null) {
    return "This asset is unavailable because the country of the requesting IP address could not be determined. No execution plan was prepared. Do not retry through another network path or another Ekubo tool.";
  }
  const base = `This asset is unavailable in your region (${country.toUpperCase()}). No execution plan was prepared.`;
  const acquisitionOnly =
    isDisposalExempt(country) &&
    restricted.every((asset) => asset.side === "buy");
  return acquisitionOnly
    ? `${base} Acquiring it is restricted; disposing of a balance you already hold is not, so a sell of this asset for an unrestricted one will still be prepared. Do not retry the same acquisition through another Ekubo tool: the same restriction applies to every path that would acquire it.`
    : `${base} Do not retry through another Ekubo tool: the same restriction applies to every path that would trade it.`;
}

/**
 * Refuse to prepare anything that trades an asset the caller's jurisdiction
 * restricts. Call this before spending upstream quote credit, not after: a
 * plan that is never built is also never charged for.
 *
 * Assets with no token — an optional argument the caller omitted — are skipped
 * rather than treated as the native token, which would silently check the
 * wrong thing.
 */
export function assertAssetsTradable(
  assets: readonly RestrictableAsset[],
  country: RequestCountry,
): void {
  const restricted = assets.filter(
    (asset): asset is RestrictableAsset & { token: string | bigint } =>
      isAssetBlocked(asset, country),
  );
  if (restricted.length === 0) return;

  throw new ServiceError(
    "restricted_jurisdiction",
    restrictionMessage(restricted, country),
    {
      country,
      restricted_assets: restricted.map((asset) => ({
        chain_id: BigInt(asset.chainId).toString(),
        token: `0x${BigInt(asset.token).toString(16).padStart(40, "0")}`,
        side: asset.side,
      })),
    },
  );
}
