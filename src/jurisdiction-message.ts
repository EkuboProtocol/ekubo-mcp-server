// Compatibility exports; the versioned package owns the payload and schemas.
export {
  attestationTypedData,
  ATTESTATION_TTL_SECONDS,
  JURISDICTION_CODES,
  ATTESTATION_DOMAIN,
  ATTESTATION_TYPES,
  ATTESTATION_STATEMENT,
  type SignedAttestation,
} from "@ekubo/jurisdiction/worker";
export {
  jurisdictionCodeSchema,
  signedAttestationSchema,
} from "@ekubo/jurisdiction/schema";
