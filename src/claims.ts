import {
  encodeFunctionData,
  getAddress,
  multicall3Abi,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { localFunctionResultMetadata } from "./abi-decode.js";
import { type Env, ServiceError } from "./core.js";
import { preparedTransaction, preparedUiAction } from "./ui-actions.js";

const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11");
const RECOVERY_FUND = getAddress("0x5E1da6D39d2Aa65B4739EcE2CDE1Ae77d22ECA63");
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
const RECOVERY_ABI = parseAbi([
  "function agreeToClaimConditions(address account,bytes signature)",
  "function claim(address account,address token,uint256 amount)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
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
      exact_read_list: claims.flatMap((item, index) => {
        const target =
          item.drop_address === INCENTIVES_V2
            ? INCENTIVES_V2
            : INCENTIVES_DATA_FETCHER_V3;
        const isClaimedData = encodeFunctionData({
          abi: INCENTIVES_ABI,
          functionName: "isClaimed",
          args: [item.key, BigInt(item.claim.index)],
        });
        const isAvailableData = encodeFunctionData({
          abi: INCENTIVES_ABI,
          functionName: "isAvailable",
          args: [
            item.key,
            BigInt(item.claim.index),
            BigInt(item.claim.amount),
          ],
        });
        return [
          {
            claim_index: index,
            field: "is_claimed",
            chain_id: item.chain_id,
            rpc_request: {
              jsonrpc: "2.0",
              id: index * 2 + 1,
              method: "eth_call",
              params: [
                {
                  to: target,
                  data: isClaimedData,
                },
                "pending",
              ],
            },
            decode_as: "bool",
            ...localFunctionResultMetadata({
              chainId: item.chain_id,
              id: `ekubo-reward-claim-${index}-is-claimed`,
              to: target,
              data: isClaimedData,
              abi: INCENTIVES_ABI,
              functionName: "isClaimed",
            }),
          },
          {
            claim_index: index,
            field: "is_available",
            chain_id: item.chain_id,
            rpc_request: {
              jsonrpc: "2.0",
              id: index * 2 + 2,
              method: "eth_call",
              params: [
                {
                  to: target,
                  data: isAvailableData,
                },
                "pending",
              ],
            },
            decode_as: "bool",
            ...localFunctionResultMetadata({
              chainId: item.chain_id,
              id: `ekubo-reward-claim-${index}-is-available`,
              to: target,
              data: isAvailableData,
              abi: INCENTIVES_ABI,
              functionName: "isAvailable",
            }),
          },
        ];
      }),
      instruction:
        "Execute every supplied read on its stated chain. A claim is executable only when is_claimed=false and is_available=true; then pass its prepare_input unchanged to ekubo_prepare_rewards_claim grouped by chain_id.",
    },
    source_url: url.toString(),
    ignored_non_evm_claim_count: body.claims.length - evmClaims.length,
    next_step:
      "Run the supplied exact read list, group available unclaimed records by chain, then call ekubo_prepare_rewards_claim with each record's prepare_input. Do not reconstruct the read or claim calldata.",
    cache: { mcp_result_storage: "none" },
  };
}

export function prepareRewardsClaim(input: {
  chainId: string;
  sender: string;
  claims: RewardsClaimInput[];
}) {
  const sender = getAddress(input.sender);
  if (input.claims.length === 0 || input.claims.length > 200) {
    throw new ServiceError(
      "invalid_claims",
      "Provide between 1 and 200 rewards claims from one chain",
    );
  }
  const claims = input.claims.map((item, index) => {
    const dropAddress = getAddress(item.dropAddress);
    const owner = getAddress(item.key.owner);
    const account = getAddress(item.claim.account);
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
      key: { owner, token: getAddress(item.key.token), root: item.key.root },
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
    decodedCalls: claims.map((claim, index) => ({
      order: index + 1,
      function: "claim",
      target: claim.dropAddress,
      arguments: {
        key: claim.key,
        claim: {
          ...claim.claim,
          index: claim.claim.index.toString(),
          amount: claim.claim.amount.toString(),
        },
        proof: claim.proof,
        allow_failure_in_aggregate: calls.length > 1,
      },
    })),
    transaction,
    details: {
      multicall3: calls.length > 1 ? MULTICALL3 : null,
      independent_claim_failures_are_allowed: calls.length > 1,
      exact_claim_count: claims.length,
    },
  });
}

