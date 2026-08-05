import { fakePlanStore } from "./fake-kv.js";
import { describe, expect, it } from "bun:test";
import { keccak256, stringToHex } from "viem";
import type { Env } from "../src/core.js";
import {
  PLAN_TTL_SECONDS,
  loadExecutionPlan,
  referenceExecutionPlans,
} from "../src/plan-store.js";

const ORIGIN = "https://mcp.ekubo.org";

function planFixture(chainId = "1") {
  return {
    schema_version: "1",
    chain_id: chainId,
    caip2_chain_id: `eip155:${chainId}`,
    sender: "0x1111111111111111111111111111111111111111",
    ordered_steps: [
      {
        step: 1,
        kind: "execution",
        submit_condition: "after_prior_required_steps_have_successful_receipts",
        transaction: {
          chain_id: chainId,
          from: "0x1111111111111111111111111111111111111111",
          to: "0x2222222222222222222222222222222222222222",
          data: "0xabcdef",
          value: "0",
        },
      },
    ],
  };
}

function testEnv() {
  const store = fakePlanStore();
  return { env: { PLAN_STORE: store } as unknown as Env, store };
}

describe("plan store", () => {
  it("replaces a top-level execution_plan with a fetchable reference", async () => {
    const { env, store } = testEnv();
    const { value, replaced } = await referenceExecutionPlans(env, ORIGIN, {
      action: "example",
      execution_plan: planFixture(),
    });
    expect(replaced).toBe(1);
    const result = value as {
      execution_plan?: unknown;
      execution_plan_reference: {
        kind: string;
        execution_plan_url: string;
        content_keccak256: `0x${string}`;
        content_length: number;
        chain_id: string;
        sender: string;
        step_count: number;
      };
    };
    expect(result.execution_plan).toBeUndefined();
    const reference = result.execution_plan_reference;
    expect(reference.kind).toBe("ekubo_execution_plan_reference");
    expect(reference.chain_id).toBe("1");
    expect(reference.sender).toBe(
      "0x1111111111111111111111111111111111111111",
    );
    expect(reference.step_count).toBe(1);

    const id = reference.execution_plan_url.split("/plan/")[1] ?? "";
    expect(reference.execution_plan_url).toBe(`${ORIGIN}/plan/${id}`);
    const stored = (await loadExecutionPlan(env, id)) ?? "";
    expect(stored).not.toBe("");
    expect(keccak256(stringToHex(stored))).toBe(reference.content_keccak256);
    expect(reference.content_length).toBe(
      new TextEncoder().encode(stored).length,
    );
    expect(JSON.parse(stored)).toEqual(planFixture());
    expect(store.entries.get(`plan:${id}`)?.expirationTtl).toBe(
      PLAN_TTL_SECONDS,
    );
  });

  it("rewrites every nested quote candidate plan independently", async () => {
    const { env } = testEnv();
    const { value, replaced } = await referenceExecutionPlans(env, ORIGIN, {
      quotes: [
        { execution: { execution_plan: planFixture("1") } },
        { execution: { execution_plan: planFixture("8453") } },
        { execution: null, execution_unavailable: { code: "x" } },
      ],
    });
    expect(replaced).toBe(2);
    const result = value as {
      quotes: {
        execution: {
          execution_plan?: unknown;
          execution_plan_reference?: {
            chain_id: string;
            execution_plan_url: string;
          };
        } | null;
      }[];
    };
    expect(
      result.quotes[0]?.execution?.execution_plan_reference?.chain_id,
    ).toBe("1");
    expect(
      result.quotes[1]?.execution?.execution_plan_reference?.chain_id,
    ).toBe("8453");
    expect(result.quotes[0]?.execution?.execution_plan).toBeUndefined();
    expect(result.quotes[2]?.execution).toBeNull();
    const urls = result.quotes
      .map((quote) => quote.execution)
      .filter(
        (execution): execution is NonNullable<typeof execution> =>
          execution !== null,
      )
      .map((execution) => execution.execution_plan_reference?.execution_plan_url);
    expect(new Set(urls).size).toBe(2);
  });

  it("leaves results without plans untouched and stores nothing", async () => {
    const { env, store } = testEnv();
    const input = {
      tokens: [{ symbol: "ETH" }],
      execution_plan: { schema_version: "2", ordered_steps: [] },
      nested: { execution_plan: "not a plan" },
    };
    const { value, replaced } = await referenceExecutionPlans(
      env,
      ORIGIN,
      input,
    );
    expect(replaced).toBe(0);
    expect(value).toEqual(input);
    expect(store.entries.size).toBe(0);
  });
});
