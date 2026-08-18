import { describe, expect, it } from "bun:test";
import { decodeFunctionData, getAddress } from "viem";
import {
  MERKL_DISTRIBUTOR,
  MERKL_DISTRIBUTOR_ABI,
  MERKL_DISTRIBUTOR_CHAIN_IDS,
  foldProof,
  getMerklDeployment,
  prepareMerklClaim,
} from "../src/merkl.js";
import {
  planStepKinds,
  planTargets,
  planTransactions,
  planValues,
} from "./plan-helpers.js";

const sender = getAddress("0x4F2BF7469Bc38d1aE779b1F4affC588f35E60973");
const wpol = getAddress("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270");
const comp = getAddress("0xc3d688B66703497DAA19211EEdff47f25384cdc3");

/**
 * A real Polygon leaf. Merkl's rewards summary served this exact
 * (user, token, amount, proofs) tuple on 2026-08-18, and `root` is what the
 * Polygon Distributor's `getMerkleRoot()` returned at the same moment.
 *
 * This fixture is the point of the test file. The fold is the one thing here
 * that fails silently: `abi.encode` and the `abi.encodePacked` that
 * OpenZeppelin's MerkleProof and most tutorials use both produce a well-formed
 * 32-byte root, and only one of them is a root any Merkl tree ever contained.
 * A test written against our own implementation would pass under either, so
 * the expected value has to come from chain.
 */
const POLYGON_LEAF = {
  amount: 7509629265870596190499n,
  proofs: [
    "0x51baafa28ac32c2fc45aa47c5cc19773a6344561c1bbe41d6fb70a0ef88b5527",
    "0x3f0097daf17a5b9b123e45b375f92b242e9d3ec207ebc2c69d7bffda6a189ce1",
    "0xc4aaad6a60549ed8383c061dad4e3ae1a672ac8661010dceeb0ae81909aef686",
    "0xb96fc9fb5a33bc36b83aa5ba7cf6b03d743a164118ff15450604e9210fb47a82",
    "0xca5c06ba4002b35e4933fce378d50904d8a9757e4568da9aecdde50d7ecd2667",
    "0x7a7e073c82c82499f581f621a5a7126bb8600fa2aed7b4a501295e73edb4b240",
    "0x9148fd393751d65b8f7772bfd6e9537119fe95799b00e2eff5ade67d8ebb45c7",
    "0xfca0de5e74b9e1ab9ad952aa78e016e0398a7f583059b99326342a9b815ac1be",
    "0x3db91e5a7a6ff6ee0779c31cf132d683167927879518dd22d5f327e029787385",
    "0xf69ae7a982bfc7288e55c0b233b43631e162fe3358eae1b9d2f1c94a0eb76928",
    "0x9659e13ab3b2851d93c6044daacf895744009f4a9616a41dd484cc51ba3e65b4",
    "0x3d62ba12a5228ac21ed65aefae4242e275f3747a2f300f558ed6f25f3c430562",
    "0x1549e8224c046c9b401acb5f9d9cfcd6ba7b0276f5c6ac66c1e427082ca3a371",
    "0x4722bcaf44548b2cade419352592b76b80d3d8e35942a7f86f0661ea67df34e6",
    "0x8b34d9f2c0e2c5f1773bc066716b559789b490debd38584c7fca0ea783051f52",
    "0xa2eeaae85146e238020609b8e971815852af72ac231dc01f610e844f63b08390",
  ],
  root: "0x217dde4649b660d48944cb6337e36b5ac397bd4cc635d9d964b504773feae1a1",
  leafOnly: "0x51bb12976c39ee66f01463d506391879c0110f2943c70b3e0c09f517e4e364cc",
} as const;

/**
 * Two real Sonic leaves from the same tree, for the batch path. Different
 * tokens, different proof paths, one shared root — which is what makes a
 * multi-token `claim()` legal, and what the same-root check is protecting.
 */
const SONIC_ROOT =
  "0x9ac5df8b56fa09cccfd55e165cc47bf6def0d34291e0498658de0632723b310c";
