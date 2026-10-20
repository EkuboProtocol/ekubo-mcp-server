import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { encodeAbiParameters, getAddress, type Address } from "viem";
import { fakeArtifactStore } from "./fake-r2.js";
import worker from "../src/index.js";
import { checkSignedLink, LINK_TTL_SECONDS, ownershipStep, PROOF_TTL_SECONDS, type OwnershipRequest } from "../src/onramp-proof.js";
import { LINK_SECRET, owner, stranger, withProof } from "./onramp-helpers.js";

const env = {
  ARTIFACT_STORE: fakeArtifactStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ALLOWED_ORIGINS: "https://mcp.ekubo.org",
  MOONPAY_PUBLISHABLE_KEY: "pk_test_fixture",
  MOONPAY_SECRET_KEY: "sk_test_fixture",
  ONRAMP_LINK_SECRET: LINK_SECRET,
};
const context = {} as unknown as ExecutionContext;
const ORIGIN = "https://mcp.ekubo.org";
const smartAccount = getAddress("0x3333333333333333333333333333333333333333");

type ToolResult = { result: { isError?: boolean; structuredContent: Record<string, any> } };

async function buy(args: Record<string, unknown>, e: Record<string, unknown> = env): Promise<ToolResult> {
  const response = await worker.fetch(
    new Request(`${ORIGIN}/mcp/moonpay`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        host: "mcp.ekubo.org",
        origin: ORIGIN,
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_moonpay_buy_link", arguments: args } }),
    }),
    e as never,
    context,
  );
  const body = await response.text();
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? body.split("\n").find((line) => line.startsWith("data:"))!.slice(5)
    : body;
  return JSON.parse(data) as ToolResult;
}

const open = (link: string) => worker.fetch(new Request(link, { headers: { "cf-connecting-ip": "203.0.113.42" } }), env as never, context);

function request(address: Address, extra: Partial<OwnershipRequest> = {}): OwnershipRequest {
  return {
    provider: "moonpay",
    providerName: "MoonPay",
    redirectPath: "/onramp/moonpay",
    query: new URLSearchParams({ wallet_address: address, currency_code: "eth", base_currency_code: "usd" }),
    address,
    chainId: 1,
    summary: "ETH on Ethereum",
    ...extra,
  };
}

/** A JSON-RPC endpoint on chainId whose every eth_call answers the ERC-6492 validator with valid. */
function mockRpc(valid: boolean, chainId = 1) {
  return spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? (await new Request(input, init).text())));
    const result = body.method === "eth_chainId" ? `0x${chainId.toString(16)}` : encodeAbiParameters([{ type: "bool" }], [valid]);
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  }) as typeof fetch);
}

afterEach(() => {
  (globalThis.fetch as { mockRestore?: () => void }).mockRestore?.();
});

