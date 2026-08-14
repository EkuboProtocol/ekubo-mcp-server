import { describe, expect, it } from "bun:test";
import {
  decodeFunctionData,
  erc20Abi,
  erc1155Abi,
  erc721Abi,
} from "viem";
import { prepareTransfersSchema } from "../src/server.js";
import { MAX_MCP_BODY_BYTES } from "../src/rate-limit.js";
import {
  MAX_TRANSFERS_PER_PLAN,
  prepareTransfers,
} from "../src/transfers.js";
import {
  planStepKinds,
  planTargets,
  planTransactions,
  planValues,
} from "./plan-helpers.js";

const SENDER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const SECOND_RECIPIENT = "0x3333333333333333333333333333333333333333";
const ERC20 = "0x4444444444444444444444444444444444444444";
const ERC721 = "0x5555555555555555555555555555555555555555";
const ERC1155 = "0x6666666666666666666666666666666666666666";

describe("prepare transfers", () => {
  it("prepares an atomic ordered plan with mixed transfer kinds", () => {
    const result = prepareTransfers({
      chainId: "8453",
      sender: SENDER,
      transfers: [
        { kind: "native", recipient: RECIPIENT, amount: "1" },
        {
          kind: "erc20",
          token: ERC20,
          recipient: SECOND_RECIPIENT,
          amount: "2",
        },
        {
          kind: "erc721",
          token: ERC721,
          recipient: RECIPIENT,
          tokenId: "0",
        },
        {
          kind: "erc721",
          token: ERC721,
          recipient: SECOND_RECIPIENT,
          tokenId: "4",
          safe: false,
        },
        {
          kind: "erc1155",
          token: ERC1155,
          recipient: RECIPIENT,
          tokenId: "6",
          amount: "7",
          data: "0x1234",
        },
      ],
    });

    expect(result.action).toBe("batch_transfers");
    expect(result.request).toEqual({
      chain_id: "8453",
      sender: SENDER,
      transfer_count: 5,
    });
    expect(result.details).toMatchObject({
      transfer_count: 5,
      transfer_counts: { native: 1, erc20: 1, erc721: 2, erc1155: 1 },
      total_native_value: "1",
      atomic_batch_required: true,
    });
    expect(result.execution_plan.required_capabilities).toEqual([
      "atomic_batch",
    ]);
    expect(planStepKinds(result)).toEqual(Array(5).fill("execution"));
    expect(planTargets(result)).toEqual([
      RECIPIENT,
      ERC20,
      ERC721,
      ERC721,
      ERC1155,
    ]);
    expect(planValues(result)).toEqual(["1", "0", "0", "0", "0"]);

    const transactions = planTransactions(result);
    expect(transactions[0]?.data).toBe("0x");
    expect(
      decodeFunctionData({ abi: erc20Abi, data: transactions[1].data }),
    ).toMatchObject({
      functionName: "transfer",
      args: [SECOND_RECIPIENT, 2n],
    });
    expect(
      decodeFunctionData({ abi: erc721Abi, data: transactions[2].data }),
    ).toMatchObject({
      functionName: "safeTransferFrom",
      args: [SENDER, RECIPIENT, 0n],
    });
    expect(
      decodeFunctionData({ abi: erc721Abi, data: transactions[3].data }),
    ).toMatchObject({
      functionName: "transferFrom",
      args: [SENDER, SECOND_RECIPIENT, 4n],
    });
    expect(
      decodeFunctionData({ abi: erc1155Abi, data: transactions[4].data }),
    ).toMatchObject({
      functionName: "safeTransferFrom",
      args: [SENDER, RECIPIENT, 6n, 7n, "0x1234"],
    });
  });

  it("defaults ERC-721 and ERC-1155 to their safe transfer methods", () => {
    const parsed = prepareTransfersSchema.parse({
      chain_id: "1",
      sender: SENDER,
      transfers: [
        {
          kind: "erc721",
          token: ERC721,
          recipient: RECIPIENT,
          token_id: "1",
        },
        {
          kind: "erc1155",
          token: ERC1155,
          recipient: RECIPIENT,
          token_id: "2",
          amount: "3",
        },
      ],
    });

    expect(parsed.transfers[0]).not.toHaveProperty("safe");
    expect(parsed.transfers[1]).not.toHaveProperty("safe");
    expect(parsed.transfers[1]).not.toHaveProperty("data");
    expect(
      prepareTransfersSchema.safeParse({
        chain_id: "1",
        sender: SENDER,
        transfers: [
          {
            kind: "erc1155",
            token: ERC1155,
            recipient: RECIPIENT,
            token_id: "2",
            amount: "3",
            safe: false,
          },
        ],
      }).success,
    ).toBe(false);
    expect(() =>
      prepareTransfers({
        chainId: "1",
        sender: SENDER,
        transfers: [
          {
            kind: "erc721",
            token: ERC721,
            recipient: RECIPIENT,
            tokenId: "1",
            safe: false,
            data: "0x12",
          },
        ],
      }),
    ).toThrow("callback data requires safeTransferFrom");
  });

  it("requires 1 to 4,096 transfers and prohibits zero amounts", () => {
    const base = {
      chain_id: "1",
      sender: SENDER,
    };
    expect(
      prepareTransfersSchema.safeParse({ ...base, transfers: [] }).success,
    ).toBe(false);
    expect(
      prepareTransfersSchema.safeParse({
        ...base,
        transfers: [{ kind: "native", recipient: "invalid", amount: "1" }],
      }).success,
    ).toBe(false);
    expect(
      prepareTransfersSchema.safeParse({
        ...base,
        transfers: [
          { kind: "native", recipient: RECIPIENT, amount: "0" },
        ],
      }).success,
    ).toBe(false);
    expect(
      prepareTransfersSchema.safeParse({
        ...base,
        transfers: [
          {
            kind: "erc20",
            token: ERC20,
            recipient: RECIPIENT,
            amount: "0",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      prepareTransfersSchema.safeParse({
        ...base,
        transfers: [
          {
            kind: "erc1155",
            token: ERC1155,
            recipient: RECIPIENT,
            token_id: "1",
            amount: "0",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      prepareTransfersSchema.safeParse({
        ...base,
        transfers: Array.from(
          { length: MAX_TRANSFERS_PER_PLAN + 1 },
          () => ({ kind: "native", recipient: RECIPIENT, amount: "1" }),
        ),
      }).success,
    ).toBe(false);
    expect(() =>
      prepareTransfers({ chainId: "1", sender: SENDER, transfers: [] }),
    ).toThrow("At least one transfer");
    expect(() =>
      prepareTransfers({
        chainId: "1",
        sender: SENDER,
        transfers: [
          { kind: "native", recipient: RECIPIENT, amount: "0" },
        ],
      }),
    ).toThrow("must be positive");
  });

  it("supports the full 4,096-step wallet plan limit", () => {
    const result = prepareTransfers({
      chainId: "1",
      sender: SENDER,
      transfers: Array.from({ length: MAX_TRANSFERS_PER_PLAN }, () => ({
        kind: "native" as const,
        recipient: RECIPIENT,
        amount: "1",
      })),
    });

    expect(result.execution_plan.ordered_steps).toHaveLength(
      MAX_TRANSFERS_PER_PLAN,
    );
    expect(result.details).toMatchObject({
      transfer_count: MAX_TRANSFERS_PER_PLAN,
      total_native_value: MAX_TRANSFERS_PER_PLAN.toString(),
    });
  });

  it("fits 4,096 fully populated ordinary entries within the MCP body limit", () => {
    const maxUint256 = ((1n << 256n) - 1n).toString();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "prepare_transfers",
        arguments: {
          chain_id: "1",
          sender: SENDER,
          transfers: Array.from(
            { length: MAX_TRANSFERS_PER_PLAN },
            () => ({
              kind: "erc1155",
              token: ERC1155,
              recipient: RECIPIENT,
              token_id: maxUint256,
              amount: maxUint256,
            }),
          ),
        },
      },
    });
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(
      MAX_MCP_BODY_BYTES,
    );
  });

  it("does not mark a single transfer as requiring an atomic batch", () => {
    const result = prepareTransfers({
      chainId: "1",
      sender: SENDER,
      transfers: [{ kind: "native", recipient: RECIPIENT, amount: "1" }],
    });
    expect(result.execution_plan).not.toHaveProperty("required_capabilities");
  });
});
