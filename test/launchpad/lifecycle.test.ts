import { describe, expect, it } from "bun:test";
import { C, addr } from "./chain-builder.js";
import { BUYER_A, BUYER_B, E18, RECIPIENT_R, TOKEN, standardLaunch, tools } from "./helpers.js";

describe("launch phases", () => {
  it("is scheduled before start_time", async () => {
    const { chain } = standardLaunch();
    const bundle = chain.bundle({ head_block: 103, indexed_range: { from_block: 100, to_block: 103 } });
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
    expect(pending.launch.pending_principal).toEqual({ launch_token: (950_000n * unit).toString(), quote: E18.toString() });

    chain.block((b) => {
      const tx = b.tx(addr(0x5a, "e"), C.locked_launch_liquidity.address);
      const [r0, r1] = sim.pair(-(10n * unit), E18 / 100n);
      tx.coreSwap(C.locked_launch_liquidity.address, sim.terminalId, r0, r1);
      const [d0, d1] = sim.pair(900_000n * unit, E18);
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
    expect(migrated.launch.terminal_pool_id).toBe(sim.terminalId);
    expect(migrated.launch.pending_principal).toBeNull();

    const analytics = await tools.analytics(chain.bundle(), { token: TOKEN });
    expect(analytics.volume.user_terminal).toBe((2n * E18).toString());
    expect(analytics.volume.internal.migration_rebalancing).toBe((E18 / 100n).toString());
    expect(analytics.creator_allocation.unclaimed_launch_token_fees.terminal_ledger).toBeNull();
    expect(analytics.creator_allocation.total_is_lower_bound).toBe(true);
  });
});

describe("early acquisition", () => {
  it("reports net acquisition in stated block and time windows", async () => {
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
      net_acquired: (46_800n * unit).toString(),
      distinct_buying_lockers: 1,
      distinct_buying_recipients: 2,
      buys_without_recipient: 0,
      largest_single_share_of_total_supply: "0.045",
      confidence: "exact",
    });
    expect(seconds.window).toMatchObject({ kind: "seconds", seconds: 24 });
    expect(seconds.net_acquired).toBe((45_000n * unit).toString());

    const wide = await tools.analytics(chain.bundle(), { token: TOKEN, early_window_blocks: 4 });
    expect(wide.early_acquisition.windows[0]).toMatchObject({
      net_acquired: (47_800n * unit).toString(),
      distinct_buying_lockers: 2,
      buys_without_recipient: 1,
    });
    expect(BUYER_A).not.toBe(RECIPIENT_R);
  });
});
