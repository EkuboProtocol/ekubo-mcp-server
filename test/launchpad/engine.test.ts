import { describe, expect, it } from "bun:test";
import { ratio } from "../../src/launchpad/analytics/numbers.js";
import { C, addr } from "./chain-builder.js";
import {
  BENEFICIARY,
  BUYER_A,
  PAYER,
  SENDER,
  TOKEN,
  standardLaunch,
  tools,
  type Json,
} from "./helpers.js";

const category = (holders: Json, name: string) =>
  holders.excluded[0].components.find((c: Json) => c.category === name).amount;

describe("launchpad engine: one routed buy", () => {
  it("decomposes Core's balance by category and excludes it from holders", async () => {
    const { chain, unit } = standardLaunch();
    const result = await tools.analytics(chain.bundle(), { token: TOKEN });
    const holders = result.holders;
    expect(result.source.complete).toBe(true);
    expect(holders.excluded[0]).toMatchObject({ address: C.core.address, category: "core", amount: (955_000n * unit).toString() });
    expect(category(holders, "unreleased_inventory")).toBe((900_000n * unit).toString());
    expect(category(holders, "launch_pool_liquidity")).toBe((50_000n * unit).toString());
    expect(category(holders, "unclaimed_creator_fees")).toBe((5_000n * unit).toString());
    expect(category(holders, "locked_terminal_liquidity")).toBe("0");
    expect(category(holders, "other_core_held")).toBe("0");
    expect(holders.denominators).toEqual({
      total_supply: (1_000_000n * unit).toString(),
      excluded_total: (955_000n * unit).toString(),
      circulating: (45_000n * unit).toString(),
    });
    expect(holders.holder_count).toBe(1);
    expect(holders.holders).toEqual([
      { rank: 1, address: BUYER_A, balance: (45_000n * unit).toString(), share_of_circulating: ratio(1n, 1n) },
    ]);
    expect(holders.top_n_share).toEqual({ "1": ratio(1n, 1n), "5": ratio(1n, 1n), "10": ratio(1n, 1n) });
    expect(holders.mean).toEqual(ratio(45_000n * unit, 1n));
    expect(holders.economic_ownership).toBe("unknown");
  });

  it("counts unclaimed launch-token fees in the beneficiary allocation", async () => {
    const { chain, unit } = standardLaunch();
    const result = await tools.analytics(chain.bundle(), { token: TOKEN });
    expect(result.creator_allocation).toMatchObject({
      beneficiary: BENEFICIARY,
      beneficiary_wallet_balance: "0",
      unclaimed_launch_token_fees: {
        scheduled_launch_ledger: (5_000n * unit).toString(),
        locked_launch_liquidity_ledger: "0",
        uncollected_terminal_position_fees: "0",
      },
      total: (5_000n * unit).toString(),
      share_of_total_supply: ratio(1n, 200n),
    });
    expect(result.creator_allocation.beneficiary_note).toContain("not a verified creator");
  });

  it("reports sender, payer and beneficiary separately in provenance", async () => {
    const { chain } = standardLaunch();
    const result = await tools.provenance(chain.bundle(), { token: TOKEN });
    const p = result.provenance;
    expect(p.transaction_sender).toBe(SENDER);
    expect(p.payer).toBe(PAYER);
    expect(p.beneficiary).toBe(BENEFICIARY);
    expect(p.beneficiary_differs_from_sender).toBe(true);
    expect(p.emitting_contract).toMatchObject({
      address: C.scheduled_launch.address,
      address_matches_manifest: true,
      code_hash_matches_manifest: true,
    });
    expect(p.does_not_prove.length).toBeGreaterThan(0);
  });

  it("flags a code hash that differs from the manifest", async () => {
    const { chain } = standardLaunch();
    const bundle = chain.bundle({ code_hashes: { [C.scheduled_launch.address]: `0x${"ab".repeat(32)}` } });
    const result = await tools.provenance(bundle, { token: TOKEN });
    expect(result.provenance.emitting_contract.code_hash_matches_manifest).toBe(false);
  });

  it("reports launch state with exact fees, remaining schedule and phase", async () => {
    const { chain, unit, start } = standardLaunch();
    const result = await tools.launch(chain.bundle(), { token: TOKEN });
    const initial = (1n << 64n) / 10n;
    const final = (1n << 64n) / 100n;
    const now = initial - ((initial - final) * 12n) / 120n;
    expect(result.launch).toMatchObject({
      token: TOKEN,
      phase: "active",
      released: (100_000n * unit).toString(),
      deployed: (100_000n * unit).toString(),
      schedule: { start_time: start, end_time: start + 120 },
      quote: { asset: "0x0000000000000000000000000000000000000000", decimals: 18 },
    });
    expect(result.launch.fees.initial).toEqual({ q64: initial.toString(), fraction: ratio(initial, 1n << 64n), percent: "9.99999999" });
    expect(result.launch.fees.now.q64).toBe(now.toString());
    expect(result.launch.fees.remaining_schedule).toMatchObject({
      kind: "linear",
      from_timestamp: chain.head.timestamp,
      to_timestamp: start + 120,
      to_fee: { q64: final.toString() },
    });
  });

  it("rejects an unknown token and a chain the launchpad does not cover", async () => {
    const { chain } = standardLaunch();
    await expect(tools.launch(chain.bundle(), { token: addr(1, "f") })).rejects.toMatchObject({ code: "launch_not_found" });
    await expect(tools.launch(chain.bundle(), { token: TOKEN, chain_id: 1 })).rejects.toMatchObject({
      code: "launch_not_found",
      details: { chain_id: 1, covered_chain_ids: [31337] },
    });
  });
});
