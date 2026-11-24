// Wallet to X account links (EKU-3113), backed by the Ekubo API's
// /v1/identity routes. This server holds no X credentials: it only relays the
// API's link flow. The X approval is always a person in a browser, and the
// wallet signature goes through the wallet's own signing tool.
//
// Served only when EKUBO_IDENTITY_API_URL is set, on endpoints that include
// the ekubo protocol. Production leaves it empty until the feature launches.
import { getAddress } from "viem";
import { z } from "zod";
import { ServiceError, type Env } from "./core.js";

const STARKNET_MAINNET = 0x534e5f4d41494en;
const TIMEOUT_MS = 20_000;

const chainId = z
  .string()
  .regex(/^(0x[0-9a-fA-F]+|[1-9][0-9]*)$/)
  .describe(
    "Chain ID, decimal or 0x hex. EVM chains where Ekubo is deployed, or Starknet mainnet 0x534e5f4d41494e",
  );
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{1,64}$/)
  .describe("Wallet address, 0x hex");
const linkId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .describe("link_id from start_x_link");
const code = z
  .string()
  .min(10)
  .max(18)
  .describe(
    "The 10-character code the person sees on x.com's return page after approving; ask them for it",
  );

export const startXLinkSchema = z.object({ chain_id: chainId, address });
export const getXLinkSchema = z.object({
  link_id: linkId,
  code: code.optional(),
});
export const completeXLinkSchema = z.object({
  link_id: linkId,
  code,
  signature: z
    .union([
      z.string().regex(/^0x[0-9a-fA-F]*$/).max(16_384),
      z.array(z.string().max(80)).min(1).max(32),
    ])
    .describe(
      "EVM: the 0x signature from wallet_get_signature_result (or eth_signTypedData_v4). Starknet: the signature felts",
    ),
});
export const lookupXIdentitiesSchema = z.object({
  chain_id: chainId,
  addresses: z.array(address).min(1).max(100),
});

const PUBLIC_NOTICE =
  "Linking is public: once linked, anyone can see that this address belongs to the X account. Confirm the person wants that before starting.";

