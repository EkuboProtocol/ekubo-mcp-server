import { describe, expect, it } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { type Address } from "viem";
import {
  getQuotesWithPlans,
  type Env,
  type QuoteDiscoveryIntent,
} from "../src/core.js";
import {
  requireJurisdictionAttestation,
  verifyAttestation,
} from "../src/jurisdiction-attestation.js";
import {
  attestationTypedData,
  ATTESTATION_TTL_SECONDS,
  type SignedAttestation,
} from "../src/jurisdiction-message.js";

const wallet = privateKeyToAccount(`0x${"01".repeat(32)}`);
const other = privateKeyToAccount(`0x${"02".repeat(32)}`);
const now = 1_800_000_000;
const restricted: Address = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const native: Address = "0x0000000000000000000000000000000000000000";
const intent: QuoteDiscoveryIntent = {
  chainId: "4663",
  tokenIn: native,
  tokenOut: restricted,
  quoteType: "exact_input",
  amount: "1",
  attestationAddress: wallet.address,
  jurisdictionCode: "DE",
};
async function signed(
  code = "DE",
  issuedAt = now,
  expiresAt = issuedAt + ATTESTATION_TTL_SECONDS,
  signer = wallet,
): Promise<SignedAttestation> {
  const typed_data = attestationTypedData(
    wallet.address,
    code,
    issuedAt,
    expiresAt,
  );
  return { typed_data, signature: await signer.signTypedData(typed_data) };
}
describe("stateless restricted-token jurisdiction proofs", () => {
  it("returns the known payload and never contacts providers without a proof", async () => {
    await expect(
      requireJurisdictionAttestation(intent, now),
    ).rejects.toMatchObject({
      code: "jurisdiction_attestation_required",
      details: { typed_data: attestationTypedData(wallet.address, "DE", now) },
    });
    let fetched = false;
    await expect(
      getQuotesWithPlans({} as Env, intent, (async () => {
        fetched = true;
        throw new Error("unexpected provider call");
      }) as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "jurisdiction_attestation_required" });
    expect(fetched).toBe(false);
  });
  it("accepts a week or shorter validity, and requires the proof on every request", async () => {
    for (const duration of [60, ATTESTATION_TTL_SECONDS]) {
      await requireJurisdictionAttestation(
        { ...intent, attestation: await signed("DE", now, now + duration) },
        now,
      );
    }
    await expect(
      requireJurisdictionAttestation(intent, now),
    ).rejects.toMatchObject({ code: "jurisdiction_attestation_required" });
  });
  it("rejects exact expiry, future issuance, zero/negative validity and more than a week", async () => {
    for (const [issued, expires] of [
      [now - 60, now],
      [now + 1, now + 60],
      [now, now],
      [now, now - 1],
      [now, now + ATTESTATION_TTL_SECONDS + 1],
    ]) {
      await expect(
        requireJurisdictionAttestation(
          { ...intent, attestation: await signed("DE", issued, expires) },
          now,
        ),
      ).rejects.toMatchObject({ code: "invalid_attestation" });
    }
  });
  it("rejects wrong signers, altered payloads and unknown templates", async () => {
    const valid = await signed();
    const mutations = [
      await signed("DE", now, now + 60, other),
      {
        ...valid,
        typed_data: {
          ...valid.typed_data,
          message: { ...valid.typed_data.message, jurisdictionCode: "FR" },
        },
      },
      {
        ...valid,
        typed_data: {
          ...valid.typed_data,
          domain: { name: "other", version: "1" },
        },
      },
      {
        ...valid,
        typed_data: {
          ...valid.typed_data,
          types: {
            JurisdictionAttestation: [
              ...valid.typed_data.types.JurisdictionAttestation,
            ].reverse(),
          },
        },
      },
    ];
    for (const attestation of mutations) {
      await expect(
        requireJurisdictionAttestation(
          { ...intent, attestation: attestation as SignedAttestation },
          now,
        ),
      ).rejects.toMatchObject({ code: "invalid_attestation" });
    }
  });
  it("rejects placeholders and binds the proof to the sender", async () => {
    const attestation = await signed();
    await expect(
      verifyAttestation(attestation, other.address, now),
    ).rejects.toMatchObject({ code: "invalid_attestation" });
    for (const code of ["ZZ", "XX", "T1", "de"]) {
      await expect(
        verifyAttestation(await signed(code), wallet.address, now),
      ).rejects.toMatchObject({ code: "invalid_attestation" });
    }
  });
  it("applies the declared jurisdiction to buys, sales, and bridge destinations", async () => {
    const attestation = await signed("US");
    for (const request of [
      intent,
      { ...intent, chainId: "1", destinationChainId: "4663" },
    ]) {
      await expect(
        requireJurisdictionAttestation({ ...request, attestation }, now),
      ).rejects.toMatchObject({ code: "restricted_jurisdiction" });
    }
    await requireJurisdictionAttestation(
      { ...intent, tokenIn: restricted, tokenOut: native, attestation },
      now,
    );
    await expect(
      requireJurisdictionAttestation(
        {
          ...intent,
          tokenIn: restricted,
          tokenOut: native,
          attestation: await signed("IR"),
        },
        now,
      ),
    ).rejects.toMatchObject({ code: "restricted_jurisdiction" });
  });
  it("does not require proofs for unrestricted quotes", async () => {
    await requireJurisdictionAttestation({ ...intent, tokenOut: native }, now);
  });
  it("refuses missing or mismatched quote addresses", async () => {
    await expect(
      requireJurisdictionAttestation(
        { ...intent, attestationAddress: undefined },
        now,
      ),
    ).rejects.toMatchObject({ code: "jurisdiction_attestation_required" });
    await expect(
      requireJurisdictionAttestation({ ...intent, sender: other.address }, now),
    ).rejects.toMatchObject({ code: "invalid_attestation" });
  });
});

it("matches the signed interoperability fixture used by the Rust verifier", async () => {
  const fixture = await import("./fixtures/jurisdiction-proof.json");
  expect(JSON.stringify(attestationTypedData(wallet.address, "DE", now))).toBe(
    JSON.stringify(fixture.default.typed_data),
  );
  expect(
    await verifyAttestation(
      fixture.default as SignedAttestation,
      wallet.address,
      now,
    ),
  ).toBe("DE");
});

it("forwards private proofs only to the Ekubo quoter, without echoing them", async () => {
  const currentTime = Math.floor(Date.now() / 1000);
  const attestation = await signed("DE", currentTime);
  const calls: Array<{ url: string; proof: string | null }> = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({
      url: String(input),
      proof: new Headers(init?.headers).get("X-Ekubo-Jurisdiction"),
    });
    return new Response(
      JSON.stringify({ error: "test provider unavailable" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const env = {
    EKUBO_QUOTER_URL: "https://quoter.test",
    ZERO_X_API_KEY: "test",
    ZERO_X_API_URL: "https://zero-x.test",
  } as Env;
  const result = await getQuotesWithPlans(
    env,
    { ...intent, attestation },
    fetcher,
  ).catch((error: unknown) => error);
  expect(result).toMatchObject({ code: "quote_unavailable" });
  expect(
    calls.some(
      (call) =>
        call.url.startsWith("https://quoter.test") &&
        call.proof === JSON.stringify(attestation),
    ),
  ).toBe(true);
  expect(
    calls
      .filter((call) => !call.url.startsWith("https://quoter.test"))
      .every((call) => call.proof === null),
  ).toBe(true);
  expect(JSON.stringify(result)).not.toContain(attestation.signature);
  expect(calls.every((call) => !call.url.includes(attestation.signature))).toBe(
    true,
  );
});
