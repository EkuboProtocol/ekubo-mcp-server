import { describe, expect, it } from "bun:test";
import {
  decodeFunctionData,
  erc20Abi,
  erc1155Abi,
  erc721Abi,
  getAddress,
  keccak256,
  stringToHex,
  type Hex,
} from "viem";
import worker from "../src/index.js";
import { MAX_TRANSFERS_PER_PLAN } from "../src/transfers.js";
import { walletExecutionPlanSchema } from "../src/wallet-compatibility.js";
import { fakeArtifactStore } from "./fake-r2.js";

const SENDER = "0x1111111111111111111111111111111111111111";
const LETTER_SENDER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const SECOND_RECIPIENT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ERC20 = "0x4444444444444444444444444444444444444444";
const ERC721 = "0x5555555555555555555555555555555555555555";
const ERC1155 = "0x6666666666666666666666666666666666666666";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_UINT256 = ((1n << 256n) - 1n).toString();
const OVERFLOW_UINT256 = (1n << 256n).toString();

interface TestEnv {
  ARTIFACT_STORE: ReturnType<typeof fakeArtifactStore>;
  EKUBO_API_URL: string;
  EKUBO_QUOTER_URL: string;
  ALLOWED_ORIGINS: string;
}

interface ArtifactReference {
  kind: "artifact_reference";
  artifact_type: "execution_plan";
  url: string;
  integrity: { algorithm: "keccak256"; value: `0x${string}` };
  bytes: number;
  instruction: string;
}

function testEnv(): TestEnv {
  return {
    ARTIFACT_STORE: fakeArtifactStore(),
    EKUBO_API_URL: "https://api.test",
    EKUBO_QUOTER_URL: "https://quoter.test",
    ALLOWED_ORIGINS: "https://mcp.ekubo.org",
  };
}

function input(transfers: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    chain_id: "1",
    sender: SENDER,
    transfers,
    ...overrides,
  };
}

