import { describe, expect, it } from "bun:test";
import { Interface, Transaction } from "ethers";
import {
  createPublicClient, decodeFunctionData, encodeFunctionData, http,
  parseAbi, parseTransaction, serializeTransaction,
} from "viem";
import { computeMinForceWithdrawSharePrice } from "@morpho-org/morpho-sdk";

const target = "0x1111111111111111111111111111111111111111";

describe("dependency runtime compatibility", () => {
  for (const type of ["legacy", "eip1559"] as const) {
    it(`serializes unsigned ${type} transactions identically to an independent implementation`, () => {
      const common = { chainId: 8453, nonce: 7, gas: 123456n, to: target,
        value: (1n << 80n) + 1n, data: "0x12345678" as const } as const;
      const fees = type === "legacy" ? { type: "legacy" as const, gasPrice: 9007199254740993n }
        : { type: "eip1559" as const, maxFeePerGas: 9007199254740995n, maxPriorityFeePerGas: 9007199254740993n };
      const bytes = serializeTransaction({ ...common, ...fees });
      const independent = Transaction.from({ ...common, ...fees, gasLimit: common.gas,
        type: type === "legacy" ? 0 : 2 });
      expect(independent.unsignedSerialized).toBe(bytes);
      expect(parseTransaction(bytes)).toMatchObject({ ...common, ...fees, type });
      expect(independent.signature).toBeNull();
    });
  }

  it("keeps cached overloaded selectors and nested ABI values exact", () => {
    const definitions = [
      "function probe(uint256 amount)",
      "function probe((int256 amount,bytes data)[] values)",
    ];
    const independent = new Interface(definitions);
    const abi = parseAbi(definitions);
    for (const amount of [1n, 9007199254740993n, (1n << 128n) + 1n]) {
      const scalar = encodeFunctionData({ abi, functionName: "probe", args: [amount] });
      const nested = encodeFunctionData({ abi, functionName: "probe", args: [[{ amount: -amount, data: "0x010203" }]] });
      expect(independent.encodeFunctionData("probe(uint256)", [amount])).toBe(scalar);
      expect(independent.encodeFunctionData("probe((int256,bytes)[])", [[[-amount, "0x010203"]]])).toBe(nested);
      expect(decodeFunctionData({ abi, data: scalar }).args).toEqual([amount]);
      expect(decodeFunctionData({ abi, data: nested }).args).toEqual([[{ amount: -amount, data: "0x010203" }]]);
    }
  });

  it("rejects indistinguishable overloads rather than selecting different calldata", () => {
    const abi = parseAbi(["function probe(uint256 value)", "function probe(int256 value)"]);
    expect(() => encodeFunctionData({ abi, functionName: "probe", args: [1n] })).toThrow(/ambiguous/i);
    const data = encodeFunctionData({ abi, functionName: "probe", args: [-1n] });
    expect(new Interface(["function probe(int256)"]).encodeFunctionData("probe", [-1n])).toBe(data);
  });

  for (const code of [-32601, -32004]) {
    it(`does not retry provider refusal ${code} from a non-2xx response`, async () => {
      let calls = 0;
      const client = createPublicClient({ transport: http("https://provider.test", {
        retryCount: 3, retryDelay: 1,
        fetchFn: async (_input, init) => {
          calls++;
          const request = JSON.parse(String(init!.body));
          expect(request.method).toBe("eth_blockNumber");
          return Response.json({ jsonrpc: "2.0", id: request.id, error: { code, message: "unsupported fixture" } }, { status: 400 });
        },
      }) });
      await expect(client.getBlockNumber()).rejects.toThrow();
      expect(calls).toBe(1);
    });
  }

  // SDK arithmetic compatibility only: the MCP tools accept explicit bounds and
  // do not expose force-withdraw or fetch a vault snapshot.
  it("preserves Morpho's conservative RAY rounding against integer inequalities", () => {
    const wad = 10n ** 18n;
    for (const assets of [1n, 9007199254740993n, (1n << 128n) - 1n]) {
      for (const shares of [3n, 9007199254740995n]) {
        const slippageTolerance = 1234567890123456n;
        const price = computeMinForceWithdrawSharePrice({ withdrawnAssets: assets, sharesBurnt: shares, slippageTolerance });
        const numerator = assets * (wad - slippageTolerance) * 10n ** 9n;
        expect(price * shares <= numerator).toBe(true);
        expect((price + 1n) * shares > numerator).toBe(true);
      }
    }
    expect(() => computeMinForceWithdrawSharePrice({
      withdrawnAssets: 1n, sharesBurnt: 10n ** 28n, slippageTolerance: 0n,
    })).toThrow();
  });
});