export function prepareRecoveryFundClaim(input: {
  chainId: string;
  sender: string;
  claims: { token: string; amount: string }[];
  hasSignedConditions: boolean;
  signature?: Hex;
}) {
  if (input.chainId !== "1") {
    throw new ServiceError(
      "unsupported_chain",
      "The recovery fund is deployed only on Ethereum mainnet",
    );
  }
  const sender = getAddress(input.sender);
  if (input.claims.length === 0 || input.claims.length > 50) {
    throw new ServiceError(
      "invalid_claims",
      "Provide between 1 and 50 nonzero recovery claims",
    );
  }
  const seen = new Set<string>();
  const claims = input.claims.map((claim, index) => {
    const token = getAddress(claim.token);
    if (seen.has(token.toLowerCase())) {
      throw new ServiceError(
        "duplicate_claim",
        `claims[${index}] repeats token ${token}`,
      );
    }
    seen.add(token.toLowerCase());
    return {
      token,
      amount: positiveUnsigned(claim.amount, 256, `claims[${index}].amount`),
    };
  });
  if (!input.hasSignedConditions && input.signature === undefined) {
    return {
      schema_version: "1",
      action: "ekubo_claim_recovery_fund",
      phase: "sign_claim_conditions",
      next_phase: "prepare_execution",
      execution_plan_ready: false,
      agent_confirmation_required: false,
      wallet_validation_required: true,
      request: {
        chain_id: input.chainId,
        sender,
        claims: claims.map(({ token, amount }) => ({
          token,
          amount: amount.toString(),
        })),
      },
      signature_request: recoverySignatureRequest(sender),
      resume:
        "Pass this exact typed-data request to the wallet's signing flow. After the wallet presents it and collects the signature, call this tool again with signature. The MCP will then construct the complete multicall.",
      wallet_handoff: {
        instruction:
          "Do not ask for a separate agent-level approval. The wallet owns presentation and authorization of this typed-data signature.",
        calldata_complete:
          "The MCP supplies both the exact typed-data request and, after signing, all transaction calldata.",
      },
    };
  }
  if (
    !input.hasSignedConditions &&
    (input.signature === undefined ||
      !/^0x[0-9a-fA-F]{130}$/.test(input.signature))
  ) {
    throw new ServiceError(
      "invalid_signature",
      "signature must be a 65-byte EIP-712 signature",
    );
  }
  const calls: Hex[] = [
    ...(!input.hasSignedConditions
      ? [
          encodeFunctionData({
            abi: RECOVERY_ABI,
            functionName: "agreeToClaimConditions",
            args: [sender, input.signature as Hex],
          }),
        ]
      : []),
    ...claims.map(({ token, amount }) =>
      encodeFunctionData({
        abi: RECOVERY_ABI,
        functionName: "claim",
        args: [sender, token, amount],
      }),
    ),
  ];
  const data = encodeFunctionData({
    abi: RECOVERY_ABI,
    functionName: "multicall",
    args: [calls],
  });
  const transaction = preparedTransaction(
    input.chainId,
    RECOVERY_FUND,
    data,
    0n,
  );

  return {
    ...preparedUiAction({
      action: "ekubo_claim_recovery_fund",
      chainId: input.chainId,
      sender,
      request: {
        chain_id: input.chainId,
        sender,
        has_signed_conditions: input.hasSignedConditions,
        claims: claims.map(({ token, amount }) => ({
          token,
          amount: amount.toString(),
        })),
      },
      decodedCalls: [
        ...(!input.hasSignedConditions
          ? [
              {
                order: 1,
                function: "agreeToClaimConditions",
                target: RECOVERY_FUND,
                arguments: { account: sender, signature: input.signature },
              },
            ]
          : []),
        ...claims.map(({ token, amount }, index) => ({
          order: index + (input.hasSignedConditions ? 1 : 2),
          function: "claim",
          target: RECOVERY_FUND,
          arguments: { account: sender, token, amount: amount.toString() },
        })),
      ],
      transaction,
      details: {
        recovery_fund: RECOVERY_FUND,
        signature_was_required: !input.hasSignedConditions,
        claim_count: claims.length,
      },
    }),
    phase: "execute",
    next_phase: null,
  };
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
  const decodedCalls: {
    order: number;
    function: string;
    target: Address;
    arguments: Record<string, unknown>;
  }[] = [];
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
    decodedCalls.push({
      order: decodedCalls.length + 1,
      function: "collect",
      target: REVENUE_BUYBACKS,
      arguments: {
        sell_token: sellToken,
        fee: fee.toString(),
        end_time: endTime.toString(),
      },
    });
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
    decodedCalls.push({
      order: decodedCalls.length + 1,
      function: "withdrawProtocolFees",
      target: REVENUE_BUYBACKS,
      arguments: { token0, token1 },
    });
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
    decodedCalls.push({
      order: decodedCalls.length + 1,
      function: "roll",
      target: REVENUE_BUYBACKS,
      arguments: { token },
    });
  }
  const data = encodeFunctionData({
    abi: REVENUE_BUYBACKS_ABI,
    functionName: "multicall",
    args: [calls],
  });
  const transaction = preparedTransaction(
    input.chainId,
    REVENUE_BUYBACKS,
    data,
    0n,
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
    decodedCalls,
    transaction,
    details: {
      permissionless_maintenance: true,
      revenue_buybacks_contract: REVENUE_BUYBACKS,
      exact_selected_call_count: calls.length,
    },
  });
}

