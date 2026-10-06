import { describe, expect, it } from "bun:test";
import { ServiceError } from "../src/core.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertAssetsTradable,
  classifyAsset,
  isTokenCountryRestricted,
  JURISDICTION_POLICY_DIGEST,
  JURISDICTION_POLICY_VERSION,
  LEGACY_GATE_POLICY_VERSION,
  mergeQuoteJurisdictions,
  producerCountryGate,
  QUOTE_JURISDICTION_NOTICE_V2,
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
 * SHA-256 of src/jurisdiction-policy.json, generated in EkuboProtocol/default-tokens.
 * The interface (src/util/common/jurisdictionPolicy.json) and default-tokens pin
 * the same digest; change all three together.
 */
const POLICY_SHA256 =
  "2897e242c7030f9d0c5b99a548bb62bfefc91f4b665785814bbeca8a41eb776a";

/** The CLO EKU-853 §3 notice, copied from the decision, not from the source. */
const CLO_NOTICE = "A quote, execution plan, simulation or wallet approval is not permission to trade. Robinhood Stock Tokens are tokenised debt securities subject to issuer restrictions and applicable law. Before requesting signatures or submitting approvals or trades, establish the user's relevant jurisdiction and eligibility, including location, residence or entity incorporation, US-person status under Regulation S, any person for whose account or benefit the transaction is made, and issuer Prohibited Investor restrictions. Never infer these facts from an agent or server IP. If required facts or asset-policy coverage are unknown, do not proceed. Only the user or an authorized representative of the actual investor may provide an explicit factual attestation; an agent must not attest on their behalf. A known prohibited fact cannot be overridden by attestation. An attestation is not a license, legal exemption or substitute for required screening. Keep the attestation client-side; do not send it to the quote API or MCP server. No blanket disposal exemption applies.";

/** artifacts/eku-853/v2-class-addresses.txt: the CLO-approved 200-address class. */
const CLASS_ADDRESSES = readFileSync(
  new URL("./fixtures/jurisdiction-v2-class-addresses.txt", import.meta.url),
  "utf8",
).split("\n").filter(Boolean);

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

describe("token country restrictions", () => {
  it("restricts a tokenized equity in a restricted country", () => {
    expect(
      isTokenCountryRestricted({
        chainId: ROBINHOOD_CHAIN,
        token: NVDA,
        country: "US",
      }),
    ).toBe(true);
  });

  it("allows a tokenized equity outside the restricted countries", () => {
    expect(
      isTokenCountryRestricted({
        chainId: ROBINHOOD_CHAIN,
        token: NVDA,
        country: "FR",
      }),
    ).toBe(false);
  });

  it("normalizes the country code and the token address", () => {
    expect(
      isTokenCountryRestricted({
        chainId: ROBINHOOD_CHAIN,
        token: AAPL,
        country: "us",
      }),
    ).toBe(true);
  });

  it("never restricts the native token", () => {
    for (const country of ["US", null]) {
      expect(
        isTokenCountryRestricted({
          chainId: ROBINHOOD_CHAIN,
          token: NATIVE,
          country,
        }),
      ).toBe(false);
    }
  });

  it("fails closed for a restricted asset when the country is unresolved", () => {
    expect(
      isTokenCountryRestricted({
        chainId: ROBINHOOD_CHAIN,
        token: NVDA,
        country: null,
      }),
    ).toBe(true);
  });

  // The chain-wide entry for Robinhood chain names no countries. An entry that
  // restricts nobody must not make an unresolved country restrict everything on
  // the chain — only the assets that are genuinely restricted fail closed.
  it("does not restrict an ordinary token when the country is unresolved", () => {
    expect(
      isTokenCountryRestricted({
        chainId: ROBINHOOD_CHAIN,
        token: USDG,
        country: null,
      }),
    ).toBe(false);
    expect(
      isTokenCountryRestricted({
        chainId: ROBINHOOD_CHAIN,
        token: USDG,
        country: "US",
      }),
    ).toBe(false);
  });

  it("does not restrict the same address on another chain", () => {
    expect(
      isTokenCountryRestricted({ chainId: "1", token: NVDA, country: null }),
    ).toBe(false);
    expect(
      isTokenCountryRestricted({ chainId: "1", token: NVDA, country: "US" }),
    ).toBe(false);
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
      country: "US",
      restricted_assets: [
        { chain_id: ROBINHOOD_CHAIN, token: NVDA, side: "buy" },
      ],
    });
  });

  it("reports an unresolved country without naming a region", () => {
    const error = throwsFrom(() =>
      assertAssetsTradable(
        [{ chainId: ROBINHOOD_CHAIN, token: NVDA, side: "buy" }],
        null,
      ),
    );
    expect(error.code).toBe("restricted_jurisdiction");
    expect(error.message).toContain("could not be determined");
    expect((error.details as { country: unknown }).country).toBeNull();
  });
});

