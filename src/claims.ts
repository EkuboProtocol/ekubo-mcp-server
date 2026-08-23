import {
  encodeFunctionData,
  getAddress,
  multicall3Abi,
  numberToHex,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { functionReadCall, readCallsBundle } from "./abi-decode.js";
import { type Env, ServiceError } from "./core.js";
import { preparedTransaction, preparedUiAction } from "./ui-actions.js";

const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11");
const REVENUE_BUYBACKS = getAddress(
  "0x7CA5F67ee6025A4d433ca0595889c76CC960C48A",
);

const INCENTIVES_ABI = parseAbi([
  "function claim((address owner,address token,bytes32 root) key,(uint256 index,address account,uint128 amount) claim,bytes32[] proof)",
  "function isClaimed((address owner,address token,bytes32 root) key,uint256 index) view returns (bool)",
  "function isAvailable((address owner,address token,bytes32 root) key,uint256 index,uint128 amount) view returns (bool)",
]);
const INCENTIVES_V2 = getAddress("0xBe4C4C4e35DED081831A1f04e24E84dEFbA75fEC");
const INCENTIVES_DATA_FETCHER_V3 = getAddress(
  "0x69F9eCfa84CF0C41bE9F68b557b07b6b89d71eD0",
);
const INTERFACE_EVM_CHAIN_IDS = new Set([
  1n,
  4_663n,
  8_453n,
  42_161n,
  46_630n,
  84_532n,
  421_614n,
  11_155_111n,
]);
const REVENUE_BUYBACKS_ABI = parseAbi([
  "function collect(address sellToken,uint64 fee,uint64 endTime) payable",
  "function withdrawProtocolFees(address token0,address token1) payable",
  "function roll(address token) payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);

export interface RewardsClaimInput {
  dropAddress: string;
  key: { owner: string; token: string; root: Hex };
  claim: { index: string; account: string; amount: string };
  proof: Hex[];
}

export async function getRewardsClaimsByOwner(
  env: Env,
  input: { owner: string },
  fetcher: typeof fetch = fetch,
) {
  const owner = getAddress(input.owner);
  const url = new URL(
    `/claims/${encodeURIComponent(owner)}`,
    `${env.EKUBO_API_URL.replace(/\/+$/, "")}/`,
  );
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new ServiceError(
      "invalid_upstream_response",
      "Rewards claim endpoint returned non-JSON content",
    );
  }
  if (!response.ok) {
    throw new ServiceError(
      "upstream_error",
      `${response.status} ${response.statusText} from ${url}`,
      body,
    );
  }
  if (!isRecord(body) || !Array.isArray(body.claims)) {
    throw new ServiceError(
      "invalid_upstream_response",
      "Rewards claim response is missing its claims array",
    );
  }
  const evmClaims = body.claims.filter((value) => {
    if (!isRecord(value)) return false;
    try {
      return INTERFACE_EVM_CHAIN_IDS.has(BigInt(String(value.chainId)));
    } catch {
      return false;
    }
  });
  const claims = evmClaims.map((value, index) =>
    normalizeIndexedRewardClaim(value, index, owner),
  );
  return {
    owner,
    claims,
    onchain_validation: {
      status: "not_executed",
      // Two reads per claim, grouped into one stored bundle per chain. Each
      // claim's is_claimed/is_available results are addressed by call id.
      validation_reads: (() => {
        const callsByChain = new Map<
          string,
          ReturnType<typeof functionReadCall>[]
        >();
        for (const [index, item] of claims.entries()) {
          const target =
            item.drop_address === INCENTIVES_V2
              ? INCENTIVES_V2
              : INCENTIVES_DATA_FETCHER_V3;
          const chainCalls = callsByChain.get(item.chain_id) ?? [];
          chainCalls.push(
            functionReadCall({
              id: `ekubo-reward-claim-${index}-is-claimed`,
              to: target,
              data: encodeFunctionData({
                abi: INCENTIVES_ABI,
                functionName: "isClaimed",
                args: [item.key, BigInt(item.claim.index)],
              }),
              abi: INCENTIVES_ABI,
              functionName: "isClaimed",
            }),
            functionReadCall({
              id: `ekubo-reward-claim-${index}-is-available`,
              to: target,
              data: encodeFunctionData({
                abi: INCENTIVES_ABI,
                functionName: "isAvailable",
                args: [
                  item.key,
                  BigInt(item.claim.index),
                  BigInt(item.claim.amount),
                ],
              }),
              abi: INCENTIVES_ABI,
              functionName: "isAvailable",
            }),
          );
          callsByChain.set(item.chain_id, chainCalls);
        }
        // The wallet boundary caps a bundle at 128 calls; chunk beyond it.
        const MAX_CALLS_PER_BUNDLE = 128;
        return [...callsByChain.entries()].flatMap(([chainId, chainCalls]) => {
          const chunks = [];
          for (
            let start = 0;
            start < chainCalls.length;
            start += MAX_CALLS_PER_BUNDLE
          ) {
            chunks.push({
              chain_id: chainId,
              read_calls: readCallsBundle({
                chainId,
                calls: chainCalls.slice(start, start + MAX_CALLS_PER_BUNDLE),
              }),
            });
          }
          return chunks;
        });
      })(),
      call_id_pattern:
        "ekubo-reward-claim-<claim_index>-is-claimed and ekubo-reward-claim-<claim_index>-is-available, both decoding as bool",
      instruction:
        "Pass each validation_reads entry's read_calls_reference unchanged as wallet_batch_eth_call's reference argument on its stated chain. A claim is executable only when is_claimed=false and is_available=true; then pass its prepare_input unchanged to prepare_rewards_claim grouped by chain_id.",
    },
    source_url: url.toString(),
    ignored_non_evm_claim_count: body.claims.length - evmClaims.length,
    next_step:
      "Run the stored validation reads through the wallet, group available unclaimed records by chain, then call prepare_rewards_claim with each record's prepare_input. Do not reconstruct the read or claim calldata.",
    cache: { mcp_result_storage: "wallet_read_bundles_only" },
  };
}

export function prepareRewardsClaim(input: {
  chainId: string;
  sender: string;
  claims: RewardsClaimInput[];
}) {
  const sender = normalizeAddress(input.sender, "sender");
  if (input.claims.length === 0 || input.claims.length > 200) {
    throw new ServiceError(
      "invalid_claims",
      "Provide between 1 and 200 rewards claims from one chain",
    );
  }
  const claims = input.claims.map((item, index) => {
    const dropAddress = normalizeAddress(
      item.dropAddress,
      `claims[${index}].drop_address`,
    );
    const owner = normalizeAddress(item.key.owner, `claims[${index}].key.owner`);
    const account = normalizeAddress(
      item.claim.account,
      `claims[${index}].claim.account`,
    );
    if (owner !== sender || account !== sender) {
      throw new ServiceError(
        "claim_owner_mismatch",
        `claims[${index}] owner and account must equal sender`,
      );
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(item.key.root)) {
      throw new ServiceError(
        "invalid_claim",
        `claims[${index}].key.root must be bytes32`,
      );
    }
    if (!item.proof.every((proof) => /^0x[0-9a-fA-F]{64}$/.test(proof))) {
      throw new ServiceError(
        "invalid_claim",
        `claims[${index}].proof contains a non-bytes32 item`,
      );
    }
    return {
      dropAddress,
      key: {
        owner,
        token: normalizeAddress(item.key.token, `claims[${index}].key.token`),
        root: item.key.root,
      },
      claim: {
        index: unsigned(item.claim.index, 256, `claims[${index}].index`),
        account,
        amount: positiveUnsigned(
          item.claim.amount,
          128,
          `claims[${index}].amount`,
        ),
      },
      proof: item.proof,
    };
  });
  const calls = claims.map((claim) => ({
    target: claim.dropAddress,
    allowFailure: true,
    callData: encodeFunctionData({
      abi: INCENTIVES_ABI,
      functionName: "claim",
      args: [claim.key, claim.claim, claim.proof],
    }),
  }));
  const target = calls.length === 1 ? calls[0].target : MULTICALL3;
  const data =
    calls.length === 1
      ? calls[0].callData
      : encodeFunctionData({
          abi: multicall3Abi,
          functionName: "aggregate3",
          args: [calls],
        });
  const transaction = preparedTransaction(input.chainId, target, data, 0n);

  return preparedUiAction({
    action: "ekubo_claim_incentive_rewards",
    chainId: input.chainId,
    sender,
    request: {
      chain_id: input.chainId,
      sender,
      claim_count: claims.length,
    },
    transaction,
    details: {
      multicall3: calls.length > 1 ? MULTICALL3 : null,
      independent_claim_failures_are_allowed: calls.length > 1,
      exact_claim_count: claims.length,
    },
  });
}

export function prepareRevenueBuybacks(input: {
  chainId: string;
  sender: string;
  endedOrderCollects: { sellToken: string; fee: string; endTime: string }[];
  protocolFeePairs: { token0: string; token1: string }[];
  rollTokens: string[];
}) {
  if (input.chainId !== "1") {
    throw new ServiceError(
      "unsupported_chain",
      "The interface's Positions revenue buybacks action is available only on Ethereum mainnet",
    );
  }
  const sender = getAddress(input.sender);
  if (
    input.endedOrderCollects.length +
      input.protocolFeePairs.length +
      input.rollTokens.length ===
    0
  ) {
    throw new ServiceError("no_work", "Select at least one buyback action");
  }
  const calls: Hex[] = [];
  for (const [index, item] of input.endedOrderCollects.entries()) {
    const sellToken = getAddress(item.sellToken);
    const fee = unsigned(item.fee, 64, `ended_order_collects[${index}].fee`);
    const endTime = unsigned(
      item.endTime,
      64,
      `ended_order_collects[${index}].end_time`,
    );
    calls.push(
      encodeFunctionData({
        abi: REVENUE_BUYBACKS_ABI,
        functionName: "collect",
        args: [sellToken, fee, endTime],
      }),
    );
  }
  for (const [index, pair] of input.protocolFeePairs.entries()) {
    const token0 = getAddress(pair.token0);
    const token1 = getAddress(pair.token1);
    if (BigInt(token0) >= BigInt(token1)) {
      throw new ServiceError(
        "invalid_pair",
        `protocol_fee_pairs[${index}] tokens are not sorted`,
      );
    }
    calls.push(
      encodeFunctionData({
        abi: REVENUE_BUYBACKS_ABI,
        functionName: "withdrawProtocolFees",
        args: [token0, token1],
      }),
    );
  }
  for (const tokenValue of input.rollTokens) {
    const token = getAddress(tokenValue);
    calls.push(
      encodeFunctionData({
        abi: REVENUE_BUYBACKS_ABI,
        functionName: "roll",
        args: [token],
      }),
    );
  }
  // One step per call. An opaque `bytes[]` payload collapses the batch into a
  // single allowlisted target the wallet cannot decode; separate steps are each
  // read and authorized, and the atomic batch keeps them all-or-nothing.
  const transactions = calls.map((call) =>
    preparedTransaction(input.chainId, REVENUE_BUYBACKS, call, 0n),
  );

  return preparedUiAction({
    action: "ekubo_process_revenue_buybacks",
    chainId: input.chainId,
    sender,
    request: {
      chain_id: input.chainId,
      sender,
      ended_order_collects: input.endedOrderCollects,
      protocol_fee_pairs: input.protocolFeePairs,
      roll_tokens: input.rollTokens,
    },
    steps: transactions.map((transaction) => ({
      kind: "execution" as const,
      transaction,
    })),
    atomicBatchRequired: transactions.length > 1,
    details: {
      permissionless_maintenance: true,
      revenue_buybacks_contract: REVENUE_BUYBACKS,
      exact_selected_call_count: calls.length,
    },
  });
}

function normalizeIndexedRewardClaim(
  value: unknown,
  index: number,
  requestedOwner: Address,
) {
  try {
    if (
      !isRecord(value) ||
      !isRecord(value.key) ||
      !isRecord(value.claim) ||
      !Array.isArray(value.proof)
    ) {
      throw new Error("claim, key, or proof has the wrong shape");
    }
    const chainIdRaw = value.chainId;
    if (
      (typeof chainIdRaw !== "string" && typeof chainIdRaw !== "number") ||
      BigInt(chainIdRaw) <= 0n
    ) {
      throw new Error("chainId must be positive");
    }
    const chainId = BigInt(chainIdRaw).toString();
    const dropAddress = normalizeAddress(
      String(value.dropAddress),
      "drop_address",
    );
    const key = {
      owner: normalizeAddress(String(value.key.owner), "key.owner"),
      token: normalizeAddress(String(value.key.token), "key.token"),
      root: String(value.key.root) as Hex,
    };
    if (!/^0x[0-9a-fA-F]{64}$/.test(key.root)) {
      throw new Error("root must be bytes32");
    }
    const claimIndex = unsigned(String(value.claim.index), 256, "claim.index");
    const account = normalizeAddress(
      String(value.claim.account),
      "claim.account",
    );
    const amount = positiveUnsigned(
      String(value.claim.amount),
      128,
      "claim.amount",
    );
    const proof = value.proof.map((item) => String(item) as Hex);
    if (!proof.every((item) => /^0x[0-9a-fA-F]{64}$/.test(item))) {
      throw new Error("proof entries must be bytes32");
    }
    const prepareInput = {
      drop_address: dropAddress,
      key,
      claim: {
        index: claimIndex.toString(),
        account,
        amount: amount.toString(),
      },
      proof,
    };
    return {
      chain_id: chainId,
      campaign: typeof value.campaign === "string" ? value.campaign : null,
      drop_address: dropAddress,
      key,
      claim: prepareInput.claim,
      proof,
      requested_owner_matches_key: key.owner === requestedOwner,
      prepare_input: prepareInput,
    };
  } catch (error) {
    throw new ServiceError(
      "invalid_upstream_response",
      `Rewards claim ${index} is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

function unsigned(value: string, bits: number, label: string) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ServiceError("invalid_integer", `${label} must be decimal`);
  }
  const parsed = BigInt(value);
  if (parsed >= 1n << BigInt(bits)) {
    throw new ServiceError("integer_overflow", `${label} must fit uint${bits}`);
  }
  return parsed;
}

function positiveUnsigned(value: string, bits: number, label: string) {
  const parsed = unsigned(value, bits, label);
  if (parsed === 0n) {
    throw new ServiceError("invalid_integer", `${label} must be positive`);
  }
  return parsed;
}

// The claims API serializes addresses as unpadded hex integers, so a value with
// leading zero nibbles arrives shorter than 20 bytes (the EKUBO token reaches us
// as 0x4c46...d0f rather than 0x04c46...d0f). Widening to 20 bytes recovers the
// exact same address, and `numberToHex` still rejects anything that does not fit,
// so no value can be coerced into a different address.
function normalizeAddress(value: string, label: string): Address {
  try {
    return getAddress(numberToHex(BigInt(value), { size: 20 }));
  } catch {
    throw new ServiceError(
      "invalid_address",
      `${label} must be an address that fits in 20 bytes: ${value}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
