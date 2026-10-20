import { createPublicClient, getAddress, http, recoverMessageAddress, toHex, type Address, type Hex } from "viem";
import { createSiweMessage } from "viem/siwe";
import { z } from "zod";
import { ServiceError } from "./core.js";

/** How long a signed ownership message stays acceptable after its issued_at. */
export const PROOF_TTL_SECONDS = 600;
/** How long a checkout link stays usable after the signature was verified. */
export const LINK_TTL_SECONDS = 1800;
const CLOCK_SKEW_SECONDS = 60;

const DEFAULT_RPC_URLS: Readonly<Record<number, string>> = {
  1: "https://ethereum-rpc.publicnode.com",
  10: "https://optimism-rpc.publicnode.com",
  8453: "https://base-rpc.publicnode.com",
  42161: "https://arbitrum-one-rpc.publicnode.com",
  11155111: "https://ethereum-sepolia-rpc.publicnode.com",
};

export type OnrampProofEnv = {
  ONRAMP_LINK_SECRET?: string;
  /** Optional JSON object of chain ID to RPC URL, overriding the public defaults. */
  ONRAMP_RPC_URLS?: string;
};

export const ownershipProofFields = {
  issued_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
    .optional()
    .describe("ownership_proof.issued_at from the first call"),
  signature: z
    .string()
    .regex(/^0x([0-9a-fA-F]{2})+$/)
    .optional()
    .describe("wallet_address's EIP-191 signature over ownership_proof.message"),
};

export type OwnershipRequest = {
  provider: string;
  providerName: string;
  redirectPath: string;
  /** Canonical query of the redirect link, without expires or proof. */
  query: URLSearchParams;
  address: Address;
  chainId: number;
  summary: string;
  issuedAt?: string;
  signature?: string;
};

/**
 * The first call (no signature) returns a message for wallet_address to sign.
 * The second call verifies the signature against the delivery chain and
 * returns a redirect link authenticated by this server, so only a requester
 * who controls the receiving address can obtain a checkout link.
 */
export async function ownershipStep(
  env: OnrampProofEnv,
  origin: string,
  request: OwnershipRequest,
  now = Date.now(),
  fetcher: typeof fetch = fetch,
) {
  const secret = linkSecret(env);
  if ((request.issuedAt === undefined) !== (request.signature === undefined)) {
    throw new ServiceError(
      "ownership_proof_incomplete",
      "Send issued_at and signature together, both from the first call; or send neither to get a new message to sign",
    );
  }
  if (request.issuedAt === undefined || request.signature === undefined) {
    const issuedAt = new Date(Math.floor(now / 1000) * 1000).toISOString();
    const message = await ownershipMessage(origin, request, issuedAt);
    return {
      status: "signature_required" as const,
      ownership_proof: {
        message,
        message_hex: toHex(message),
        signer: request.address,
        chain_id: String(request.chainId),
        issued_at: issuedAt,
        expires_at: new Date(Date.parse(issuedAt) + PROOF_TTL_SECONDS * 1000).toISOString(),
      },
      next_step: `Have the wallet that controls ${request.address} sign message as an EIP-191 personal message on chain ${request.chainId} (for Cloud Wallet: wallet_sign_message with message_hex, verified on chain_id ${request.chainId}). Then call this tool again with the same arguments plus issued_at and signature within ${PROOF_TTL_SECONDS / 60} minutes. Never sign for an address the user does not control.`,
    };
  }

  const issuedMs = Date.parse(request.issuedAt);
  if (!Number.isFinite(issuedMs) || issuedMs > now + CLOCK_SKEW_SECONDS * 1000) {
    throw new ServiceError("ownership_proof_invalid", "issued_at is not one this server issued; call again without issued_at and signature");
  }
  if (now > issuedMs + PROOF_TTL_SECONDS * 1000) {
    throw new ServiceError(
      "ownership_proof_expired",
      "The signed message has expired; call again without issued_at and signature to get a new one",
    );
  }
  const message = await ownershipMessage(origin, request, new Date(issuedMs).toISOString());
  const valid = await verifyOwnership(env, request.chainId, request.address, message, request.signature as Hex, fetcher);
  if (!valid) {
    throw new ServiceError(
      "ownership_proof_rejected",
      `The signature does not prove control of ${request.address} on chain ${request.chainId}. Sign the exact message from the first call with that wallet; do not retry with another wallet's signature.`,
    );
  }
  const expires = Math.floor(now / 1000) + LINK_TTL_SECONDS;
  return {
    status: "verified" as const,
    checkout_url: await signedLink(secret, origin, request.redirectPath, request.query, expires),
    link_expires_at: new Date(expires * 1000).toISOString(),
  };
}

