import { encodeFunctionData, getAddress, parseAbi, type Address } from "viem";
import { ServiceError } from "./core.js";
import {
  erc20ApprovalTransaction,
  preparedTransaction,
  preparedUiAction,
} from "./ui-actions.js";

export const SKY_SAVINGS_ABI = parseAbi([
  "function deposit(uint256 assets,address receiver) returns (uint256 shares)",
  "function withdraw(uint256 assets,address receiver,address owner) returns (uint256 shares)",
  "function redeem(uint256 shares,address receiver,address owner) returns (uint256 assets)",
]);

export const SKY_SAVINGS_DEPLOYMENT = {
  chain_id: "1",
  network: "Ethereum",
  usds: getAddress("0xdC035D45d973E3EC169d2276DDab16f1e407384F"),
  susds: getAddress("0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD"),
  asset_decimals: 18,
  share_decimals: 18,
} as const;

export function getSkySavingsDeployment() {
  return {
    protocol: "sky_savings",
    network_access: "none",
    source: {
      documentation: "https://developers.skyeco.com/protocol/tokens/susds/",
      deployment_tracker:
        "https://developers.skyeco.com/quick-start/protocol-navigator/?group=all&module=susds&status=active",
      snapshot_date: "2026-08-13",
    },
    agent_market_data_discovery: {
      server_involvement: "none",
      skill_resource: "ekubo://skills/use-sky",
      method:
        "Use the user's wallet/RPC for ERC-4626 totalAssets, totalSupply, convertToShares, convertToAssets, previewDeposit, previewWithdraw, previewRedeem, maxDeposit, maxWithdraw, and maxRedeem reads",
      handoff:
        "Verify asset() equals the fixed USDS address and chain is Ethereum before preparation",
    },
    deployment: SKY_SAVINGS_DEPLOYMENT,
    properties: {
      standard: "ERC-4626",
      deposit_asset: "USDS",
      received_share: "sUSDS",
      route_fees: "none according to Sky protocol documentation",
    },
    limitations: {
      live_state:
        "No API, RPC, savings rate, vault accounting, balance, allowance, preview, or capacity state is queried",
      execution:
        "The direct ERC-4626 interface has no deadline or minimum-output argument; require a fresh exact wallet simulation immediately before authorization",
    },
  };
}

export function prepareSkySavingsDeposit(input: {
  chainId: string;
  sender: string;
  amount: string;
  receiver?: string;
}) {
  requireEthereum(input.chainId);
  const sender = getAddress(input.sender);
  const receiver = getAddress(input.receiver ?? sender);
  const amount = positiveUint(input.amount, "amount");
  return preparedUiAction({
    action: "sky_savings_deposit",
    chainId: input.chainId,
    sender,
    request: { chain_id: input.chainId, sender, amount: amount.toString(), receiver },
    approvals: [erc20ApprovalTransaction(input.chainId, SKY_SAVINGS_DEPLOYMENT.usds, SKY_SAVINGS_DEPLOYMENT.susds, amount)],
    transaction: preparedTransaction(
      input.chainId,
      SKY_SAVINGS_DEPLOYMENT.susds,
      encodeFunctionData({ abi: SKY_SAVINGS_ABI, functionName: "deposit", args: [amount, receiver] }),
      0n,
    ),
    postExecutionTransactions: [erc20ApprovalTransaction(input.chainId, SKY_SAVINGS_DEPLOYMENT.usds, SKY_SAVINGS_DEPLOYMENT.susds, 0n)],
    atomicBatchRequired: true,
    details: skyDetails({ exact_usds_approval_then_cleanup: true, receiver_receives_susds: receiver }),
    onchainValidation: { fresh_preview_deposit_required: true },
  });
}

export function prepareSkySavingsWithdraw(input: {
  chainId: string;
  sender: string;
  amount: string;
  receiver?: string;
  owner?: string;
}) {
  requireEthereum(input.chainId);
  const sender = getAddress(input.sender);
  const receiver = getAddress(input.receiver ?? sender);
  const owner = getAddress(input.owner ?? sender);
  const amount = positiveUint(input.amount, "amount");
  return skyDirectAction("sky_savings_withdraw", input.chainId, sender, {
    functionName: "withdraw",
    args: [amount, receiver, owner],
    request: { amount: amount.toString(), receiver, owner },
    details: { burns_shares_for_exact_usds_amount: true, delegated_owner_may_require_share_allowance: owner !== sender },
  });
}

export function prepareSkySavingsRedeem(input: {
  chainId: string;
  sender: string;
  shares: string;
  receiver?: string;
  owner?: string;
}) {
  requireEthereum(input.chainId);
  const sender = getAddress(input.sender);
  const receiver = getAddress(input.receiver ?? sender);
  const owner = getAddress(input.owner ?? sender);
  const shares = positiveUint(input.shares, "shares");
  return skyDirectAction("sky_savings_redeem", input.chainId, sender, {
    functionName: "redeem",
    args: [shares, receiver, owner],
    request: { shares: shares.toString(), receiver, owner },
    details: { redeems_exact_susds_share_amount: true, delegated_owner_may_require_share_allowance: owner !== sender },
  });
}

function skyDirectAction(
  action: string,
  chainId: string,
  sender: Address,
  input: {
    functionName: "withdraw" | "redeem";
    args: readonly [bigint, Address, Address];
    request: Record<string, unknown>;
    details: Record<string, unknown>;
  },
) {
  return preparedUiAction({
    action,
    chainId,
    sender,
    request: { chain_id: chainId, sender, ...input.request },
    transaction: preparedTransaction(
      chainId,
      SKY_SAVINGS_DEPLOYMENT.susds,
      encodeFunctionData({ abi: SKY_SAVINGS_ABI, functionName: input.functionName, args: input.args }),
      0n,
    ),
    details: skyDetails(input.details),
    onchainValidation: { fresh_erc4626_preview_required: true },
  });
}

function skyDetails(fields: Record<string, unknown>) {
  return {
    deployment: SKY_SAVINGS_DEPLOYMENT,
    server_network_access: "none",
    live_state_not_queried: true,
    exact_wallet_simulation_required: true,
    direct_erc4626_has_no_deadline_or_minimum_output: true,
    ...fields,
  };
}

function requireEthereum(chainId: string) {
  if (chainId !== SKY_SAVINGS_DEPLOYMENT.chain_id) {
    throw new ServiceError("unsupported_sky_chain", "Sky sUSDS preparation is configured only for Ethereum chain 1");
  }
}

function positiveUint(value: string, label: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new ServiceError("invalid_integer", `${label} must be a positive decimal integer`);
  const parsed = BigInt(value);
  if (parsed >= 1n << 256n) throw new ServiceError("integer_overflow", `${label} must fit uint256`);
  return parsed;
}