/**
 * Board direction (EKU-862, 2026-10-06): policy v2 is metadata only. The
 * pre-existing v1 connection-country gate keeps exactly its 0.44.1 behaviour
 * and must not pick up anything from v2: no new addresses, no new countries,
 * no unclassified-asset hold, no XX handling, no loss of the disposal
 * exemption.
 */
describe("legacy v1 gate is not extended by policy v2", () => {
  const V2_ONLY_COUNTRIES = ["BY", "MM", "RU", "SD", "SS", "VE"];

  it("does not refuse a Stock Token that only v2 classifies", () => {
    for (const token of [AMC, GLD, HIMS]) {
      expect(V1_ADDRESSES).not.toContain(token);
      for (const side of ["buy", "sell"] as const) {
        for (const country of ["US", "IR", null]) {
          expect(() =>
            assertAssetsTradable([{ chainId: ROBINHOOD_CHAIN, token, side }], country),
          ).not.toThrow();
        }
      }
    }
  });

  it("restricts exactly the 100 v1 addresses", () => {
    let restricted = 0;
    for (const token of CLASS_ADDRESSES) {
      if (isTokenCountryRestricted({ chainId: ROBINHOOD_CHAIN, token, country: "US" })) restricted += 1;
      expect(isTokenCountryRestricted({ chainId: ROBINHOOD_CHAIN, token, country: "US" }))
        .toBe(V1_ADDRESSES.includes(token));
    }
    expect(restricted).toBe(100);
  });

  it("does not refuse an unclassified asset, from any country or unresolved", () => {
    for (const country of ["FR", ...V2_COUNTRIES, "XX", "T1", null]) {
      for (const side of ["buy", "sell"] as const) {
        expect(() =>
          assertAssetsTradable([{ chainId: ROBINHOOD_CHAIN, token: SPOOF, side }], country),
        ).not.toThrow();
      }
    }
  });

  it("does not restrict the six countries only v2 names", () => {
    for (const country of V2_ONLY_COUNTRIES) {
      expect(isTokenCountryRestricted({ chainId: ROBINHOOD_CHAIN, token: NVDA, country })).toBe(false);
    }
  });

  it("does not treat Cloudflare XX or a malformed code as unresolved", () => {
    expect(requestCountry(requestWithCountry("XX"))).toBe("XX");
    for (const country of ["XX", "USA"]) {
      expect(() =>
        assertAssetsTradable([{ chainId: ROBINHOOD_CHAIN, token: NVDA, side: "buy" }], country),
      ).not.toThrow();
    }
  });

  it("keeps the v1 disposal exemption", () => {
    expect(() =>
      assertAssetsTradable([{ chainId: ROBINHOOD_CHAIN, token: NVDA, side: "sell" }], "US"),
    ).not.toThrow();
  });

  it("reports the v1 policy on the connection-gate record", () => {
    expect(LEGACY_GATE_POLICY_VERSION).toBe("ekubo-token-jurisdictions-v1");
    expect(producerCountryGate("US")).toEqual({
      applied: true,
      policy_version: "ekubo-token-jurisdictions-v1",
      country_resolved: true,
    });
  });
});

