import { describe, expect, it } from "bun:test";
import { decodeFunctionData, encodeAbiParameters, keccak256, parseAbiParameters, stringToHex, concatHex, zeroAddress } from "viem";
import { prepareSafeTransaction, safeTools, SAFE_ABI } from "../src/safe.js";
import { referenceWalletArtifacts } from "../src/artifact-store.js";
import type { Env } from "../src/core.js";
import { fakeArtifactStore } from "./fake-r2.js";

const input = {
  chain_id: "1", safe: "0x1111111111111111111111111111111111111111", safe_version: "1.4.1" as const,
  signer: "0x2222222222222222222222222222222222222222",
  transaction: { to: "0x3333333333333333333333333333333333333333", value: "123", data: "0x1234", operation: "0" as const,
    safeTxGas: "456", baseGas: "789", gasPrice: "12", gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: "3" },
};
function run(name: string, args: unknown) {
  const tool = safeTools.find((tool) => tool.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(args) as any;
}

describe("Safe preparation", () => {
  it("matches Safe's Solidity domain/struct encoding and binds request constraints separately", () => {
    const result = prepareSafeTransaction(input);
    const domain = keccak256(encodeAbiParameters(parseAbiParameters("bytes32,uint256,address"), [
      keccak256(stringToHex("EIP712Domain(uint256 chainId,address verifyingContract)")), 1n, input.safe as `0x${string}`,
    ]));
    const struct = keccak256(encodeAbiParameters(parseAbiParameters("bytes32,address,uint256,bytes32,uint8,uint256,uint256,uint256,address,address,uint256"), [
      keccak256(stringToHex("SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)")),
      input.transaction.to as `0x${string}`, 123n, keccak256("0x1234"), 0, 456n, 789n, 12n, zeroAddress, zeroAddress, 3n,
    ]));
    expect(result.signing_digest).toBe(keccak256(concatHex(["0x1901", domain, struct])));
    const cutoff = prepareSafeTransaction({ ...input, valid_until: "1900000000" });
    expect(cutoff.signing_digest).toBe(result.signing_digest);
    expect(cutoff.request_digest).not.toBe(result.request_digest);
    expect(prepareSafeTransaction({ ...input, chain_id: "8453" }).signing_digest).not.toBe(result.signing_digest);
    expect(prepareSafeTransaction({ ...input, signer: input.safe }).request_digest).not.toBe(result.request_digest);
  });

  it("stores typed data and read bundles as integrity-bound references", async () => {
    const env = { ARTIFACT_STORE: fakeArtifactStore() } as unknown as Env;
    const { value, replaced } = await referenceWalletArtifacts(env, "https://mcp.ekubo.org", prepareSafeTransaction(input));
    expect(replaced).toBe(2);
    const result = value as any;
    expect(result.typed_data_signature_request).toBeUndefined();
    const ref = result.typed_data_signature_request_reference;
    expect(ref.artifact_type).toBe("typed_data_signature_request");
    const stored = await env.ARTIFACT_STORE.get(new URL(ref.url).pathname.slice(1));
    const text = await stored!.text();
    expect(ref.integrity.value).toBe(keccak256(stringToHex(text)));
    expect(ref.bytes).toBe(new TextEncoder().encode(text).length);
    const request = JSON.parse(text);
    expect(Object.keys(request).sort()).toEqual(["schema_version", "kind", "signer", "typed_data"].sort());
    expect(request.typed_data.message.operation).toBe("0");
    expect(request.typed_data.domain.chainId).toBe("1");
  });

  it("encodes owner changes as signed Safe self-calls", () => {
    const result = run("prepare_safe_owner_change", { ...input, nonce: "3", change: { action: "add_owner", owner: input.transaction.to, threshold: "2" } });
    const message = result.typed_data_signature_request.typed_data.message;
    expect(message.to).toBe(input.safe);
    expect(message.operation).toBe("0");
    const decoded = decodeFunctionData({ abi: SAFE_ABI, data: message.data });
    expect(decoded.functionName).toBe("addOwnerWithThreshold");
    expect(decoded.args).toEqual([input.transaction.to as `0x${string}`, 2n]);
    expect(result.execution_plan).toBeUndefined();
  });

  it("encodes onchain approval and execution for the owner's wallet", () => {
    const approval = run("prepare_safe_approve_hash", { ...input, sender: input.signer });
    const step = approval.execution_plan.ordered_steps[0].transaction;
    expect(step.from).toBe(input.signer);
    expect(decodeFunctionData({ abi: SAFE_ABI, data: step.data }).args).toEqual([prepareSafeTransaction(input).signing_digest]);
    const execution = run("prepare_safe_execution", { ...input, sender: input.signer, signatures: `0x${"11".repeat(65)}` });
    expect(execution.expected_nonce).toBe("3");
    expect(decodeFunctionData({ abi: SAFE_ABI, data: execution.execution_plan.ordered_steps[0].transaction.data }).functionName).toBe("execTransaction");
  });

  it("prepares SafeMessage bytes without pretending it is a transaction", () => {
    const result = run("prepare_safe_message_signature", { ...input, message: "0xABCD" });
    expect(result.typed_data_signature_request.typed_data.primaryType).toBe("SafeMessage");
    expect(result.typed_data_signature_request.typed_data.message.message).toBe("0xabcd");
    expect(result.execution_plan).toBeUndefined();
  });

  it("rejects unsupported versions, noncanonical integers, overflow and malformed bytes", () => {
    expect(() => prepareSafeTransaction({ ...input, safe_version: "1.1.1" as any })).toThrow();
    for (const nonce of ["01", "-1", (2n ** 256n).toString()]) {
      expect(() => prepareSafeTransaction({ ...input, transaction: { ...input.transaction, nonce } })).toThrow();
    }
    expect(() => prepareSafeTransaction({ ...input, transaction: { ...input.transaction, data: "0x1" } })).toThrow();
    expect(() => prepareSafeTransaction({ ...input, valid_until: (2n ** 64n).toString() })).toThrow();
  });
});