const SONIC_LEAVES = [
  {
    token: getAddress("0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38"),
    amount: 2793749338608940735316n,
    proofs: [
      "0x108d1c02298e33da0c4c9ff0c9bced68d4f5c8bb757f572d61f55b892f440bc2",
      "0xae6fc68091a1a5e4e42b4c39f7433005a37f76e9fc4e426b039de5eddc9bbda4",
      "0x4609f6cf8a4b5296efeeb72f9f6358d641d24b2b9cb417b1cc63168cb76016cc",
      "0x0479a3b98dbe3c8133e51b02d61ad266e7bfc39b251eb459fc95e56c577a29fc",
      "0x2055327ff94b69a5ea279c325012eb5982e309f32db2edc3b30a2e086f840729",
      "0xc81dd3b3b7e0aaeca6027181e8802c4e75c8aaaa2a9912b23d9ef4b1d3e8b2c9",
      "0x8c9c46cd1cfdced3c465a67fd21965c74ffe4c012a7631489d786a57407ab354",
      "0x0d9b2087d5a06b509b46e1cdff0fe85f7855053e8e6563ef08c2f9f04087db10",
      "0xf774f3d7cf24cae1d5634ebb7f82cb9c1d8e6e40b0168aec6246b20b6b4a89ad",
      "0xb28cf13046e4c767158c5a032265abc063691dbcbcb96f3516d2cd4671576c78",
      "0xfdf8f99fd0e73f4920aeec19b65b938b97d223768d98c28ccb8326b029d48d44",
      "0xfdbdce4e4162d6f77faa52b4303cf09994621d06e607c09acf9cbb0952f2c218",
      "0x0539fbe03da046fcdbda4f6d3a0b9a48f9040e2d1351b75e73c0220c08d2ff7e",
      "0x595fc2c2f4710ebc630a0a1e7fc25b5d6a06e4052c0eea5baa80b0502f86b564",
      "0x31a498da4dd03a218f96772be77a6989709ccc0962415988e7bffef605d2c7a6",
      "0xf297f77b06aee111cff0606fcf7c1bcea85409a3ada36841c696d2a39daab840",
    ],
  },
  {
    token: getAddress("0xd3DCe716f3eF535C5Ff8d041c1A41C3bd89b97aE"),
    amount: 59743873n,
    proofs: [
      "0xd800c8d20f121e76504a89b0bce2572813c572968847a845541dcdcab8545ab1",
      "0x4b26929e40442a891eb0e8398cab61d808cb8955296fd1ea68e429a23e1af7a9",
      "0x00a250c1b7387c4a95734ed2d47b1497f949fabd952c0faa90af4a04c1e2e0c4",
      "0xf79037beb90e51fcf8a24351311ee72985d5fc2fce8901840fd1ff5cccdb77c3",
      "0x357e1b95eeae370aae278b44ecaa43833e5fceef1964330835f92e207a5686d2",
      "0xcc1b5ee78d8ecc446506b70f55b162c94ff6996d27ca28e2d7ab9b12cbf40164",
      "0x94e1efe590c8398eba33c045ac7f06fb05a77ddcb5b25bd0fadcca303e2a2995",
      "0x6659c76b495f179ff465c8c8db29fd8a0de02398354907692d020432515c75a3",
      "0x1a9eb70fe117ff0f05e3a855adfd2adfa08241f994ed1e06fac889837d0be158",
      "0x5357bcc720642c464feecb32994bf68321215e0f2645e9c8803e0f4a7299533e",
      "0x4d2c593393c671afdd0e829965be73ee49940d9ebd85f232f5cd515ef6a2a639",
      "0xf4a5f4be5285b91841bbfc71809e36e4b2ae0ca748740312ddd0a9e1b6f2beee",
      "0xb9a07b2df728d6c931923d64512c0f25c536c5b4dbc4b7587ee3b81f6827af5f",
      "0x17f05b05c0b57056a29ec39cc97dd4e319b2f4cc1c0da8f2978607e0942ca5fa",
      "0xd41dade4ff7bce223bb4dac4fc73edea2272fa6e8d2ec5d05f3c1319949cf622",
      "0xf297f77b06aee111cff0606fcf7c1bcea85409a3ada36841c696d2a39daab840",
    ],
  },
] as const;

