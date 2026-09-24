import { describe, expect, it } from "bun:test";
import { createVM, type VM } from "@ethereumjs/vm";
import { createAccount, createAddressFromString, bytesToHex, hexToBytes } from "@ethereumjs/util";
import { AbiCoder, Interface, Signature, TypedDataEncoder, Wallet, concat, hashMessage, keccak256, toUtf8Bytes } from "ethers";
import type { Hex } from "viem";
import safe130 from "@gnosis.pm/safe-contracts/build/artifacts/contracts/GnosisSafe.sol/GnosisSafe.json";
import proxy130 from "@gnosis.pm/safe-contracts/build/artifacts/contracts/proxies/GnosisSafeProxy.sol/GnosisSafeProxy.json";
import handler130 from "@gnosis.pm/safe-contracts/build/artifacts/contracts/handler/CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler.json";
import safe141 from "@safe-global/safe-contracts/build/artifacts/contracts/Safe.sol/Safe.json";
import proxy141 from "@safe-global/safe-contracts/build/artifacts/contracts/proxies/SafeProxy.sol/SafeProxy.json";
import handler141 from "@safe-global/safe-contracts/build/artifacts/contracts/handler/CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler.json";
import { prepareSafeTransaction, safeTools } from "../src/safe.js";
import { referenceWalletArtifacts, type ArtifactReference } from "../src/artifact-store.js";
import type { Env } from "../src/core.js";
import { fakeArtifactStore } from "./fake-r2.js";

// Public, deterministic test keys only. Ethers signs independently of the viem producer.
const owner = new Wallet(`0x${"11".repeat(32)}`);
const secondOwner = new Wallet(`0x${"22".repeat(32)}`);
const stranger = new Wallet(`0x${"33".repeat(32)}`);
const ZERO = "0x0000000000000000000000000000000000000000";
const abi = new Interface([
  "function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)",
  "function VERSION() view returns (string)",
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function isOwner(address owner) view returns (bool)",
  "function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)",
  "function checkSignatures(bytes32 dataHash,bytes data,bytes signatures) view",
  "function isValidSignature(bytes,bytes) view returns (bytes4)",
  "function isValidSignature(bytes32,bytes) view returns (bytes4)",
]);
const versions = [
  { version: "1.3.0" as const, safe: safe130, proxy: proxy130, handler: handler130 },
  { version: "1.4.1" as const, safe: safe141, proxy: proxy141, handler: handler141 },
];
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Request = ReturnType<typeof prepareSafeTransaction>["typed_data_signature_request"];

async function call(vm: VM, to: string, data: string, caller = stranger.address) {
  return vm.evm.runCall({
    caller: createAddressFromString(caller),
    to: createAddressFromString(to), data: hexToBytes(data as Hex), gasLimit: 30_000_000n,
  });
}

async function checkedCall(vm: VM, to: string, data: string) {
  const result = await call(vm, to, data);
  expect(result.execResult.exceptionError).toBeUndefined();
  return bytesToHex(result.execResult.returnValue);
}

async function deploy(vm: VM, bytecode: string) {
  const result = await vm.evm.runCall({ caller: createAddressFromString(stranger.address), data: hexToBytes(bytecode as Hex), gasLimit: 30_000_000n });
  expect(result.execResult.exceptionError).toBeUndefined();
  if (!result.createdAddress) throw new Error("No deployment address");
  return result.createdAddress.toString();
}

async function fixture(contracts: (typeof versions)[number], owners = [owner.address], threshold = 1) {
  const vm = await createVM();
  await vm.stateManager.putAccount(createAddressFromString(stranger.address), createAccount({ balance: 10n ** 20n }));
  const singleton = await deploy(vm, contracts.safe.bytecode);
  const handler = await deploy(vm, contracts.handler.bytecode);
  const safe = await deploy(vm, concat([contracts.proxy.bytecode, AbiCoder.defaultAbiCoder().encode(["address"], [singleton])]));
  await checkedCall(vm, safe, abi.encodeFunctionData("setup", [owners, threshold, ZERO, "0x", handler, ZERO, 0, ZERO]));
  const version = await checkedCall(vm, safe, abi.encodeFunctionData("VERSION"));
  expect(abi.decodeFunctionResult("VERSION", version)[0]).toBe(contracts.version);
  const account = await vm.stateManager.getAccount(createAddressFromString(safe));
  account!.balance = 10n ** 18n;
  await vm.stateManager.putAccount(createAddressFromString(safe), account!);
  return { vm, safe, safe_version: contracts.version, chain_id: "1", signer: owner.address };
}

function transaction() {
  return { to: secondOwner.address, value: "123", data: "0x", operation: "0" as const,
    safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: ZERO, refundReceiver: ZERO, nonce: "0" };
}

