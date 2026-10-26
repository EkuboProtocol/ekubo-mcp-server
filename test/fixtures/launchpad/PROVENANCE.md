# Zero-seed launch fixtures

Copied verbatim from `test/vectors/` of EkuboProtocol/evm-contracts at
`853b608ec26d4c80bdad6e394cb8ba686e1ae615` (local fixture vectors, not live-chain
evidence). `test/launchpad/frozen.test.ts` re-checks these hashes.

| File | sha256 |
| --- | --- |
| zero-seed-launch.json | e5444bf6b1f7e422238331b50b64cf0400597bd13421e281615735511274190b |
| zero-seed-launch-events.json | 24dd5883ce242ec523517c9f38cfd5e8ca29740974aeded5740ac3608e1e7066 |
| zero-seed-launch-installation.json | 5cf44854cbf00abb700936b2e22782c27dac5e68cf892edc8f5aa7090067a555 |

`local-lifecycle.json` and `wallet-handoff-final.json` are written by
`LAUNCHPAD_ANVIL=1 LAUNCHPAD_WRITE_FIXTURE=1 bun test test/launchpad/local-chain.test.ts`
from plans prepared by these tools and executed on a local anvil chain (frozen
853b608 init code). `wallet-handoff-final.json` records the sealed owner-review
artifacts, owner summaries and negative cases in the shape the Cloud Wallet's
verifier tests consume (see docs/launchpad.md, Owner review).

`zero-seed-launch-api-v7.golden.json` (sha256
8eb9e7537158561d5a937866e5b8af36d28b51030d0aa574deb7adfd1a5b92b1) is copied
verbatim from `src/routes/launches/fixtures/` of the Ekubo API at commit
`90d13a6e83de5f0df69539586f243a050e573f32`: every response of the launch routes
(contract `zero-seed-launch-api/v7`) as written by that repository's replay
test from the actual handlers over the indexer's replayed local chain, plus
`list_by_volume_native_priced`, the list ordered by volume while only the
native quote had an indexed USD price (mixed priced and unpriced quotes). Its
`source` field names the indexer commit and chain fixture hash.
`test/launchpad/api-contract.test.ts` parses it through the adapter and tools.