export const xIdentityTools = [
  {
    name: "start_x_link",
    title: "Start linking an X account to a wallet",
    description: `Start linking a wallet address to the person's X (Twitter) account. Returns authorization_url for the person to open in their own browser and approve on x.com; an agent cannot approve for them. x.com then shows a 10-character code: ask the person for it and call get_x_link. ${PUBLIC_NOTICE} Expires in 10 minutes.`,
    schema: startXLinkSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "get_x_link",
    title: "Get the X link message to sign",
    description:
      "Status of a link from start_x_link. With the person's code, returns the verified X handle and the exact typed data the wallet must sign. On EVM, signature_request is a typed_data_signature_request: pass it unchanged as request to Cloud Wallet wallet_sign_typed_data (wallet_id = the address), then complete_x_link with the signature. On Starknet, sign typed_data with the Starknet wallet. Five wrong codes discard the link.",
    schema: getXLinkSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "complete_x_link",
    title: "Complete an X link with the wallet signature",
    description:
      "Verify the wallet signature over get_x_link's typed data and link the address to the X account. An EOA (ECDSA) signature links the address on every EVM chain; a smart-account signature (ERC-1271, ERC-6492, Starknet) only on the chain it was verified on. Replaces any previous link of the address.",
    schema: completeXLinkSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "lookup_x_identities",
    title: "Look up X accounts linked to wallets",
    description:
      "Linked X accounts for up to 100 addresses on one chain, keyed by canonical address (EVM lowercase, Starknet 0x + 64 hex); null when unlinked. Cached for 30 seconds.",
    schema: lookupXIdentitiesSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
] as const;

const STATUS_CODES: Record<number, { code: string; retry: string }> = {
  400: { code: "invalid_request", retry: "Fix the named argument." },
  401: {
    code: "invalid_signature",
    retry:
      "The signature is not by this address over this message. Sign signature_request from get_x_link unchanged, with the wallet at the linked address.",
  },
  403: {
    code: "wrong_code",
    retry: "Ask the person for the code again; do not guess.",
  },
  404: {
    code: "link_not_found",
    retry: "The link expired or was used. Call start_x_link again.",
  },
  409: {
    code: "link_not_ready",
    retry:
      "If the person has not approved on x.com yet, wait for their code. If the message was already used, start again.",
  },
  429: { code: "rate_limited", retry: "Wait a minute, then retry." },
  503: {
    code: "unavailable",
    retry: "Retry shortly; nothing was linked.",
  },
};

function baseUrl(env: Env): string {
  const url = env.EKUBO_IDENTITY_API_URL;
  if (!url) {
    throw new ServiceError(
      "unavailable",
      "X linking is not enabled on this server",
    );
  }
  return url.replace(/\/+$/, "");
}

function requestInit(init: { method?: string; body?: unknown }): RequestInit {
  if (init.body === undefined) {
    return { method: init.method ?? "GET", headers: { accept: "application/json" } };
  }
  return {
    method: init.method ?? "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(init.body),
  };
}

function apiError(status: number, body: { error?: unknown } | null) {
  const mapped = STATUS_CODES[status] ?? {
    code: "upstream_error",
    retry: "Retry shortly.",
  };
  const message =
    body !== null && typeof body.error === "string"
      ? body.error
      : `${status} from the Ekubo API`;
  return new ServiceError(mapped.code, message, {
    retry: mapped.retry,
    retryable: status === 429 || status >= 500,
  });
}

async function identityApi<T>(
  env: Env,
  path: string,
  init: { method?: string; body?: unknown } = {},
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const response = await fetcher(`${baseUrl(env)}${path}`, {
    ...requestInit(init),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: unknown })
    | null;
  if (response.ok && body !== null) return body;
  throw apiError(response.status, body);
}

interface LinkStatus {
  link_id: string;
  status: "awaiting_x" | "awaiting_signature";
  chain_id: string;
  address: string;
  expires_at: string;
  x_user_id: string | null;
  x_handle: string | null;
  typed_data: {
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    domain: Record<string, unknown>;
    message: Record<string, unknown>;
  } | null;
}

export async function startXLink(
  env: Env,
  input: z.infer<typeof startXLinkSchema>,
) {
  const result = await identityApi<{
    link_id: string;
    authorization_url: string;
    expires_at: string;
  }>(env, "/v1/identity/x/link/start", {
    method: "POST",
    body: { chain_id: input.chain_id, address: input.address },
  });
  return {
    ...result,
    notice: PUBLIC_NOTICE,
    next: "Give authorization_url to the person to open and approve on x.com. Then ask them for the 10-character code shown and call get_x_link with link_id and code.",
  };
}

function signatureRequest(status: LinkStatus) {
  if (status.typed_data === null) return null;
  if (BigInt(status.chain_id) === STARKNET_MAINNET) return null;
  return {
    schema_version: "1",
    kind: "typed_data_signature_request",
    signer: getAddress(status.address),
    typed_data: status.typed_data,
    verification_chain_id: Number(status.chain_id),
    valid_until: String(Math.floor(Date.parse(status.expires_at) / 1000)),
  };
}

function nextStep(status: LinkStatus, request: unknown) {
  if (status.status === "awaiting_x") {
    return "The person has not approved on x.com yet. Wait for them to share the code, then call get_x_link again with it.";
  }
  if (status.typed_data === null) {
    return "X is verified. Call get_x_link again with the person's code to get the message to sign.";
  }
  return request === null
    ? "Sign typed_data with the Starknet account (SNIP-12), then call complete_x_link with link_id, code and the signature felts."
    : "Pass signature_request unchanged as request to wallet_sign_typed_data with wallet_id = the address, wait for wallet_get_signature_result, then call complete_x_link with link_id, code and the signature.";
}

export async function getXLink(
  env: Env,
  input: z.infer<typeof getXLinkSchema>,
) {
  const query =
    input.code === undefined ? "" : `?code=${encodeURIComponent(input.code)}`;
  const status = await identityApi<LinkStatus>(
    env,
    `/v1/identity/x/link/${input.link_id}${query}`,
  );
  const request = signatureRequest(status);
  return {
    ...status,
    signature_request: request,
    next: nextStep(status, request),
  };
}

export async function completeXLink(
  env: Env,
  input: z.infer<typeof completeXLinkSchema>,
) {
  return identityApi<Record<string, unknown>>(
    env,
    `/v1/identity/x/link/${input.link_id}/complete`,
    {
      method: "POST",
      body: { code: input.code, signature: input.signature },
    },
  );
}

export async function lookupXIdentities(
  env: Env,
  input: z.infer<typeof lookupXIdentitiesSchema>,
) {
  const query = new URLSearchParams({ chainId: input.chain_id });
  for (const value of input.addresses) query.append("address", value);
  return identityApi<Record<string, unknown>>(
    env,
    `/v1/identity/addresses?${query.toString()}`,
  );
}

export const xIdentityHandlers: Record<
  (typeof xIdentityTools)[number]["name"],
  (env: Env, input: never) => Promise<unknown>
> = {
  start_x_link: startXLink,
  get_x_link: getXLink,
  complete_x_link: completeXLink,
  lookup_x_identities: lookupXIdentities,
};
