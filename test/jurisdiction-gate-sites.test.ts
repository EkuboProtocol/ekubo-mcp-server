import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

/**
 * Snapshot of every place that applies a jurisdiction refusal. Board direction
 * on EKU-862 (2026-10-06): policy v2 is metadata only and adds no server-side
 * refusal, so this is exactly the pre-existing v1 connection-country gate as
 * shipped in 0.44.1, and nothing else. Withdrawals, fee and proceeds
 * collection, claims and transfers stay ungated. Adding or removing a gated
 * path must update this list in review.
 */
const GATED = [
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

function srcFiles(): { file: string; text: string }[] {
  const root = new URL("../src/", import.meta.url);
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file, text: readFileSync(new URL(file, root), "utf8") }));
}

describe("jurisdiction gate call sites", () => {
  it("adds no refusal site beyond the 0.44.1 v1 gate (zero v2 refusal sites)", () => {
    expect(gateSites()).toHaveLength(6);
    for (const { file, text } of srcFiles()) {
      expect(`${file}: ${/unclassified_asset/.test(text)}`).toBe(`${file}: false`);
      expect(`${file}: ${/assertAssetsClassified|normalizeCountry/.test(text)}`).toBe(`${file}: false`);
    }
  });

  it("reads the connection country only at the request edge", () => {
    const readers = srcFiles()
      .filter(({ text }) => /\brequestCountry\(|\.cf\b|\bcf\?\./.test(text))
      .map(({ file }) => file)
      .sort();
    expect(readers).toEqual(["index.ts", "token-restrictions.ts"]);
  });

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
