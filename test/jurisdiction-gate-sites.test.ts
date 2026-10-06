import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Snapshot of every place that applies the jurisdiction gate (EKU-853 contract
 * §1, §7.10). Policy v2 changed what the gate decides, not where it applies:
 * withdrawals, fee and proceeds collection, claims and transfers stay ungated.
 * Adding or removing a gated path must update this list in review. Every file
 * under src/ is scanned, subdirectories included (EKU-864: src/uniswap/ was
 * outside the original top-level scan).
 */
const GATED = [
  "core.ts getQuotesWithPlans assertAssetsClassified",
  "core.ts prepareSwap assertAssetsClassified",
  "fix-price.ts prepareFixPoolPrice assertAssetsTradable",
  "liquidity.ts prepareLpPositionDeposit assertAssetsTradable",
  "server.ts prepare_auction_create assertAssetsTradable",
  "server.ts prepare_oracle_capacity_expansion assertAssetsTradable",
  "server.ts prepare_transfers assertAssetsTradable",
  "server.ts prepare_twamm_order assertAssetsTradable",
  "ui-actions.ts prepareManualPoolBoost assertAssetsTradable",
  "uniswap/v2.ts prepareV2Add assertAssetsTradable",
  "uniswap/v3.ts prepareV3Add assertAssetsTradable",
  "uniswap/v4.ts prepareV4Add assertAssetsTradable",
  "ve33.ts prepareVe33IncreaseStake assertAssetsTradable",
  // phase=swap, phase=stake_all and phase=stake, in source order.
  "ve33.ts prepareVe33Reinvest assertAssetsTradable",
  "ve33.ts prepareVe33Reinvest assertAssetsTradable",
  "ve33.ts prepareVe33Reinvest assertAssetsTradable",
  "ve33.ts prepareVe33Stake assertAssetsTradable",
];

/**
 * Snapshot of every place a plan's `extensions["ekubo.jurisdiction"]` is
 * built as a trade (CTO decision EKU-873, contract §4.1). Each is a GATED path
 * above carrying `quoteJurisdiction` over the asset list its gate checked, or
 * wrap/unwrap. Swap plans are built in `prepareCandidate` for both
 * `getQuotesWithPlans` and `prepareSwap`; the TWAMM order, auction, oracle
 * and transfer preparers receive the metadata their `server.ts` gate computed
 * (a transfer batch is a trade only when it disposes of a gated asset, CLO
 * EKU-878). Every other plan site passes `nonTradingJurisdiction()`.
 */
const TRADE_PLAN_SITES = [
  "core.ts prepareCandidate quoteJurisdiction(swapAssets(intent))",
  "fix-price.ts prepareFixPoolPrice quoteJurisdiction(gatedAssets)",
  "liquidity.ts prepareLpPositionDeposit quoteJurisdiction(gatedAssets)",
  "server.ts prepare_auction_create quoteJurisdiction(gatedAssets)",
  "server.ts prepare_oracle_capacity_expansion quoteJurisdiction(gatedAssets)",
  "server.ts prepare_transfers quoteJurisdiction(gatedAssets)",
  "server.ts prepare_twamm_order quoteJurisdiction(gatedAssets)",
  "ui-actions.ts prepareManualPoolBoost quoteJurisdiction(gatedAssets)",
  "ui-actions.ts prepareWrapUnwrap quoteJurisdiction(wrapAssets)",
  "uniswap/v2.ts prepareV2Add quoteJurisdiction(gatedAssets)",
  "uniswap/v2.ts prepareV2Add quoteJurisdiction(gatedAssets)",
  "uniswap/v3.ts prepareV3Add quoteJurisdiction(gatedAssets)",
  "uniswap/v4.ts prepareV4Add quoteJurisdiction(gatedAssets)",
  "ve33.ts prepareVe33IncreaseStake quoteJurisdiction(gatedAssets)",
  // phase=stake_all and phase=stake; phase=swap children are swap plans.
  "ve33.ts prepareVe33Reinvest quoteJurisdiction(gatedAssets)",
  "ve33.ts prepareVe33Reinvest quoteJurisdiction(gatedAssets)",
  "ve33.ts prepareVe33Stake quoteJurisdiction(gatedAssets)",
];

/** Gated scopes whose plan metadata is built in another scope. */
const TRADE_PLAN_BUILT_IN: Record<string, string> = {
  "core.ts getQuotesWithPlans": "core.ts prepareCandidate",
  "core.ts prepareSwap": "core.ts prepareCandidate",
};