describe("on-ramp ownership proof", () => {
  it("refuses a signature from a wallet other than wallet_address", async () => {
    const spy = mockRpc(false, 11155111);
    const result = await withProof(buy, { wallet_address: owner.address, currency_code: "eth" }, stranger);
    expect(result.result.isError).toBe(true);
    expect(result.result.structuredContent.error.code).toBe("ownership_proof_rejected");
    expect(JSON.stringify(result)).not.toContain("checkout_url");
    expect(spy).toHaveBeenCalled();
  });

  it("refuses a signature over different purchase details", async () => {
    const first = await buy({ wallet_address: owner.address, currency_code: "eth" });
    const proof = first.result.structuredContent.ownership_proof;
    const signature = await owner.signMessage({ message: proof.message });
    mockRpc(false, 11155111);
    const changed = await buy({ wallet_address: owner.address, currency_code: "usdc", issued_at: proof.issued_at, signature });
    expect(changed.result.structuredContent.error.code).toBe("ownership_proof_rejected");
  });

  it("needs issued_at and signature together", async () => {
    const result = await buy({ wallet_address: owner.address, currency_code: "eth", signature: "0x1234" });
    expect(result.result.structuredContent.error.code).toBe("ownership_proof_incomplete");
  });

  it("expires signed messages and rejects future issued_at", async () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    const challenge = await ownershipStep(env, ORIGIN, request(owner.address), now);
    if (challenge.status !== "signature_required") throw new Error("expected a challenge");
    const signature = await owner.signMessage({ message: challenge.ownership_proof.message });
    const signed = request(owner.address, { issuedAt: challenge.ownership_proof.issued_at, signature });
    const late = now + PROOF_TTL_SECONDS * 1000 + 1;
    await expect(ownershipStep(env, ORIGIN, signed, late)).rejects.toMatchObject({ code: "ownership_proof_expired" });
    await expect(ownershipStep(env, ORIGIN, signed, now - 120_000)).rejects.toMatchObject({ code: "ownership_proof_invalid" });
    const verified = await ownershipStep(env, ORIGIN, signed, now + 1000);
    expect(verified).toMatchObject({ status: "verified" });
  });

  it("accepts an ERC-1271 smart-account signature verified on the delivery chain", async () => {
    const challenge = await ownershipStep(env, ORIGIN, request(smartAccount, { chainId: 8453 }));
    if (challenge.status !== "signature_required") throw new Error("expected a challenge");
    const signature = `0x${"ab".repeat(97)}` as const;
    const signed = request(smartAccount, { chainId: 8453, issuedAt: challenge.ownership_proof.issued_at, signature });
    const spy = mockRpc(true, 8453);
    expect(await ownershipStep(env, ORIGIN, signed)).toMatchObject({ status: "verified" });
    expect(String(spy.mock.calls[0]![0])).toBe("https://base-rpc.publicnode.com/");
    const methods = spy.mock.calls.map((call) => JSON.parse(String(call[1]!.body)).method);
    expect(methods).toEqual(["eth_chainId", "eth_call"]);
    spy.mockRestore();
    const wrongChain = mockRpc(true, 1);
    await expect(ownershipStep(env, ORIGIN, signed)).rejects.toMatchObject({ code: "upstream_error" });
    wrongChain.mockRestore();
    mockRpc(false, 8453);
    await expect(ownershipStep(env, ORIGIN, signed)).rejects.toMatchObject({ code: "ownership_proof_rejected" });
  });

  it("uses a configured RPC override and reports an unreachable network as retryable", async () => {
    const challenge = await ownershipStep(env, ORIGIN, request(smartAccount));
    if (challenge.status !== "signature_required") throw new Error("expected a challenge");
    const signed = request(smartAccount, { issuedAt: challenge.ownership_proof.issued_at, signature: `0x${"ab".repeat(97)}` });
    const spy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response("down", { status: 503 })) as unknown as typeof fetch);
    const overridden = { ...env, ONRAMP_RPC_URLS: JSON.stringify({ 1: "https://rpc.example/eth" }) };
    await expect(ownershipStep(overridden, ORIGIN, signed)).rejects.toMatchObject({ code: "upstream_error" });
    expect(String(spy.mock.calls[0]![0])).toBe("https://rpc.example/eth");
  });

  it("only redirects links this server issued, unaltered and unexpired", async () => {
    const { result } = await withProof(buy, { wallet_address: owner.address, currency_code: "eth", base_currency_amount: "50" });
    const link = new URL(result.structuredContent.checkout_url);
    expect((await open(link.toString())).status).toBe(302);

    const altered = new URL(link);
    altered.searchParams.set("base_currency_amount", "5000");
    expect((await open(altered.toString())).status).toBe(400);
    const redirected = new URL(link);
    redirected.searchParams.set("wallet_address", stranger.address);
    expect((await open(redirected.toString())).status).toBe(400);
    const extended = new URL(link);
    extended.searchParams.set("expires", String(Number(link.searchParams.get("expires")) + 3600));
    expect((await open(extended.toString())).status).toBe(400);

    const later = Date.now() + (LINK_TTL_SECONDS + 1) * 1000;
    expect(await checkSignedLink(env, link, later)).toEqual({ ok: false, status: 410, code: "link_expired" });
    expect(await checkSignedLink({ ONRAMP_LINK_SECRET: "another-secret-another-secret-another" }, link)).toMatchObject({ status: 400 });
    expect(await checkSignedLink({}, link)).toMatchObject({ status: 503, code: "onramp_not_configured" });
  });

  it("refuses to issue links without a link secret", async () => {
    const { ONRAMP_LINK_SECRET: _, ...unconfigured } = env;
    const result = await buy({ wallet_address: owner.address, currency_code: "eth" }, unconfigured);
    expect(result.result.structuredContent.error.code).toBe("onramp_not_configured");
  });
});
