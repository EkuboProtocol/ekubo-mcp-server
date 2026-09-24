import { concatHex, encodeFunctionData, hashDomain, hashStruct, hashTypedData, keccak256, parseAbi, stringToHex, zeroAddress, type Address, type Hex, type Abi } from "viem";
import { z } from "zod";
import { readCallsBundle, functionResultDecodePlan } from "./abi-decode.js";

const uint = z.string().max(78).regex(/^(0|[1-9][0-9]*)$/).refine((v) => BigInt(v) < 2n ** 256n, "must fit uint256");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((v) => v.toLowerCase() as Address);
const nonzeroAddress = address.refine((v) => v !== zeroAddress, "address cannot be zero");
const bytes = z.string().max(131074).regex(/^0x(?:[0-9a-fA-F]{2})*$/).transform((v) => v.toLowerCase() as Hex);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((v) => v.toLowerCase() as Hex);
const base = z.object({
  chain_id: uint.refine((v) => BigInt(v) > 0n),
  safe: address.refine((v) => v !== zeroAddress),
  safe_version: z.enum(["1.3.0", "1.4.1"]).describe("Verify VERSION through the wallet before preparation"),
});
const signing = base.extend({
  signer: address.refine((v) => v !== zeroAddress).describe("Safe owner account expected to sign, not the Safe itself"),
  valid_until: uint.refine((v) => BigInt(v) < 2n ** 64n).optional(),
});
export const safeTransactionSchema = z.strictObject({
  to: address, value: uint, data: bytes,
  operation: z.enum(["0", "1"]).describe("0 CALL, 1 DELEGATECALL (executes in Safe storage context)"),
  safeTxGas: uint, baseGas: uint, gasPrice: uint,
  gasToken: address, refundReceiver: address, nonce: uint,
});
const transactionSigning = signing.extend({ transaction: safeTransactionSchema });
const messageSigning = signing.extend({ message: bytes.describe("Exact SafeMessage.message bytes, wrapped without additional preprocessing. To match Safe Wallet for text, supply its EIP-191 hashMessage(text); for application typed data, supply its EIP-712 digest. For ERC-1271 isValidSignature(bytes32,bytes), supply that bytes32 digest directly.") });
export const SAFE_ABI = parseAbi([
  "function VERSION() view returns (string)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function isOwner(address owner) view returns (bool)",
  "function approvedHashes(address owner, bytes32 hash) view returns (uint256)",
  "function checkSignatures(bytes32 dataHash,bytes data,bytes signatures) view",
  "function approveHash(bytes32 hashToApprove)",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
  "function addOwnerWithThreshold(address owner,uint256 _threshold)",
  "function removeOwner(address prevOwner,address owner,uint256 _threshold)",
  "function swapOwner(address prevOwner,address oldOwner,address newOwner)",
  "function changeThreshold(uint256 _threshold)",
]);
const SAFE_TX = [
  { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "data", type: "bytes" }, { name: "operation", type: "uint8" },
  { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
  { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" },
  { name: "refundReceiver", type: "address" }, { name: "nonce", type: "uint256" },
];
type Base = z.output<typeof base>;
type Transaction = z.output<typeof safeTransactionSchema>;
function transactionArgs(tx: Transaction) {
  return [tx.to, BigInt(tx.value), tx.data, Number(tx.operation), BigInt(tx.safeTxGas), BigInt(tx.baseGas), BigInt(tx.gasPrice), tx.gasToken, tx.refundReceiver] as const;
}
function read(id: string, safe: Address, functionName: string, args: readonly unknown[] = []) {
  return { id, to: safe, data: encodeFunctionData({ abi: SAFE_ABI as Abi, functionName, args }), decode: functionResultDecodePlan(SAFE_ABI, functionName) };
}
function stateReads(input: Base, owner?: Address) {
  const calls = ["VERSION", "getOwners", "getThreshold", "nonce"].map((name) => read(name, input.safe, name));
  if (owner !== undefined) calls.push(read("is_owner", input.safe, "isOwner", [owner]));
  return calls;
}
function safeTypedData(input: Base, primaryType: string, fields: { name: string; type: string }[], message: Record<string, string>) {
  return {
    types: { EIP712Domain: [{ name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], [primaryType]: fields },
    primaryType, domain: { chainId: input.chain_id, verifyingContract: input.safe }, message,
  };
}
function signatureRequest(input: z.output<typeof signing>, primaryType: string, fields: { name: string; type: string }[], message: Record<string, string>) {
  const typed_data = safeTypedData(input, primaryType, fields, message);
  const signing_digest = hashTypedData({ ...typed_data, domain: { ...typed_data.domain, chainId: BigInt(input.chain_id) } });
  const typed_data_signature_request = {
    schema_version: "1" as const, kind: "typed_data_signature_request" as const,
    signer: input.signer, typed_data,
    ...(input.valid_until === undefined ? {} : { valid_until: input.valid_until }),
  };
  const request_digest = keccak256(stringToHex(JSON.stringify({
    kind: "typed_data_signature_request", schema_version: "1", signer: input.signer,
    signing_digest, valid_until: input.valid_until ?? null, delivery: null,
  })));
  return { protocol: "safe", signing_digest, request_digest, typed_data_signature_request };
}
export function prepareSafeTransaction(raw: z.input<typeof transactionSigning>) {
  const input = transactionSigning.parse(raw);
  return {
    ...signatureRequest(input, "SafeTx", SAFE_TX, input.transaction),
    read_calls: readCallsBundle({ chainId: input.chain_id, calls: [
      ...stateReads(input, input.signer),
      read("transaction_hash", input.safe, "getTransactionHash", [...transactionArgs(input.transaction), BigInt(input.transaction.nonce)]),
    ] }),
    validation: "Require VERSION to match safe_version, signer to be an owner, and getTransactionHash to equal signing_digest. Check nonce and review every transaction field, including delegatecall and gas refunds. A future nonce queues authority; a consumed nonce is stale. Simulate the Safe transaction before signing. valid_until only limits wallet release, not use of an existing signature.",
  };
}
function prepareSafeMessage(raw: z.input<typeof messageSigning>) {
  const input = messageSigning.parse(raw);
  return { ...signatureRequest(input, "SafeMessage", [{ name: "message", type: "bytes" }], { message: input.message }),
    read_calls: readCallsBundle({ chainId: input.chain_id, calls: stateReads(input, input.signer) }),
    validation: "Input bytes are wrapped exactly, without application-message hashing. Match Safe Wallet by supplying hashMessage(text) or the application EIP-712 digest; for isValidSignature(bytes32,bytes), supply that digest. Verify Safe version and owner. SafeMessage has no nonce or expiration; confirm the intended ERC-1271 verifier and fallback handler. This is an owner signature for Safe aggregation, not itself a Safe contract signature.",
  };
}
function execution(input: Base, sender: Address, data: Hex) {
  return { protocol: "safe", execution_plan: {
    schema_version: "1", chain_id: input.chain_id, caip2_chain_id: `eip155:${input.chain_id}`, sender,
    ordered_steps: [{ step: 1, kind: "execution", transaction: { chain_id: input.chain_id, from: sender, to: input.safe, data, value: "0" } }],
  } };
}
const approve = base.extend({ sender: nonzeroAddress, transaction: safeTransactionSchema });
function prepareApprove(raw: z.input<typeof approve>) {
  const input = approve.parse(raw);
  const prepared = prepareSafeTransaction({ ...input, signer: input.sender });
  return { ...execution(input, input.sender, encodeFunctionData({ abi: SAFE_ABI, functionName: "approveHash", args: [prepared.signing_digest] })),
    signing_digest: prepared.signing_digest, read_calls: prepared.read_calls,
    validation: "Require signer ownership and matching onchain transaction hash before approval. approveHash persists; it is not a revocable offchain confirmation.",
  };
}
const execute = base.extend({ sender: nonzeroAddress, transaction: safeTransactionSchema, signatures: bytes.refine((v) => v.length >= 132, "Safe signatures require at least one 65-byte static entry").describe("Complete Safe-format bundle, sorted by owner address. EIP-712 EOA signatures must use v=27/28 (normalize wallet v=0/1 before assembly). Contract signatures use v=0 and dynamic offsets; prevalidated signatures use v=1. This tool preserves the bundle verbatim.") });
function transactionValidation(input: z.output<typeof execute>) {
  const typedData = safeTypedData(input, "SafeTx", SAFE_TX, input.transaction);
  const domain = { ...typedData.domain, chainId: BigInt(input.chain_id) };
  const preimage = concatHex([
    "0x1901",
    hashDomain({ domain, types: typedData.types }),
    hashStruct({ data: typedData.message, primaryType: "SafeTx", types: typedData.types }),
  ]);
  const signing_digest = keccak256(preimage);
  return { signing_digest, read_calls: readCallsBundle({
    chainId: input.chain_id,
    from: input.sender,
    calls: [
      ...stateReads(input),
      read("transaction_hash", input.safe, "getTransactionHash", [...transactionArgs(input.transaction), BigInt(input.transaction.nonce)]),
      read("check_signatures", input.safe, "checkSignatures", [signing_digest, preimage, input.signatures]),
    ],
  }) };
}
function prepareExecute(raw: z.input<typeof execute>) {
  const input = execute.parse(raw);
  return { ...execution(input, input.sender, encodeFunctionData({ abi: SAFE_ABI, functionName: "execTransaction", args: [...transactionArgs(input.transaction), input.signatures] })),
    ...transactionValidation(input),
    expected_nonce: input.transaction.nonce,
    validation: "Execute all validation reads from the supplied sender; require VERSION to match safe_version, transaction_hash to equal signing_digest, check_signatures to succeed, and the current nonce to equal expected_nonce. checkSignatures alone does not check nonce freshness. These are wallet preconditions, not constraints embedded in the execution plan. The complete Safe-format signature bundle is preserved verbatim. Simulate and require execTransaction success=true; a mined outer receipt alone is insufficient (ExecutionFailure can consume the nonce). The preparer has not executed these reads or verified live state.",
  };
}
const ownerAddress = address.refine((v) => v !== zeroAddress && BigInt(v) !== 1n, "owner cannot be zero or sentinel");
const threshold = uint.refine((v) => BigInt(v) > 0n);
const ownerAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("add_owner"), owner: ownerAddress, threshold }),
  z.strictObject({ action: z.literal("remove_owner"), prev_owner: nonzeroAddress, owner: ownerAddress, threshold }),
  z.strictObject({ action: z.literal("swap_owner"), prev_owner: nonzeroAddress, old_owner: ownerAddress, new_owner: ownerAddress }),
  z.strictObject({ action: z.literal("change_threshold"), threshold }),
]);
const ownerSigning = signing.extend({ nonce: uint, change: ownerAction });
function validateOwnerChange(input: z.output<typeof ownerSigning>) {
  const change = input.change;
  if (change.action === "change_threshold") return;
  const target = change.action === "swap_owner" ? change.old_owner : change.owner;
  if (target === input.safe) throw new Error("Safe cannot be its own owner");
  if (change.action === "add_owner") return;
  if (change.prev_owner === target) throw new Error("Owner cannot be its own predecessor");
  if (change.prev_owner === input.safe) throw new Error("Safe cannot be an owner predecessor");
  if (change.action === "swap_owner") validateReplacement(input.safe, change);
}
function validateReplacement(safe: Address, change: Extract<z.output<typeof ownerAction>, { action: "swap_owner" }>) {
  if (change.new_owner === safe) throw new Error("Safe cannot be its own owner");
  if (change.new_owner === change.old_owner || change.new_owner === change.prev_owner) {
    throw new Error("Replacement must be a new owner");
  }
}
function ownerCall(change: z.output<typeof ownerAction>) {
  switch (change.action) {
    case "add_owner": return encodeFunctionData({ abi: SAFE_ABI, functionName: "addOwnerWithThreshold", args: [change.owner, BigInt(change.threshold)] });
    case "remove_owner": return encodeFunctionData({ abi: SAFE_ABI, functionName: "removeOwner", args: [change.prev_owner, change.owner, BigInt(change.threshold)] });
    case "swap_owner": return encodeFunctionData({ abi: SAFE_ABI, functionName: "swapOwner", args: [change.prev_owner, change.old_owner, change.new_owner] });
    case "change_threshold": return encodeFunctionData({ abi: SAFE_ABI, functionName: "changeThreshold", args: [BigInt(change.threshold)] });
  }
}
function prepareOwner(raw: z.input<typeof ownerSigning>) {
  const input = ownerSigning.parse(raw);
  validateOwnerChange(input);
  return { ...prepareSafeTransaction({ ...input, transaction: {
    to: input.safe, value: "0", data: ownerCall(input.change), operation: "0", safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: input.nonce,
  } }), change: input.change,
    owner_validation: "Owner management is a Safe self-call authorized by its existing threshold. Verify the linked-list predecessor from getOwners (first predecessor is 0x0000000000000000000000000000000000000001), owner uniqueness, and threshold against the resulting owner count. Reject the Safe itself as a new owner. Simulate before signing.",
  };
}
const reads = base.extend({ owner: address.optional(), transaction_hash: hash.optional() })
  .refine((input) => input.transaction_hash === undefined || input.owner !== undefined, "owner is required when transaction_hash is supplied");