describe("assertAssetsTradable disposal exemption", () => {
  it("permits selling a restricted asset for an unrestricted one", () => {
    expect(() =>
      assertAssetsTradable(
        [
          { chainId: ROBINHOOD_CHAIN, token: NVDA, side: "sell" },
          { chainId: ROBINHOOD_CHAIN, token: USDG, side: "buy" },
        ],
        "US",
      ),
    ).not.toThrow();
  });

  it("exempts every offering-restricted country, not just the US", () => {
    for (const country of ["GB", "CA", "SG", "AE", "CH", "gb"]) {
      expect(() =>
        assertAssetsTradable(
          [{ chainId: ROBINHOOD_CHAIN, token: NVDA, side: "sell" }],
          country,
        ),
      ).not.toThrow();
    }
  });

  it("still blocks a sale into another restricted asset", () => {
    const error = throwsFrom(() =>
      assertAssetsTradable(
        [
          { chainId: ROBINHOOD_CHAIN, token: NVDA, side: "sell" },
          { chainId: ROBINHOOD_CHAIN, token: AAPL, side: "buy" },
        ],
        "US",
      ),
    );
    expect(error.details).toEqual({
      country: "US",
      restricted_assets: [
        { chain_id: ROBINHOOD_CHAIN, token: AAPL.toLowerCase(), side: "buy" },
      ],
    });
  });

  it("does not exempt a sanctioned jurisdiction", () => {
    for (const country of ["IR", "KP", "SY", "CU", "UA"]) {
      const error = throwsFrom(() =>
        assertAssetsTradable(
          [{ chainId: ROBINHOOD_CHAIN, token: NVDA, side: "sell" }],
          country,
        ),
      );
      expect(error.code).toBe("restricted_jurisdiction");
      expect(error.message).toContain("every path that would trade it");
    }
  });

  it("does not exempt an unresolved country", () => {
    expect(() =>
      assertAssetsTradable(
        [{ chainId: ROBINHOOD_CHAIN, token: NVDA, side: "sell" }],
        null,
      ),
    ).toThrow(ServiceError);
  });

  it("tells an acquisition-side caller that the disposal is still open", () => {
    const error = throwsFrom(() =>
      assertAssetsTradable(
        [{ chainId: ROBINHOOD_CHAIN, token: NVDA, side: "buy" }],
        "US",
      ),
    );
    expect(error.message).toContain("disposing of a balance you already hold");
  });

  it("does not offer the disposal route where disposal is also blocked", () => {
    const error = throwsFrom(() =>
      assertAssetsTradable(
        [{ chainId: ROBINHOOD_CHAIN, token: NVDA, side: "buy" }],
        "IR",
      ),
    );
    expect(error.message).not.toContain("disposing of a balance");
  });
});

