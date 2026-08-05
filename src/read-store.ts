import { keccak256, stringToHex } from "viem";
import type { Env } from "./core.js";
import { walletBatchEthCallInputSchema } from "./wallet-compatibility.js";

/**
 * How long a stored read-call bundle stays fetchable. Unlike execution plans,
 * a read bundle is idempotent calldata plus decode plans — nothing in it goes
 * stale on a quote's clock — so it outlives plan references and survives an
 * agent conversation that stalls between preparation and the wallet call.
 * Cloudflare KV enforces a 60-second floor.
 */
export const READ_CALLS_TTL_SECONDS = 900;

/**
 * The compact handoff an agent relays instead of a read-call bundle's body.
 *
 * The stored body is an exact `wallet_batch_eth_call` argument object
 * (chain_id, optional block_parameter and from, calls with their decode
 * plans), so the wallet executes it verbatim after fetching and
 * digest-verifying it — the agent never reassembles calldata or ABIs.
 */
export interface ReadCallsReference {
  kind: "ekubo_read_calls_reference";
  read_calls_url: string;
  content_keccak256: string;
  content_length: number;
  expires_at: string;
  chain_id: string;
  call_count: number;
  wallet_instruction: string;
}

interface StorableReadCalls {
  chain_id: string;
  calls: unknown[];
}

const WALLET_INSTRUCTION =
  "Pass read_calls_url (as calls_url) and content_keccak256 (as expected_content_keccak256) unchanged to wallet_batch_eth_call with this same chain_id and no inline calls; the wallet fetches, verifies, and executes the stored calls itself. Do not fetch or restate the calls. A 404 means the reference expired: re-run the tool that produced it. If the wallet only accepts inline calls, fetch this URL once and spread its exact JSON fields into wallet_batch_eth_call unchanged.";

/**
 * Whether a value is exactly a valid wallet_batch_eth_call argument object.
 * The strict mirror schema excludes fork_id and reference fields, so nothing
 * stored here can carry more than the wallet's inline read surface.
 */
export function isStorableReadCalls(
  value: unknown,
): value is StorableReadCalls {
  return walletBatchEthCallInputSchema.safeParse(value).success;
}

export async function storeReadCalls(
  env: Env,
  origin: string,
  readCalls: StorableReadCalls,
): Promise<ReadCallsReference> {
  // The producer's exact object, not the schema's parsed output: the digest
  // must bind the bytes actually serialized and served.
  const body = JSON.stringify(readCalls);
  const id = crypto.randomUUID();
  await env.PLAN_STORE.put(`read:${id}`, body, {
    expirationTtl: READ_CALLS_TTL_SECONDS,
  });
  return {
    kind: "ekubo_read_calls_reference",
    read_calls_url: `${origin}/read/${id}`,
    content_keccak256: keccak256(stringToHex(body)),
    // UTF-8 byte length, matching the Content-Length header the /read route
    // serves; string length would diverge on any non-ASCII byte.
    content_length: new TextEncoder().encode(body).length,
    expires_at: new Date(
      Date.now() + READ_CALLS_TTL_SECONDS * 1000,
    ).toISOString(),
    chain_id: readCalls.chain_id,
    call_count: readCalls.calls.length,
    wallet_instruction: WALLET_INSTRUCTION,
  };
}

export function loadReadCalls(env: Env, id: string): Promise<string | null> {
  return env.PLAN_STORE.get(`read:${id}`, "text");
}
