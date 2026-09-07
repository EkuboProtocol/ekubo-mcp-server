import { describe, expect, it } from "bun:test";
import {
  contractAddressResource,
  contractChainResource,
  contractDirectory,
  isOrdersV3Address,
  isPositionsV3Address,
  ORDERS_V3_ADDRESSES,
  ordersV3Address,
  POSITIONS_V3_ADDRESSES,
  positionsV3Address,
  tokenDataFetcherContract,
} from "../src/contracts.js";
import releaseDeployments from "../script/evm-contracts-release-deployments.json";

const productionChainIds = [
  "1",
  "10",
  "56",
  "100",
  "130",
  "137",
  "143",
  "480",
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

  // The recompile in v3.2.0 moved Positions and Orders. Getting this wrong is
  // silent: the plan is built against an address with no code on that chain.
  const [POSITIONS_ORIGINAL, POSITIONS_RECOMPILED] = POSITIONS_V3_ADDRESSES;
  const [ORDERS_ORIGINAL, ORDERS_RECOMPILED] = ORDERS_V3_ADDRESSES;
  const originalManagerChainIds = ["1", "143", "4326", "4663", "8453", "42161"];

  it("prefers the original managers only where they are actually deployed", () => {
    for (const chainId of productionChainIds) {
      const expectsOriginal = originalManagerChainIds.includes(chainId);
      expect({
        chainId,
        positions: positionsV3Address(chainId),
      }).toEqual({
        chainId,
        positions: expectsOriginal ? POSITIONS_ORIGINAL : POSITIONS_RECOMPILED,
      });
      // Orders moved in the same recompile and splits the chains identically.
      expect({ chainId, orders: ordersV3Address(chainId) }).toEqual({
        chainId,
        orders: expectsOriginal ? ORDERS_ORIGINAL : ORDERS_RECOMPILED,
      });
    }
  });

  it("resolves every chain's managers to a contract in the catalog", () => {
    for (const chainId of productionChainIds) {
      const contracts = contractChainResource(chainId)?.contracts ?? {};
      expect({
        chainId,
        positions: contracts[positionsV3Address(chainId)]?.name,
      }).toEqual({ chainId, positions: "Positions" });
      expect({ chainId, orders: contracts[ordersV3Address(chainId)]?.name }).toEqual(
        { chainId, orders: "Orders" },
      );
    }
  });

  it("recognizes a position or order from either generation on any chain", () => {
    for (const address of POSITIONS_V3_ADDRESSES) {
      expect(isPositionsV3Address(address)).toBe(true);
    }
    for (const address of ORDERS_V3_ADDRESSES) {
      expect(isOrdersV3Address(address)).toBe(true);
    }
    expect(isPositionsV3Address(ORDERS_ORIGINAL)).toBe(false);
    expect(isOrdersV3Address(POSITIONS_ORIGINAL)).toBe(false);
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