function prepareReads(raw: z.input<typeof reads>) {
  const input = reads.parse(raw);
  const calls = stateReads(input, input.owner);
  if (input.owner !== undefined && input.transaction_hash !== undefined) calls.push(read("approved_hash", input.safe, "approvedHashes", [input.owner, input.transaction_hash]));
  return { protocol: "safe", read_calls: readCallsBundle({ chainId: input.chain_id, calls }) };
}
function tool<S extends z.ZodObject>(name: string, description: string, schema: S, handler: (input: z.output<S>) => unknown) {
  return { name, title: name.replaceAll("_", " "), description, schema, handler: (input: unknown) => handler(schema.parse(input)) };
}
export const safeTools = [
  tool("prepare_safe_reads", "Prepare wallet reads of Safe version, owners, threshold, nonce and optional onchain hash approval.", reads, prepareReads),
  tool("prepare_safe_transaction_signature", "Prepare an ERC-8410 EIP-712 SafeTx owner signature request and onchain hash validation reads. All transaction and refund fields are explicit.", transactionSigning, prepareSafeTransaction),
  tool("prepare_safe_message_signature", "Prepare an ERC-8410 EIP-712 SafeMessage owner signature request for exact bytes, for Safe ERC-1271 signature aggregation.", messageSigning, prepareSafeMessage),
  tool("prepare_safe_approve_hash", "Prepare an owner approveHash onchain transaction for an exact Safe transaction, with matching hash and ownership reads.", approve, prepareApprove),
  tool("prepare_safe_execution", "Prepare execTransaction using a complete Safe-format signature bundle. Verify nonce, signatures and inner success through the wallet.", execute, prepareExecute),
  tool("prepare_safe_owner_change", "Prepare a SafeTx typed-data owner signature request to add, remove or replace an owner, or change threshold, through a Safe self-call.", ownerSigning, prepareOwner),
];
export const safeCatalog = safeTools.map(({ name, title, description, schema }) => ({ name, title, description, inputSchema: z.toJSONSchema(schema, { io: "input" }) }));
