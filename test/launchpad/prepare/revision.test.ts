import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import abiRevision from "../../../src/launchpad/prepare/abis/revision.json";
import { ABI_REVISION, prepareManifest } from "../../../src/launchpad/prepare/contracts.js";
import { env, MANIFEST } from "./fake-chain.js";
import { rejection } from "./helpers.js";

const ABI_DIR = join(import.meta.dir, "../../../src/launchpad/prepare/abis");
const PINNED = "3e4ffad2446c7777c26e74caa809c3f77ee054e1";

function refusal(gitRevision: unknown) {
  try {
    prepareManifest({ LAUNCHPAD_MANIFEST: JSON.stringify({ ...MANIFEST, git_revision: gitRevision }) });
  } catch (error) {
    const e = error as { code?: string; details?: Record<string, unknown> };
    return { code: e.code, details: e.details };
  }
  throw new Error("expected a refusal");
}

describe("bundled launchpad ABIs", () => {
  it("are pinned to evm-contracts 3e4ffad", () => {
    expect(ABI_REVISION).toBe(PINNED);
  });

  it("match the build output recorded for the pinned revision, byte for byte", () => {
    const bundled = readdirSync(ABI_DIR).filter((name) => name !== "revision.json").sort();
    expect(Object.keys(abiRevision.abi_sha256).sort()).toEqual(bundled);
    for (const [name, digest] of Object.entries(abiRevision.abi_sha256)) {
      expect(createHash("sha256").update(readFileSync(join(ABI_DIR, name))).digest("hex")).toBe(digest);
    }
  });
});

describe("manifest revision gate", () => {
  it("accepts the deployment manifest written at 3e4ffad", () => {
    expect(MANIFEST.git_revision).toBe(PINNED);
    expect(prepareManifest(env()).git_revision).toBe(PINNED);
  });

  it("refuses every other revision, including a32c9e9 and c9bc329, prefixes, case changes and dirty builds", () => {
    for (const revision of [
      "e3781726c2bc5bb639cc80d5c9de9eac8efaf940",
      "87667a26fbe302e0b0b0e3c89dfaab19cb490e25",
      "a32c9e9e45526e01436d38a35cc970d3ae872ebe",
      "c9bc329b7abcdb2f326453525b1148b139b1c470",
      "0".repeat(40),
      "3e4ffad",
      `${PINNED}-dirty`,
      PINNED.toUpperCase(),
      ` ${PINNED}`,
      "",
    ]) {
      expect(refusal(revision)).toEqual({
        code: "abi_revision_mismatch",
        details: expect.objectContaining({ manifest_revision: revision, abi_revision: PINNED }),
      });
    }
  });

  it("refuses a manifest without a string revision", () => {
    for (const revision of [undefined, null, 0x3e4ffad]) {
      expect(refusal(revision)).toMatchObject({ code: "abi_revision_mismatch", details: { manifest_revision: "" } });
    }
  });

  it("refuses a preparation call against the e3781726 manifest", async () => {
    expect(await rejection({}, { git_revision: "e3781726c2bc5bb639cc80d5c9de9eac8efaf940" })).toMatchObject({
      code: "abi_revision_mismatch",
      details: { manifest_revision: "e3781726c2bc5bb639cc80d5c9de9eac8efaf940", abi_revision: PINNED },
    });
  });
});