describe("prepare_transfers MCP endpoint", () => {
  it("publishes a discriminated, bounded, agent-friendly input schema", async () => {
    const env = testEnv();
    const response = await worker.fetch(
      new Request("https://mcp.ekubo.org/tools"),
      env as never,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    const catalog = (await response.json()) as {
      tools: { name: string; inputSchema: Record<string, any> }[];
    };
    const schema = catalog.tools.find(
      (tool) => tool.name === "prepare_transfers",
    )?.inputSchema;
    expect(schema).toBeDefined();
    expect(schema?.required).toEqual(["chain_id", "sender", "transfers"]);
    expect(schema?.additionalProperties).toBe(false);
    const transfers = schema?.properties?.transfers;
    expect(transfers).toMatchObject({ minItems: 1, maxItems: 4_096 });
    const variants = transfers.items.oneOf as Record<string, any>[];
    expect(
      variants.map((variant) => variant.properties.kind.const),
    ).toEqual(["native", "erc20", "erc721", "erc1155"]);
    const erc721 = variants.find(
      (variant) => variant.properties.kind.const === "erc721",
    );
    const erc1155 = variants.find(
      (variant) => variant.properties.kind.const === "erc1155",
    );
    expect(erc721?.required).toEqual([
      "kind",
      "token",
      "recipient",
      "token_id",
    ]);
    expect(erc721?.properties.safe.description).toContain("default");
    expect(erc721?.properties.data.description).toContain(
      "four-argument safeTransferFrom",
    );
    expect(erc1155?.required).toEqual([
      "kind",
      "token",
      "recipient",
      "token_id",
      "amount",
    ]);
    expect(erc1155?.properties.safe.const).toBe(true);
    expect(erc1155?.properties.data.description).toContain("defaults to empty");
  });

  it("stores a verifiable exact plan for a mixed transfer batch", async () => {
    const env = testEnv();
    const result = await callTransfers(
      input([
        { kind: "native", recipient: RECIPIENT, amount: "10" },
        {
          kind: "erc20",
          token: ERC20,
          recipient: SECOND_RECIPIENT,
          amount: "20",
        },
        {
          kind: "erc721",
          token: ERC721,
          recipient: RECIPIENT,
          token_id: "0",
        },
        {
          kind: "erc1155",
          token: ERC1155,
          recipient: SECOND_RECIPIENT,
          token_id: "30",
          amount: "40",
          data: "0x1234",
        },
      ]),
      env,
    );
    const prepared = successfulContent(result);

    expect(prepared).toMatchObject({
      action: "batch_transfers",
      execution_plan_ready: true,
      request: { chain_id: "1", sender: SENDER, transfer_count: 4 },
      details: {
        transfer_count: 4,
        transfer_counts: { native: 1, erc20: 1, erc721: 1, erc1155: 1 },
        total_native_value: "10",
        atomic_batch_required: true,
      },
    });
    expect(prepared).not.toHaveProperty("execution_plan");
    const reference = prepared.execution_plan_reference as ArtifactReference;
    expect(reference).toMatchObject({
      kind: "artifact_reference",
      artifact_type: "execution_plan",
      integrity: { algorithm: "keccak256" },
    });

    const planBody = await fetchArtifact(reference, env);
    expect(reference.bytes).toBe(new TextEncoder().encode(planBody).length);
    expect(keccak256(stringToHex(planBody))).toBe(reference.integrity.value);
    const plan = walletExecutionPlanSchema.parse(JSON.parse(planBody));
    expect(plan.required_capabilities).toEqual(["atomic_batch"]);
    expect(plan.ordered_steps.map((step) => step.transaction.value)).toEqual([
      "10",
      "0",
      "0",
      "0",
    ]);
    expect(plan.ordered_steps.map((step) => step.transaction.to)).toEqual([
      RECIPIENT,
      ERC20,
      ERC721,
      getAddress(ERC1155),
    ]);
    expect(
      decodeFunctionData({
        abi: erc20Abi,
        data: plan.ordered_steps[1].transaction.data as Hex,
      }),
    ).toMatchObject({
      functionName: "transfer",
      args: [getAddress(SECOND_RECIPIENT), 20n],
    });
    expect(
      decodeFunctionData({
        abi: erc721Abi,
        data: plan.ordered_steps[2].transaction.data as Hex,
      }),
    ).toMatchObject({
      functionName: "safeTransferFrom",
      args: [SENDER, RECIPIENT, 0n],
    });
    expect(
      decodeFunctionData({
        abi: erc1155Abi,
        data: plan.ordered_steps[3].transaction.data as Hex,
      }),
    ).toMatchObject({
      functionName: "safeTransferFrom",
      args: [SENDER, getAddress(SECOND_RECIPIENT), 30n, 40n, "0x1234"],
    });
  });

  it("defaults ERC-721 to safeTransferFrom and permits explicit transferFrom", async () => {
    const env = testEnv();
    const result = await callTransfers(
      input([
        {
          kind: "erc721",
          token: ERC721,
          recipient: RECIPIENT,
          token_id: "1",
        },
        {
          kind: "erc721",
          token: ERC721,
          recipient: SECOND_RECIPIENT,
          token_id: "2",
          safe: false,
        },
      ]),
      env,
    );
    const plan = await storedPlan(successfulContent(result), env);
    expect(
      plan.ordered_steps.map(
        (step) =>
          decodeFunctionData({
            abi: erc721Abi,
            data: step.transaction.data as Hex,
          })
            .functionName,
      ),
    ).toEqual(["safeTransferFrom", "transferFrom"]);
  });

  it("encodes ERC-721 receiver data with the four-argument safe overload", async () => {
    const env = testEnv();
    const result = await callTransfers(
      input([
        {
          kind: "erc721",
          token: ERC721,
          recipient: RECIPIENT,
          token_id: "9",
          data: "0xabcd",
        },
      ]),
      env,
    );
    const plan = await storedPlan(successfulContent(result), env);
    expect(
      decodeFunctionData({
        abi: erc721Abi,
        data: plan.ordered_steps[0].transaction.data as Hex,
      }),
    ).toMatchObject({
      functionName: "safeTransferFrom",
      args: [SENDER, RECIPIENT, 9n, "0xabcd"],
    });
  });

  it("defaults ERC-1155 callback data to empty bytes", async () => {
    const env = testEnv();
    const result = await callTransfers(
      input([
        {
          kind: "erc1155",
          token: ERC1155,
          recipient: RECIPIENT,
          token_id: "0",
          amount: "1",
          safe: true,
        },
      ]),
      env,
    );
    const plan = await storedPlan(successfulContent(result), env);
    expect(
      decodeFunctionData({
        abi: erc1155Abi,
        data: plan.ordered_steps[0].transaction.data as Hex,
      }),
    ).toMatchObject({ args: [SENDER, RECIPIENT, 0n, 1n, "0x"] });
  });

  it("canonicalizes hexadecimal chain IDs and checksums addresses", async () => {
    const env = testEnv();
    const result = await callTransfers(
      input(
        [{ kind: "native", recipient: SECOND_RECIPIENT, amount: "1" }],
        { chain_id: "0x2105", sender: LETTER_SENDER },
      ),
      env,
    );
    const prepared = successfulContent(result);
    expect(prepared.request).toMatchObject({
      chain_id: "8453",
      sender: getAddress(LETTER_SENDER),
    });
    const plan = await storedPlan(prepared, env);
    expect(plan.chain_id).toBe("8453");
    expect(plan.caip2_chain_id).toBe("eip155:8453");
    expect(plan.sender).toBe(getAddress(LETTER_SENDER));
    expect(plan.ordered_steps[0].transaction.to).toBe(
      getAddress(SECOND_RECIPIENT),
    );

    const maxEnv = testEnv();
    const maxChain = await callTransfers(
      input([{ kind: "native", recipient: RECIPIENT, amount: "1" }], {
        chain_id: MAX_UINT256,
      }),
      maxEnv,
    );
    expect((await storedPlan(successfulContent(maxChain), maxEnv)).chain_id).toBe(
      MAX_UINT256,
    );
  });

  it("requires atomic_batch only when there is more than one transfer", async () => {
    const singleEnv = testEnv();
    const single = await callTransfers(
      input([{ kind: "native", recipient: RECIPIENT, amount: "1" }]),
      singleEnv,
    );
    expect(
      await storedPlan(successfulContent(single), singleEnv),
    ).not.toHaveProperty("required_capabilities");

    const batchEnv = testEnv();
    const batch = await callTransfers(
      input([
        { kind: "native", recipient: RECIPIENT, amount: "1" },
        { kind: "native", recipient: RECIPIENT, amount: "2" },
      ]),
      batchEnv,
    );
    expect(
      (await storedPlan(successfulContent(batch), batchEnv))
        .required_capabilities,
    ).toEqual(["atomic_batch"]);
  });

  it("keeps the endpoint result compact instead of echoing transfer entries", async () => {
    const env = testEnv();
    const result = await callTransfers(
      input([
        { kind: "native", recipient: RECIPIENT, amount: "1" },
        { kind: "native", recipient: SECOND_RECIPIENT, amount: "2" },
      ]),
      env,
    );
    const prepared = successfulContent(result);
    expect(prepared.request).toEqual({
      chain_id: "1",
      sender: SENDER,
      transfer_count: 2,
    });
    expect(JSON.stringify(prepared)).not.toContain('"transfers"');
    expect(JSON.stringify(prepared)).not.toContain(SECOND_RECIPIENT);
  });

  it("accepts and stores the full 4,096-transfer endpoint batch", async () => {
    const env = testEnv();
    const result = await callTransfers(
      input(
        Array.from({ length: MAX_TRANSFERS_PER_PLAN }, () => ({
          kind: "native",
          recipient: RECIPIENT,
          amount: "1",
        })),
      ),
      env,
    );
    const prepared = successfulContent(result);
    expect(prepared.details).toMatchObject({
      transfer_count: MAX_TRANSFERS_PER_PLAN,
      total_native_value: MAX_TRANSFERS_PER_PLAN.toString(),
    });
    const plan = await storedPlan(prepared, env);
    expect(plan.ordered_steps).toHaveLength(MAX_TRANSFERS_PER_PLAN);
    expect(plan.ordered_steps[0].step).toBe(1);
    expect(plan.ordered_steps.at(-1)?.step).toBe(MAX_TRANSFERS_PER_PLAN);
  });

  it("preserves duplicates and caller-specified order", async () => {
    const env = testEnv();
    const result = await callTransfers(
      input([
        { kind: "native", recipient: RECIPIENT, amount: "3" },
        { kind: "native", recipient: RECIPIENT, amount: "3" },
        { kind: "native", recipient: SECOND_RECIPIENT, amount: "4" },
      ]),
      env,
    );
    const plan = await storedPlan(successfulContent(result), env);
    expect(
      plan.ordered_steps.map(({ transaction }) => [
        transaction.to,
        transaction.value,
      ]),
    ).toEqual([
      [RECIPIENT, "3"],
      [RECIPIENT, "3"],
      [getAddress(SECOND_RECIPIENT), "4"],
    ]);
  });

  it("rejects empty and over-limit batches without storing artifacts", async () => {
    await expectInvalid(input([]), "transfers");
    await expectInvalid(
      input(
        Array.from({ length: MAX_TRANSFERS_PER_PLAN + 1 }, () => ({
          kind: "native",
          recipient: RECIPIENT,
          amount: "1",
        })),
      ),
      "transfers",
    );
  });

  it("rejects zero amounts for every amount-bearing transfer kind", async () => {
    for (const transfer of [
      { kind: "native", recipient: RECIPIENT, amount: "0" },
      {
        kind: "erc20",
        token: ERC20,
        recipient: RECIPIENT,
        amount: "0",
      },
      {
        kind: "erc1155",
        token: ERC1155,
        recipient: RECIPIENT,
        token_id: "1",
        amount: "0",
      },
    ]) {
      await expectInvalid(input([transfer]), "amount");
    }
  });

  it("rejects noncanonical and nondecimal amount representations", async () => {
    for (const amount of [
      "01",
      "-1",
      "+1",
      "0x1",
      "1.0",
      "1e3",
      " 1",
      "1 ",
      "",
    ]) {
      await expectInvalid(
        input([{ kind: "native", recipient: RECIPIENT, amount }]),
        "amount",
      );
    }
  });

  it("accepts uint256 maximums and rejects overflowing amounts", async () => {
    const env = testEnv();
    successfulContent(
      await callTransfers(
        input([{ kind: "native", recipient: RECIPIENT, amount: MAX_UINT256 }]),
        env,
      ),
    );
    await expectInvalid(
      input([
        { kind: "native", recipient: RECIPIENT, amount: OVERFLOW_UINT256 },
      ]),
      "amount",
    );
  });

  it("accepts token ID zero and uint256 maximum but rejects malformed IDs", async () => {
    for (const tokenId of ["0", MAX_UINT256]) {
      const env = testEnv();
      successfulContent(
        await callTransfers(
          input([
            {
              kind: "erc721",
              token: ERC721,
              recipient: RECIPIENT,
              token_id: tokenId,
            },
          ]),
          env,
        ),
      );
    }
    for (const tokenId of ["00", "01", "-1", "0x1", OVERFLOW_UINT256]) {
      await expectInvalid(
        input([
          {
            kind: "erc721",
            token: ERC721,
            recipient: RECIPIENT,
            token_id: tokenId,
          },
        ]),
        "token_id",
      );
    }
  });

  it("rejects invalid, zero, and uint256-overflow chain IDs", async () => {
    for (const chainId of [
      0,
      -1,
      1.5,
      "0",
      "0x0",
      "01",
      "not-a-chain",
      `0x1${"0".repeat(64)}`,
      OVERFLOW_UINT256,
    ]) {
      await expectInvalid(
        input([{ kind: "native", recipient: RECIPIENT, amount: "1" }], {
          chain_id: chainId,
        }),
        "chain_id",
      );
    }
  });

  it("rejects malformed and zero sender addresses", async () => {
    for (const sender of [
      ZERO_ADDRESS,
      "0x1234",
      `0x${"g".repeat(40)}`,
      "1111111111111111111111111111111111111111",
      "0x52908400098527886e0F7030069857D2E4169EE7",
    ]) {
      await expectInvalid(
        input([{ kind: "native", recipient: RECIPIENT, amount: "1" }], {
          sender,
        }),
        "sender",
      );
    }
  });

  it("rejects malformed and zero recipients for every transfer kind", async () => {
    for (const recipient of [
      ZERO_ADDRESS,
      "0x1234",
      `0x${"g".repeat(40)}`,
      "0x52908400098527886e0F7030069857D2E4169EE7",
    ]) {
      for (const transfer of [
        { kind: "native", recipient, amount: "1" },
        { kind: "erc20", token: ERC20, recipient, amount: "1" },
        { kind: "erc721", token: ERC721, recipient, token_id: "1" },
        {
          kind: "erc1155",
          token: ERC1155,
          recipient,
          token_id: "1",
          amount: "1",
        },
      ]) {
        await expectInvalid(input([transfer]), "recipient");
      }
    }
  });

  it("rejects malformed and zero token contract addresses", async () => {
    for (const token of [
      ZERO_ADDRESS,
      "0x1234",
      `0x${"g".repeat(40)}`,
      "0x52908400098527886e0F7030069857D2E4169EE7",
    ]) {
      for (const transfer of [
        { kind: "erc20", token, recipient: RECIPIENT, amount: "1" },
        { kind: "erc721", token, recipient: RECIPIENT, token_id: "1" },
        {
          kind: "erc1155",
          token,
          recipient: RECIPIENT,
          token_id: "1",
          amount: "1",
        },
      ]) {
        await expectInvalid(input([transfer]), "token");
      }
    }
  });

  it("requires every kind-specific field", async () => {
    for (const transfer of [
      { kind: "native", amount: "1" },
      { kind: "native", recipient: RECIPIENT },
      { kind: "erc20", recipient: RECIPIENT, amount: "1" },
      { kind: "erc20", token: ERC20, recipient: RECIPIENT },
      { kind: "erc721", token: ERC721, recipient: RECIPIENT },
      {
        kind: "erc1155",
        token: ERC1155,
        recipient: RECIPIENT,
        amount: "1",
      },
      {
        kind: "erc1155",
        token: ERC1155,
        recipient: RECIPIENT,
        token_id: "1",
      },
    ]) {
      await expectInvalid(input([transfer]), "transfers");
    }
  });

  it("rejects unknown kinds and kind-inappropriate extra fields", async () => {
    await expectInvalid(
      input([{ kind: "erc777", recipient: RECIPIENT, amount: "1" }]),
      "kind",
    );
    for (const transfer of [
      {
        kind: "native",
        recipient: RECIPIENT,
        amount: "1",
        token: ERC20,
      },
      {
        kind: "erc20",
        token: ERC20,
        recipient: RECIPIENT,
        amount: "1",
        token_id: "1",
      },
      {
        kind: "erc721",
        token: ERC721,
        recipient: RECIPIENT,
        token_id: "1",
        amount: "1",
      },
    ]) {
      await expectInvalid(input([transfer]), "Unrecognized key");
    }
  });

  it("rejects unknown top-level fields and missing top-level fields", async () => {
    await expectInvalid(
      {
        ...input([{ kind: "native", recipient: RECIPIENT, amount: "1" }]),
        memo: "not part of the endpoint",
      },
      "Unrecognized key",
    );
    await expectInvalid(
      {
        sender: SENDER,
        transfers: [
          { kind: "native", recipient: RECIPIENT, amount: "1" },
        ],
      },
      "chain_id",
    );
    await expectInvalid(
      {
        chain_id: "1",
        transfers: [
          { kind: "native", recipient: RECIPIENT, amount: "1" },
        ],
      },
      "sender",
    );
    await expectInvalid({ chain_id: "1", sender: SENDER }, "transfers");
  });

  it("rejects contradictory unsafe modes and malformed callback bytes", async () => {
    await expectInvalid(
      input([
        {
          kind: "erc1155",
          token: ERC1155,
          recipient: RECIPIENT,
          token_id: "1",
          amount: "1",
          safe: false,
        },
      ]),
      "safe",
    );
    await expectInvalid(
      input([
        {
          kind: "erc721",
          token: ERC721,
          recipient: RECIPIENT,
          token_id: "1",
          safe: false,
          data: "0x12",
        },
      ]),
      "data",
    );
    for (const data of ["", "1234", "0x1", "0xzz", "0X12", 12]) {
      for (const transfer of [
        {
          kind: "erc721",
          token: ERC721,
          recipient: RECIPIENT,
          token_id: "1",
          data,
        },
        {
          kind: "erc1155",
          token: ERC1155,
          recipient: RECIPIENT,
          token_id: "1",
          amount: "1",
          data,
        },
      ]) {
        await expectInvalid(input([transfer]), "data");
      }
    }
  });

  it("rejects invalid safe flag types", async () => {
    for (const safe of ["true", 1, null]) {
      await expectInvalid(
        input([
          {
            kind: "erc721",
            token: ERC721,
            recipient: RECIPIENT,
            token_id: "1",
            safe,
          },
        ]),
        "safe",
      );
    }
  });

  it("rejects wrong JSON types at every input level", async () => {
    for (const arguments_ of [
      { chain_id: true, sender: SENDER, transfers: [] },
      { chain_id: "1", sender: 123, transfers: [] },
      { chain_id: "1", sender: SENDER, transfers: null },
      { chain_id: "1", sender: SENDER, transfers: {} },
      { chain_id: "1", sender: SENDER, transfers: [null] },
      input([{ kind: "native", recipient: 123, amount: "1" }]),
      input([{ kind: "native", recipient: RECIPIENT, amount: 1 }]),
      input([
        {
          kind: "erc721",
          token: ERC721,
          recipient: RECIPIENT,
          token_id: 1,
        },
      ]),
      input([
        {
          kind: null,
          token: ERC20,
          recipient: RECIPIENT,
          amount: "1",
        },
      ]),
    ]) {
      await expectInvalid(arguments_, "Input validation error");
    }
  });
});

async function callTransfers(arguments_: unknown, env: TestEnv) {
  const response = await worker.fetch(
    new Request("https://mcp.ekubo.org/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        origin: "https://mcp.ekubo.org",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "prepare_transfers", arguments: arguments_ },
      }),
    }),
    env as never,
    {} as ExecutionContext,
  );
  expect(response.status).toBe(200);
  return mcpJson(response) as Promise<Record<string, any>>;
}

