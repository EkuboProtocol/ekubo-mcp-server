/**
 * Real quoter-service output for zero-seed pools -> MCP router plans -> local execution.
 *
 * Runs the quoter's own LOCAL router harness (tests/local-router at quoter-service a1ce2ee) on the indexer's
 * fork-free replay chain, then executes the MCP plan built from each guarded quoter response. Writes
 * test/fixtures/launchpad/zero-seed-quoter-plans.json, which the unit tests replay. Nothing here touches a live
 * chain, provider, key or funds.
 *
 *   ZERO_SEED_QUOTER_WORKTREE=…/quoter-service    (a1ce2ee7a2546a74b7192bb926b3f0531a65b899, cargo deps cached)
 *   ZERO_SEED_INDEXER_WORKTREE=…/indexer          (200684630121eef0ce18c649cd5035f9b57cef60, bun install run)
 *   ZERO_SEED_CONTRACTS_WORKTREE=…/evm-contracts  (4f1a3060b099e8a50469848118f44c0c65cfab9a, forge build run)
 *   ZERO_SEED_SCRATCH_DIR=$(mktemp -d) bun script/zero-seed-quoter-plans.ts
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return resolve(value);
};
const QUOTER = env("ZERO_SEED_QUOTER_WORKTREE");
const INDEXER = env("ZERO_SEED_INDEXER_WORKTREE");
const CONTRACTS = env("ZERO_SEED_CONTRACTS_WORKTREE");
const SCRATCH = env("ZERO_SEED_SCRATCH_DIR");
const OUT = join(ROOT, "test/fixtures/launchpad/zero-seed-quoter-plans.json");
const HEADS = {
  quoter: [QUOTER, "a1ce2ee7a2546a74b7192bb926b3f0531a65b899"],
  indexer: [INDEXER, "200684630121eef0ce18c649cd5035f9b57cef60"],
  contracts: [CONTRACTS, "4f1a3060b099e8a50469848118f44c0c65cfab9a"],
} as const;
const FIXTURE_SHA256 = "c4cea4e1d1accf56fcf7beb90743321cd6b1c4761e304651c3636dc9136d482b";

const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

for (const [name, [repo, head]] of Object.entries(HEADS)) {
  if (git(repo, "rev-parse", "HEAD") !== head) throw new Error(`${name} is not at ${head}`);
  if (git(repo, "status", "--porcelain", "--untracked-files=no")) throw new Error(`${name} has tracked changes`);
}
if (sha256(join(INDEXER, "tests/fixtures/zero-seed-launch/local-chain.json")) !== FIXTURE_SHA256) {
  throw new Error("indexer replay fixture changed");
}

const build = execFileSync("cargo", ["test", "--locked", "--offline", "-p", "evm-quoter-service", "--lib", "--no-run",
  "--message-format=json"], { cwd: QUOTER, encoding: "utf8", maxBuffer: 1 << 28 });
const quoterTest = build.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((m) =>
  m.reason === "compiler-artifact" && m.executable && m.target?.name === "evm_quoter_service")?.executable;
if (!quoterTest) throw new Error("quoter test executable not built");

let text = readFileSync(join(INDEXER, "scripts/zeroSeedLaunchFixture.ts"), "utf8");
const markers = ["async function main() {", "  await prefix();\n", "  await canonical();\n", "  mkdirSync(dirname(OUT)"];
for (const marker of markers) {
  if (text.split(marker).length !== 2) throw new Error(`pinned generator shape changed: ${JSON.stringify(marker)}`);
}
const runtime = readFileSync(join(QUOTER, "tests/local-router/runtime.ts"), "utf8") + "\n" +
  readFileSync(join(ROOT, "script/zero-seed-quoter-plans.runtime.ts"), "utf8");
text = text.replace(markers[0], `${runtime}\n${markers[0]}`)
  .replace(markers[1], `${markers[1]}  await runRouterMatrix("prefix");\n  await runMcpPlans("prefix");\n`)
  .replace(markers[2], `${markers[2]}  await runRouterMatrix("canonical");\n  await runMcpPlans("canonical");\n`)
  .replace(markers[3], `  writeRouterVectors();\n  writeMcpPlans();\n${markers[3]}`);

mkdirSync(SCRATCH, { recursive: true });
const proof = join(SCRATCH, "proof");
mkdirSync(proof, { recursive: true });
if (!existsSync(join(SCRATCH, "node_modules"))) symlinkSync(join(INDEXER, "node_modules"), join(SCRATCH, "node_modules"), "dir");
const runner = join(SCRATCH, "quoter-plans-fixture.ts");
writeFileSync(runner, text);
const run = spawnSync("bun", [runner, CONTRACTS, join(proof, "regenerated-local-chain.json")], {
  cwd: INDEXER, stdio: "inherit",
  env: { ...process.env, ZERO_SEED_QUOTER_TEST: quoterTest, ZERO_SEED_PROOF_DIR: proof, ZERO_SEED_MCP_ROOT: ROOT },
});
if (run.status !== 0) throw new Error(`generator exited ${run.status}`);
if (sha256(join(proof, "regenerated-local-chain.json")) !== FIXTURE_SHA256) throw new Error("regenerated chain differs");

const vectors = JSON.parse(readFileSync(join(proof, "router-vectors.json"), "utf8"));
const plans = JSON.parse(readFileSync(join(proof, "mcp-plans.json"), "utf8"));
const fixture = {
  scope: "LOCAL only: fork-free anvil replay chain of the indexer generator. Not live, forked, UserOp or bundler evidence.",
  provenance: {
    quoterService: HEADS.quoter[1], indexer: HEADS.indexer[1], evmContracts: HEADS.contracts[1],
    indexerReplayFixtureSha256: FIXTURE_SHA256,
    quoterOutput: "zero_seed_launch::tests::local_router_probe_from_indexed_response: the guarded snapshot quote through the service's hop builder and response serializer at the anvil-observed block",
    generator: "script/zero-seed-quoter-plans.ts",
  },
  quoterHarness: { executions: vectors.vectors.length, refusals: vectors.refusals.length,
    negativeControls: vectors.vectors.reduce((n: number, v: any) => n + v.negativeControls.length, 0) },
  plans,
};
writeFileSync(OUT, `${JSON.stringify(fixture, null, 1)}\n`);
console.log(`PASS: ${plans.length} MCP plans from ${vectors.vectors.length} quoter responses executed; wrote ${OUT}`);
