import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { Interface, keccak256, toUtf8Bytes } from "ethers";
import worker from "../src/index.js";
import { ARTIFACT_TTL_SECONDS } from "../src/artifact-store.js";
import { MORPHO_VAULT_V2_CATALOG } from "../src/morpho.js";
import { fakeArtifactStore } from "./fake-r2.js";

const sender = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const owner = "0x3333333333333333333333333333333333333333";
const now = 1_800_000_000_000;
const deadline = "1800007200";
const maxUint256 = ((1n << 256n) - 1n).toString();
const spenders: Record<string, string> = {
  "1": "0x02912516d49dE997db75B9D7858faAE59209650B",
  "8453": "0x2B08A911f48dE25A7e305D910Afb5597aBE8ea7B",
};
// Independent ABI declarations/decoder: do not validate the SDK against itself.
const erc20 = new Interface(["function approve(address spender,uint256 amount)"]);
const bundles = new Interface([
  "function vaultBundlesV1Deposit(address vault,uint256 assets,uint256 maxSharePriceE27,(uint8 kind,bytes data) assetPermit,uint256 referralFeePct,address referralFeeRecipient,uint256 deadline)",
]);
const vaultAbi = new Interface([
  "function withdraw(uint256 assets,address receiver,address owner)",
  "function redeem(uint256 shares,address receiver,address owner)",
]);
const store = fakeArtifactStore();
const env = {
  ARTIFACT_STORE: store, EKUBO_API_URL: "https://api.test", EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused", ACROSS_API_KEY: "unused", ACROSS_INTEGRATOR_ID: "unused",
  LAYER_ZERO_API_KEY: "unused", LI_FI_API_KEY: "unused", DUNE_API_KEY: "unused",
};
const context = {} as ExecutionContext;
type Json = Record<string, any>;

