import {
  vaultV2Deposit,
  vaultV2Redeem,
  vaultV2Withdraw,
} from "@morpho-org/morpho-sdk";
import { getChainAddresses } from "@morpho-org/morpho-sdk/addresses";
import { getAddress, type Address, type Hex } from "viem";
import { ServiceError } from "./core.js";
import {
  erc20ApprovalTransaction,
  preparedTransaction,
  preparedUiAction,
} from "./ui-actions.js";

export const MORPHO_SDK_VERSION = "5.5.0";

interface MorphoVaultDefinition {
  chain_id: string;
  network: string;
  address: Address;
  name: string;
  symbol: string;
  asset: { address: Address; symbol: string; decimals: number };
}

function vault(
  chainId: string,
  network: string,
  address: string,
  name: string,
  symbol: string,
  asset: string,
  assetSymbol: string,
  decimals: number,
): MorphoVaultDefinition {
  return {
    chain_id: chainId,
    network,
    address: getAddress(address),
    name,
    symbol,
    asset: { address: getAddress(asset), symbol: assetSymbol, decimals },
  };
}

/**
 * A build-time snapshot of listed, warning-free Morpho Vault V2 deployments.
 * Live listing status, allocations, liquidity, APY and share price are not
 * implied by inclusion and must be discovered directly by the agent.
 */
export const MORPHO_VAULT_V2_CATALOG: readonly MorphoVaultDefinition[] = [
  vault(
    "8453",
    "Base",
    "0x050cE30b927Da55177A4914EC73480238BAD56f0",
    "Gauntlet USDC Prime",
    "gtusdcp",
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "USDC",
    6,
  ),
  vault(
    "1",
    "Ethereum",
    "0x04422053aDDbc9bB2759b248B574e3FCA76Bc145",
    "Keyrock USDC",
    "kUSDC",
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "USDC",
    6,
  ),
  vault(
    "1",
    "Ethereum",
    "0x069662D2588fcaC24B5c209456Db965D151556f0",
    "Apyx USDC",
    "ApyxUSDC",
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "USDC",
    6,
  ),
];

export function getMorphoVaults(input: { chainId?: string } = {}) {
  const vaults = input.chainId
    ? MORPHO_VAULT_V2_CATALOG.filter((item) => item.chain_id === input.chainId)
    : [...MORPHO_VAULT_V2_CATALOG];
  return {
    protocol: "morpho_vault_v2",
    network_access: "none",
    source: {
      sdk_package: "@morpho-org/morpho-sdk",
      sdk_version: MORPHO_SDK_VERSION,
      graphql_endpoint: "https://api.morpho.org/graphql",
      snapshot_date: "2026-08-13",
    },
    agent_market_data_discovery: {
      server_involvement: "none",
      skill_resource: "ekubo://skills/use-morpho",
      graphql_endpoint: "https://api.morpho.org/graphql",
      documentation: "https://docs.morpho.org/developers/api/get-started/",
      use_for:
        "Current listing and warning status, vault asset, totals, liquidity, APY, allocations, and the fresh share price used to choose max_share_price_ray",
      handoff:
        "Intersect the live API result with this exact chain, vault, and asset catalog before preparing a transaction",
    },
    vaults: vaults.map((item) => ({
      ...item,
      bundler3: getChainAddresses(Number(item.chain_id)).bundler3.bundler3,
      general_adapter_1:
        getChainAddresses(Number(item.chain_id)).bundler3.generalAdapter1,
    })),
    limitations: {
      live_state:
        "No API, RPC, balance, allowance, vault accounting, liquidity, APY, allocation, warning, or listing state is queried",
      execution:
        "Deposits use the official SDK's Bundler3/GeneralAdapter1 maxSharePrice guard; every plan still requires exact wallet simulation",
    },
  };
}

export function prepareMorphoVaultDeposit(input: {
  chainId: string;
  sender: string;
  vault: string;
  amount: string;
  maxSharePriceRay: string;
  recipient?: string;
}) {
  const definition = resolveVault(input.chainId, input.vault);
  const sender = getAddress(input.sender);
  const recipient = getAddress(input.recipient ?? sender);
  const amount = positiveUint(input.amount, "amount");
  const maxSharePrice = positiveUint(
    input.maxSharePriceRay,
    "max_share_price_ray",
  );
  const addresses = getChainAddresses(Number(input.chainId)).bundler3;
  const tx = vaultV2Deposit({
    vault: {
      chainId: Number(input.chainId),
      address: definition.address,
      asset: definition.asset.address,
    },
    args: { amount, maxSharePrice, recipient },
  });
  return preparedUiAction({
    action: "morpho_vault_v2_deposit",
    chainId: input.chainId,
    sender,
    request: morphoRequest(definition, sender, {
      amount: amount.toString(),
      max_share_price_ray: maxSharePrice.toString(),
      recipient,
    }),
    approvals: [
      erc20ApprovalTransaction(
        input.chainId,
        definition.asset.address,
        addresses.generalAdapter1,
        amount,
      ),
    ],
    transaction: sdkTransaction(input.chainId, tx),
    postExecutionTransactions: [
      erc20ApprovalTransaction(
        input.chainId,
        definition.asset.address,
        addresses.generalAdapter1,
        0n,
      ),
    ],
    atomicBatchRequired: true,
    details: morphoDetails(definition, {
      route: "Bundler3 via GeneralAdapter1",
      bundler3: addresses.bundler3,
      general_adapter_1: addresses.generalAdapter1,
      exact_approval_then_cleanup: true,
      max_share_price_enforced_onchain: true,
      max_share_price_scale: "RAY (1e27)",
    }),
  });
}

