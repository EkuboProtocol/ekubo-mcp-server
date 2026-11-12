/**
 * Integrations that do not cover every chain Ekubo is deployed on.
 *
 * Ekubo's own contracts, API and quoter answer for a chain as soon as it is
 * deployed, but the third-party services some tools lean on arrive later or
 * not at all. A chain listed here is one where a tool would otherwise reach an
 * integration that cannot answer for it and surface the provider's error,
 * which reads as an outage rather than a gap. Listing it lets the tool say
 * plainly that the feature is not available there, before any upstream call.
 *
 * A chain absent from this table is not claimed to support everything; the
 * table only records gaps that are known.
 */
export type ChainIntegration = "across" | "cloud_wallet" | "zero_x";

interface ChainGaps {
  name: string;
  unsupported: ReadonlySet<ChainIntegration>;
}

const CHAIN_GAPS: Readonly<Record<string, ChainGaps>> = {
  "99901": {
    name: "Elysium",
    unsupported: new Set(["across", "cloud_wallet"]),
  },
};

const INTEGRATION_NAMES: Record<ChainIntegration, string> = {
  across: "Across",
  cloud_wallet: "Cloud Wallet",
  zero_x: "0x",
};

export function chainSupports(
  chainId: string,
  integration: ChainIntegration,
): boolean {
  return CHAIN_GAPS[chainId]?.unsupported.has(integration) !== true;
}

/** "Elysium (chain 99901)" for a chain in the table, "chain 123" otherwise. */
export function chainLabel(chainId: string): string {
  const name = CHAIN_GAPS[chainId]?.name;
  return name === undefined ? `chain ${chainId}` : `${name} (chain ${chainId})`;
}

export function unsupportedIntegrationMessage(
  chainId: string,
  integration: ChainIntegration,
): string {
  return `${INTEGRATION_NAMES[integration]} does not support ${chainLabel(chainId)}`;
}

export interface WalletSupportNotice {
  chain_id: string;
  cloud_wallet_supported: false;
  message: string;
}

/**
 * The notice attached to a result whose wallet handoff targets a chain Cloud
 * Wallet does not support. The plan and read bundle stay valid for any other
 * wallet that implements the same handoff; only the hosted wallet cannot run
 * them.
 */
export function walletSupportNotices(
  chainIds: Iterable<string>,
): WalletSupportNotice[] {
  return [...new Set(chainIds)]
    .filter((chainId) => !chainSupports(chainId, "cloud_wallet"))
    .sort()
    .map((chainId) => ({
      chain_id: chainId,
      cloud_wallet_supported: false as const,
      message: `${unsupportedIntegrationMessage(chainId, "cloud_wallet")}, so its wallet_simulate_execution_plan and wallet_batch_eth_call cannot run this chain's references. Pass them unchanged to another wallet that implements the same reference handoff, or tell the user this step must run from a wallet that supports ${chainLabel(chainId)}. Do not move the action to another chain.`,
    }));
}

/**
 * Adds `wallet_support` to a tool result whose stored plans or read bundles
 * target a chain Cloud Wallet does not support. Additive and root-level, so
 * no output schema changes shape; results on every other chain are returned
 * as they were.
 */
export function withWalletSupportNotices(
  value: unknown,
  chainIds: readonly string[],
): unknown {
  const notices = walletSupportNotices(chainIds);
  if (
    notices.length === 0 ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return value;
  }
  return { ...(value as Record<string, unknown>), wallet_support: notices };
}