function recoverySignatureRequest(sender: Address) {
  return {
    method: "eth_signTypedData_v4",
    account: sender,
    typed_data: {
      domain: {
        name: "Recovery Fund",
        version: "1",
        chainId: 1,
        verifyingContract: RECOVERY_FUND,
      },
      types: {
        AgreeToClaimConditions: [{ name: "claimConditions", type: "string" }],
      },
      primaryType: "AgreeToClaimConditions",
      message: { claimConditions: CLAIM_CONDITIONS },
    },
  };
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
    const dropAddress = getAddress(String(value.dropAddress));
    const key = {
      owner: getAddress(String(value.key.owner)),
      token: getAddress(String(value.key.token)),
      root: String(value.key.root) as Hex,
    };
    if (!/^0x[0-9a-fA-F]{64}$/.test(key.root)) {
      throw new Error("root must be bytes32");
    }
    const claimIndex = unsigned(String(value.claim.index), 256, "claim.index");
    const account = getAddress(String(value.claim.account));
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

const CLAIM_CONDITIONS = [
  "By signing this message, I accept the conditions for claiming from this Recovery Fund.",
  "I represent that I am not a sanctioned person, am not located, organized, or resident in a sanctioned or embargoed jurisdiction, am not owned or controlled by a sanctioned person, and am not otherwise prohibited by law from receiving these funds.",
  "I understand that any recovery distribution is voluntary, discretionary, and ex gratia by the Ekubo DAO. I have no contractual, statutory, equitable, or other entitlement to any recovery distribution. Neither the Ekubo interface, any Ekubo-related smart contract, nor any current or future deployment of the same, similar, derivative, replacement, or related code is provided with any warranty, guarantee, or undertaking. Applicable terms and smart contract disclaimers disclaim warranties and limit liability to the fullest extent permitted by law.",
  "In exchange for my ability to claim from this Recovery Fund, to the fullest extent permitted by law, I irrevocably and forever release, waive, discharge, and covenant not to sue the Ekubo DAO tokenholders, Ekubo, Inc., and Ekubo, Inc.'s current and former employees, officers, directors, contractors, agents, affiliates, successors, and assigns (the Released Parties) from any and all claims, demands, causes of action, liabilities, losses, damages, costs, and expenses, whether known or unknown, suspected or unsuspected, arising out of or relating to any hack, exploit, vulnerability, bug, incident, approval, transfer, loss, or other consequence involving eip155:1:0x8f52903d17e2d8d6c77d1a1de0cc975b6b5a0d15, eip155:1:0x8ccb1ffd5c2aa6bd926473425dea4c8c15de60fd, eip155:1:0x4f168f17923435c999f5c8565acab52c2218edf2, or eip155:42161:0xc93c4ad185ca48d66fefe80f906a67ef859fc47d.",
].join("\n\n");

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
