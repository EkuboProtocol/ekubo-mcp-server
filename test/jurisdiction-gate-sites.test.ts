import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

/**
 * Snapshot of every place that applies the jurisdiction gate (EKU-853 contract
 * §1, §7.10). Policy v2 changed what the gate decides, not where it applies:
 * withdrawals, fee and proceeds collection, claims and transfers stay ungated.
 * Adding or removing a gated path must update this list in review.
 */
const GATED = [
  "core.ts getQuotesWithPlans assertAssetsClassified",
  "core.ts prepareSwap assertAssetsClassified",
  "fix-price.ts prepareFixPoolPrice assertAssetsTradable",
  "liquidity.ts prepareLpPositionDeposit assertAssetsTradable",
  "server.ts prepare_auction_create assertAssetsTradable",
  "server.ts prepare_oracle_capacity_expansion assertAssetsTradable",
  "server.ts prepare_twamm_order assertAssetsTradable",
  "ve33.ts prepareVe33Reinvest assertAssetsTradable",
];

function gateSites(): string[] {
  const root = new URL("../src/", import.meta.url);
  return readdirSync(root)
    .filter((file) => file.endsWith(".ts") && file !== "token-restrictions.ts")
    .flatMap((file) => {
      const lines = readFileSync(new URL(file, root), "utf8").split("\n");
      let scope = "?";
      return lines.flatMap((line) => {
        const tool = /registerCatalogTool\(\s*"(\w+)"/.exec(line);
        const fn = /^(?:export )?(?:async )?function (\w+)/.exec(line);
        if (tool) scope = tool[1]!;
        else if (fn) scope = fn[1]!;
        const call = /\b(assertAssetsTradable|assertAssetsClassified)\(/.exec(line);
        return call && !line.includes("import") ? [`${file} ${scope} ${call[1]}`] : [];
      });
    })
    .sort();
}

describe("jurisdiction gate call sites", () => {
  it("gates exactly the reviewed plan-producing paths", () => {
    expect(gateSites()).toEqual(GATED);
  });

  it("leaves withdrawals, claims, collection and transfers ungated", () => {
    const sites = gateSites().join("\n");
    for (const name of ["withdraw", "claim", "collect", "transfer", "stop", "revoke", "complete"]) {
      expect(sites.toLowerCase()).not.toContain(name);
    }
  });
});
