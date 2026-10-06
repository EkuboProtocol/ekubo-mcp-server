import {
  encodeFunctionData,
  erc20Abi,
  erc1155Abi,
  erc721Abi,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { isEkuboNftContract } from "./contracts.js";
import { ServiceError } from "./core.js";
import { type ExecutionPlanStepInput } from "./execution-plan.js";
import { preparedTransaction, preparedUiAction } from "./ui-actions.js";
import {
  classifyAsset,
  type PlanJurisdiction,
  type RestrictableAsset,
} from "./token-restrictions.js";

export const MAX_TRANSFERS_PER_PLAN = 4_096;

interface NativeTransferInput {
  kind: "native";
  recipient: string;
  amount: string;
}

interface Erc20TransferInput {
  kind: "erc20";
  token: string;
  recipient: string;
  amount: string;
}

interface Erc721TransferInput {
  kind: "erc721";
  token: string;
  recipient: string;
  tokenId: string;
  safe?: boolean;
  data?: Hex;
}

interface Erc1155TransferInput {
  kind: "erc1155";
  token: string;
  recipient: string;
  tokenId: string;
  amount: string;
  safe?: boolean;
  data?: Hex;
}

export type TransferInput =
  | NativeTransferInput
  | Erc20TransferInput
  | Erc721TransferInput
  | Erc1155TransferInput;

/**
 * The entries of a transfer batch that dispose of a gated asset (CLO ruling
 * EKU-878): delivering a Robinhood Stock Token to any address other than the
 * sender is a disposal, gated like a sale, with no exemption for a contract
 * the sender controls. An unclassified ERC-20 on a covered chain is included
 * too, so the gate refuses it rather than guessing that it is not a Stock
 * Token. A transfer to the sender itself, and every non-class or out-of-scope
 * asset, is not a disposal.
 *
 * The declared `kind` is not trusted to rule a contract out (CSO EKU-882
 * N-1): ERC-721 `transferFrom(address,address,uint256)` has the same selector
 * as ERC-20 `transferFrom`, so an "erc721" entry against an unregistered Stock
 * Token moves `token_id` units of it. An unclassified contract is therefore
 * gated whatever its kind, which refuses it with `unclassified_asset`. The one
 * exception is an ERC-721 entry against a contract the deployment catalog
 * records as an Ekubo NFT manager on that chain (positions, orders, VeToken):
 * that is positively an NFT, not a member of the fungible class.
 */
export function transferDisposals(input: {
  chainId: string;
  sender: string;
  transfers: readonly { kind: TransferInput["kind"]; recipient: string; token?: string }[];
}): RestrictableAsset[] {
  const sender = input.sender.toLowerCase();
  return input.transfers.flatMap((transfer): RestrictableAsset[] => {
    if (transfer.kind === "native" || transfer.token === undefined) return [];
    if (transfer.recipient.toLowerCase() === sender) return [];
    const { classification } = classifyAsset(input.chainId, transfer.token);
    const gated =
      classification === "rhj_stock_token" ||
      (classification === "unknown" &&
        !(transfer.kind === "erc721" && isEkuboNftContract(input.chainId, transfer.token)));
    return gated ? [{ chainId: input.chainId, token: transfer.token, side: "sell" }] : [];
  });
}

export function prepareTransfers(input: {
  chainId: string;
  sender: string;
  transfers: TransferInput[];
  /**
   * `quoteJurisdiction` over `transferDisposals` when the caller's gate found
   * any, `nonTradingJurisdiction()` otherwise (EKU-873, EKU-878).
   */
  jurisdiction: PlanJurisdiction;
}) {
  if (input.transfers.length === 0) {
    throw new ServiceError(
      "no_transfers",
      "At least one transfer must be specified",
    );
  }
  if (input.transfers.length > MAX_TRANSFERS_PER_PLAN) {
    throw new ServiceError(
      "too_many_transfers",
      `At most ${MAX_TRANSFERS_PER_PLAN} transfers can be prepared in one plan`,
    );
  }

  const sender = nonzeroAddress(input.sender, "sender");
  const counts: Record<TransferInput["kind"], number> = {
    native: 0,
    erc20: 0,
    erc721: 0,
    erc1155: 0,
  };
  let totalNativeValue = 0n;

  const steps = input.transfers.map(
    (transfer, index): ExecutionPlanStepInput => {
      const item = index + 1;
      const recipient = nonzeroAddress(
        transfer.recipient,
        `transfers[${index}].recipient`,
      );
      counts[transfer.kind] += 1;

      switch (transfer.kind) {
        case "native": {
          const amount = positiveUint256(transfer.amount, item, "amount");
          totalNativeValue += amount;
          return {
            kind: "execution",
            transaction: preparedTransaction(
              input.chainId,
              recipient,
              "0x",
              amount,
            ),
          };
        }
        case "erc20": {
          const token = nonzeroAddress(
            transfer.token,
            `transfers[${index}].token`,
          );
          const amount = positiveUint256(transfer.amount, item, "amount");
          return {
            kind: "execution",
            transaction: preparedTransaction(
              input.chainId,
              token,
              encodeFunctionData({
                abi: erc20Abi,
                functionName: "transfer",
                args: [recipient, amount],
              }),
              0n,
            ),
          };
        }
        case "erc721": {
          const token = nonzeroAddress(
            transfer.token,
            `transfers[${index}].token`,
          );
          const tokenId = uint256(transfer.tokenId, item, "token_id");
          const safe = transfer.safe ?? true;
          if (!safe && transfer.data !== undefined) {
            throw new ServiceError(
              "invalid_transfer_data",
              "ERC-721 callback data requires safeTransferFrom; omit data when safe is false",
            );
          }
          const args =
            transfer.data === undefined
              ? ([sender, recipient, tokenId] as const)
              : ([sender, recipient, tokenId, transfer.data] as const);
          return {
            kind: "execution",
            transaction: preparedTransaction(
              input.chainId,
              token,
              encodeFunctionData({
                abi: erc721Abi,
                functionName: safe ? "safeTransferFrom" : "transferFrom",
                args,
              }),
              0n,
            ),
          };
        }
        case "erc1155": {
          if (transfer.safe === false) {
            throw new ServiceError(
              "unsupported_transfer_mode",
              "ERC-1155 defines only safeTransferFrom; safe cannot be false",
            );
          }
          const token = nonzeroAddress(
            transfer.token,
            `transfers[${index}].token`,
          );
          const tokenId = uint256(transfer.tokenId, item, "token_id");
          const amount = positiveUint256(transfer.amount, item, "amount");
          return {
            kind: "execution",
            transaction: preparedTransaction(
              input.chainId,
              token,
              encodeFunctionData({
                abi: erc1155Abi,
                functionName: "safeTransferFrom",
                args: [sender, recipient, tokenId, amount, transfer.data ?? "0x"],
              }),
              0n,
            ),
          };
        }
      }
    },
  );

  const atomicBatchRequired = steps.length > 1;
  return preparedUiAction({
    jurisdiction: input.jurisdiction,
    action: "batch_transfers",
    chainId: input.chainId,
    sender,
    // The exact recipients, amounts, token contracts, and calldata live in the
    // integrity-protected plan body. Repeating thousands of entries in the
    // agent-visible result would defeat the artifact-reference handoff.
    request: {
      chain_id: input.chainId,
      sender,
      transfer_count: steps.length,
    },
    steps,
    atomicBatchRequired,
    details: {
      transfer_count: steps.length,
      transfer_counts: counts,
      total_native_value: totalNativeValue.toString(),
      atomic_batch_required: atomicBatchRequired,
      erc721_safe_transfer_is_default: true,
      erc1155_uses_safe_transfer_from: true,
    },
  });
}

function nonzeroAddress(value: string, label: string): Address {
  const normalized = getAddress(value);
  if (BigInt(normalized) === 0n) {
    throw new ServiceError("invalid_address", `${label} must not be zero`);
  }
  return normalized;
}

function positiveUint256(value: string, item: number, label: string): bigint {
  const parsed = uint256(value, item, label);
  if (parsed === 0n) {
    throw new ServiceError(
      "invalid_amount",
      `Transfer ${item} ${label} must be positive`,
    );
  }
  return parsed;
}

function uint256(value: string, item: number, label: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ServiceError(
      "invalid_integer",
      `Transfer ${item} ${label} must be an unsigned decimal integer`,
    );
  }
  const parsed = BigInt(value);
  if (parsed >= 1n << 256n) {
    throw new ServiceError(
      "integer_overflow",
      `Transfer ${item} ${label} must fit uint256`,
    );
  }
  return parsed;
}
