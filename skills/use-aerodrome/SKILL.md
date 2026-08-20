---
name: use-aerodrome
description: Read Aerodrome state from its Sugar lens contracts through the user's own RPC and prepare guarded v2 liquidity, gauge, veAERO lock, vote, and reward-claim transactions through the Ekubo MCP. Use for Aerodrome pools, LP positions, gauge emissions, veAERO locks, voting, and bribe or fee claims on Base. Never route live Aerodrome data through the Ekubo MCP.
---

# Use Aerodrome

Aerodrome is the ve(3,3) exchange on Base. It exists only on Base — Velodrome is
the same codebase on Optimism and the Superchain, under different addresses and
a different brand, and nothing here applies to it.

Aerodrome has no data API to call. Its data pipeline is **Sugar**: a set of lens
contracts that assemble pools, positions, veNFTs, epochs, and rewards into
structs and answer `eth_call`. So discovery is an on-chain read against the
user's own RPC, and the MCP's no-proxy boundary costs nothing here — it is how
Sugar is meant to be used.

## Workflow

1. Read `references/discovery.md` before reading anything.
2. Call `get_aerodrome_deployment` for the verified contracts and the protocol
   behaviour that decides what is safe.
3. Call `prepare_aerodrome_sugar_reads` for the dataset you need, and run the
   returned `read_calls_reference` through the wallet. The decoded result is
   authoritative state read from the user's RPC; the MCP never saw it.
4. Feed the addresses that read returns — pool, gauge, `fee`, and `bribe`
   contracts, and veNFT ids — into the `prepare_aerodrome_*` tools. Do not
   derive or guess them.
5. Pass each `execution_plan_reference` unchanged to the wallet, run the plan's
   own `onchain_validation` reads, simulate, and send that same simulation.

## What earns what

This is the part agents get wrong, so state it to the user plainly:

- **Holding an LP token** earns trading fees and no AERO.
- **Staking it in the pool's gauge** earns AERO emissions and hands that
  position's trading fees to the pool's voters. It is a swap of one income for
  another, not an addition.
- **Locking AERO into a veNFT** earns nothing by itself. Voting with it earns
  that pool's fees and bribes, and the rebase is claimed separately.

So "what is my Aerodrome APR" has no single answer until you know whether the
position is staked and whether the veNFT voted.

## Epoch rules that cause reverts

Aerodrome runs on weekly epochs, and most failed ve(3,3) transactions are
timing, not balances:

- A veNFT votes **once per epoch**. A second vote reverts with
  `AlreadyVotedOrDeposited`, and the fix is to wait for the next epoch, never to
  retry. Check `lastVoted` against the current epoch start first.
- A vote **replaces** the whole allocation. Pools left out of the list are voted
  zero, not left as they were.
- Weights are **relative shares**, so `[1,1]` and `[50,50]` cast the same vote.
- A veNFT that voted this epoch **cannot be withdrawn or merged** until it is
  reset, and a reset is itself blocked in the distribute window at the epoch
  boundary.
- A lock duration is measured from now and **floored to a week**, so anything
  under a week locks nothing.

## Claiming

Voter rewards and LP emissions are different tools:

- `prepare_aerodrome_gauge_claim` collects an LP's AERO from a gauge.
- `prepare_aerodrome_incentive_claim` collects a voter's fees and bribes, and
  optionally the rebase.

The fee and bribe contracts are per pool and only a Sugar `venft_rewards` read
returns them. A claim naming the wrong contract **succeeds and transfers
nothing**, so a green simulation is not evidence the amounts were right — check
them against the read they came from.

## Safety gates

- Stop if the chain is not Base 8453.
- Stop if a Sugar read shows `gauge_alive` false and the user is about to stake:
  the gauge takes the deposit and pays no emissions.
- Stop if a liquidity deposit's `pool` read is the zero address. That pair and
  stable flag have no pool, and depositing would create one at a price the user
  is implicitly setting.
- Stop before a withdrawal whose `earned` is non-zero without telling the user
  it will be left unclaimed.
- Both liquidity minimums are required. `addLiquidity` takes whatever ratio the
  reserves demand and refunds the rest, so zero minimums accept any split, not
  merely a worse price.
- Concentrated (Slipstream) positions are **readable** through Sugar but minting
  and CL gauge staking are not prepared by this server. Do not attempt them with
  the v2 tools; the v2 gauge stakes a fungible amount and a CL gauge stakes an
  ERC-721 id.
- Swaps do not belong here. Use `get_quotes_with_plans`, which compares sources
  and returns a firm executable plan.
- **Do not propose a relay when a user wants their voting automated.** Depositing
  a veNFT into a relay hands its votes to that relay's manager and locks the NFT
  behind `escrowType`, after which none of the lock or vote tools here apply to
  it. Recurring agent voting through the wallet covers the same need while the
  user keeps the NFT, so relay deposits are deliberately not prepared. Reading a
  relay's votes is fine; delegating to one is the thing to steer away from.
