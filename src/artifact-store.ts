import { keccak256, stringToHex } from "viem";
import { z } from "zod";
import type { Env } from "./core.js";
import { walletBatchEthCallInputSchema } from "./wallet-compatibility.js";

/**
 * How long a stored artifact body stays fetchable. This is a storage detail,
 * deliberately absent from the reference envelope: a 404 already tells a
 * wallet the body is gone, and a plan's semantic validity is expressed by the
 * deadline inside its calldata and enforced by the wallet's simulation
 * against current chain state — never by comparing wall clocks.
 *
 * Bodies live in R2, which is strongly consistent: a wallet on another edge
 * can fetch a reference the instant its producing tool call returns, with no
 * propagation window in which a fresh reference 404s. Expiry is enforced at
 * read time against the object's upload timestamp (one server's clock on
 * both sides, so no cross-clock coupling); configure a bucket lifecycle rule
 * to physically delete aged objects.
 */
export const ARTIFACT_TTL_SECONDS = 3600;

export type ArtifactType = "execution_plan" | "read_calls";

/**
 * The compact handoff an agent relays instead of a wallet payload's body.
 *
 * The agent is the transport between this server and an unrelated wallet
 * server, and every byte of a tool result it must re-emit costs model output.
 * A body — calldata, decode plans, failure-policy prose — is consumed only by
 * the wallet, so it is stored here and travels as this envelope, which the
 * agent passes to the wallet VERBATIM as one `reference` argument. The wallet
 * fetches the body itself and recomputes `integrity.value` over the fetched
 * bytes, refusing a mismatch, so the two servers verify integrity without
 * sharing any state. Nothing in the envelope is vendor-specific: any producer
 * can emit it and any wallet can consume it.
 */
export interface ArtifactReference {
  kind: "artifact_reference";
  artifact_type: ArtifactType;
  url: string;
  integrity: { algorithm: "keccak256"; value: `0x${string}` };
  /** Exact stored byte length; consumers reject a body of any other size. */
  bytes: number;
  summary:
    | { chain_id: string; sender: string; step_count: number }
    | { chain_id: string; call_count: number };
  instruction: string;
}

/**
 * The envelope's shape for tool outputSchema declarations. Loose objects
 * throughout: outputSchema validation must describe results, never strip or
 * reject additive fields.
 */
export const artifactReferenceSchema = z.looseObject({
  kind: z.literal("artifact_reference"),
  artifact_type: z.enum(["execution_plan", "read_calls"]),
  url: z.string(),
  integrity: z.looseObject({
    algorithm: z.literal("keccak256"),
    value: z.string(),
  }),
  bytes: z.number().int(),
  summary: z.looseObject({
    chain_id: z.string(),
    sender: z.string().optional(),
    step_count: z.number().int().optional(),
    call_count: z.number().int().optional(),
  }),
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

const PLAN_INSTRUCTION =
  "Pass this reference object unchanged as the wallet's reference argument for simulating and sending. Do not fetch, restate, or reconstruct the plan; the wallet fetches it, verifies integrity, and validates it. A fetch 404 means the reference expired: re-run the Ekubo preparation tool for a fresh plan.";

const READ_CALLS_INSTRUCTION =
  "Pass this reference object unchanged as wallet_batch_eth_call's reference argument, with no inline calls; the wallet fetches, verifies, and executes the stored calls itself. Do not fetch or restate the calls. A fetch 404 means the reference expired: re-run the tool that produced it.";

export async function storeArtifact(
  env: Env,
  origin: string,
  artifact:
    | { artifactType: "execution_plan"; body: StorableExecutionPlan }
    | { artifactType: "read_calls"; body: StorableReadCalls },
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
      // Digest of the exact bytes stored and served; the wallet recomputes
      // this over what it fetched and refuses a mismatch.
      value: keccak256(stringToHex(body)),
    },
    // UTF-8 byte length, matching the Content-Length header the /artifact
    // route serves; string length would diverge on any non-ASCII byte.
    bytes: new TextEncoder().encode(body).length,
    summary:
      artifact.artifactType === "execution_plan"
        ? {
            chain_id: artifact.body.chain_id,
            sender: artifact.body.sender,
            step_count: artifact.body.ordered_steps.length,
          }
        : {
            chain_id: artifact.body.chain_id,
            call_count: artifact.body.calls.length,
          },
    instruction:
      artifact.artifactType === "execution_plan"
        ? PLAN_INSTRUCTION
        : READ_CALLS_INSTRUCTION,
  };
}

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
    // One result can carry several bodies (per-chain read bundles, quote
    // candidates); store them concurrently rather than serializing KV puts.
    const rewritten = await Promise.all(
      Object.entries(record).map(
        async ([key, entry]): Promise<[string, unknown]> => {
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
