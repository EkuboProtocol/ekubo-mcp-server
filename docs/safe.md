# Safe signer preparation

Connect to `https://mcp.ekubo.org/mcp/safe`. This endpoint is separate from
the root `/mcp` bundle. Discovery is available at `/tools?protocol=safe`.

Supported contracts are Safe **1.3.0 and 1.4.1**, using the chain-bound
`EIP712Domain(uint256 chainId,address verifyingContract)` domain. The caller
provides the Safe address and chain; the server makes no RPC or Transaction
Service requests and never signs or broadcasts.

## Tools

| Tool | Result |
| --- | --- |
| `prepare_safe_reads` | Version, owners, threshold, nonce, optional owner/hash approval reads |
| `prepare_safe_transaction_signature` | ERC-8410 `SafeTx` owner signing request, signing/request digests, validation reads |
| `prepare_safe_message_signature` | ERC-8410 `SafeMessage(bytes message)` owner signing request |
| `prepare_safe_approve_hash` | Onchain owner `approveHash` execution plan for an exact transaction |
| `prepare_safe_execution` | `execTransaction` execution plan with a complete Safe-format signature bundle |
| `prepare_safe_owner_change` | Safe self-call signing request to add/remove/swap owners or change threshold |

All numeric inputs are canonical decimal strings, including `operation` (`"0"`
CALL or `"1"` DELEGATECALL). Transaction signing requires every SafeTx field:
`to`, `value`, `data`, `operation`, `safeTxGas`, `baseGas`, `gasPrice`, `gasToken`,
`refundReceiver`, and `nonce`. No fee, refund, or nonce values are guessed.
Byte input is bounded to 64 KiB. Hex output is lowercase. Execution requires a
nonzero sender and at least one complete 65-byte signature entry. A hash-approval
read requires both `owner` and `transaction_hash`.

### SafeMessage input semantics

`prepare_safe_message_signature` wraps the exact supplied bytes as
`SafeMessage.message`; it does not hash an application message first.
For the same signature semantics as Safe Wallet's website:

- For text, pass the EIP-191 `hashMessage(text)` digest.
- For application typed data, pass its EIP-712 `hashTypedData(...)` digest.
- For `isValidSignature(bytes32,bytes)`, pass the exact bytes32 digest that the
  verifier will supply, without hashing it again.

For example, signing the application text `hello` uses
`message: "0x50b2c43fd39106bafbba0da34fc430e1f91e3c96ea2acee2bc34119f92b37750"`.
Supplying its raw UTF-8 bytes `0x68656c6c6f` instead signs a different message,
usable with the legacy `isValidSignature(bytes,bytes)` call over those raw bytes.

## Wallet handoff

1. Obtain the connected owner account and the intended Safe address and chain.
2. Run the prepared read bundle through the wallet, passing
   `read_calls_reference` unchanged. Verify version, owner membership, threshold,
   nonce and, for transaction signatures, the onchain transaction hash against
   `signing_digest`. Decode locally and retain raw bytes.
3. Review the entire Safe transaction and simulate its effects. A delegatecall
   operates in Safe storage context; refund fields can transfer assets too.
4. Pass `typed_data_signature_request_reference` unchanged to a wallet that
   supports ERC-8410 typed-data requests. It fetches and verifies the bytes and
   authorizes the owner signature independently of transaction permissions.
5. Aggregate signatures using Safe's owner ordering and encoding conventions.
   Supply the resulting complete bundle to `prepare_safe_execution`, then pass
    its `execution_plan_reference` unchanged to the executing wallet.

The execution tool accepts a complete Safe-format bundle and preserves it
verbatim. Normalize EIP-712 EOA signatures with wallet-returned `v=0/1` to
`v=27/28` before assembly. Do not apply that conversion to an already assembled
bundle: Safe uses `v=0` for contract signatures and `v=1` for prevalidated
signatures. Contract entries also require correctly computed dynamic offsets.

The artifact has exactly `schema_version`, `kind`, `signer`, `typed_data` and
optional `valid_until`. The signer is the actual owner authorizing the SafeTx,
not implicitly the Safe address. The artifact-integrity digest, EIP-712 signing
digest and ERC-8410 request digest are distinct. The wallet signs the EIP-712
digest. No signature delivery endpoint is configured; results return to the
caller for aggregation or external relay.

`valid_until` constrains wallet signing/release only. It cannot revoke a released
signature. SafeTx nonce consumption provides transaction replay protection;
SafeMessage has no nonce or expiry. Message signatures require a compatible
Safe fallback handler and intended ERC-1271 verifier, and one owner signature
does not itself constitute a threshold Safe signature.

Execution preparation returns `getTransactionHash` and `checkSignatures` reads
alongside version, owners, threshold and nonce, with the read bundle's `from`
set to the executor. This matters for prevalidated signatures that rely on
`msg.sender`. The signature check receives the complete EIP-712 preimage.
Require every read to succeed, the onchain hash to equal `signing_digest`, and
the version to match the requested version.

Execution also requires current nonce equality: `execTransaction` uses the
Safe's current nonce rather than taking it as an argument. `checkSignatures`
does not check nonce freshness. `expected_nonce` is a wallet precondition in
the preparation response, not an enforced execution-plan field. Revalidate
before execution and require inner `success=true` / `ExecutionSuccess`; an
outer successful receipt can contain `ExecutionFailure` and consume the nonce.
The preparer constructs these reads but does not execute them or claim to
have verified live state.

Owner changes use a zero-value CALL from the Safe to itself, zero gas refund
fields, and an explicitly supplied nonce. They require the existing threshold.
Check linked-list predecessors, unique owners and the resulting threshold
against fresh state. The first owner's predecessor is sentinel address
`0x0000000000000000000000000000000000000001`.
Preparation rejects self-ownership, zero or self-referential predecessors,
and replacements that are already identified as the old owner or predecessor.
Checks requiring the full current owner list remain wallet-read preconditions.

## Signature compatibility tests

Run `bun test test/safe-signatures.test.ts` (also included in `bun test`).
These tests run offline in EthereumJS's in-memory EVM. Pinned official npm
artifacts supply the actual Safe 1.3.0 and 1.4.1 singleton, proxy, and
CompatibilityFallbackHandler creation bytecode. Each fixture deploys and sets
up a fresh Safe, rather than mocking its signature verifier.

A minimal test EOA consumer retrieves the stored ERC-8410 body, checks its
integrity, signer and cutoff, independently computes its signing/request
digests, and signs its typed data using ethers. The producer uses viem, so the
signer does not merely reuse the producer's hash implementation or digest.
This fixture covers the fixed Safe request shapes, not a general-purpose
ERC-8410 wallet parser or HTTPS transport.

The contracts themselves verify:

- Agreement with `getTransactionHash` and acceptance by `checkSignatures`.
- Successful `execTransaction`, exact ETH delivery, nonce consumption and replay rejection.
- Threshold enforcement and ascending owner-address signature ordering.
- Both legacy `isValidSignature(bytes,bytes)` and modern
  `isValidSignature(bytes32,bytes)` through the installed fallback handler.
- Owner addition and threshold change via a signed Safe self-call.
- Website-compatible preprocessing of text and application typed-data messages.
- Prepared execution-validation reads, including executor-dependent prevalidated signatures.
- Rejection of signatures over the request digest, unadjusted personal-sign
  signatures, non-owner signatures, and substitutions of any SafeTx field,
  chain ID or verifying Safe address.

These tests establish EOA-owner compatibility. Contract-owner signature
aggregation and other fallback handlers require their own fixtures.
