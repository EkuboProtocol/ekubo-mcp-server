import { describe, expect, it } from "bun:test";
import {
  contractAddressResource,
  contractChainResource,
  contractDirectory,
  tokenDataFetcherContract,
} from "../src/contracts.js";
import releaseDeployments from "../script/evm-contracts-release-deployments.json";

const productionChainIds = [
  "1",
  "10",
  "56",
  "130",
  "137",
  "143",
  "4326",
  "4663",
  "8453",
  "42161",
  "57073",
];
const tokenDataFetcherAddress =
  "0x305Cf9A34dCb265522780D1D64544d3f7C450407";

describe("contract resource provenance", () => {
  it("makes the source commit and snapshot state citable at every level", () => {
    const provenances = [
      contractDirectory().provenance,
      contractChainResource("4663")!.provenance,
      contractAddressResource(
        "4663",
        "0x00000000000014aA86C5d3c41765bb24e11bd701",
      )!.provenance,
    ];

    for (const provenance of provenances) {
      expect(provenance.source_repository).toBe("evm-contracts");
      expect(provenance.source_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(provenance.source_tag).toMatch(/^v/);
      expect(provenance.source_release.tag).toBe("v3.2.0");
      expect(provenance.source_release.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(provenance.source_release.url).toBe(
        "https://github.com/EkuboProtocol/evm-contracts/releases/tag/v3.2.0",
      );
      expect(typeof provenance.source_worktree_dirty_at_snapshot).toBe(
        "boolean",
      );
    }
  });

  it("merges every production release deployment with broadcast deployments", () => {
    for (const group of releaseDeployments.deployment_groups) {
      for (const chainId of group.chain_ids) {
        for (const contract of group.contracts) {
          expect(
            contractAddressResource(chainId, contract.address),
          ).toMatchObject({ name: contract.name });
        }
      }
    }

    for (const chainId of productionChainIds) {
      expect(tokenDataFetcherContract(chainId)?.address).toBe(
        tokenDataFetcherAddress,
      );
      expect(contractChainResource(chainId)?.contracts).toHaveProperty(
        tokenDataFetcherAddress,
      );
    }
  });

  it("retains release addresses whose legacy ABI is absent from the checkout", () => {
    const legacyRouter = contractAddressResource(
      "8453",
      "0xd26f20001a72a18C002b00e6710000d68700ce00",
    );
    expect(legacyRouter).toMatchObject({
      name: "MEVCaptureRouter",
      abi_snapshot: { available: false },
      abi_unavailable: expect.any(String),
    });
    expect(legacyRouter).not.toHaveProperty("abi");
  });
});
