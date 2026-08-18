import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { errorResultDecodePlan, functionReadCall, readCallsBundle } from "./abi-decode.js";
import { ServiceError } from "./core.js";
import type { ExecutionPlanStepInput } from "./execution-plan.js";
import { preparedTransaction, preparedUiAction } from "./ui-actions.js";

/**
 * Merkl's reward Distributor, deployed at the same address on every chain in
 * `MERKL_DISTRIBUTOR_CHAIN_IDS`.
 *
 * The shared address is a convenience, never an assumption: ZKsync Era derives
 * contract addresses differently and has no code here at all, so a catalog
 * that inferred "same address everywhere" would happily prepare a claim
 * against an empty account. Membership below is per chain and was established
 * by reading code at this address and calling `getMerkleRoot()` on it — code
 * alone would also match an unrelated deployment that happened to land here.
 */
export const MERKL_DISTRIBUTOR = getAddress(
  "0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae",
);

/**
 * Chains where this server will prepare a Merkl claim, verified 2026-08-18.
 *
 * Merkl lists 67 chains. This is deliberately the subset each of which
 * answered `getMerkleRoot()` with a non-zero root at `MERKL_DISTRIBUTOR`, not
 * the subset Merkl advertises: an unverified chain returns
 * `unsupported_merkl_chain` rather than a plan nobody checked.
 */
export const MERKL_DISTRIBUTOR_CHAIN_IDS: ReadonlySet<string> = new Set([
  "1", // Ethereum
  "10", // OP Mainnet
  "56", // BNB Chain
  "100", // Gnosis
  "130", // Unichain
  "137", // Polygon
  "146", // Sonic
  "480", // World Chain
  "999", // HyperEVM
  "1868", // Soneium
  "4663", // Robinhood Chain
  "5000", // Mantle
  "8453", // Base
  "34443", // Mode
  "42161", // Arbitrum One
  "42220", // Celo
  "43114", // Avalanche
  "57073", // Ink
  "59144", // Linea
  "80094", // Berachain
  "81457", // Blast
  "534352", // Scroll
]);

export const MERKL_DISTRIBUTOR_ABI = parseAbi([
  "function claim(address[] users,address[] tokens,uint256[] amounts,bytes32[][] proofs)",
  "function getMerkleRoot() view returns (bytes32 root)",
  "function endOfDisputePeriod() view returns (uint48 endOfDisputePeriod)",
  "function disputer() view returns (address disputer)",
  "function claimed(address user,address token) view returns (uint208 amount,uint48 timestamp,bytes32 merkleRoot)",
  "function claimRecipient(address user,address token) view returns (address recipient)",
]);

/**
 * The Distributor's own reverts, so a failed simulation names the cause rather
 * than showing four opaque bytes. `InvalidProof` is the one that matters: it
 * is what a rotated or still-disputed root produces, and it means re-fetch,
 * never retry.
 */
export const MERKL_DISTRIBUTOR_ERRORS_ABI = parseAbi([
  "error InvalidProof()",
  "error NotWhitelisted()",
  "error InvalidLengths()",
  "error InvalidUninitializedRoot()",
  "error InvalidReturnMessage()",
]);

const ZERO_ADDRESS = getAddress("0x0000000000000000000000000000000000000000");
const LEAF_PARAMETERS = parseAbiParameters("address, address, uint256");
const NODE_PARAMETERS = parseAbiParameters("bytes32, bytes32");

/** Merkl's live trees are ~16 levels deep; this bounds a malformed input. */
const MAX_PROOF_DEPTH = 64;
const MAX_REWARDS_PER_CLAIM = 32;

export interface MerklRewardInput {
  token: string;
  amount: string;
  proofs: string[];
}

