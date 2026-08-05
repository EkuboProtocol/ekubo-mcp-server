import { fakePlanStore } from "./fake-kv.js";
import { describe, expect, it } from "bun:test";
import { keccak256, stringToHex } from "viem";
import type { Env } from "../src/core.js";
import { referenceExecutionPlans } from "../src/plan-store.js";
import { READ_CALLS_TTL_SECONDS, loadReadCalls } from "../src/read-store.js";

const ORIGIN = "https://mcp.ekubo.org";

function readCallsFixture(chainId = "1") {
  return {
    chain_id: chainId,
    block_parameter: "pending",
    calls: [
      {
        id: "pool-state",
        to: "0xF68F25CA6C817733b7B15a42191AE72A34d56a2B",
        data: "0x1234abcd",
        include_raw: true,
      },
    ],
  };
}

function testEnv() {
  const store = fakePlanStore();
  return { env: { PLAN_STORE: store } as unknown as Env, store };
}

describe("read store", () => {
  it("replaces read_calls with a fetchable reference bound to the exact bytes", async () => {
    const { env, store } = testEnv();
    const { value, replaced } = await referenceExecutionPlans(env, ORIGIN, {
      action: "example",
      read_calls: readCallsFixture(),
    });
    expect(replaced).toBe(1);
    const result = value as {
      read_calls?: unknown;
      read_calls_reference: {
        kind: string;
        read_calls_url: string;
        content_keccak256: `0x${string}`;
        content_length: number;
        chain_id: string;
        call_count: number;
        wallet_instruction: string;
      };
    };
    expect(result.read_calls).toBeUndefined();
    const reference = result.read_calls_reference;
    expect(reference.kind).toBe("ekubo_read_calls_reference");
    expect(reference.chain_id).toBe("1");
    expect(reference.call_count).toBe(1);
    expect(reference.wallet_instruction).toContain("calls_url");
    expect(reference.wallet_instruction).toContain(
      "expected_content_keccak256",
    );

    const id = reference.read_calls_url.split("/read/")[1] ?? "";
    expect(reference.read_calls_url).toBe(`${ORIGIN}/read/${id}`);
    const stored = (await loadReadCalls(env, id)) ?? "";
    expect(stored).not.toBe("");
    expect(keccak256(stringToHex(stored))).toBe(reference.content_keccak256);
    expect(reference.content_length).toBe(stored.length);
    expect(JSON.parse(stored)).toEqual(readCallsFixture());
    expect(store.entries.get(`read:${id}`)?.expirationTtl).toBe(
      READ_CALLS_TTL_SECONDS,
    );
  });

  it("rewrites nested read bundles and coexists with plan references", async () => {
    const { env } = testEnv();
    const plan = {
      schema_version: "1",
      chain_id: "1",
      caip2_chain_id: "eip155:1",
      sender: "0x1111111111111111111111111111111111111111",
      ordered_steps: [
        {
          step: 1,
          kind: "execution",
          submit_condition: "always",
          transaction: {
            chain_id: "1",
            from: "0x1111111111111111111111111111111111111111",
            to: "0x2222222222222222222222222222222222222222",
            data: "0xabcdef",
            value: "0",
          },
        },
      ],
    };
    const { value, replaced } = await referenceExecutionPlans(env, ORIGIN, {
      execution_plan: plan,
      pools: [
        { current_state_query: { read_calls: readCallsFixture("1") } },
        { current_state_query: { read_calls: readCallsFixture("8453") } },
      ],
    });
    expect(replaced).toBe(3);
    const result = value as {
      execution_plan_reference?: { execution_plan_url: string };
      pools: {
        current_state_query: {
          read_calls?: unknown;
          read_calls_reference?: { chain_id: string; read_calls_url: string };
        };
      }[];
    };
    expect(result.execution_plan_reference?.execution_plan_url).toContain(
      "/plan/",
    );
    expect(
      result.pools[0]?.current_state_query.read_calls_reference?.chain_id,
    ).toBe("1");
    expect(
      result.pools[1]?.current_state_query.read_calls_reference?.chain_id,
    ).toBe("8453");
    expect(result.pools[0]?.current_state_query.read_calls).toBeUndefined();
    const urls = result.pools.map(
      (pool) => pool.current_state_query.read_calls_reference?.read_calls_url,
    );
    expect(new Set(urls).size).toBe(2);
  });

  it("leaves invalid bundles inline and stores nothing", async () => {
    const { env, store } = testEnv();
    const oversized = {
      chain_id: "1",
      calls: Array.from({ length: 129 }, (_, index) => ({
        id: `call-${index}`,
        to: "0xF68F25CA6C817733b7B15a42191AE72A34d56a2B",
        data: "0x1234",
      })),
    };
    const input = {
      read_calls: { chain_id: "1", calls: [], fork_id: "smuggled" },
      unknown_field: {
        read_calls: { ...readCallsFixture(), extra_field: true },
      },
      no_chain: { read_calls: { calls: readCallsFixture().calls } },
      bad_address: {
        read_calls: {
          chain_id: "1",
          calls: [{ to: "0x123", data: "0x" }],
        },
      },
      oversized: { read_calls: oversized },
      not_an_object: { read_calls: "fetch these calls" },
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
