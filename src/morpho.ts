import { vaultV2Deposit } from "@morpho-org/morpho-sdk";
import { vaultV2Abi } from "@morpho-org/morpho-sdk/abis";
import { getChainAddresses } from "@morpho-org/morpho-sdk/addresses";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import packageJson from "../package.json";
import { ServiceError } from "./core.js";
import {
  erc20ApprovalTransaction,
  preparedTransaction,
  preparedUiAction,
} from "./ui-actions.js";

// package.json pins the SDK exactly, so this is the version that is bundled.
export const MORPHO_SDK_VERSION: string =
  packageJson.dependencies["@morpho-org/morpho-sdk"];

// Matches the SDK entity default for VaultBundlesV1 operations.
const DEFAULT_DEPOSIT_DEADLINE_SECONDS = 2n * 60n * 60n;

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
      vault_bundles_v1: vaultBundlesV1(item.chain_id),
    })),
    limitations: {
      live_state:
        "No API, RPC, balance, allowance, vault accounting, liquidity, APY, allocation, warning, or listing state is queried",
      execution:
        "Deposits use the official SDK's VaultBundlesV1 route, which enforces maxSharePrice onchain and mints shares only to the transaction sender; withdrawals and redemptions are direct vault calls; every plan still requires exact wallet simulation",
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
  deadline?: string;
}) {
  const definition = resolveVault(input.chainId, input.vault);
  const sender = getAddress(input.sender);
  const recipient = senderOnlyRecipient(sender, input.recipient);
  const amount = positiveUint(input.amount, "amount");
  const maxSharePrice = positiveUint(
    input.maxSharePriceRay,
    "max_share_price_ray",
  );
  const deadline = depositDeadline(input.deadline);
  const spender = vaultBundlesV1(input.chainId);
  const tx = vaultV2Deposit({
    vault: {
      chainId: Number(input.chainId),
      address: definition.address,
      asset: definition.asset.address,
    },
    args: { amount, maxSharePrice, userAddress: sender, deadline },
  });
  return preparedUiAction({
    action: "morpho_vault_v2_deposit",
    chainId: input.chainId,
    sender,
    request: morphoRequest(definition, sender, {
      amount: amount.toString(),
      max_share_price_ray: maxSharePrice.toString(),
      recipient,
      deadline: deadline.toString(),
    }),
    approvals: [
      erc20ApprovalTransaction(
        input.chainId,
        definition.asset.address,
        spender,
        amount,
      ),
    ],
    transaction: sdkTransaction(input.chainId, tx),
    postExecutionTransactions: [
      erc20ApprovalTransaction(
        input.chainId,
        definition.asset.address,
        spender,
        0n,
      ),
    ],
    atomicBatchRequired: true,
    details: morphoDetails(definition, {
      route: "VaultBundlesV1",
      vault_bundles_v1: spender,
      shares_minted_to_sender_only: true,
      deadline: deadline.toString(),
      exact_approval_then_cleanup: true,
      max_share_price_enforced_onchain: true,
      max_share_price_scale: "RAY (1e27)",
    }),
  });
}

/**
 * Withdraw and redeem stay direct vault calls. The SDK's v6 builders route
 * them through VaultBundlesV1, which always burns and pays msg.sender and
 * needs a new share approval, so they cannot keep an independent recipient
 * or owner.
 */
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
  const data = encodeFunctionData({
    abi: vaultV2Abi,
    functionName: "withdraw",
    args: [amount, recipient, owner],
  });
  return directVaultAction(
    "morpho_vault_v2_withdraw",
    definition,
    sender,
    preparedTransaction(input.chainId, definition.address, data, 0n),
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
  const data = encodeFunctionData({
    abi: vaultV2Abi,
    functionName: "redeem",
    args: [shares, recipient, owner],
  });
  return directVaultAction(
    "morpho_vault_v2_redeem",
    definition,
    sender,
    preparedTransaction(input.chainId, definition.address, data, 0n),
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

function vaultBundlesV1(chainId: string): Address {
  const address = getChainAddresses(Number(chainId)).bundles?.vaultBundlesV1;
  if (!address) {
    throw new ServiceError(
      "unsupported_morpho_chain",
      `The Morpho SDK registers no VaultBundlesV1 deployment on chain ${chainId}`,
    );
  }
  return address;
}

function senderOnlyRecipient(sender: Address, recipient: string | undefined) {
  const resolved = getAddress(recipient ?? sender);
  if (resolved !== sender) {
    throw new ServiceError(
      "unsupported_morpho_recipient",
      "Guarded Morpho deposits mint vault shares to the sender only; deposit as the sender, then transfer the shares",
      { sender, recipient: resolved },
    );
  }
  return resolved;
}

/**
 * VaultBundlesV1 reverts once block.timestamp passes the deadline, so a past
 * one turns the plan into a guaranteed revert.
 */
function depositDeadline(value: string | undefined): bigint {
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (value === undefined) return now + DEFAULT_DEPOSIT_DEADLINE_SECONDS;
  const deadline = positiveUint(value, "deadline");
  if (deadline <= now) {
    throw new ServiceError(
      "expired_deadline",
      "deadline is a unix timestamp in the past, so this transaction would revert on arrival",
      { supplied_deadline: deadline.toString(), server_time: now.toString() },
    );
  }
  return deadline;
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