async function call(name: string, args: Json) {
  const response = await worker.fetch(new Request("https://mcp.ekubo.org/mcp/morpho", {
    method: "POST", headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), env, context);
  expect(response.status).toBe(200);
  const text = await response.text();
  const body = JSON.parse(text.startsWith("{") ? text : text.split("\n").find(line => line.startsWith("data:"))!.slice(5));
  expect(body.error).toBeUndefined();
  return body.result as Json;
}

async function fetchPlan(result: Json) {
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  const content = result.structuredContent;
  expect(content.execution_plan).toBeUndefined();
  expect(content.wallet_validation_required).toBe(true);
  const reference = content.execution_plan_reference;
  expect(reference).toMatchObject({ kind: "artifact_reference", artifact_type: "execution_plan" });
  const response = await worker.fetch(new Request(reference.url), env, context);
  expect(response.status).toBe(200);
  const bytes = await response.text();
  expect(keccak256(toUtf8Bytes(bytes))).toBe(reference.integrity.value);
  expect(toUtf8Bytes(bytes).length).toBe(reference.bytes);
  return JSON.parse(bytes) as Json;
}

describe("Morpho dependency compatibility through MCP", () => {
  beforeEach(() => { setSystemTime(new Date(now)); store.entries.clear(); });
  afterEach(() => { setSystemTime(); });

  for (const vault of MORPHO_VAULT_V2_CATALOG) {
    for (const amount of ["1", "9007199254740993", maxUint256]) {
      it(`${vault.name}: preserves exact deposit authorization and bounds for ${amount}`, async () => {
        const result = await call("prepare_morpho_vault_deposit", {
          chain_id: vault.chain_id, sender, vault: vault.address, amount,
          max_share_price_ray: amount,
        });
        const plan = await fetchPlan(result);
        expect(plan.chain_id).toBe(vault.chain_id);
        expect(plan.sender).toBe(sender);
        expect(plan.ordered_steps.map((step: Json) => step.kind)).toEqual(["approval", "execution", "allowance_cleanup"]);
        const [approval, deposit, cleanup] = plan.ordered_steps.map((step: Json) => step.transaction);
        expect([approval.to, deposit.to, cleanup.to]).toEqual([vault.asset.address, spenders[vault.chain_id], vault.asset.address]);
        for (const tx of [approval, deposit, cleanup]) expect(tx).toMatchObject({ from: sender, value: "0" });
        expect([...erc20.decodeFunctionData("approve", approval.data)]).toEqual([spenders[vault.chain_id], BigInt(amount)]);
        expect([...erc20.decodeFunctionData("approve", cleanup.data)]).toEqual([spenders[vault.chain_id], 0n]);
        const decoded = bundles.decodeFunctionData("vaultBundlesV1Deposit", deposit.data);
        expect(decoded.toArray(true)).toEqual([
          vault.address, BigInt(amount), BigInt(amount), [0n, "0x"], 0n,
          "0x0000000000000000000000000000000000000000", BigInt(deadline),
        ]);
      });

      for (const action of ["withdraw", "redeem"]) {
        it(`${vault.name}: preserves direct ${action} owner/recipient and exact ${amount}`, async () => {
          const result = await call(`prepare_morpho_vault_${action}`, {
            chain_id: vault.chain_id, sender, vault: vault.address, recipient, owner,
            [action === "withdraw" ? "amount" : "shares"]: amount,
          });
          const plan = await fetchPlan(result);
          expect(plan.ordered_steps).toHaveLength(1);
          const tx = plan.ordered_steps[0].transaction;
          expect(tx).toMatchObject({ to: vault.address, from: sender, value: "0" });
          expect([...vaultAbi.decodeFunctionData(action, tx.data)]).toEqual([BigInt(amount), recipient, owner]);
        });
      }
    }
  }

  const input = {
    chain_id: "8453", sender, vault: MORPHO_VAULT_V2_CATALOG[0]!.address,
    amount: "9007199254740993", max_share_price_ray: "1001000000000000000000000001", deadline,
  };
  const invalid: [string, Json][] = [
    ["missing amount", { amount: undefined }], ["missing price", { max_share_price_ray: undefined }],
    ["zero", { amount: "0" }], ["negative", { amount: "-1" }], ["decimal", { amount: "1.5" }],
    ["overflow", { amount: (1n << 256n).toString() }], ["price overflow", { max_share_price_ray: (1n << 256n).toString() }],
    ["expired", { deadline: String(now / 1000) }], ["other recipient", { recipient }],
    ["unsupported chain", { chain_id: "10" }], ["unknown vault", { vault: sender }],
  ];
  for (const [label, overrides] of invalid) {
    it(`rejects ${label} before storing a plan or making a network call`, async () => {
      const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network access"));
      try {
        const result = await call("prepare_morpho_vault_deposit", { ...input, ...overrides });
        expect(result.isError).toBe(true);
        expect(result.content[0].text.length).toBeGreaterThan(0);
        expect(store.entries.size).toBe(0);
        expect(network).not.toHaveBeenCalled();
      } finally { network.mockRestore(); }
    });
  }

  it("expires opaque plans and safely re-prepares the identical unsigned bytes", async () => {
    const first = await call("prepare_morpho_vault_deposit", { ...input, deadline: "4000000000" });
    const plan = await fetchPlan(first);
    setSystemTime(new Date(now + (ARTIFACT_TTL_SECONDS + 1) * 1000));
    const expired = await worker.fetch(new Request(first.structuredContent.execution_plan_reference.url), env, context);
    expect(expired.status).toBe(404);
    expect(await expired.json()).toMatchObject({ error: { code: "artifact_not_found_or_expired" } });
    const retry = await call("prepare_morpho_vault_deposit", { ...input, deadline: "4000000000" });
    expect(retry.structuredContent.execution_plan_reference.url).not.toBe(first.structuredContent.execution_plan_reference.url);
    expect(await fetchPlan(retry)).toEqual(plan);
  });
});