async function artifact(prepared: unknown) {
  const store = fakeArtifactStore();
  const { value } = await referenceWalletArtifacts({ ARTIFACT_STORE: store } as unknown as Env, "https://mcp.ekubo.org", prepared);
  const reference = (value as { typed_data_signature_request_reference: ArtifactReference }).typed_data_signature_request_reference;
  const stored = await store.get(new URL(reference.url).pathname.slice(1));
  return { reference, body: await stored!.text() };
}

// Minimal consumer of the producer's fixed Safe request shapes, not a general
// untrusted-EIP-712 parser or network-fetch implementation. No producer digest
// is used to sign: independently hash and sign only the verified stored body.
async function signArtifact(reference: ArtifactReference, body: string, wallet = owner) {
  expect(reference.artifact_type).toBe("typed_data_signature_request");
  if (reference.bytes !== toUtf8Bytes(body).length || reference.integrity.value !== keccak256(toUtf8Bytes(body))) throw new Error("Artifact integrity mismatch");
  const request = JSON.parse(body) as Request;
  expect(Object.keys(request).sort()).toEqual(["kind", "schema_version", "signer", "typed_data", ...(request.valid_until === undefined ? [] : ["valid_until"])].sort());
  expect(request.kind).toBe("typed_data_signature_request");
  expect(request.schema_version).toBe("1");
  if (request.signer !== wallet.address.toLowerCase()) throw new Error("Wrong signer");
  if (request.valid_until !== undefined && BigInt(request.valid_until) <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("Expired request");
  const { EIP712Domain: _domain, ...types } = request.typed_data.types;
  const { domain, message } = request.typed_data;
  const signing_digest = TypedDataEncoder.hash(domain, types, message);
  const request_digest = keccak256(toUtf8Bytes(JSON.stringify({ kind: request.kind, schema_version: request.schema_version,
    signer: request.signer, signing_digest, valid_until: request.valid_until ?? null, delivery: null })));
  return { kind: "typed_data_result", schema_version: "1", signer: request.signer,
    signature: await wallet.signTypedData(domain, types, message), signing_digest, request_digest };
}

async function assertAccepted(f: Fixture, digest: string, signature: string) {
  await checkedCall(f.vm, f.safe, abi.encodeFunctionData("checkSignatures", [digest, "0x", signature]));
}

async function assertRejected(f: Fixture, digest: string, signature: string, reason = "GS026") {
  const result = await call(f.vm, f.safe, abi.encodeFunctionData("checkSignatures", [digest, "0x", signature]));
  expect(result.execResult.exceptionError).toBeDefined();
  // Assert Safe's actual rejection, rather than accepting an unrelated EVM failure.
  expect(bytesToHex(result.execResult.returnValue)).toBe(concat(["0x08c379a0", AbiCoder.defaultAbiCoder().encode(["string"], [reason])]) as Hex);
}

function prepare(name: string, input: unknown) {
  const tool = safeTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(name);
  return tool.handler(input);
}

async function executionData(f: Fixture, tx: ReturnType<typeof transaction>, signatures: string) {
  const prepared = prepare("prepare_safe_execution", { ...f, sender: stranger.address, transaction: tx, signatures });
  const store = fakeArtifactStore();
  const { value } = await referenceWalletArtifacts({ ARTIFACT_STORE: store } as unknown as Env, "https://mcp.ekubo.org", prepared);
  const readRef = (value as { read_calls_reference: ArtifactReference }).read_calls_reference;
  const readObject = await store.get(new URL(readRef.url).pathname.slice(1));
  const reads = JSON.parse(await readObject!.text()) as { from: string; calls: { to: string; data: string }[] };
  expect(reads.from).toBe(stranger.address.toLowerCase());
  for (const read of reads.calls) {
    expect((await call(f.vm, read.to, read.data, reads.from)).execResult.exceptionError).toBeUndefined();
  }
  const ref = (value as { execution_plan_reference: ArtifactReference }).execution_plan_reference;
  const stored = await store.get(new URL(ref.url).pathname.slice(1));
  const plan = JSON.parse(await stored!.text()) as { ordered_steps: { transaction: { data: string } }[] };
  return plan.ordered_steps[0].transaction.data;
}

for (const contracts of versions) {
  describe(`Safe ${contracts.version} real-contract signature compatibility`, () => {
    it("accepts an artifact-only EOA signature and executes the exact prepared transfer", async () => {
      const f = await fixture(contracts);
      const tx = transaction();
      const prepared = prepareSafeTransaction({ ...f, transaction: tx });
      const stored = await artifact(prepared);
      const signed = await signArtifact(stored.reference, stored.body);
      expect(signed.signing_digest).toBe(prepared.signing_digest);
      expect(signed.request_digest).toBe(prepared.request_digest);
      expect([27, 28]).toContain(Signature.from(signed.signature).v);
      const hash = await checkedCall(f.vm, f.safe, abi.encodeFunctionData("getTransactionHash", Object.values(tx)));
      expect(abi.decodeFunctionResult("getTransactionHash", hash)[0]).toBe(signed.signing_digest);
      await assertAccepted(f, signed.signing_digest, signed.signature);

      const data = await executionData(f, tx, signed.signature);
      const result = await checkedCall(f.vm, f.safe, data);
      expect(AbiCoder.defaultAbiCoder().decode(["bool"], result)[0]).toBe(true);
      expect((await f.vm.stateManager.getAccount(createAddressFromString(tx.to)))!.balance).toBe(123n);
      const nonce = await checkedCall(f.vm, f.safe, abi.encodeFunctionData("nonce"));
      expect(abi.decodeFunctionResult("nonce", nonce)[0]).toBe(1n);
      // execTransaction hashes the current nonce, so the exact signed calldata cannot replay.
      expect((await call(f.vm, f.safe, data)).execResult.exceptionError).toBeDefined();
    });

    it("rejects signing the request digest, personal-sign encoding, or a non-owner signature", async () => {
      const f = await fixture(contracts);
      const prepared = prepareSafeTransaction({ ...f, transaction: transaction() });
      const wrongDigest = owner.signingKey.sign(prepared.request_digest).serialized;
      await assertRejected(f, prepared.signing_digest, wrongDigest);
      const personal = await owner.signMessage(hexToBytes(prepared.signing_digest));
      // EIP-712 signatures use v=27/28. Safe's distinct eth_sign branch uses v>30.
      await assertRejected(f, prepared.signing_digest, personal);
      const other = await artifact(prepareSafeTransaction({ ...f, signer: stranger.address, transaction: transaction() }));
      const signed = await signArtifact(other.reference, other.body, stranger);
      await assertRejected(f, prepared.signing_digest, signed.signature);
    });

    it("rejects signatures after transaction, chain, or Safe domain substitution", async () => {
      const f = await fixture(contracts);
      const prepared = prepareSafeTransaction({ ...f, transaction: transaction() });
      const changes = [
        { transaction: { ...transaction(), to: stranger.address } },
        { transaction: { ...transaction(), value: "124" } },
        { transaction: { ...transaction(), nonce: "1" } },
        { transaction: { ...transaction(), data: "0x1234" } },
        { transaction: { ...transaction(), operation: "1" as const } },
        { transaction: { ...transaction(), safeTxGas: "100000" } },
        { transaction: { ...transaction(), baseGas: "21000" } },
        { transaction: { ...transaction(), gasPrice: "1" } },
        { transaction: { ...transaction(), gasToken: stranger.address } },
        { transaction: { ...transaction(), refundReceiver: stranger.address } },
        { chain_id: "8453" }, { safe: stranger.address },
      ];
      for (const change of changes) {
        const stored = await artifact(prepareSafeTransaction({ ...f, transaction: transaction(), ...change }));
        const signed = await signArtifact(stored.reference, stored.body);
        await assertRejected(f, prepared.signing_digest, signed.signature);
      }
    });

    it("enforces threshold and ascending owner order on artifact-produced signatures", async () => {
      const f = await fixture(contracts, [owner.address, secondOwner.address], 2);
      const signed = await Promise.all([owner, secondOwner].map(async (wallet) => {
        const stored = await artifact(prepareSafeTransaction({ ...f, signer: wallet.address, transaction: transaction() }));
        return signArtifact(stored.reference, stored.body, wallet);
      }));
      signed.sort((a, b) => a.signer.localeCompare(b.signer));
      const digest = signed[0].signing_digest;
      await assertRejected(f, digest, signed[0].signature, "GS020");
      await assertRejected(f, digest, concat([signed[0].signature, signed[0].signature]));
      await assertRejected(f, digest, concat([signed[1].signature, signed[0].signature]));
      await assertAccepted(f, digest, concat(signed.map((result) => result.signature)));
    });

    it("accepts SafeMessage through the real fallback handler's two ERC-1271 overloads", async () => {
      const f = await fixture(contracts);
      const message = "0x1234abcd";
      const stored = await artifact(prepare("prepare_safe_message_signature", { ...f, message }));
      const signed = await signArtifact(stored.reference, stored.body);
      const legacy = await checkedCall(f.vm, f.safe, abi.encodeFunctionData("isValidSignature(bytes,bytes)", [message, signed.signature]));
      expect(abi.decodeFunctionResult("isValidSignature(bytes,bytes)", legacy)[0]).toBe("0x20c13b0b");
      const dataHash = keccak256(toUtf8Bytes("An application's ERC-1271 digest"));
      const modern = await artifact(prepare("prepare_safe_message_signature", { ...f, message: dataHash }));
      const modernSigned = await signArtifact(modern.reference, modern.body);
      const result = await checkedCall(f.vm, f.safe, abi.encodeFunctionData("isValidSignature(bytes32,bytes)", [dataHash, modernSigned.signature]));
      expect(abi.decodeFunctionResult("isValidSignature(bytes32,bytes)", result)[0]).toBe("0x1626ba7e");
      expect((await call(f.vm, f.safe, abi.encodeFunctionData("isValidSignature(bytes,bytes)", ["0x1234abce", signed.signature]))).execResult.exceptionError).toBeDefined();
    });

    it("executes an artifact-signed owner change as a Safe self-call", async () => {
      const f = await fixture(contracts);
      const stored = await artifact(prepare("prepare_safe_owner_change", { ...f, nonce: "0", change: { action: "add_owner", owner: secondOwner.address, threshold: "2" } }));
      const signed = await signArtifact(stored.reference, stored.body);
      const tx = (JSON.parse(stored.body) as Request).typed_data.message as ReturnType<typeof transaction>;
      const result = await checkedCall(f.vm, f.safe, await executionData(f, tx, signed.signature));
      expect(AbiCoder.defaultAbiCoder().decode(["bool"], result)[0]).toBe(true);
      const membership = await checkedCall(f.vm, f.safe, abi.encodeFunctionData("isOwner", [secondOwner.address]));
      expect(abi.decodeFunctionResult("isOwner", membership)[0]).toBe(true);
      const threshold = await checkedCall(f.vm, f.safe, abi.encodeFunctionData("getThreshold"));
      expect(abi.decodeFunctionResult("getThreshold", threshold)[0]).toBe(2n);
    });

    it("matches Safe Wallet's text and application typed-data message preprocessing", async () => {
      const f = await fixture(contracts);
      // Safe Wallet first hashes the application input, then wraps that digest in SafeMessage.
      const applicationDigests = [
        hashMessage("hello"),
        TypedDataEncoder.hash({ name: "Application", chainId: 1 }, { Message: [{ name: "text", type: "string" }] }, { text: "hello" }),
      ];
      for (const digest of applicationDigests) {
        const stored = await artifact(prepare("prepare_safe_message_signature", { ...f, message: digest }));
        const signed = await signArtifact(stored.reference, stored.body);
        const websiteDigest = TypedDataEncoder.hash(
          { chainId: 1, verifyingContract: f.safe },
          { SafeMessage: [{ name: "message", type: "bytes" }] },
          { message: digest },
        );
        expect(signed.signing_digest).toBe(websiteDigest);
        const result = await checkedCall(f.vm, f.safe, abi.encodeFunctionData("isValidSignature(bytes32,bytes)", [digest, signed.signature]));
        expect(abi.decodeFunctionResult("isValidSignature(bytes32,bytes)", result)[0]).toBe("0x1626ba7e");
      }
      const raw = await artifact(prepare("prepare_safe_message_signature", { ...f, message: "0x68656c6c6f" }));
      const rawSigned = await signArtifact(raw.reference, raw.body);
      expect((await call(f.vm, f.safe, abi.encodeFunctionData("isValidSignature(bytes32,bytes)", [applicationDigests[0], rawSigned.signature]))).execResult.exceptionError).toBeDefined();
    });

    it("checks prevalidated signatures in the supplied executor's call context", async () => {
      const f = await fixture(contracts);
      const signatures = concat([AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [owner.address, 0]), "0x01"]);
      const prepared = prepare("prepare_safe_execution", { ...f, transaction: transaction(), sender: owner.address, signatures }) as {
        read_calls: { from: string; calls: { id: string; to: string; data: string }[] };
      };
      expect(prepared.read_calls.from).toBe(owner.address.toLowerCase());
      const check = prepared.read_calls.calls.find((read) => read.id === "check_signatures")!;
      expect((await call(f.vm, check.to, check.data, prepared.read_calls.from)).execResult.exceptionError).toBeUndefined();
      expect((await call(f.vm, check.to, check.data, stranger.address)).execResult.exceptionError).toBeDefined();
    });
  });
}

describe("ERC-8410 fixture consumer", () => {
  it("refuses tampered bytes, wrong signer and expired signing requests", async () => {
    const input = { chain_id: "1", safe: secondOwner.address, safe_version: "1.4.1" as const, signer: owner.address, transaction: transaction() };
    const stored = await artifact(prepareSafeTransaction(input));
    await expect(signArtifact(stored.reference, stored.body.replace('"123"', '"124"'))).rejects.toThrow("integrity");
    await expect(signArtifact(stored.reference, stored.body, stranger)).rejects.toThrow("Wrong signer");
    const expired = await artifact(prepareSafeTransaction({ ...input, valid_until: "1" }));
    await expect(signArtifact(expired.reference, expired.body)).rejects.toThrow("Expired");
  });
});