function successfulContent(result: Record<string, any>): Record<string, any> {
  expect(result.result?.isError).not.toBe(true);
  expect(result.result?.structuredContent).toBeDefined();
  return result.result.structuredContent as Record<string, any>;
}

async function expectInvalid(arguments_: unknown, path: string) {
  const env = testEnv();
  const result = await callTransfers(arguments_, env);
  expect(result.result?.isError).toBe(true);
  const message = result.result?.content?.[0]?.text;
  expect(message).toContain("Input validation error");
  expect(message).toContain(path);
  expect(env.ARTIFACT_STORE.entries.size).toBe(0);
}

async function fetchArtifact(reference: ArtifactReference, env: TestEnv) {
  const response = await worker.fetch(
    new Request(reference.url),
    env as never,
    {} as ExecutionContext,
  );
  expect(response.status).toBe(200);
  return response.text();
}

async function storedPlan(prepared: Record<string, any>, env: TestEnv) {
  const reference = prepared.execution_plan_reference as ArtifactReference;
  return walletExecutionPlanSchema.parse(
    JSON.parse(await fetchArtifact(reference, env)),
  );
}

async function mcpJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(body);
  }
  const data = body
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice("data:".length)
    .trim();
  if (data === undefined) throw new Error(`MCP stream had no data: ${body}`);
  return JSON.parse(data);
}
