import { keccak256, stringToHex } from "viem";
import { z } from "zod";
import type { Env } from "./core.js";
import { walletBatchEthCallInputSchema } from "./wallet-compatibility.js";

export const ARTIFACT_TTL_SECONDS = 3600;

export type ArtifactType = "execution_plan" | "read_calls" | "token_list" | "typed_data_signature_request";

export interface ArtifactReference {
  kind: "artifact_reference";
  artifact_type: ArtifactType;
  url: string;
  integrity: { algorithm: "keccak256"; value: `0x${string}` };
  bytes: number;
  instruction: string;
}

/**
 * The envelope's shape for tool outputSchema declarations. Loose objects
 * throughout: outputSchema validation must describe results, never strip or
 * reject additive fields.
 */
export const artifactReferenceSchema = z.looseObject({
  kind: z.literal("artifact_reference"),
  artifact_type: z.enum(["execution_plan", "read_calls", "token_list", "typed_data_signature_request"]),
  url: z.string(),
  integrity: z.looseObject({
    algorithm: z.literal("keccak256"),
    value: z.string(),
  }),
  bytes: z.number().int(),
  instruction: z.string(),
});

interface StorableExecutionPlan {
  schema_version: string;
  chain_id: string;
  sender: string;
  ordered_steps: unknown[];
}

interface StorableReadCalls {
  chain_id: string;
  calls: unknown[];
}

export interface StorableTokenList {
  name: string;
  tokens: {
    chain_id: string;
    address: string;
    symbol: string;
    name: string;
    decimals: number;
  }[];
}

function passthroughRule(property: string): string {
  return `Hold the producer result in a variable and pass this object through from it (const ref = result.${property}; then reference: ref) in the same code block; never retype url, bytes or integrity by hand, since a hand-copied envelope fails the wallet's parse, length or digest check, or 404s.`;
}

const PLAN_INSTRUCTION = `Pass this reference object unchanged as the wallet's reference argument for simulating and sending. Do not fetch, restate, or reconstruct the plan; the wallet fetches it, verifies integrity, and validates it. ${passthroughRule("execution_plan_reference")} A fetch 404 means the reference expired: re-run the Ekubo preparation tool for a fresh plan.`;

const READ_CALLS_INSTRUCTION = `Pass this reference object unchanged as wallet_batch_eth_call's reference argument, with no inline calls; the wallet fetches, verifies, and executes the stored calls itself. Do not fetch or restate the calls. ${passthroughRule("read_calls_reference")} A fetch 404 means the reference expired: re-run the tool that produced it.`;

const TOKEN_LIST_INSTRUCTION =
  "Pass this reference object unchanged as the reference argument of the wallet's propose-tokens tool (to suggest these names to its owner) or its get-balances tool (to read balances for these addresses), with no inline tokens; the wallet fetches and integrity-verifies the list itself. Do not fetch or restate the entries — writing out a thousand-token list costs roughly fifty thousand output tokens and this envelope costs a few hundred. A fetch 404 means the reference expired: re-run the tool that produced it.";

export async function storeArtifact(
  env: Env,
  origin: string,
  artifact:
    | { artifactType: "execution_plan"; body: StorableExecutionPlan }
    | { artifactType: "read_calls"; body: StorableReadCalls }
    | { artifactType: "token_list"; body: StorableTokenList }
    | { artifactType: "typed_data_signature_request"; body: Record<string, unknown> },
): Promise<ArtifactReference> {
  const body = JSON.stringify(artifact.body);
  const id = crypto.randomUUID();
  await env.ARTIFACT_STORE.put(`artifact/${id}`, body);
  return {
    kind: "artifact_reference",
    artifact_type: artifact.artifactType,
    url: `${origin}/artifact/${id}`,
    integrity: {
      algorithm: "keccak256",
      value: keccak256(stringToHex(body)),
    },
    bytes: new TextEncoder().encode(body).length,
    instruction: INSTRUCTIONS[artifact.artifactType],
  };
}

