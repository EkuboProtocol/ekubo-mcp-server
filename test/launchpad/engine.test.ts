import { describe, expect, it } from "bun:test";
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
    expect(category(holders, "other_core_held")).toBe("0");
    expect(holders.circulating).toBe((45_000n * unit).toString());
    expect(holders.holder_count).toBe(1);
    expect(holders.holders).toEqual([
      { rank: 1, address: BUYER_A, balance: (45_000n * unit).toString(), share_of_circulating: "1" },
    ]);
    expect(holders.top_n_share).toEqual({ "1": "1", "5": "1", "10": "1" });
  });

  it("counts unclaimed launch-token fees in the beneficiary allocation", async () => {
    const { chain, unit } = standardLaunch();
    const result = await tools.analytics(chain.bundle(), { token: TOKEN });
    expect(result.creator_allocation).toMatchObject({
      beneficiary: BENEFICIARY,
      beneficiary_wallet_balance: "0",
      unclaimed_launch_token_fees: { scheduled_launch_ledger: (5_000n * unit).toString(), terminal_ledger: "0" },
      total: (5_000n * unit).toString(),
      share_of_total_supply: "0.005",
    });
    expect(result.creator_allocation.beneficiary_note).toContain("not a verified creator");
  });

  it("reports sender, payer and beneficiary separately in provenance", async () => {
    const { chain } = standardLaunch();
    const result = await tools.provenance(chain.bundle(), { token: TOKEN });
    const p = result.provenance;
    expect(p.transaction_sender).toBe(SENDER);
    expect(p.payer).toBe(PAYER);
    expect(p.fee_beneficiary).toBe(BENEFICIARY);
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

  it("reports launch state with schedule, fee and phase", async () => {
    const { chain, unit, start } = standardLaunch();
    const result = await tools.launch(chain.bundle(), { token: TOKEN });
    expect(result.launch).toMatchObject({
      token: TOKEN,
      phase: "active",
      released: (100_000n * unit).toString(),
      deployed: (100_000n * unit).toString(),
      schedule: { start_time: start, end_time: start + 120 },
    });
    // 10% → 1% over 120 s, 12 s elapsed, in the contract's integer arithmetic.
    const initial = (1n << 64n) / 10n;
    const final = (1n << 64n) / 100n;
    expect(result.launch.fee_now.raw).toBe((initial - ((initial - final) * 12n) / 120n).toString());
    expect(result.launch.fee_now.fraction.startsWith("0.0909")).toBe(true);
  });

  it("rejects an unknown token and a wrong chain", async () => {
    const { chain } = standardLaunch();
    await expect(tools.launch(chain.bundle(), { token: addr(1, "f") })).rejects.toMatchObject({ code: "launch_not_found" });
    await expect(
      tools.launch(chain.bundle(), { token: TOKEN, chain_id: 1 }),
    ).rejects.toMatchObject({ code: "unsupported_chain" });
  });
});