function sourceLines(): { file: string; scope: string; line: string }[] {
  const root = new URL("../src/", import.meta.url);
  return (readdirSync(fileURLToPath(root), { recursive: true }) as string[])
    .map((file) => file.split("\\").join("/"))
    .filter((file) => file.endsWith(".ts") && file !== "token-restrictions.ts")
    .flatMap((file) => {
      let scope = "?";
      return readFileSync(new URL(file, root), "utf8").split("\n").flatMap((line) => {
        const tool = /registerCatalogTool\(\s*"(\w+)"/.exec(line);
        const fn = /^(?:export )?(?:async )?function (\w+)/.exec(line);
        if (tool) scope = tool[1]!;
        else if (fn) scope = fn[1]!;
        return /^\s*(?:\/\/|\*|\/\*)/.test(line) ? [] : [{ file, scope, line }];
      });
    });
}

/**
 * Every expression that supplies a plan's jurisdiction metadata, by scope. A
 * `return` is a helper producing inline quote metadata (`swapJurisdiction`),
 * not a plan argument.
 */
function planJurisdictionSites(): string[] {
  return sourceLines()
    .filter(({ line }) => !/^\s*return\b/.test(line))
    .flatMap(({ file, scope, line }) => {
      const match =
        /\b(nonTradingJurisdiction\(\)|quoteJurisdiction\((?:\w+|swapAssets\(intent\))\)|input\.jurisdiction)/.exec(line);
      return match ? [`${file} ${scope} ${match[1]}`] : [];
    })
    .sort();
}

function gateSites(): string[] {
  const root = new URL("../src/", import.meta.url);
  return (readdirSync(fileURLToPath(root), { recursive: true }) as string[])
    .map((file) => file.split("\\").join("/"))
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
  it("refuses every plan built over undecoded calldata on a policy chain (CSO EKU-876 B-2)", () => {
    const sites = sourceLines()
      .filter(({ line }) => /\bassertCalldataInspectable\(/.test(line) && !line.includes("import"))
      .map(({ file, scope }) => `${file} ${scope}`)
      .sort();
    expect(sites).toEqual(["safe.ts prepareApprove", "safe.ts prepareExecute"]);
    // Every Safe execution plan is built by one of those two scopes.
    const builders = sourceLines()
      .filter(({ file, line }) => file === "safe.ts" && /\bexecution\(input,/.test(line))
      .map(({ scope }) => scope)
      .sort();
    expect(builders).toEqual(["prepareApprove", "prepareExecute"]);
  });

  it("gates exactly the reviewed plan-producing paths", () => {
    expect(gateSites()).toEqual(GATED);
  });

  it("leaves withdrawals, claims, collection and transfers ungated", () => {
    // The one transfer gate: a Stock Token sent to another address is a
    // disposal (CLO ruling EKU-878). It is the only site allowed to name one.
    const sites = gateSites()
      .filter((site) => site !== "server.ts prepare_transfers assertAssetsTradable")
      .join("\n");
    for (const name of ["withdraw", "claim", "collect", "transfer", "stop", "revoke", "complete"]) {
      expect(sites.toLowerCase()).not.toContain(name);
    }
  });
});

describe("plan jurisdiction scope sites (EKU-873)", () => {
  it("builds trade metadata at exactly the reviewed sites", () => {
    const trade = planJurisdictionSites().filter(
      (site) => !site.endsWith(" nonTradingJurisdiction()") && !site.endsWith(" input.jurisdiction"),
    );
    expect(trade).toEqual([...TRADE_PLAN_SITES].sort());
  });

  it("gives every gated path trade metadata, and nothing else but wrap/unwrap", () => {
    const tradeScopes = new Set(TRADE_PLAN_SITES.map((site) => site.split(" ").slice(0, 2).join(" ")));
    const gatedScopes = new Set(
      GATED.map((site) => site.split(" ").slice(0, 2).join(" ")).map((scope) => TRADE_PLAN_BUILT_IN[scope] ?? scope),
    );
    expect([...tradeScopes].filter((scope) => !gatedScopes.has(scope))).toEqual(["ui-actions.ts prepareWrapUnwrap"]);
    expect([...gatedScopes].filter((scope) => !tradeScopes.has(scope))).toEqual([]);
  });

  it("passes caller-supplied metadata through only where a server gate computed it", () => {
    expect(planJurisdictionSites().filter((site) => site.endsWith(" input.jurisdiction"))).toEqual([
      "auctions.ts prepareAuctionCreate input.jurisdiction",
      "orders.ts prepareTwammOrder input.jurisdiction",
      "transfers.ts prepareTransfers input.jurisdiction",
      "ui-actions.ts prepareOracleCapacityExpansion input.jurisdiction",
      "ui-actions.ts preparedUiAction input.jurisdiction",
      "ui-actions.ts preparedUiAction input.jurisdiction",
    ]);
  });

  it("never classifies the tokens a non-trading plan moves", () => {
    for (const { line } of sourceLines()) {
      if (line.includes("nonTradingJurisdiction(")) expect(line).toContain("nonTradingJurisdiction()");
    }
  });
});