export function prepareMorphoVaultWithdraw(input: {
  chainId: string;
  sender: string;
  vault: string;
  amount: string;
  recipient?: string;
  owner?: string;
}) {
  const definition = resolveVault(input.chainId, input.vault);
  const sender = getAddress(input.sender);
  const recipient = getAddress(input.recipient ?? sender);
  const owner = getAddress(input.owner ?? sender);
  const amount = positiveUint(input.amount, "amount");
  const tx = vaultV2Withdraw({
    vault: { address: definition.address },
    args: { amount, recipient, onBehalf: owner },
  });
  return directVaultAction(
    "morpho_vault_v2_withdraw",
    definition,
    sender,
    sdkTransaction(input.chainId, tx),
    { amount: amount.toString(), recipient, owner },
    { burns_shares_for_exact_asset_amount: true, delegated_owner_may_require_share_allowance: owner !== sender },
  );
}

export function prepareMorphoVaultRedeem(input: {
  chainId: string;
  sender: string;
  vault: string;
  shares: string;
  recipient?: string;
  owner?: string;
}) {
  const definition = resolveVault(input.chainId, input.vault);
  const sender = getAddress(input.sender);
  const recipient = getAddress(input.recipient ?? sender);
  const owner = getAddress(input.owner ?? sender);
  const shares = positiveUint(input.shares, "shares");
  const tx = vaultV2Redeem({
    vault: { address: definition.address },
    args: { shares, recipient, onBehalf: owner },
  });
  return directVaultAction(
    "morpho_vault_v2_redeem",
    definition,
    sender,
    sdkTransaction(input.chainId, tx),
    { shares: shares.toString(), recipient, owner },
    { redeems_exact_share_amount: true, recommended_for_full_exit: true, delegated_owner_may_require_share_allowance: owner !== sender },
  );
}

function directVaultAction(
  action: string,
  definition: MorphoVaultDefinition,
  sender: Address,
  transaction: ReturnType<typeof preparedTransaction>,
  request: Record<string, unknown>,
  details: Record<string, unknown>,
) {
  return preparedUiAction({
    action,
    chainId: definition.chain_id,
    sender,
    request: morphoRequest(definition, sender, request),
    transaction,
    details: morphoDetails(definition, { route: "direct vault call", ...details }),
  });
}

function sdkTransaction(
  chainId: string,
  tx: { to: Address; data: Hex; value: bigint },
) {
  return preparedTransaction(chainId, tx.to, tx.data, tx.value);
}

function morphoRequest(
  definition: MorphoVaultDefinition,
  sender: Address,
  fields: Record<string, unknown>,
) {
  return {
    chain_id: definition.chain_id,
    sender,
    vault: definition.address,
    vault_name: definition.name,
    asset: definition.asset.address,
    ...fields,
  };
}

function morphoDetails(
  definition: MorphoVaultDefinition,
  fields: Record<string, unknown>,
) {
  return {
    vault: definition,
    official_sdk_version: MORPHO_SDK_VERSION,
    server_network_access: "none",
    live_state_not_queried: true,
    exact_wallet_simulation_required: true,
    ...fields,
  };
}

function resolveVault(chainId: string, address: string) {
  const normalized = getAddress(address);
  const result = MORPHO_VAULT_V2_CATALOG.find(
    (item) =>
      item.chain_id === chainId &&
      item.address.toLowerCase() === normalized.toLowerCase(),
  );
  if (!result) {
    throw new ServiceError(
      "unsupported_morpho_vault",
      `Vault ${normalized} is not in the fixed Morpho Vault V2 catalog for chain ${chainId}; use get_morpho_vaults`,
    );
  }
  return result;
}

function positiveUint(value: string, label: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ServiceError("invalid_integer", `${label} must be a positive decimal integer`);
  }
  const parsed = BigInt(value);
  if (parsed >= 1n << 256n) {
    throw new ServiceError("integer_overflow", `${label} must fit uint256`);
  }
  return parsed;
}
