import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256 } from "viem";
import abiRevision from "../../src/launchpad/prepare/abis/revision.json";
import { launchpadPrepareAdvance } from "../../src/launchpad/prepare/advance.js";
import { launchpadPrepareClaim } from "../../src/launchpad/prepare/claim.js";
import { ABI_REVISION, CONTRACT_NAMES, prepareManifest } from "../../src/launchpad/prepare/contracts.js";
import { launchpadPrepareCreate } from "../../src/launchpad/prepare/create.js";
import { launchpadPrepareTrade } from "../../src/launchpad/prepare/trade.js";
import { createArgs } from "./helpers.js";
import { C, CODE, E18, env, failure, harness, launchQuote, MANIFEST, OTHER, SENDER, TOKEN } from "./fake.js";

const ABI_DIR = join(import.meta.dir, "../../src/launchpad/prepare/abis");
const PINNED = "40e5bb11f7d4a8b40bb40232027fa7888052eacb";

function prepareCalls() {
  const trade = { chain_id: 1, sender: SENDER, slippage_bps: 100, token: TOKEN, side: "buy", amount_kind: "exact_input", amount: E18.toString() };
  const short = { chain_id: 1, sender: SENDER, slippage_bps: 0, token: TOKEN };
  return [
    (deps: never) => launchpadPrepareCreate(env(), createArgs() as never, deps),
    (deps: never) => launchpadPrepareTrade(env(), trade as never, deps),
    (deps: never) => launchpadPrepareAdvance(env(), short, deps),
    (deps: never) => launchpadPrepareClaim(env(), short, deps),
  ];
}

describe("bundled launchpad ABIs", () => {
  it("are pinned to evm-contracts 40e5bb1 (src tree 92def448)", () => {
    expect(ABI_REVISION).toBe(PINNED);
    expect(abiRevision.src_tree).toBe("92def4480f59670c427265c116e9f00473a3c963");
  });

  it("match the build output recorded for the pinned revision, byte for byte", () => {
    const bundled = readdirSync(ABI_DIR).filter((name) => name !== "revision.json").sort();
    expect(bundled).toEqual(["LaunchRouter.json", "LockedLaunchLiquidity.json", "ScheduledLaunch.json"]);
    expect(Object.keys(abiRevision.abi_sha256).sort()).toEqual(bundled);
    for (const [name, digest] of Object.entries(abiRevision.abi_sha256)) {
      expect(createHash("sha256").update(readFileSync(join(ABI_DIR, name))).digest("hex")).toBe(digest);
    }
  });

  it("have LaunchConfig without quoteAmount, LaunchCreated without payer, and no direct create or claim on the extension or LLL", () => {
    const abi = (name: string) => JSON.parse(readFileSync(join(ABI_DIR, name), "utf8")) as { type: string; name?: string; inputs?: { name: string; components?: { name: string }[] }[] }[];
    const fns = (name: string) => abi(name).filter((item) => item.type === "function").map((item) => item.name);
    const created = abi("ScheduledLaunch.json").find((item) => item.name === "LaunchCreated")!;
    expect(created.inputs!.map((input) => input.name)).toEqual(["poolId", "token", "owner", "config"]);
    expect(created.inputs![3].components!.map((c) => c.name)).not.toContain("quoteAmount");
    expect(fns("ScheduledLaunch.json")).not.toContain("create");
    expect(fns("ScheduledLaunch.json")).not.toContain("claimFees");
    expect(fns("LockedLaunchLiquidity.json")).not.toContain("fund");
    expect(fns("LockedLaunchLiquidity.json")).not.toContain("claimFees");
    expect(fns("LaunchRouter.json")).toEqual(expect.arrayContaining(["create", "fund", "claimFees", "creator"]));
    expect(abi("LaunchRouter.json").some((item) => item.type === "event" && item.name === "LaunchCreatedBy")).toBe(true);
  });
});

describe("manifest", () => {
  it("accepts the manifest written at 40e5bb1 and refuses every other revision", () => {
    expect(prepareManifest(env()).git_revision).toBe(PINNED);
    for (const revision of ["3e4ffad2446c7777c26e74caa809c3f77ee054e1", "40e5bb1", `${PINNED}-dirty`, PINNED.toUpperCase(), ""]) {
      expect(() => prepareManifest(env({ git_revision: revision }))).toThrow(expect.objectContaining({ code: "abi_revision_mismatch" }));
    }
  });

  it("requires an address and a code hash for each of the six contracts", () => {
    for (const name of CONTRACT_NAMES) {
      const contracts = structuredClone(MANIFEST.contracts) as Record<string, Record<string, unknown>>;
      delete contracts[name].code_hash;
      expect(() => prepareManifest(env({ contracts }))).toThrow(expect.objectContaining({ code: "invalid_manifest", details: expect.objectContaining({ field: `contracts.${name}.code_hash` }) }));
    }
  });
});

describe("C1: code hashes and contract links before any plan", () => {
  it("checks all six code hashes and the five links at the pinned block on every preparation call", async () => {
    for (const run of prepareCalls()) {
      const { chain, services, deps } = harness();
      services.quote = { status: 200, body: launchQuote({ specified: E18, calculated: 10n ** 21n }) };
      chain.claimable = { amount0: 1n, amount1: 0n };
      const output = (await run(deps as never)) as { deployment_check: unknown };
      expect(output.deployment_check).toEqual({
        contracts: Object.fromEntries(CONTRACT_NAMES.map((name) => [name, C[name]])),
        code_hashes_match_manifest: true,
        at_block: "26106200",
      });
      expect(chain.methods.eth_getCode).toBe(6);
    }
  });

  it("refuses to build any plan when one contract's code differs, naming it", async () => {
    for (const name of CONTRACT_NAMES) {
      for (const run of prepareCalls()) {
        const { chain, services, deps } = harness();
        services.quote = { status: 200, body: launchQuote({ specified: E18, calculated: 10n ** 21n }) };
        chain.codes[C[name]] = "0x6000";
        const error = await failure(() => run(deps as never));
        expect(error).toMatchObject({
          code: "deployment_mismatch",
          details: { contract: name, address: C[name], manifest_code_hash: keccak256(CODE[name]), observed_code_hash: keccak256("0x6000") },
        });
        // Nothing past the check: no api or quoter request was made.
        expect(services.requests).toEqual([]);
      }
    }
  });

  it("refuses an address with no code and a launch contract wired to another instance", async () => {
    const empty = harness();
    empty.chain.codes[C.launch_router] = "0x";
    expect(await failure(() => launchpadPrepareCreate(env(), createArgs() as never, empty.deps))).toMatchObject({
      code: "deployment_mismatch",
      details: { contract: "launch_router", observed_code_hash: null },
    });
    for (const link of ["scheduled_launch.LIQUIDITY", "scheduled_launch.TWAMM", "launch_router.EXTENSION", "launch_router.LIQUIDITY", "locked_launch_liquidity.EXTENSION"]) {
      const { chain, deps } = harness();
      chain.links[link] = OTHER;
      expect(await failure(() => launchpadPrepareCreate(env(), createArgs() as never, deps))).toMatchObject({
        code: "deployment_mismatch",
        details: { contract: link.split(".")[0], link: link.split(".")[1], observed: OTHER },
      });
    }
  });
});
