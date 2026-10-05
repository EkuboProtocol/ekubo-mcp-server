import { describe, expect, it } from "bun:test";
import { ratio } from "../../src/launchpad/analytics/numbers.js";
import { C, addr } from "./chain-builder.js";
import { BUYER_A, BUYER_B, E18, RECIPIENT_R, TOKEN, standardLaunch, tools } from "./helpers.js";

describe("launch phases", () => {
  it("is scheduled before start_time", async () => {
    const { chain } = standardLaunch();
    const bundle = chain.bundle({ as_of: 103, head: 103 });
    expect((await tools.launch(bundle, { token: TOKEN })).launch.phase).toBe("scheduled");
  });

  it("is stalled when the price sits beyond the launch range with released inventory undeployed", async () => {
    const { chain, sim, unit } = standardLaunch();
    // TOKEN sorts above native ETH, so it is token1 and the range is [-upper, -target].
    chain.block((b) => sim.buy(b, { payer: BUYER_B, quoteIn: E18, tokenOut: 1_000n * unit, fee: 0n, tick: -1500, liquidity: 0n }));
    chain.block();
    const result = await tools.launch(chain.bundle(), { token: TOKEN });
    expect(result.launch.phase).toBe("stalled");
    expect(result.launch.launch_pool_state).toMatchObject({ tick: -1500, liquidity: "0", basis: "last_core_swap" });
  });

  it("moves through ended, migration pending and migrated", async () => {
    const { chain, sim, unit } = standardLaunch();
    chain.blocksUntil(116);
    expect((await tools.launch(chain.bundle(), { token: TOKEN })).launch.phase).toBe("ended_pending_advance");

    chain.block((b) => {
      const tx = b.tx(addr(0x5a, "e"), C.scheduled_launch.address);
      const [p0, p1] = sim.pair(950_000n * unit, E18);
      tx.principal(sim.poolId, p0, p1);
      tx.advanced(sim.poolId, sim.deployed, true);
    });
    const pending = await tools.launch(chain.bundle(), { token: TOKEN });
    expect(pending.launch.phase).toBe("migration_pending");
    expect(pending.launch.principal).toEqual({
      received: { launch_token: (950_000n * unit).toString(), quote: E18.toString() },
      deposited: { launch_token: "0", quote: "0" },
      pending: { launch_token: (950_000n * unit).toString(), quote: E18.toString() },
      liquidity_locked: "0",
    });

    chain.block((b) => {
      const tx = b.tx(addr(0x5a, "e"), C.locked_launch_liquidity.address);
      const [r0, r1] = sim.pair(-(10n * unit), E18 / 100n);
      tx.coreSwap(C.locked_launch_liquidity.address, sim.terminalId, r0, r1);
      const [d0, d1] = sim.pair(900_000n * unit, (99n * E18) / 100n);
      tx.positionUpdated(C.locked_launch_liquidity.address, sim.terminalId, 1n, d0, d1);
      tx.locked(sim.poolId, sim.terminalId, 12345n);
    });
    chain.block((b) => {
      const tx = b.tx(BUYER_B, C.router.address);
      const [s0, s1] = sim.pair(-(100n * unit), 2n * E18);
      tx.coreSwap(C.router.address, sim.terminalId, s0, s1);
    });
    const migrated = await tools.launch(chain.bundle(), { token: TOKEN });
    expect(migrated.launch.phase).toBe("migrated");
    expect(migrated.launch.migration).toMatchObject({
      terminal_pool_id: sim.terminalId,
      bounds: { tick_lower: -2000, tick_upper: 2000 },
      // The last terminal swap left the pool at tick 0, which is tick 0 in launch orientation too.
      current_terminal_price: { tick: 0, quote_per_token_raw: "1" },
      inside_bounds: true,
    });
    // Rebalancing paid 0.01 quote for 10 tokens; the deposit took the rest of the quote.
    expect(migrated.launch.principal).toEqual({
      received: { launch_token: (950_000n * unit).toString(), quote: E18.toString() },
      deposited: { launch_token: (900_000n * unit).toString(), quote: ((99n * E18) / 100n).toString() },
      pending: { launch_token: (50_010n * unit).toString(), quote: "0" },
      liquidity_locked: "12345",
    });

    const analytics = await tools.analytics(chain.bundle(), { token: TOKEN });
    expect(analytics.volume.user_terminal).toBe((2n * E18).toString());
    expect(analytics.volume.internal.migration_rebalancing).toBe((E18 / 100n).toString());
    expect(analytics.creator_allocation.unclaimed_launch_token_fees.uncollected_terminal_position_fees).toBeNull();
    expect(analytics.creator_allocation.total_is_lower_bound).toBe(true);
  });
});

describe("early acquisition", () => {
  it("reports acquisition in stated block and time windows", async () => {
    const { chain, sim, unit } = standardLaunch();
    chain.block((b) => sim.buy(b, { payer: BUYER_B, recipient: RECIPIENT_R, quoteIn: E18, tokenOut: 2_000n * unit, fee: 200n * unit }));
    chain.block((b) =>
      sim.buy(b, { payer: addr(0xd1, "b"), quoteIn: E18, tokenOut: 1_000n * unit, fee: 0n, locker: addr(0xf0, "e") }),
    );
    chain.blocksUntil(120);
    const result = await tools.analytics(chain.bundle(), { token: TOKEN, early_window_blocks: 3, early_window_seconds: 24 });
    const [blocks, seconds] = result.early_acquisition.windows;
    expect(blocks.window).toEqual({ kind: "blocks", blocks: 3, from_block: 105, to_block: 107, end_timestamp: chain.blocks[7].timestamp });
    expect(blocks).toMatchObject({
      window_closed: true,
      amount: (46_800n * unit).toString(),
      distinct_buying_lockers: 1,
      distinct_buying_recipients: 2,
      buys_without_recipient: 0,
      largest_single_share_of_total_supply: ratio(9n, 200n),
      confidence: "exact",
    });
    expect(seconds.window).toMatchObject({ kind: "seconds", seconds: 24 });
    expect(seconds.amount).toBe((45_000n * unit).toString());

    const wide = await tools.analytics(chain.bundle(), { token: TOKEN, early_window_blocks: 4 });
    expect(wide.early_acquisition.windows[0]).toMatchObject({
      amount: (47_800n * unit).toString(),
      distinct_buying_lockers: 2,
      buys_without_recipient: 1,
    });
    expect(BUYER_A).not.toBe(RECIPIENT_R);
  });

  it("counts what buys received, net of the creator fee once, and reports sells beside it", async () => {
    const { chain, sim, unit } = standardLaunch();
    chain.block((b) => sim.sell(b, { payer: BUYER_A, tokenIn: 10_000n * unit, quoteOut: E18 / 10n, fee: E18 / 100n }));
    chain.blocksUntil(120);
    const result = await tools.analytics(chain.bundle(), { token: TOKEN, early_window_blocks: 3 });
    // BUYER_A's buy moved 45,000 tokens out of Core: 50,000 out of the pool less the 5,000 fee.
    expect(result.early_acquisition.windows[0]).toMatchObject({
      amount: (45_000n * unit).toString(),
      sold: (10_000n * unit).toString(),
      share_of_total_supply: ratio(45_000n, 1_000_000n),
      largest_single_share_of_total_supply: ratio(45_000n, 1_000_000n),
    });
    expect(result.reconciliation.mismatched).toEqual([]);
  });
});
