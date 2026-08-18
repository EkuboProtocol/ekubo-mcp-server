---
name: use-merkl
description: Discover and claim Merkl incentive rewards earned on any supported protocol, by querying Merkl's public API directly and preparing a guarded Distributor claim through the Ekubo MCP. Use for Merkl reward balances, claimable amounts, campaign and opportunity discovery, and claiming. Never route live Merkl data through the Ekubo MCP.
---

# Use Merkl

Merkl (Angle Labs) distributes incentive campaigns across dozens of chains and
hundreds of protocols. Rewards accrue off chain, are published as a Merkle root
to the Distributor, and are claimed against a proof.

Fetch the proof yourself, let the MCP fold it, and let the chain settle whether
that root is live. Nothing here requires trusting Merkl's API.

## Workflow

1. Read `references/discovery.md` before querying Merkl.
2. Query `https://api.merkl.xyz/v4/users/{address}/rewards/summary` directly. It
   is public and needs no API key. Do not ask the Ekubo MCP to fetch, relay,
   cache, or authenticate this request.
3. Call `get_merkl_deployment` and keep only chains it lists. The Distributor is
   at one address on most chains but not all, and an unlisted chain is unverified
   rather than merely unusual.
4. Present the **claimable delta**, `amount - claimed`. Never present `amount`,
   which is cumulative and includes everything already collected. Show `pending`
   separately and say plainly that it is not yet claimable — it enters a root
   later. Never add `pending` to `amount`.
5. Call `prepare_merkl_claim` with each token's exact `token`, `amount`, and
   `proofs`, copied unchanged. Batch every token on one chain into one call.
6. Run the returned `onchain_validation.read_calls_reference` through the wallet
   and check all three gates before authorizing:
   - `merkle_root` equals `details.derived_merkle_root`. A mismatch means the
     tree rotated or is inside its dispute period. Re-fetch from Merkl and
     prepare again; do not send.
   - each `claimed_*` amount is strictly below the matching cumulative amount,
     or the claim transfers nothing and only costs gas.
   - each `claim_recipient_*` is the zero address. A non-zero value means the
     payout goes somewhere else, and the user has to be told before they
     authorize.
7. Pass the `execution_plan_reference` unchanged to the wallet, simulate, show
   the user the simulated result, and send that same simulation.

## After a revert

`InvalidProof` means the root moved under the plan. Re-fetch
`/rewards/summary`, prepare again, and never resubmit the old calldata. Add
`reloadChainId={chainId}` when re-reading within about five minutes of a claim,
since `claimed` is indexed from chain and lags behind the transaction.

## Discovery

`GET /v4/opportunities` indexes live campaigns across every protocol Merkl
supports, filterable by `chainId`, `status`, `action`, and `mainProtocolId`. Use
it to answer "where can I earn" questions, and cross-check anything it says about
Ekubo pools against `get_liquidity_opportunities`.

Treat Merkl's `apr` and `dailyRewards` as campaign-derived projections over
current TVL, not realized yield. They move when TVL moves and when a campaign
ends.

## Safety gates

- Stop if the chain is not in `get_merkl_deployment`.
- Stop if the derived root does not match the chain's active root.
- Stop if the whole claim would transfer zero.
- Claiming for yourself needs no operator authorization, and the tokens go to
  the user no matter who submits. Enabling Merkl's autoclaim through
  `toggleOperator` therefore delegates gas and timing, not custody — say it that
  way rather than as a security decision.
- Reward tokens are ordinary ERC-20s chosen by whoever funded the campaign.
  Their being claimable says nothing about whether they are worth anything.