export async function ownershipMessage(origin: string, request: OwnershipRequest, issuedAt: string): Promise<string> {
  const url = new URL(origin);
  const resource = `${url.origin}${request.redirectPath}?${request.query.toString()}`;
  return createSiweMessage({
    domain: url.host,
    address: request.address,
    statement: `Confirm that this wallet receives the ${request.providerName} purchase: ${request.summary}. Signing moves no funds and approves nothing.`,
    uri: url.origin,
    version: "1",
    chainId: request.chainId,
    nonce: (await sha256Hex(resource)).slice(0, 16),
    issuedAt: new Date(issuedAt),
    expirationTime: new Date(Date.parse(issuedAt) + PROOF_TTL_SECONDS * 1000),
    resources: [resource],
  });
}

async function verifyOwnership(
  env: OnrampProofEnv,
  chainId: number,
  address: Address,
  message: string,
  signature: Hex,
  fetcher: typeof fetch,
): Promise<boolean> {
  try {
    if (getAddress(await recoverMessageAddress({ message, signature })) === address) return true;
  } catch {
    // Not a plain 65-byte ECDSA signature; fall through to contract verification.
  }
  const client = createPublicClient({
    transport: http(rpcUrl(env, chainId), { fetchFn: fetcher, retryCount: 1, timeout: 10_000 }),
  });
  // verifyMessage reports an unreachable RPC as an invalid signature, so check
  // the network first; this also catches an override pointing at another chain.
  let networkChainId: number | null = null;
  try {
    networkChainId = await client.getChainId();
  } catch {
    // Reported below.
  }
  if (networkChainId !== chainId) {
    throw new ServiceError("upstream_error", "Could not reach the network to verify the wallet signature; retry shortly", {
      chain_id: String(chainId),
    });
  }
  return client.verifyMessage({ address, message, signature }).catch(() => false);
}

function rpcUrl(env: OnrampProofEnv, chainId: number): string {
  if (env.ONRAMP_RPC_URLS) {
    try {
      const configured = (JSON.parse(env.ONRAMP_RPC_URLS) as Record<string, unknown>)[String(chainId)];
      if (typeof configured === "string" && configured.startsWith("https://")) return configured;
    } catch {
      // Malformed override: fall back to the public default.
    }
  }
  const url = DEFAULT_RPC_URLS[chainId];
  if (url === undefined) throw new ServiceError("unsupported_chain", `No verification network is configured for chain ${chainId}`);
  return url;
}

function linkSecret(env: OnrampProofEnv): string {
  const secret = env.ONRAMP_LINK_SECRET;
  if (!secret || secret.length < 32) {
    throw new ServiceError(
      "onramp_not_configured",
      "Card checkout is not configured on this server. Do not retry; tell the user card purchases are not available here yet.",
    );
  }
  return secret;
}

async function signedLink(secret: string, origin: string, path: string, query: URLSearchParams, expires: number) {
  const linked = new URLSearchParams(query);
  linked.set("expires", String(expires));
  linked.set("proof", await linkMac(secret, path, linked));
  return `${new URL(origin).origin}${path}?${linked.toString()}`;
}

async function linkMac(secret: string, path: string, query: URLSearchParams): Promise<string> {
  const key = await hmacKey(secret);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${path}?${query.toString()}`)));
  return base64Url(mac);
}

export type LinkCheck = { ok: true; params: Record<string, string> } | { ok: false; status: number; code: string };

/**
 * Checks a redirect link's proof and expiry. Returns the request parameters
 * without expires and proof when the link was issued by this server and is
 * still valid.
 */
export async function checkSignedLink(env: OnrampProofEnv, url: URL, now = Date.now()): Promise<LinkCheck> {
  const secret = env.ONRAMP_LINK_SECRET;
  if (!secret || secret.length < 32) return { ok: false, status: 503, code: "onramp_not_configured" };
  const proof = url.searchParams.get("proof");
  const expires = url.searchParams.get("expires");
  if (proof === null || expires === null || !/^\d{1,12}$/.test(expires) || !/^[A-Za-z0-9_-]{43}$/.test(proof)) {
    return { ok: false, status: 400, code: "invalid_link" };
  }
  const query = new URLSearchParams(url.searchParams);
  query.delete("proof");
  const mac = decodeBase64Url(proof);
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    mac,
    new TextEncoder().encode(`${url.pathname}?${query.toString()}`),
  );
  if (!valid) return { ok: false, status: 400, code: "invalid_link" };
  if (now > Number(expires) * 1000) return { ok: false, status: 410, code: "link_expired" };
  query.delete("expires");
  return { ok: true, params: Object.fromEntries(query) };
}

function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
