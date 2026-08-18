# Merkl direct discovery

Canonical documentation:

- Product and mechanisms: <https://docs.merkl.xyz/>
- API integration guide: <https://developers.merkl.xyz/integrate-merkl/quickstart>
- Reward endpoints: <https://developers.merkl.xyz/integrate-merkl/user-rewards>
- Chains and contracts: <https://developers.merkl.xyz/resources/chains-and-contracts>

Base URL is `https://api.merkl.xyz/v4`. No API key is required; the default
limit is 10 requests per second, and a key only raises it. Never send a key,
RPC credential, or API response through the Ekubo MCP.

## Reading rewards

`GET /v4/users/{address}/rewards/summary` is the endpoint to build a claim
from. It returns one entry per chain, each with a `rewards` array whose tokens
carry:

| field | meaning |
| --- | --- |
| `amount` | cumulative credited in the live tree, including everything already claimed |
| `claimed` | cumulative already pulled on chain |
| `pending` | earned but not yet in any root — **not claimable** |
| `proofs` | the Merkle proof for `amount`, passed to the Distributor as-is |

Claimable is `amount - claimed`. Show `pending` on its own line. When a new root
is published, `pending` resets to zero because those rewards folded into
`amount`, so `amount + pending` is never a number to display.

`claimed` is indexed from chain and lags a claim by up to about five minutes.
Pass `reloadChainId={chainId}` to bypass the cache when re-reading right after
claiming, and only then — it is expensive on Merkl's side.

Related endpoints, when the question is not "what can I claim":

- `GET /v4/users/{address}/rewards/stats` — `totalEarnedUSD`, `pendingUSD`,
  `claimableUSD` for a headline.
- `GET /v4/users/{address}/rewards/active-opportunities` — where the user is
  currently earning, LIVE only, sorted by APR.
- `GET /v4/users/{address}/rewards/breakdowns` — which campaign each fraction
  came from, capped at ~1000 breakdowns. Past that, paginate
  `GET /v4/leaves/{recipient}/breakdowns`.
- `GET /v4/claims/history/{address}` — past claims grouped per transaction.

## Reading opportunities

`GET /v4/opportunities` takes `chainId`, `status` (`LIVE`, `PAST`, `SOON`),
`action` (`POOL`, `LEND`, `BORROW`, `HOLD`, …), `mainProtocolId`, and
`items`/`page`. Each entry carries `apr`, `tvl`, `dailyRewards`, `tokens`, and
`depositUrl`.

APR is computed from campaign spend over current TVL. It is a projection, it
moves as TVL moves, and it stops when the campaign does.

## Verifying against chain

The Distributor is the authority on all of it. Through the user's wallet/RPC:

- `getMerkleRoot()` — the root claims are verified against right now. It returns
  the *previous* root while a newly published tree is inside its dispute window
  or under active dispute, which is why a proof for a fresh tree can revert.
- `endOfDisputePeriod()` and `disputer()` — whether that is the case.
- `claimed(user, token)` — the cumulative amount already taken, as
  `(amount, timestamp, merkleRoot)`.
- `claimRecipient(user, token)` and `claimRecipient(user, 0x0)` — a non-zero
  value redirects the payout away from the user's own wallet.

`prepare_merkl_claim` returns all of these as one stored read bundle, so ask the
wallet for them rather than assembling calldata.

Use official Merkl sources for semantics. Treat any UI, explorer, or analytics
output as secondary, and never take calldata from one.
