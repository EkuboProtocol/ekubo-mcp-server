import { describe, expect, it } from "bun:test";
import { decodeFunctionData, parseAbi, type Hex } from "viem";
import { fakeArtifactStore } from "./fake-r2.js";
import { planTransactions } from "./plan-helpers.js";
import type { Env } from "../src/core.js";
import { getRewardsClaimsByOwner, prepareRewardsClaim } from "../src/claims.js";

const env = {
  ARTIFACT_STORE: fakeArtifactStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused",
  ACROSS_API_KEY: "unused",
  ACROSS_INTEGRATOR_ID: "unused",
  LAYER_ZERO_API_KEY: "unused",
  LI_FI_API_KEY: "unused",
  DUNE_API_KEY: "unused",
} satisfies Env;

const CLAIM_ABI = parseAbi([
  "function claim((address owner,address token,bytes32 root) key,(uint256 index,address account,uint128 amount) claim,bytes32[] proof)",
]);

const requester = "0xf94e5Cdf41247E268d4847C30A0DC2893B33e85d";
const root =
  "0x7d981bf9012fe83a57881d633676e3d9c18fe3338289b00811a072da810a6ef4";
const proof: Hex[] = [
  "0xe8de05c93dba2365dc7cbfe7ecfb084863a35c2e658cf274b399a7896f10bbda",
];

// Verbatim shape of https://prod-api.ekubo.org/claims/<owner>: the drop owner and
// the EKUBO token both arrive as unpadded hex integers, 35 and 39 nibbles wide.
const UNPADDED_OWNER = "0xc771f6176268d5a9846e0956c3ef58597a1";
const UNPADDED_TOKEN = "0x4c46e830bb56ce22735d5d8fc9cb90309317d0f";
const PADDED_OWNER = "0x00000C771F6176268D5A9846E0956C3eF58597A1";
const PADDED_TOKEN = "0x04C46E830Bb56ce22735d5d8Fc9CB90309317d0f";

function upstreamClaim(overrides: Record<string, unknown> = {}) {
  return {
    campaign: "ekubo_dao_wave_zero",
    chainId: "0x1",
    dropAddress: "0xbe4c4c4e35ded081831a1f04e24e84defba75fec",
    claim: {
      account: "0xf94e5cdf41247e268d4847c30a0dc2893b33e85d",
      amount: "391177039545681936850",
      index: 0,
    },
    key: { owner: UNPADDED_OWNER, root, token: UNPADDED_TOKEN },
    proof,
    ...overrides,
  };
}

function fetcherFor(body: unknown) {
  return (async (_input: RequestInfo | URL) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

describe("getRewardsClaimsByOwner", () => {
  it("pads and checksums addresses the claims API sends as unpadded hex", async () => {
    const result = await getRewardsClaimsByOwner(
      env,
      { owner: requester },
      fetcherFor({ claims: [upstreamClaim()] }),
    );

    expect(result.claims).toHaveLength(1);
    const [claim] = result.claims;
    expect(claim.key.owner).toBe(PADDED_OWNER);
    expect(claim.key.token).toBe(PADDED_TOKEN);
    // Already 20 bytes upstream: normalization must only restore the checksum.
    expect(claim.drop_address).toBe("0xBe4C4C4e35DED081831A1f04e24E84dEFbA75fEC");
    expect(claim.claim.account).toBe(requester);
    // The drop owner is the campaign funder, not the requesting wallet.
    expect(claim.requested_owner_matches_key).toBe(false);
    // prepare_input is what downstream consumers hand back to us.
    expect(claim.prepare_input.key.owner).toBe(PADDED_OWNER);
    expect(claim.prepare_input.key.token).toBe(PADDED_TOKEN);
  });

  it("rejects an address that does not fit in 20 bytes", async () => {
    const wide = `0x1${"a".repeat(40)}`;
    await expect(
      getRewardsClaimsByOwner(
        env,
        { owner: requester },
        fetcherFor({
          claims: [upstreamClaim({ key: { owner: wide, root, token: UNPADDED_TOKEN } })],
        }),
      ),
    ).rejects.toThrow(/20 bytes/);
  });
});

describe("prepareRewardsClaim", () => {
  it("encodes unpadded addresses as their full 20-byte form", () => {
    const prepared = prepareRewardsClaim({
      chainId: "1",
      // Same account as key.owner below, so the sender guard is satisfied while
      // every address still arrives unpadded.
      sender: PADDED_OWNER,
      claims: [
        {
          dropAddress: "0xbe4c4c4e35ded081831a1f04e24e84defba75fec",
          key: { owner: UNPADDED_OWNER, token: UNPADDED_TOKEN, root },
          claim: {
            index: "0",
            account: UNPADDED_OWNER,
            amount: "391177039545681936850",
          },
          proof,
        },
      ],
    });

    const decoded = decodeFunctionData({
      abi: CLAIM_ABI,
      data: planTransactions(prepared)[0].data,
    });
    const [key, claim] = decoded.args;
    expect(key.owner).toBe(PADDED_OWNER);
    expect(key.token).toBe(PADDED_TOKEN);
    expect(claim.account).toBe(PADDED_OWNER);
  });
});
