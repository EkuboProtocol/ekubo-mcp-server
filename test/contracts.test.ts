import { describe, expect, it } from "bun:test";
import {
  contractAddressResource,
  contractChainResource,
  contractDirectory,
} from "../src/contracts.js";

describe("contract resource provenance", () => {
  it("makes the source commit and snapshot state citable at every level", () => {
    const expected = {
      source_repository: "evm-contracts",
      source_commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      source_tag: expect.stringMatching(/^v/),
      source_worktree_dirty_at_snapshot: expect.any(Boolean),
    };
    expect(contractDirectory().provenance).toMatchObject(expected);
    expect(contractChainResource("4663")?.provenance).toMatchObject(expected);
    expect(
      contractAddressResource(
        "4663",
        "0x00000000000014aA86C5d3c41765bb24e11bd701",
      )?.provenance,
    ).toMatchObject(expected);
  });
});

