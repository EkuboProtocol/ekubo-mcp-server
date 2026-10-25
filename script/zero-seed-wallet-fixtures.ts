// Writes the unsigned producer-to-wallet handoff fixture from the recorded local chains (no provider, no wallet, no
// send): bun script/zero-seed-wallet-fixtures.ts. test/launchpad/zero-seed-wallet-handoff.test.ts rebuilds it byte for byte.
import { writeFileSync } from "node:fs";
import { serializeHandoff, WALLET_HANDOFF_PATH } from "../test/launchpad/zero-seed-wallet-handoff.js";

writeFileSync(WALLET_HANDOFF_PATH, serializeHandoff());
console.log(JSON.stringify({ written: WALLET_HANDOFF_PATH }));
