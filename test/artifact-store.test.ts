import { fakeArtifactStore } from "./fake-r2.js";
import { describe, expect, it } from "bun:test";
import { keccak256, stringToHex } from "viem";
import type { Env } from "../src/core.js";
import {
  ARTIFACT_TTL_SECONDS,
  loadArtifact,
  referenceWalletArtifacts,
} from "../src/artifact-store.js";

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
  const store = fakeArtifactStore();
  return { env: { ARTIFACT_STORE: store } as unknown as Env, store };
}

interface ReferenceShape {
  kind: string;
  artifact_type: string;
  url: string;
  integrity: { algorithm: string; value: `0x${string}` };
  bytes: number;
  instruction: string;
}

async function storedBody(env: Env, reference: ReferenceShape | undefined) {
  const id = reference?.url.split("/artifact/")[1] ?? "";
  return JSON.parse((await loadArtifact(env, id)) ?? "null") as {
    chain_id?: string;
  } | null;
}

describe("artifact store", () => {
  it("replaces a top-level execution_plan with a fetchable reference envelope", async () => {
    const { env, store } = testEnv();
    const { value, replaced } = await referenceWalletArtifacts(env, ORIGIN, {
      action: "example",
      execution_plan: planFixture(),
    });
    expect(replaced).toBe(1);
    const result = value as {
      execution_plan?: unknown;
      execution_plan_reference: ReferenceShape;
    };
    expect(result.execution_plan).toBeUndefined();
    const reference = result.execution_plan_reference;
    expect(reference.kind).toBe("artifact_reference");
    expect(reference.artifact_type).toBe("execution_plan");
    expect(reference.instruction).toContain("unchanged");
    // No wall-clock fields travel in the envelope: validity is expressed by
    // the calldata and enforced by simulation, storage expiry by a 404.
    expect(reference).not.toHaveProperty("expires_at");
    expect(reference).not.toHaveProperty("valid_until");
    // No descriptive duplicate of the body travels either: the
    // integrity-verified body is the only source of truth.
    expect(reference).not.toHaveProperty("summary");

    const id = reference.url.split("/artifact/")[1] ?? "";
    expect(reference.url).toBe(`${ORIGIN}/artifact/${id}`);
    const stored = (await loadArtifact(env, id)) ?? "";
    expect(stored).not.toBe("");
    expect(reference.integrity.algorithm).toBe("keccak256");
    expect(keccak256(stringToHex(stored))).toBe(reference.integrity.value);
    expect(reference.bytes).toBe(new TextEncoder().encode(stored).length);
    expect(JSON.parse(stored)).toEqual(planFixture());
    expect(store.entries.has(`artifact/${id}`)).toBe(true);

    // R2 has no per-object TTL, so expiry is enforced at read time against
    // the upload timestamp: an aged object reads as a miss.
    const entry = store.entries.get(`artifact/${id}`)!;
    entry.uploaded = new Date(
      Date.now() - (ARTIFACT_TTL_SECONDS + 1) * 1000,
    );
    expect(await loadArtifact(env, id)).toBeNull();
  });

  it("replaces read_calls with a reference bound to the exact bytes", async () => {
    const { env, store } = testEnv();
    const { value, replaced } = await referenceWalletArtifacts(env, ORIGIN, {
      action: "example",
      read_calls: readCallsFixture(),
    });
    expect(replaced).toBe(1);
    const result = value as {
      read_calls?: unknown;
      read_calls_reference: ReferenceShape;
    };
    expect(result.read_calls).toBeUndefined();
    const reference = result.read_calls_reference;
    expect(reference.kind).toBe("artifact_reference");
    expect(reference.artifact_type).toBe("read_calls");
    expect(reference).not.toHaveProperty("summary");
    expect(reference.instruction).toContain("wallet_batch_eth_call");
    expect(reference.instruction).toContain("unchanged");

    const id = reference.url.split("/artifact/")[1] ?? "";
    const stored = (await loadArtifact(env, id)) ?? "";
    expect(stored).not.toBe("");
    expect(keccak256(stringToHex(stored))).toBe(reference.integrity.value);
    expect(reference.bytes).toBe(new TextEncoder().encode(stored).length);
    expect(JSON.parse(stored)).toEqual(readCallsFixture());
    expect(store.entries.has(`artifact/${id}`)).toBe(true);
  });

  it("rewrites every nested quote candidate plan independently", async () => {
    const { env } = testEnv();
    const { value, replaced } = await referenceWalletArtifacts(env, ORIGIN, {
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
          execution_plan_reference?: ReferenceShape;
        } | null;
      }[];
    };
    const firstPlan = await storedBody(
      env,
      result.quotes[0]?.execution?.execution_plan_reference,
    );
    const secondPlan = await storedBody(
      env,
      result.quotes[1]?.execution?.execution_plan_reference,
    );
    expect(firstPlan?.chain_id).toBe("1");
    expect(secondPlan?.chain_id).toBe("8453");
    expect(result.quotes[0]?.execution?.execution_plan).toBeUndefined();
    expect(result.quotes[2]?.execution).toBeNull();
    const urls = result.quotes
      .map((quote) => quote.execution)
      .filter(
        (execution): execution is NonNullable<typeof execution> =>
          execution !== null,
      )
      .map((execution) => execution.execution_plan_reference?.url);
    expect(new Set(urls).size).toBe(2);
  });

  it("rewrites nested read bundles and coexists with plan references", async () => {
    const { env } = testEnv();
    const { value, replaced } = await referenceWalletArtifacts(env, ORIGIN, {
      execution_plan: planFixture(),
      pools: [
        { current_state_query: { read_calls: readCallsFixture("1") } },
        { current_state_query: { read_calls: readCallsFixture("8453") } },
      ],
    });
    expect(replaced).toBe(3);
    const result = value as {
      execution_plan_reference?: ReferenceShape;
      pools: {
        current_state_query: {
          read_calls?: unknown;
          read_calls_reference?: ReferenceShape;
        };
      }[];
    };
    expect(result.execution_plan_reference?.url).toContain("/artifact/");
    expect(result.execution_plan_reference?.artifact_type).toBe(
      "execution_plan",
    );
    const firstBundle = await storedBody(
      env,
      result.pools[0]?.current_state_query.read_calls_reference,
    );
    const secondBundle = await storedBody(
      env,
      result.pools[1]?.current_state_query.read_calls_reference,
    );
    expect(firstBundle?.chain_id).toBe("1");
    expect(secondBundle?.chain_id).toBe("8453");
    expect(result.pools[0]?.current_state_query.read_calls).toBeUndefined();
    const urls = result.pools.map(
      (pool) => pool.current_state_query.read_calls_reference?.url,
    );
    expect(new Set(urls).size).toBe(2);
  });

  it("leaves results without wallet payloads untouched and stores nothing", async () => {
    const { env, store } = testEnv();
    const input = {
      tokens: [{ symbol: "ETH" }],
      execution_plan: { schema_version: "2", ordered_steps: [] },
      nested: { execution_plan: "not a plan" },
    };
    const { value, replaced } = await referenceWalletArtifacts(
      env,
      ORIGIN,
      input,
    );
    expect(replaced).toBe(0);
    expect(value).toEqual(input);
    expect(store.entries.size).toBe(0);
  });

  it("leaves invalid read bundles inline and stores nothing", async () => {
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
    const { value, replaced } = await referenceWalletArtifacts(
      env,
      ORIGIN,
      input,
    );
    expect(replaced).toBe(0);
    expect(value).toEqual(input);
    expect(store.entries.size).toBe(0);
  });
});
