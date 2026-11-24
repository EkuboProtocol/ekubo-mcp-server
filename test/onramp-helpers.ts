import { expect } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";

export const LINK_SECRET = "fixture-onramp-link-secret-0123456789abcdef";
export const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
export const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`);

type ToolResult = { result: { isError?: boolean; structuredContent: Record<string, any> } };

/**
 * Runs the two-call ownership flow: the first call returns the message to
 * sign, the second sends it back signed by signer and returns the result.
 */
export async function withProof(
  call: (args: Record<string, unknown>) => Promise<ToolResult>,
  args: Record<string, unknown>,
  signer = owner,
): Promise<ToolResult> {
  const first = await call(args);
  expect(first.result.isError).not.toBe(true);
  const proof = first.result.structuredContent.ownership_proof;
  expect(first.result.structuredContent.status).toBe("signature_required");
  const signature = await signer.signMessage({ message: proof.message });
  return call({ ...args, issued_at: proof.issued_at, signature });
}