describe("jurisdiction policy v2 data", () => {
  it("is the reviewed policy file shared with the interface", () => {
    const bytes = readFileSync(
      new URL("../src/jurisdiction-policy.json", import.meta.url),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(POLICY_SHA256);
    expect(JURISDICTION_POLICY_DIGEST).toBe(POLICY_SHA256);
    expect(JURISDICTION_POLICY_VERSION).toBe("ekubo-token-jurisdictions-v2");
  });

  it("is byte-identical to the interface and default-tokens copies checked out beside this repo", () => {
    for (const path of [
      "../../interface/src/util/common/jurisdictionPolicy.json",
      "../../default-tokens/jurisdiction-policy/ekubo-token-jurisdictions-v2.json",
    ]) {
      let text: string;
      try {
        text = readFileSync(new URL(path, import.meta.url), "utf8");
      } catch {
        continue;
      }
      // A sibling checkout on another branch may legitimately lag; only a
      // checkout that already carries this policy shape must match.
      if (text.includes('"non_class"')) {
        expect(createHash("sha256").update(text).digest("hex")).toBe(POLICY_SHA256);
      }
    }
  });

  it("classifies exactly the 200 CLO-approved addresses as Stock Tokens", () => {
    expect(CLASS_ADDRESSES).toHaveLength(200);
    const policy = JSON.parse(
      readFileSync(new URL("../src/jurisdiction-policy.json", import.meta.url), "utf8"),
    ) as { chains: Record<string, { rhj_stock_token: { address: string }[] }> };
    expect(policy.chains[ROBINHOOD_CHAIN]!.rhj_stock_token.map((entry) => entry.address))
      .toEqual([...CLASS_ADDRESSES].sort());
  });

  it("carries provenance on every class and non-class entry", () => {
    for (const address of [...CLASS_ADDRESSES, NATIVE, WETH, USDG, STONX]) {
      const { provenance } = classifyAsset(ROBINHOOD_CHAIN, address);
      expect(provenance.length).toBeGreaterThan(0);
      for (const entry of provenance) {
        expect(Object.keys(entry).sort()).toEqual(["observed_at", "ref", "source"]);
      }
    }
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
      expect(classifyAsset(ROBINHOOD_CHAIN, address).provenance.map((entry) => entry.source)).toEqual(["v1-list"]);
    }
  });

  it("covers AMC, GLD and HIMS from the issuer registry", () => {
    for (const address of [AMC, GLD, HIMS]) {
      expect(V1_ADDRESSES).not.toContain(address);
      const { classification, provenance } = classifyAsset(ROBINHOOD_CHAIN, address);
      expect(classification).toBe("rhj_stock_token");
      expect(provenance.map((entry) => entry.source)).toEqual(["curated-tokens", "issuer-registry"]);
    }
  });

  it("places only the verified exact addresses outside the class", () => {
    const sources = (address: string) =>
      classifyAsset(ROBINHOOD_CHAIN, address).provenance.map((entry) => entry.source);
    for (const address of [NATIVE, WETH, USDG, STONX]) {
      expect(classifyAsset(ROBINHOOD_CHAIN, address).classification).toBe("non_class");
    }
    expect(sources(NATIVE)).toEqual(["native"]);
    expect(sources(WETH)).toEqual(["issuer-token-contracts-page", "onchain-verification"]);
    expect(sources(USDG)).toEqual(["issuer-token-contracts-page"]);
    expect(sources(STONX)).toEqual(["ekubo-issued"]);
  });

  it("holds an unknown or spoofed address on the covered chain", () => {
    expect(classifyAsset(ROBINHOOD_CHAIN, SPOOF).classification).toBe("unknown");
  });

  it("leaves other chains out of scope, even at a Stock Token's address", () => {
    expect(classifyAsset("1", NVDA).classification).toBe("out_of_scope");
  });
});

