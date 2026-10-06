import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

/**
 * Board direction (EKU-862, EKU-873, 2026-10-06): the server only informs.
 * There are no jurisdiction gate sites; this is the snapshot of every place
 * that attaches jurisdiction metadata to a result. Adding or removing one must
 * update this list in review.
 */
const ATTACHED = [
  "core.ts swapJurisdiction quoteJurisdiction",
  "fix-price.ts prepareFixPoolPrice quoteJurisdiction",
  "liquidity.ts prepareLpPositionDeposit quoteJurisdiction",
  "server.ts prepare_auction_create withJurisdiction",
  "server.ts prepare_oracle_capacity_expansion withJurisdiction",
  "server.ts prepare_transfers withJurisdiction",
  "server.ts prepare_twamm_order withJurisdiction",
  "ve33.ts prepareVe33Reinvest mergeQuoteJurisdictions",
];

function srcFiles(): { file: string; text: string }[] {
  const root = new URL("../src/", import.meta.url);
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file, text: readFileSync(new URL(file, root), "utf8") }));
}

function attachSites(): string[] {
  return srcFiles()
    .filter(({ file }) => file !== "token-restrictions.ts")
    .flatMap(({ file, text }) => {
      let scope = "?";
      return text.split("\n").flatMap((line) => {
        const tool = /registerCatalogTool\(\s*"(\w+)"/.exec(line);
        const fn = /^(?:export )?(?:async )?function (\w+)/.exec(line);
        if (tool) scope = tool[1]!;
        else if (fn) scope = fn[1]!;
        const call = /\b(withJurisdiction|quoteJurisdiction|mergeQuoteJurisdictions)\(/.exec(line);
        return call && !line.includes("import") ? [`${file} ${scope} ${call[1]}`] : [];
      });
    })
    .sort();
}

describe("jurisdiction metadata sites", () => {
  it("attaches metadata at exactly the reviewed sites", () => {
    expect(attachSites()).toEqual(ATTACHED);
  });

  it("has no jurisdiction refusal or connection-country read anywhere in src", () => {
    for (const { file, text } of srcFiles()) {
      for (const pattern of [
        /"restricted_jurisdiction"/,
        /unclassified_asset/,
        /assertAssets\w*\(/,
        /requestCountry|normalizeCountry|RequestCountry|producerCountryGate|producer_country_gate/,
        /\bcf\??\.country/,
      ]) {
        expect(`${file}: ${pattern.test(text)}`).toBe(`${file}: false`);
      }
    }
  });
});
