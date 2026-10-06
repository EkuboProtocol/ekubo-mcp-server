import { describe, expect, it } from "bun:test";
import { ServiceError } from "../src/core.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertAssetsTradable,
  classifyAsset,
  isTokenCountryRestricted,
  JURISDICTION_POLICY_VERSION,
  mergeQuoteJurisdictions,
  quoteJurisdiction,
  requestCountry,
} from "../src/token-restrictions.js";

const ROBINHOOD_CHAIN = "4663";
const NATIVE = "0x0000000000000000000000000000000000000000";
/** NVDA, one of the restricted tokenized equities. */
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
/** AAPL, same list, mixed case to exercise address normalization. */
const AAPL = "0xAF3D76F1834A1D425780943C99EA8A608F8A93F9";
/** USDG on the same chain: verified outside the Stock Token class. */
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const STONX = "0x570c5aa79c798e7a418412cc8399ae5bcce570c5";
/** Issuer-registry listings that v1 missed (EKU-851). */
const AMC = "0x05a3d1cd21d0c88145e82600e62e7e496e0f222b";
const GLD = "0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e";
const HIMS = "0xccee82fe024c36fa15e1005ede3e9e4787e23d09";
/** v1 addresses no longer in the curated list; still restricted. */
const LEGACY_REMOVED = [
  "0x25ee805ac369b6e3f8bf5764c682d34a37cb7175",
  "0x33c18e2cc8ae9ae486e785090d86b2ce632ff994",
  "0x666716999e75d2652398ff830bbc2e485946e140",
  "0x6ddb95405db6179012bff2fff7e0f8d49cf00137",
  "0xb02e3e1b7f68559427c2d9100566e4f3cc5b7611",
];
/** An address nobody has classified, e.g. a token that copies a ticker. */
const SPOOF = "0x1111111111111111111111111111111111111111";

/**
 * The EKU-853 country floor, written out here rather than read from the policy
 * file so a change to the file cannot silently change what is tested.
 */
const V2_COUNTRIES = [
  "AE", "BY", "CA", "CH", "CU", "GB", "IR", "KP", "MM",
  "RU", "SD", "SG", "SS", "SY", "UA", "US", "VE",
];

/**
 * SHA-256 of src/jurisdiction-policy.json. The interface pins the same digest
 * for its copy (src/util/common/jurisdictionPolicy.json); change both together.
 */
const POLICY_SHA256 =
  "0712ad8b08b487646cb1b574cfa7e2e927596fe2c8d2bec915107934988c8af1";

const V1_ADDRESSES = readFileSync(
  new URL("./fixtures/jurisdiction-v1-addresses.txt", import.meta.url),
  "utf8",
).split("\n").filter(Boolean);
const CURATED_EQUITIES = readFileSync(
  new URL("./fixtures/curated-4663-equities-0048c81.tsv", import.meta.url),
  "utf8",
).split("\n").slice(1).filter(Boolean).map((line) => {
  const [symbol, name, address] = line.split("\t");
  return { symbol: symbol!, name: name!, address: address!.toLowerCase() };
});

function requestWithCountry(country?: string): Request {
  return { cf: country === undefined ? {} : { country } } as unknown as Request;
}

describe("request country", () => {
  it("reads the country Cloudflare resolved from the connecting IP", () => {
    expect(requestCountry(requestWithCountry("US"))).toBe("US");
  });

  it("reports an unresolved country as null", () => {
    expect(requestCountry(requestWithCountry())).toBeNull();
    expect(requestCountry(requestWithCountry(""))).toBeNull();
    expect(requestCountry({} as unknown as Request)).toBeNull();
  });

  it("treats a Tor request as an unresolved country", () => {
    expect(requestCountry(requestWithCountry("T1"))).toBeNull();
    expect(requestCountry(requestWithCountry("t1"))).toBeNull();
  });
});