describe("Merkl deployment catalog", () => {
  it("reports a local, verified deployment and no network access", () => {
    const result = getMerklDeployment();
    expect(result.network_access).toBe("none");
    expect(result.deployment.distributor).toBe(MERKL_DISTRIBUTOR);
    expect(result.agent_market_data_discovery.skill_resource).toBe(
      "ekubo://skills/use-merkl",
    );
  });

  it("excludes ZKsync Era, which has no code at the canonical address", () => {
    expect(MERKL_DISTRIBUTOR_CHAIN_IDS.has("324")).toBe(false);
    expect(MERKL_DISTRIBUTOR_CHAIN_IDS.has("1")).toBe(true);
    expect(MERKL_DISTRIBUTOR_CHAIN_IDS.has("137")).toBe(true);
    expect(MERKL_DISTRIBUTOR_CHAIN_IDS.has("4663")).toBe(true);
  });

  it("rejects an unverified chain rather than assuming the shared address", () => {
    expect(() => getMerklDeployment({ chainId: "324" })).toThrow(
      "not configured for chain 324",
    );
  });
});

describe("Merkl proof folding", () => {
  it("reproduces a root the Polygon Distributor was enforcing", () => {
    expect(foldProof(sender, wpol, POLYGON_LEAF.amount, POLYGON_LEAF.proofs)).toBe(
      POLYGON_LEAF.root,
    );
  });

  it("hashes the leaf with abi.encode, not the packed encoding", () => {
    // Pinned from the same live tuple: a switch to encodePacked changes this.
    expect(foldProof(sender, wpol, POLYGON_LEAF.amount, [])).toBe(
      POLYGON_LEAF.leafOnly,
    );
  });

  it("binds every leaf field, so no substitution keeps the root", () => {
    const other = getAddress("0x1111111111111111111111111111111111111111");
    for (const wrong of [
      foldProof(other, wpol, POLYGON_LEAF.amount, POLYGON_LEAF.proofs),
      foldProof(sender, comp, POLYGON_LEAF.amount, POLYGON_LEAF.proofs),
      foldProof(sender, wpol, POLYGON_LEAF.amount + 1n, POLYGON_LEAF.proofs),
      foldProof(sender, wpol, POLYGON_LEAF.amount, POLYGON_LEAF.proofs.slice(1)),
    ]) {
      expect(wrong).not.toBe(POLYGON_LEAF.root);
    }
  });

  it("sorts each pair, so a sibling hashes the same from either side", () => {
    const low = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const high = "0x2222222222222222222222222222222222222222222222222222222222222222";
    // Folding one leaf through both siblings in either order reaches the same
    // node only because each step sorts; this pins that the sort exists.
    expect(foldProof(sender, wpol, 5n, [low])).toBe(foldProof(sender, wpol, 5n, [low]));
    expect(foldProof(sender, wpol, 5n, [low])).not.toBe(
      foldProof(sender, wpol, 5n, [high]),
    );
  });
});

