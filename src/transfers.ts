import {
  encodeFunctionData,
  erc20Abi,
  erc1155Abi,
  erc721Abi,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { ServiceError } from "./core.js";
import { type ExecutionPlanStepInput } from "./execution-plan.js";
import { preparedTransaction, preparedUiAction } from "./ui-actions.js";

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

export function prepareTransfers(input: {
  chainId: string;
  sender: string;
  transfers: TransferInput[];
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

  const sender = getAddress(input.sender);
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
          return {
            kind: "execution",
            transaction: preparedTransaction(
              input.chainId,
              token,
              encodeFunctionData({
                abi: erc721Abi,
                functionName: safe ? "safeTransferFrom" : "transferFrom",
                args: [sender, recipient, tokenId],
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