describe("jurisdiction policy v2 data", () => {
  it("is the reviewed policy file shared with the interface", () => {
    const bytes = readFileSync(
      new URL("../src/jurisdiction-policy.json", import.meta.url),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(POLICY_SHA256);
    expect(JURISDICTION_POLICY_VERSION).toBe("ekubo-token-jurisdictions-v2");
  });

  it("classifies all 195 curated equities and ETFs as Stock Tokens", () => {
    expect(CURATED_EQUITIES).toHaveLength(195);
    for (const { address } of CURATED_EQUITIES) {
      expect(classifyAsset(ROBINHOOD_CHAIN, address).classification).toBe("rhj_stock_token");
    }
  });

  it("keeps every v1 address, including the five that left curation", () => {
    expect(V1_ADDRESSES).toHaveLength(100);
    for (const address of [...V1_ADDRESSES, ...LEGACY_REMOVED]) {
      expect(classifyAsset(ROBINHOOD_CHAIN, address).classification).toBe("rhj_stock_token");
    }
    for (const address of LEGACY_REMOVED) {
      expect(V1_ADDRESSES).toContain(address);
      expect(CURATED_EQUITIES.map((entry) => entry.address)).not.toContain(address);
      expect(classifyAsset(ROBINHOOD_CHAIN, address).sources).toEqual(["ekubo_v1"]);
    }
  });

  it("covers AMC, GLD and HIMS from the issuer registry", () => {
    for (const address of [AMC, GLD, HIMS]) {
      expect(V1_ADDRESSES).not.toContain(address);
      expect(classifyAsset(ROBINHOOD_CHAIN, address)).toEqual({
        classification: "rhj_stock_token",
        sources: ["curated", "issuer_registry"],
      });
    }
  });

  it("places only the verified exact addresses outside the class", () => {
    expect(classifyAsset(ROBINHOOD_CHAIN, NATIVE)).toEqual({ classification: "outside_class", sources: ["native"] });
    expect(classifyAsset(ROBINHOOD_CHAIN, WETH)).toEqual({ classification: "outside_class", sources: ["issuer_token_contracts_page"] });
    expect(classifyAsset(ROBINHOOD_CHAIN, USDG)).toEqual({ classification: "outside_class", sources: ["issuer_token_contracts_page"] });
    expect(classifyAsset(ROBINHOOD_CHAIN, STONX)).toEqual({ classification: "outside_class", sources: ["ekubo_issued"] });
  });

  it("holds an unknown or spoofed address on the covered chain", () => {
    expect(classifyAsset(ROBINHOOD_CHAIN, SPOOF).classification).toBe("unclassified");
  });

  it("leaves other chains out of scope, even at a Stock Token's address", () => {
    expect(classifyAsset("1", NVDA).classification).toBe("out_of_scope");
  });
});

describe("token country restrictions", () => {
  it("restricts a Stock Token in every v2 country", () => {
    for (const country of V2_COUNTRIES) {
      expect(isTokenCountryRestricted({ chainId: ROBINHOOD_CHAIN, token: NVDA, country })).toBe(true);
    }
  });

  it("restricts the six countries v1 missed", () => {
    for (const country of ["BY", "RU", "SS", "SD", "MM", "VE"]) {
      expect(isTokenCountryRestricted({ chainId: ROBINHOOD_CHAIN, token: AMC, country })).toBe(true);
    }
  });

  it("allows a Stock Token outside the restricted countries", () => {
    expect(isTokenCountryRestricted({ chainId: ROBINHOOD_CHAIN, token: NVDA, country: "FR" })).toBe(false);
  });

  it("normalizes the country code and the token address", () => {
    expect(isTokenCountryRestricted({ chainId: ROBINHOOD_CHAIN, token: AAPL, country: "us" })).toBe(true);
  });

  it("never restricts the native token or the verified non-class tokens", () => {
    for (const token of [NATIVE, WETH, USDG, STONX]) {
      for (const country of ["US", "IR", null]) {
        expect(isTokenCountryRestricted({ chainId: ROBINHOOD_CHAIN, token, country })).toBe(false);
      }
    }
  });

  it("fails closed for a Stock Token when the country is unresolved", () => {
    expect(isTokenCountryRestricted({ chainId: ROBINHOOD_CHAIN, token: NVDA, country: null })).toBe(true);
  });

  it("holds an unclassified token on the covered chain for every country", () => {
    for (const country of ["FR", "US", null]) {
      expect(isTokenCountryRestricted({ chainId: ROBINHOOD_CHAIN, token: SPOOF, country })).toBe(true);
    }
  });

  it("does not restrict any token on a chain the policy does not cover", () => {
    for (const token of [NVDA, SPOOF]) {
      for (const country of ["US", null]) {
        expect(isTokenCountryRestricted({ chainId: "1", token, country })).toBe(false);
      }
    }
  });
});

function throwsFrom(call: () => void): ServiceError {
  let thrown: unknown;
  try {
    call();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ServiceError);
  return thrown as ServiceError;
}

describe("assertAssetsTradable", () => {
  it("passes when nothing is restricted", () => {
    expect(() =>
      assertAssetsTradable(
        [
          { chainId: ROBINHOOD_CHAIN, token: USDG, side: "sell" },
          { chainId: ROBINHOOD_CHAIN, token: NVDA, side: "buy" },
        ],
        "FR",
      ),
    ).not.toThrow();
  });

  it("skips an asset whose token was not supplied", () => {
    expect(() =>
      assertAssetsTradable(
        [{ chainId: ROBINHOOD_CHAIN, token: undefined, side: "buy" }],
        "US",
      ),
    ).not.toThrow();
  });

  it("refuses to prepare an acquisition of a restricted asset", () => {
    const error = throwsFrom(() =>
      assertAssetsTradable(
        [
          { chainId: ROBINHOOD_CHAIN, token: USDG, side: "sell" },
          { chainId: ROBINHOOD_CHAIN, token: NVDA, side: "buy" },
        ],
        "US",
      ),
    );
    expect(error.code).toBe("restricted_jurisdiction");
    expect(error.message).toContain("US");
    expect(error.details).toEqual({
      policy_version: "ekubo-token-jurisdictions-v2",
      country: "US",
      restricted_assets: [
        { chain_id: ROBINHOOD_CHAIN, token: NVDA, side: "buy", classification: "rhj_stock_token" },
      ],
    });
  });

  it("refuses a disposal exactly like an acquisition, in every v2 country", () => {
    for (const country of V2_COUNTRIES) {
      const error = throwsFrom(() =>
        assertAssetsTradable(
          [
            { chainId: ROBINHOOD_CHAIN, token: NVDA, side: "sell" },
            { chainId: ROBINHOOD_CHAIN, token: USDG, side: "buy" },
          ],
          country,
        ),
      );
      expect(error.code).toBe("restricted_jurisdiction");
      expect(error.message).toContain("in either direction");
      expect(error.message).not.toContain("disposing of a balance");
    }
  });

  it("refuses an equity-to-equity swap on both legs", () => {
    const error = throwsFrom(() =>
      assertAssetsTradable(
        [
          { chainId: ROBINHOOD_CHAIN, token: NVDA, side: "sell" },
          { chainId: ROBINHOOD_CHAIN, token: AAPL, side: "buy" },
        ],
        "GB",
      ),
    );
    expect((error.details as { restricted_assets: unknown[] }).restricted_assets).toEqual([
      { chain_id: ROBINHOOD_CHAIN, token: NVDA, side: "sell", classification: "rhj_stock_token" },
      { chain_id: ROBINHOOD_CHAIN, token: AAPL.toLowerCase(), side: "buy", classification: "rhj_stock_token" },
    ]);
  });

  it("reports an unresolved country without naming a region", () => {
    const error = throwsFrom(() =>
      assertAssetsTradable(
        [{ chainId: ROBINHOOD_CHAIN, token: NVDA, side: "sell" }],
        null,
      ),
    );
    expect(error.code).toBe("restricted_jurisdiction");
    expect(error.message).toContain("could not be determined");
    expect((error.details as { country: unknown }).country).toBeNull();
  });

  it("holds an unclassified asset even from an unrestricted country", () => {
    const error = throwsFrom(() =>
      assertAssetsTradable(
        [
          { chainId: ROBINHOOD_CHAIN, token: SPOOF, side: "sell" },
          { chainId: ROBINHOOD_CHAIN, token: USDG, side: "buy" },
        ],
        "FR",
      ),
    );
    expect(error.code).toBe("restricted_jurisdiction");
    expect(error.message).toContain("no classification");
    expect((error.details as { restricted_assets: unknown[] }).restricted_assets).toEqual([
      { chain_id: ROBINHOOD_CHAIN, token: SPOOF, side: "sell", classification: "unclassified" },
    ]);
  });
});

describe("quote jurisdiction metadata", () => {
  it("lists the full v2 country floor on both sides", () => {
    for (const side of ["buy", "sell"] as const) {
      const result = quoteJurisdiction([{ chainId: ROBINHOOD_CHAIN, token: HIMS, side }]);
      expect(result.restricted_jurisdictions).toEqual(V2_COUNTRIES);
      expect(result.assets[0]!.restricted_jurisdictions).toEqual(V2_COUNTRIES);
      expect(result.execution_notice).toContain("No blanket disposal exemption applies.");
    }
  });

  it("reports an explicit empty list for a classified unrestricted asset", () => {
    const result = quoteJurisdiction([{ chainId: ROBINHOOD_CHAIN, token: USDG, side: "buy" }]);
    expect(result).toMatchObject({
      coverage: "complete",
      execution_hold: false,
      restricted_jurisdictions: [],
      execution_notice: null,
    });
    expect(result.assets).toEqual([{
      chain_id: ROBINHOOD_CHAIN, token: USDG, side: "buy", classification: "outside_class",
      class_sources: ["issuer_token_contracts_page"], restricted_jurisdictions: [], execution_hold: false,
    }]);
  });

  it("marks an unclassified asset as a hold rather than an empty list", () => {
    const result = quoteJurisdiction([{ chainId: ROBINHOOD_CHAIN, token: SPOOF, side: "buy" }]);
    expect(result).toMatchObject({ coverage: "incomplete", execution_hold: true, restricted_jurisdictions: [] });
    expect(result.assets[0]).toMatchObject({ classification: "unclassified", execution_hold: true });
    expect(result.execution_notice).toContain("asset-policy coverage are unknown");
  });

  it("unions phased children and holds the batch when any child is held", () => {
    const children = [
      quoteJurisdiction([
        { chainId: ROBINHOOD_CHAIN, token: AMC, side: "sell" },
        { chainId: ROBINHOOD_CHAIN, token: STONX, side: "buy" },
      ]),
      quoteJurisdiction([
        { chainId: ROBINHOOD_CHAIN, token: USDG, side: "sell" },
        { chainId: ROBINHOOD_CHAIN, token: STONX, side: "buy" },
      ]),
    ];
    const merged = mergeQuoteJurisdictions(children);
    expect(merged.restricted_jurisdictions).toEqual(V2_COUNTRIES);
    expect(merged.assets).toHaveLength(4);
    expect(merged.execution_hold).toBe(false);
    expect(merged.coverage).toBe("complete");

    const held = mergeQuoteJurisdictions([
      ...children,
      quoteJurisdiction([{ chainId: ROBINHOOD_CHAIN, token: SPOOF, side: "sell" }]),
    ]);
    expect(held.execution_hold).toBe(true);
    expect(held.coverage).toBe("incomplete");
  });
});
