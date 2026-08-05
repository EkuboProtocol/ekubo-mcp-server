import { keccak256, stringToHex } from "viem";
import type { Env } from "./core.js";
import { isStorableReadCalls, storeReadCalls } from "./read-store.js";

/**
 * How long a stored plan body stays fetchable. Plans embed quotes and
 * allowance-dependent calldata that go stale on the same clock as the quote
 * itself, so a reference that outlives its plan's usefulness would only invite
 * executing against a dead price. Cloudflare KV enforces a 60-second floor.
 */
export const PLAN_TTL_SECONDS = 300;

/**
 * The compact handoff an agent relays instead of an execution plan's body.
 *
 * The agent is the transport between this server and an unrelated wallet
 * server, and every byte of a tool result it must re-emit costs model output.
 * A plan's body — calldata, decode plans, failure-policy prose — is consumed
 * only by the wallet, so it is stored here and travels as a URL the wallet
 * dereferences itself. content_keccak256 binds the reference to the exact
 * bytes stored: the wallet recomputes it over what it fetched and refuses a
 * mismatch, so the two servers verify integrity without sharing any state.
 */
export interface ExecutionPlanReference {
  kind: "ekubo_execution_plan_reference";
  execution_plan_url: string;
  content_keccak256: string;
  content_length: number;
  expires_at: string;
  chain_id: string;
  sender: string;
  step_count: number;
  wallet_instruction: string;
}

interface StorableExecutionPlan {
  schema_version: string;
  chain_id: string;
  sender: string;
  ordered_steps: unknown[];
}

const WALLET_INSTRUCTION =
  "Pass execution_plan_url and content_keccak256 (as expected_content_keccak256) unchanged to the wallet's simulate and send tools. Do not fetch, restate, or reconstruct the plan yourself; the wallet fetches, verifies, and validates it. If the wallet only accepts an inline execution_plan, fetch this URL once and pass its exact JSON unchanged.";

export async function storeExecutionPlan(
  env: Env,
  origin: string,
  plan: StorableExecutionPlan,
): Promise<ExecutionPlanReference> {
  const body = JSON.stringify(plan);
  const id = crypto.randomUUID();
  await env.PLAN_STORE.put(`plan:${id}`, body, {
    expirationTtl: PLAN_TTL_SECONDS,
  });
  return {
    kind: "ekubo_execution_plan_reference",
    execution_plan_url: `${origin}/plan/${id}`,
    content_keccak256: keccak256(stringToHex(body)),
    content_length: body.length,
    expires_at: new Date(Date.now() + PLAN_TTL_SECONDS * 1000).toISOString(),
    chain_id: plan.chain_id,
    sender: plan.sender,
    step_count: plan.ordered_steps.length,
    wallet_instruction: WALLET_INSTRUCTION,
  };
}

export function loadExecutionPlan(
  env: Env,
  id: string,
): Promise<string | null> {
  return env.PLAN_STORE.get(`plan:${id}`, "text");
}

/**
 * Replace every embedded wallet payload in a tool result with a stored
 * reference. One structural walk covers every preparation tool and every
 * quote candidate, so no tool has to know its payloads are stored: anything
 * shaped like a plan under a property named `execution_plan` becomes an
 * `execution_plan_reference`, and anything shaped like an exact
 * wallet_batch_eth_call argument object under a property named `read_calls`
 * becomes a `read_calls_reference`. Values that fail the shape checks stay
 * inline untouched, so a false-positive property name can never destroy
 * content.
 */
export async function referenceExecutionPlans(
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
    const rewritten: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (key === "execution_plan" && isExecutionPlan(entry)) {
        replaced += 1;
        rewritten["execution_plan_reference"] = await storeExecutionPlan(
          env,
          origin,
          entry,
        );
      } else if (key === "read_calls" && isStorableReadCalls(entry)) {
        replaced += 1;
        rewritten["read_calls_reference"] = await storeReadCalls(
          env,
          origin,
          entry,
        );
      } else {
        rewritten[key] = await walk(entry);
      }
    }
    return rewritten;
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
