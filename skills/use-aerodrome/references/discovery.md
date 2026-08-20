# Aerodrome direct discovery

Canonical sources:

- Product documentation: <https://aerodrome.finance/docs>
- Sugar lens contracts: <https://github.com/velodrome-finance/sugar>
- Python SDK: <https://github.com/velodrome-finance/sugar-sdk>
- JS SDK: <https://github.com/velodrome-finance/sdk.js>

There is no REST API. Sugar is the data pipeline: lens contracts that fold what
would otherwise be dozens of calls into one `eth_call` returning a struct array.
Read them through the user's own RPC via `prepare_aerodrome_sugar_reads`; never
route the results back through the Ekubo MCP.

## Two warnings about the SDKs

Both are worth reading for how the protocol fits together, and neither is a
source of truth for Base:

- **`sdk.js` ships Optimism addresses.** Its `*Address` maps are Velodrome, not
  Aerodrome. Using them on Base targets the wrong contracts or nothing at all.
- **`sdk.js`'s ABIs are an Optimism snapshot and have drifted.** Its `Position`
  struct omits `locker` and `unlocks_at`, which the deployed Base lens returns.
  Decoding a live response with it does not error — it silently misreads every
  field after `sqrt_ratio_upper`.

`get_aerodrome_deployment` returns addresses derived on chain from the Voter
outward, and `prepare_aerodrome_sugar_reads` ships decode plans matching the
deployed structs. Prefer both over anything transcribed from an SDK.

## Datasets

| dataset | contract | answers |
| --- | --- | --- |
| `pools` | LpSugar | every pool: reserves, gauge, fees, emissions, factory |
| `positions` | LpSugar | one account's LP positions, staked and unstaked |
| `venfts_by_account` | VeSugar | an account's veNFTs, their power and current votes |
| `venft_by_id` | VeSugar | one veNFT, including `voted_at` |
| `latest_epochs` | RewardsSugar | the current epoch per pool: votes, emissions, bribes, fees |
| `pool_epochs` | RewardsSugar | one pool's epoch history, most recent first |
| `venft_rewards` | RewardsSugar | a veNFT's claimable rewards **and their source contracts** |
| `venft_pool_rewards` | RewardsSugar | the same, narrowed to one pool |

`venft_rewards` is the one that gates claiming: its `fee` and `bribe` fields are
the contract addresses `prepare_aerodrome_incentive_claim` requires, and they
cannot be derived any other way.

## Reading the structs

- `Lp.type` is `0` for stable, `-1` for volatile, and a **positive tick spacing**
  on concentrated pools. It is how you tell the pool kinds apart.
- `Lp.gauge_alive` false means the pool still trades but earns no emissions.
- `Position.staked` is the gauge-staked portion and `liquidity` the total, so an
  unstaked position has `emissions_earned` zero.
- `VeNFT.managed_id` non-zero means the NFT is deposited into a managed veNFT
  and cannot be voted or withdrawn directly.
- `VeNFT.voted_at` compared against the current epoch start is how you know
  whether another vote this epoch would revert.

## Pagination

Sugar pages by `limit` and `offset` against a fixed ordering, capped by the
contracts' own constants: 500 pools and 200 positions per call. There are tens
of thousands of pools, so read `count` first when walking them all — a full
500-pool page is roughly 560KB of response.

`byIndex` and `byAddress` exist in the Sugar source but **revert on the deployed
Base build**, including for canonical pools. This server does not offer them;
`pools` with an offset covers the same ground.