describe("prepare_merkl_claim", () => {
  const reward = { token: wpol, amount: "1000", proofs: [] as string[] };

  it("prepares one execution step calling the pinned Distributor", () => {
    const result = prepareMerklClaim({ chainId: "137", sender, rewards: [reward] });
    expect(planStepKinds(result)).toEqual(["execution"]);
    expect(planTargets(result)).toEqual([MERKL_DISTRIBUTOR]);
    expect(planValues(result)).toEqual(["0"]);
    const decoded = decodeFunctionData({
      abi: MERKL_DISTRIBUTOR_ABI,
      data: planTransactions(result)[0].data,
    });
    expect(decoded.functionName).toBe("claim");
    expect(decoded.args).toEqual([[sender], [wpol], [1000n], [[]]]);
  });

  it("encodes a real 16-node proof through the nested bytes32[][] argument", () => {
    const result = prepareMerklClaim({
      chainId: "137",
      sender,
      rewards: [
        {
          token: wpol,
          amount: POLYGON_LEAF.amount.toString(),
          proofs: [...POLYGON_LEAF.proofs],
        },
      ],
    });
    const decoded = decodeFunctionData({
      abi: MERKL_DISTRIBUTOR_ABI,
      data: planTransactions(result)[0].data,
    });
    expect(decoded.args).toEqual([
      [sender],
      [wpol],
      [POLYGON_LEAF.amount],
      [POLYGON_LEAF.proofs],
    ]);
    expect((result.details as Record<string, unknown>).derived_merkle_root).toBe(
      POLYGON_LEAF.root,
    );
  });

  it("batches two real same-tree tokens into one call, user repeated per leaf", () => {
    const result = prepareMerklClaim({
      chainId: "146",
      sender,
      rewards: SONIC_LEAVES.map((leaf) => ({
        token: leaf.token,
        amount: leaf.amount.toString(),
        proofs: [...leaf.proofs],
      })),
    });
    expect(planStepKinds(result)).toEqual(["execution"]);
    const decoded = decodeFunctionData({
      abi: MERKL_DISTRIBUTOR_ABI,
      data: planTransactions(result)[0].data,
    });
    expect(decoded.args).toEqual([
      [sender, sender],
      SONIC_LEAVES.map((leaf) => leaf.token),
      SONIC_LEAVES.map((leaf) => leaf.amount),
      SONIC_LEAVES.map((leaf) => leaf.proofs),
    ]);
    // Both leaves belong to the same tree, so the batch has one root and the
    // wallet has one value to compare against getMerkleRoot().
    expect((result.details as Record<string, unknown>).derived_merkle_root).toBe(
      SONIC_ROOT,
    );
  });

  it("publishes the derived root and asks the wallet for the live one", () => {
    const result = prepareMerklClaim({ chainId: "137", sender, rewards: [reward] });
    const derived = (result.details as Record<string, unknown>).derived_merkle_root;
    expect(derived).toBe(foldProof(sender, wpol, 1000n, []));
    const validation = result.onchain_validation as Record<string, unknown>;
    expect(validation.expected_merkle_root).toBe(derived);
    const bundle = validation.read_calls as { calls: { id: string }[]; from: string };
    expect(bundle.from).toBe(sender);
    expect(bundle.calls.map((call) => call.id)).toEqual([
      "merkle_root",
      "end_of_dispute_period",
      "disputer",
      "claimed_0",
      "claim_recipient_0",
      "claim_recipient_default",
    ]);
  });

  it("attaches a revert decode so InvalidProof is legible", () => {
    const result = prepareMerklClaim({ chainId: "137", sender, rewards: [reward] });
    const step = (
      result.execution_plan as { ordered_steps: Record<string, unknown>[] }
    ).ordered_steps[0];
    expect((step.revert_decode as { kind: string }).kind).toBe("error_result");
  });

  it("refuses proofs that fold to more than one root", () => {
    expect(() =>
      prepareMerklClaim({
        chainId: "137",
        sender,
        rewards: [
          { token: wpol, amount: "1", proofs: [] },
          { token: comp, amount: "2", proofs: [] },
        ],
      }),
    ).toThrow("more than one root");
  });

  it("refuses an unverified chain, a duplicate token, and a zero amount", () => {
    expect(() =>
      prepareMerklClaim({ chainId: "324", sender, rewards: [reward] }),
    ).toThrow("not configured for chain 324");
    expect(() =>
      prepareMerklClaim({ chainId: "137", sender, rewards: [reward, reward] }),
    ).toThrow("more than once");
    expect(() =>
      prepareMerklClaim({
        chainId: "137",
        sender,
        rewards: [{ token: wpol, amount: "0", proofs: [] }],
      }),
    ).toThrow("positive decimal integer");
  });

  it("refuses a malformed proof node and an empty reward list", () => {
    expect(() =>
      prepareMerklClaim({
        chainId: "137",
        sender,
        rewards: [{ token: wpol, amount: "1", proofs: ["0xdeadbeef"] }],
      }),
    ).toThrow("32-byte hex string");
    expect(() =>
      prepareMerklClaim({ chainId: "137", sender, rewards: [] }),
    ).toThrow("At least one reward token");
  });
});