export function getMerklDeployment(input: { chainId?: string } = {}) {
  if (input.chainId !== undefined) requireSupportedChain(input.chainId);
  return {
    protocol: "merkl",
    network_access: "none",
    source: {
      documentation: "https://docs.merkl.xyz/",
      developer_portal: "https://developers.merkl.xyz/integrate-merkl/user-rewards",
      contracts: "https://developers.merkl.xyz/resources/chains-and-contracts",
      audits: [
        "https://code4rena.com/reports/2025-11-merkl",
        "https://code4rena.com/reports/2023-06-angle",
      ],
      snapshot_date: "2026-08-18",
    },
    agent_market_data_discovery: {
      server_involvement: "none",
      skill_resource: "ekubo://skills/use-merkl",
      method:
        "Query https://api.merkl.xyz/v4/users/{address}/rewards/summary directly for amount, claimed, pending, and proofs. The public API needs no key and allows 10 requests per second.",
      handoff:
        "Pass each token's exact amount and proofs to prepare_merkl_claim unchanged; this server never fetches, relays, or caches any Merkl response.",
    },
    deployment: {
      distributor: MERKL_DISTRIBUTOR,
      supported_chain_ids: [...MERKL_DISTRIBUTOR_CHAIN_IDS],
      verified_on: "2026-08-18",
      verification_method:
        "Code present at the address and getMerkleRoot() returning a non-zero root on each listed chain",
    },
    properties: {
      amounts_are_cumulative:
        "claim() transfers amount minus the cumulative total already claimed, so the claimable delta is amount - claimed, never amount",
      pending_is_not_claimable:
        "Merkl's pending field is earned but not yet in any root; it becomes claimable only after the next root is published, and adding it to amount double-counts",
      dispute_period:
        "getMerkleRoot() returns the previous root while a freshly published tree is inside its dispute window or under active dispute, so proofs for the new tree revert with InvalidProof until it becomes effective",
      self_claim_needs_no_authorization:
        "Anyone may call claim() for a user and the tokens still go to that user; an operator toggle only changes who pays gas and picks the timing",
      claim_recipient_override:
        "A recipient previously set through setClaimRecipient silently redirects the payout, which is why the validation reads include both claimRecipient slots",
    },
    limitations: {
      live_state:
        "No Merkl API, RPC, campaign, opportunity, reward, or proof state is queried by this server",
      chains: `Merkl lists 67 chains; preparation is limited to the ${MERKL_DISTRIBUTOR_CHAIN_IDS.size} verified here. ZKsync Era is deliberately absent: it has no code at the canonical Distributor address.`,
      automation:
        "Merkle proofs are off-chain and rotate with every root, so a wallet automation polling only on-chain state cannot build this claim; use a live agent or Merkl's own autoclaim operator",
    },
  };
}

/**
 * Build one `claim()` covering every supplied reward, and the reads that prove
 * it can succeed.
 *
 * The agent fetches `(token, amount, proofs)` from Merkl and this server never
 * sees the API. What makes that safe is not trust: the proof is folded here
 * into the root it implies, and the wallet reads the root the chain is
 * actually enforcing. Merkl is believed by neither side, and a proof for a
 * rotated or still-disputed tree fails simulation before anything is signed.
 *
 * No jurisdiction gate is applied, matching `prepare_rewards_claim` and the
 * server's stated rule that collecting what a user already earned is never
 * restricted.
 */
export function prepareMerklClaim(input: {
  chainId: string;
  sender: string;
  rewards: readonly MerklRewardInput[];
}) {
  requireSupportedChain(input.chainId);
  const sender = getAddress(input.sender);

  if (input.rewards.length === 0) {
    throw new ServiceError(
      "invalid_rewards",
      "At least one reward token is required",
    );
  }
  if (input.rewards.length > MAX_REWARDS_PER_CLAIM) {
    throw new ServiceError(
      "too_many_rewards",
      `At most ${MAX_REWARDS_PER_CLAIM} reward tokens can be claimed in one plan`,
    );
  }

  const seen = new Set<Address>();
  const rewards = input.rewards.map((reward) => {
    const token = getAddress(reward.token);
    if (token === ZERO_ADDRESS) {
      throw new ServiceError(
        "invalid_token",
        "Merkl distributes ERC-20 tokens; the zero address is not claimable",
      );
    }
    if (seen.has(token)) {
      throw new ServiceError(
        "duplicate_token",
        `Token ${token} appears more than once; one cumulative amount per token is what the tree holds`,
      );
    }
    seen.add(token);
    const amount = positiveUint256(reward.amount, "amount");
    const proofs = normalizeProofs(reward.proofs);
    return { token, amount, proofs, root: foldProof(sender, token, amount, proofs) };
  });

  // Every leaf in one call is verified against the single root the contract
  // reads at execution time, so a batch spanning two roots cannot succeed. It
  // is cheaper to refuse it here than to spend a simulation discovering it.
  const roots = new Set(rewards.map((reward) => reward.root));
  if (roots.size > 1) {
    throw new ServiceError(
      "inconsistent_merkle_roots",
      "These proofs fold to more than one root, so no single tree contains them all. Re-fetch every reward from Merkl in one request and prepare again.",
      { derived_roots: [...roots] },
    );
  }
  const derivedRoot = rewards[0].root;

  const transaction = preparedTransaction(
    input.chainId,
    MERKL_DISTRIBUTOR,
    encodeFunctionData({
      abi: MERKL_DISTRIBUTOR_ABI,
      functionName: "claim",
      args: [
        rewards.map(() => sender),
        rewards.map((reward) => reward.token),
        rewards.map((reward) => reward.amount),
        rewards.map((reward) => reward.proofs),
      ],
    }),
    0n,
  );
  const steps: ExecutionPlanStepInput[] = [
    {
      kind: "execution",
      transaction,
      revertDecode: errorResultDecodePlan(MERKL_DISTRIBUTOR_ERRORS_ABI),
    },
  ];

  return preparedUiAction({
    action: "merkl_claim_rewards",
    chainId: input.chainId,
    sender,
    request: {
      chain_id: input.chainId,
      sender,
      distributor: MERKL_DISTRIBUTOR,
      rewards: rewards.map((reward) => ({
        token: reward.token,
        cumulative_amount: reward.amount.toString(),
        proof_length: reward.proofs.length,
      })),
    },
    steps,
    details: {
      distributor: MERKL_DISTRIBUTOR,
      server_network_access: "none",
      derived_merkle_root: derivedRoot,
      derived_root_meaning:
        "Every supplied proof was folded here and yields this root. It is not evidence the root is live: compare it with the getMerkleRoot() read below before authorizing.",
      amounts_are_cumulative_not_deltas: true,
      transfers_amount_minus_already_claimed: true,
      claiming_for_self_requires_no_operator: true,
      token_count: rewards.length,
    },
    onchainValidation: {
      status: "not_executed",
      instruction:
        "Pass onchain_validation.read_calls_reference unchanged as wallet_batch_eth_call's reference argument. Require merkle_root to equal details.derived_merkle_root; a mismatch means the tree rotated or is still inside its dispute period, so re-fetch from Merkl and prepare again rather than sending. Require every claimed_* amount to be strictly below the matching cumulative_amount, or the claim transfers nothing. If a claim_recipient_* read returns a non-zero address, tell the user the payout goes there instead of to their own wallet before they authorize.",
      expected_merkle_root: derivedRoot,
      read_calls: readCallsBundle({
        chainId: input.chainId,
        from: sender,
        calls: [
          distributorRead("merkle_root", "getMerkleRoot", []),
          distributorRead("end_of_dispute_period", "endOfDisputePeriod", []),
          distributorRead("disputer", "disputer", []),
          ...rewards.flatMap((reward, index) => [
            distributorRead(`claimed_${index}`, "claimed", [sender, reward.token]),
            distributorRead(`claim_recipient_${index}`, "claimRecipient", [
              sender,
              reward.token,
            ]),
          ]),
          // The all-token default slot, which applies whenever the per-token
          // one is unset. Reading only the per-token slot would miss a
          // redirect the user set once for everything.
          distributorRead("claim_recipient_default", "claimRecipient", [
            sender,
            ZERO_ADDRESS,
          ]),
        ],
      }),
    },
  });
}

