# Zero-seed launch fixtures

Copied verbatim from `test/vectors/` of EkuboProtocol/evm-contracts at
`853b608ec26d4c80bdad6e394cb8ba686e1ae615` (local fixture vectors, not live-chain
evidence). `test/launchpad/frozen.test.ts` re-checks these hashes.

| File | sha256 |
| --- | --- |
| zero-seed-launch.json | e5444bf6b1f7e422238331b50b64cf0400597bd13421e281615735511274190b |
| zero-seed-launch-events.json | 24dd5883ce242ec523517c9f38cfd5e8ca29740974aeded5740ac3608e1e7066 |
| zero-seed-launch-installation.json | 5cf44854cbf00abb700936b2e22782c27dac5e68cf892edc8f5aa7090067a555 |

`local-lifecycle.json` is produced by `script/launchpad-local-chain.ts` from plans
prepared by these tools and executed on a local anvil chain.