describe("quote jurisdiction metadata", () => {
  it("lists the full v2 country floor on both sides", () => {
    for (const side of ["buy", "sell"] as const) {
      const result = quoteJurisdiction([{ chainId: ROBINHOOD_CHAIN, token: HIMS, side }]);
      expect(result.restricted_jurisdictions).toEqual(V2_COUNTRIES);
      expect(result.assets[0]!.restricted_jurisdictions).toEqual(V2_COUNTRIES);
      expect(result.execution_notice).toBe(CLO_NOTICE);
      expect(result.policy_digest).toBe(POLICY_SHA256);
      expect(Object.keys(result.jurisdiction_names)).toEqual(V2_COUNTRIES);
      expect(result.jurisdiction_names.US).toBe("United States of America");
      expect(result.assets[0]).toMatchObject({
        offering_exclusions: ["AE", "CA", "CH", "GB", "SG", "US"],
        issuer_prohibited_investor: ["BY", "CU", "IR", "KP", "MM", "RU", "SD", "SS", "SY", "UA", "VE"],
      });
    }
  });

  it("stores the CLO notice byte-for-byte", () => {
    expect(QUOTE_JURISDICTION_NOTICE_V2).toBe(CLO_NOTICE);
  });

  it("reports the four non-class tokens with an empty list and no notice", () => {
    for (const token of [NATIVE, WETH, USDG, STONX]) {
      const result = quoteJurisdiction([{ chainId: ROBINHOOD_CHAIN, token, side: "buy" }]);
      expect(result).toMatchObject({
        coverage: "complete", execution_hold: false, restricted_jurisdictions: [],
        jurisdiction_names: {}, execution_notice: null,
      });
    }
  });

  it("leaves a token on another chain unchanged: empty list, no notice", () => {
    const result = quoteJurisdiction([{ chainId: "1", token: NVDA, side: "buy" }]);
    expect(result).toMatchObject({ coverage: "complete", restricted_jurisdictions: [], execution_notice: null });
    expect(result.assets[0]).toMatchObject({ classification: "out_of_scope", provenance: [] });
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
      chain_id: ROBINHOOD_CHAIN, token: USDG, side: "buy", classification: "non_class",
      provenance: [{ source: "issuer-token-contracts-page", ref: "https://docs.robinhood.com/chain/contracts", observed_at: "2026-10-06" }],
      restricted_jurisdictions: [], offering_exclusions: [], issuer_prohibited_investor: [],
      execution_hold: false,
    }]);
  });

  it("marks an unclassified asset as a hold rather than an empty list", () => {
    const result = quoteJurisdiction([{ chainId: ROBINHOOD_CHAIN, token: SPOOF, side: "buy" }]);
    expect(result).toMatchObject({ coverage: "unknown", execution_hold: true, restricted_jurisdictions: null });
    expect(result.assets[0]).toMatchObject({ classification: "unknown", execution_hold: true, restricted_jurisdictions: null });
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
    expect(held.coverage).toBe("unknown");
    expect(held.restricted_jurisdictions).toBeNull();
  });
});

describe("policy v2 metadata never refuses and never reads the connection", () => {
  it("labels an unknown asset instead of throwing, on either side", () => {
    for (const side of ["buy", "sell"] as const) {
      const result = quoteJurisdiction([
        { chainId: ROBINHOOD_CHAIN, token: SPOOF, side },
        { chainId: ROBINHOOD_CHAIN, token: USDG, side: side === "buy" ? "sell" : "buy" },
      ]);
      expect(result.coverage).toBe("unknown");
      expect(result.restricted_jurisdictions).toBeNull();
      expect(result.assets.map((asset) => asset.classification)).toEqual(["unknown", "non_class"]);
      expect(result.assets[0]!.restricted_jurisdictions).toBeNull();
      expect(result.assets[1]!.restricted_jurisdictions).toEqual([]);
    }
  });

  it("never presents an unknown asset as an authoritative empty list", () => {
    for (const token of [SPOOF, "0x2222222222222222222222222222222222222222"]) {
      const result = quoteJurisdiction([{ chainId: ROBINHOOD_CHAIN, token, side: "buy" }]);
      expect(result.restricted_jurisdictions).not.toEqual([]);
      expect(result.assets[0]!.restricted_jurisdictions).not.toEqual([]);
      expect(result.assets[0]!.offering_exclusions).toBeNull();
      expect(result.assets[0]!.issuer_prohibited_investor).toBeNull();
    }
  });

  it("takes no country input and carries no country field", () => {
    expect(quoteJurisdiction.length).toBe(1);
    const result = quoteJurisdiction([{ chainId: ROBINHOOD_CHAIN, token: NVDA, side: "sell" }]);
    const text = JSON.stringify(result);
    expect(text).not.toContain('"country"');
    expect(text).not.toContain("permitted");
    expect(text).not.toContain("country_resolved");
  });

  it("the v2 module exports no refusal helper", async () => {
    const exports = Object.keys(await import("../src/token-restrictions.js"));
    expect(exports).not.toContain("assertAssetsClassified");
    expect(exports).not.toContain("normalizeCountry");
  });
});