function distributorRead(
  id: string,
  functionName: "getMerkleRoot" | "endOfDisputePeriod" | "disputer" | "claimed" | "claimRecipient",
  args: readonly unknown[],
) {
  return functionReadCall({
    id,
    to: MERKL_DISTRIBUTOR,
    data: encodeFunctionData({
      abi: MERKL_DISTRIBUTOR_ABI,
      functionName,
      // biome-ignore lint/suspicious/noExplicitAny: one helper over five read shapes
      args: args as any,
    }),
    abi: MERKL_DISTRIBUTOR_ABI,
    functionName,
  });
}

/**
 * Recompute the root a Merkl proof implies.
 *
 * Both hashes use `abi.encode`, not the `abi.encodePacked` that
 * OpenZeppelin's `MerkleProof` and most tutorials use. The two agree on
 * nothing: a packed fold produces a plausible-looking root that matches no
 * tree, so this is the one place in the file where copying the usual pattern
 * would silently break every claim.
 */
export function foldProof(
  user: Address,
  token: Address,
  amount: bigint,
  proofs: readonly Hex[],
): Hex {
  let current = keccak256(
    encodeAbiParameters(LEAF_PARAMETERS, [user, token, amount]),
  );
  for (const sibling of proofs) {
    const pair: [Hex, Hex] =
      BigInt(current) < BigInt(sibling)
        ? [current, sibling]
        : [sibling, current];
    current = keccak256(encodeAbiParameters(NODE_PARAMETERS, pair));
  }
  return current;
}

function normalizeProofs(proofs: readonly string[]): Hex[] {
  if (proofs.length > MAX_PROOF_DEPTH) {
    throw new ServiceError(
      "invalid_proof",
      `A Merkl proof is at most ${MAX_PROOF_DEPTH} nodes deep`,
    );
  }
  return proofs.map((node) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(node)) {
      throw new ServiceError(
        "invalid_proof",
        "Every proof node must be a 32-byte hex string",
      );
    }
    return node.toLowerCase() as Hex;
  });
}

function requireSupportedChain(chainId: string) {
  if (!MERKL_DISTRIBUTOR_CHAIN_IDS.has(chainId)) {
    throw new ServiceError(
      "unsupported_merkl_chain",
      `Merkl claim preparation is not configured for chain ${chainId}. The Distributor was verified only on the listed chains; do not retry this claim through another Ekubo tool.`,
      { supported_chain_ids: [...MERKL_DISTRIBUTOR_CHAIN_IDS] },
    );
  }
}

function positiveUint256(value: string, label: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ServiceError(
      "invalid_integer",
      `${label} must be a positive decimal integer`,
    );
  }
  const parsed = BigInt(value);
  if (parsed >= 1n << 256n) {
    throw new ServiceError("integer_overflow", `${label} must fit uint256`);
  }
  return parsed;
}
