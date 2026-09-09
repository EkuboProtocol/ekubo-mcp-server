import { getAddress, type Address } from "viem";
import { verifyAttestation as verifySharedAttestation } from "@ekubo/jurisdiction/worker";
import { ServiceError, type QuoteDiscoveryIntent } from "./core.js";
import {
  assertAssetsTradable,
  isTokenCountryRestricted,
} from "./token-restrictions.js";
import {
  attestationTypedData,
  jurisdictionCodeSchema,
  type SignedAttestation,
} from "./jurisdiction-message.js";
export { type SignedAttestation } from "./jurisdiction-message.js";

export function requiresJurisdictionAttestation(
  intent: QuoteDiscoveryIntent,
): boolean {
  return (
    isTokenCountryRestricted({
      chainId: intent.chainId,
      token: intent.tokenIn,
      country: null,
    }) ||
    isTokenCountryRestricted({
      chainId: intent.destinationChainId ?? intent.chainId,
      token: intent.tokenOut,
      country: null,
    })
  );
}
export async function verifyAttestation(
  proof: SignedAttestation,
  address: Address,
  now: number,
) {
  try {
    const verified = await verifySharedAttestation(proof, address, now);
    return verified.jurisdiction_code;
  } catch {
    throw new ServiceError(
      "invalid_attestation",
      "Expected an unexpired, wallet-signed Ekubo jurisdiction attestation with at most seven days of validity.",
    );
  }
}
export async function requireJurisdictionAttestation(
  intent: QuoteDiscoveryIntent,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (!requiresJurisdictionAttestation(intent)) return;
  const address = attestationWallet(intent);
  if (!intent.attestation) {
    const code = jurisdictionCodeSchema.safeParse(intent.jurisdictionCode);
    throw new ServiceError(
      "jurisdiction_attestation_required",
      "Ask the user for their legal domicile's ISO country code and have their wallet sign the known EIP-712 payload. Supply jurisdiction_code to obtain that payload, then retry each quote with attestation: { typed_data, signature }. Never infer domicile from IP or attest on the user's behalf.",
      code.success
        ? { typed_data: attestationTypedData(address, code.data, now) }
        : undefined,
    );
  }
  const jurisdiction = await verifyAttestation(
    intent.attestation,
    address,
    now,
  );
  assertAssetsTradable(
    [
      { chainId: intent.chainId, token: intent.tokenIn, side: "sell" },
      {
        chainId: intent.destinationChainId ?? intent.chainId,
        token: intent.tokenOut,
        side: "buy",
      },
    ],
    jurisdiction,
  );
}

function attestationWallet(intent: QuoteDiscoveryIntent): Address {
  const address =
    intent.sender ??
    intent.attestationAddress ??
    intent.attestation?.typed_data.message.wallet;
  if (!address)
    throw new ServiceError(
      "jurisdiction_attestation_required",
      "Supply attestation_address for indicative restricted-token quotes, or sender and slippage_bps for execution plans.",
    );
  if (
    intent.attestationAddress &&
    getAddress(intent.attestationAddress) !== getAddress(address)
  )
    throw new ServiceError(
      "invalid_attestation",
      "attestation_address must match sender.",
    );
  return address;
}