const INSTRUCTIONS: Record<ArtifactType, string> = {
  typed_data_signature_request: "Pass this reference unchanged to the wallet's typed-data signing tool. The wallet must fetch, verify, validate and authorize this ERC-8410 signature request. Do not reconstruct the typed data or sign its request digest. A 404 requires fresh preparation.",
  execution_plan: PLAN_INSTRUCTION,
  read_calls: READ_CALLS_INSTRUCTION,
  token_list: TOKEN_LIST_INSTRUCTION,
};

export async function loadArtifact(
  env: Env,
  id: string,
): Promise<string | null> {
  const object = await env.ARTIFACT_STORE.get(`artifact/${id}`);
  if (object === null) return null;
  // R2 has no per-object TTL, so expiry is enforced here against the upload
  // timestamp this same server wrote; a lifecycle rule handles physical
  // deletion later. Serving nothing past the advertised window keeps the
  // "404 means re-run the producer" contract deterministic.
  if (Date.now() - object.uploaded.getTime() > ARTIFACT_TTL_SECONDS * 1000) {
    return null;
  }
  return object.text();
}

/**
 * Replace every embedded wallet payload in a tool result with a stored
 * reference. One structural walk covers every preparation tool and every
 * quote candidate, so no tool has to know its payloads are stored: anything
 * shaped like a plan under a property named `execution_plan` becomes an
 * `execution_plan_reference`, and anything shaped like an exact
 * wallet_batch_eth_call argument object under a property named `read_calls`
 * becomes a `read_calls_reference` — both carrying the same
 * `artifact_reference` envelope. Values that fail the shape checks stay
 * inline untouched, so a false-positive property name can never destroy
 * content.
 */
export async function referenceWalletArtifacts(
  env: Env,
  origin: string,
  value: unknown,
): Promise<{ value: unknown; replaced: number }> {
  let replaced = 0;

  async function walk(node: unknown): Promise<unknown> {
    if (Array.isArray(node)) {
      return Promise.all(node.map((entry) => walk(entry)));
    }
    if (node === null || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    const rewritten = await Promise.all(
      Object.entries(record).map(
        async ([key, entry]): Promise<[string, unknown]> => {
          if (key === "typed_data_signature_request" && isSignatureRequest(entry)) {
            replaced += 1;
            return ["typed_data_signature_request_reference", await storeArtifact(env, origin, { artifactType: "typed_data_signature_request", body: entry })];
          }
          if (key === "execution_plan" && isExecutionPlan(entry)) {
            replaced += 1;
            return [
              "execution_plan_reference",
              await storeArtifact(env, origin, {
                artifactType: "execution_plan",
                body: entry,
              }),
            ];
          }
          if (key === "read_calls" && isStorableReadCalls(entry)) {
            replaced += 1;
            return [
              "read_calls_reference",
              await storeArtifact(env, origin, {
                artifactType: "read_calls",
                body: entry,
              }),
            ];
          }
          return [key, await walk(entry)];
        },
      ),
    );
    return Object.fromEntries(rewritten);
  }

  return { value: await walk(value), replaced };
}

function isSignatureRequest(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return request.kind === "typed_data_signature_request" && request.schema_version === "1" && typeof request.signer === "string" && typeof request.typed_data === "object";
}

function isExecutionPlan(value: unknown): value is StorableExecutionPlan {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)["schema_version"] === "1" &&
    Array.isArray((value as Record<string, unknown>)["ordered_steps"]) &&
    typeof (value as Record<string, unknown>)["chain_id"] === "string" &&
    typeof (value as Record<string, unknown>)["sender"] === "string"
  );
}

/**
 * Whether a value is exactly a valid wallet_batch_eth_call argument object.
 * The strict mirror schema excludes fork_id and the reference envelope, so
 * nothing stored here can carry more than the wallet's inline read surface.
 */
export function isStorableReadCalls(
  value: unknown,
): value is StorableReadCalls {
  return walletBatchEthCallInputSchema.safeParse(value).success;
}
