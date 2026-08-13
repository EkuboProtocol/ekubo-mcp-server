import { encodeFunctionData, getAddress, parseAbi } from "viem";
import { ServiceError } from "./core.js";
import {
  erc20ApprovalTransaction,
  preparedTransaction,
  preparedUiAction,
} from "./ui-actions.js";

export const LIDO_ABI = parseAbi(["function submit(address referral) payable returns (uint256 shares)"]);
export const WSTETH_ABI = parseAbi([
  "function wrap(uint256 stETHAmount) returns (uint256 wstETHAmount)",
  "function unwrap(uint256 wstETHAmount) returns (uint256 stETHAmount)",
]);
export const WITHDRAWAL_QUEUE_ABI = parseAbi([
  "function requestWithdrawals(uint256[] amounts,address owner) returns (uint256[] requestIds)",
  "function claimWithdrawal(uint256 requestId)",
]);

export const LIDO_MAINNET_DEPLOYMENT = {
  chain_id: "1",
  network: "Ethereum",
  steth: getAddress("0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84"),
  wsteth: getAddress("0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0"),
  withdrawal_queue: getAddress("0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1"),
  wsteth_referral_staker: getAddress("0xa88f0329C2c4ce51ba3fc619BBf44efE7120Dd0d"),
  decimals: 18,
} as const;

const MIN_WITHDRAWAL_WEI = 100n;
const MAX_WITHDRAWAL_WEI = 1_000n * 10n ** 18n;

export function getLidoDeployment() {
  return {
    protocol: "lido",
    network_access: "none",
    source: {
      deployments: "https://docs.lido.fi/deployed-contracts/",
      contracts: "https://docs.lido.fi/contracts/lido/",
      withdrawal_queue: "https://docs.lido.fi/contracts/withdrawal-queue-erc721/",
      snapshot_date: "2026-08-13",
    },
    agent_market_data_discovery: {
      server_involvement: "none",
      skill_resource: "ekubo://skills/use-lido",
      method:
        "Use the user's wallet/RPC for isStakingPaused, getCurrentStakeLimit, stETH/wstETH conversions, balances, getWithdrawalRequests, getWithdrawalStatus, ownerOf, and claimability",
      handoff:
        "Match Ethereum chain 1 and every target contract against this fixed deployment before preparation",
    },
    deployment: LIDO_MAINNET_DEPLOYMENT,
    withdrawal_bounds: {
      minimum_steth_wei_per_request: MIN_WITHDRAWAL_WEI.toString(),
      maximum_steth_wei_per_request: MAX_WITHDRAWAL_WEI.toString(),
    },
    limitations: {
      live_state:
        "No RPC, API, stake-limit, pause, exchange-rate, balance, queue, finalization, ownership, or claimability state is queried",
      queue:
        "Withdrawal requests are asynchronous unstETH NFTs, stop earning rewards while queued, cannot be claimed before finalization, and may settle below 1:1 after extraordinary protocol losses",
    },
  };
}

export function prepareLidoStake(input: {
  chainId: string;
  sender: string;
  amount: string;
  referral?: string;
}) {
  requireEthereum(input.chainId);
  const sender = getAddress(input.sender);
  const amount = positiveUint(input.amount, "amount");
  const referral = getAddress(input.referral ?? "0x0000000000000000000000000000000000000000");
  return preparedUiAction({
    action: "lido_stake_eth",
    chainId: input.chainId,
    sender,
    request: { chain_id: input.chainId, sender, amount: amount.toString(), referral },
    transaction: preparedTransaction(
      input.chainId,
      LIDO_MAINNET_DEPLOYMENT.steth,
      encodeFunctionData({ abi: LIDO_ABI, functionName: "submit", args: [referral] }),
      amount,
    ),
    details: lidoDetails({ received_token: "stETH", current_stake_limit_not_queried: true }),
    onchainValidation: { staking_not_paused_and_current_limit_sufficient: true },
  });
}

export function prepareLidoWrap(input: { chainId: string; sender: string; amount: string }) {
  requireEthereum(input.chainId);
  const sender = getAddress(input.sender);
  const amount = positiveUint(input.amount, "amount");
  return preparedUiAction({
    action: "lido_wrap_steth",
    chainId: input.chainId,
    sender,
    request: { chain_id: input.chainId, sender, amount: amount.toString() },
    approvals: [erc20ApprovalTransaction(input.chainId, LIDO_MAINNET_DEPLOYMENT.steth, LIDO_MAINNET_DEPLOYMENT.wsteth, amount)],
    transaction: preparedTransaction(
      input.chainId,
      LIDO_MAINNET_DEPLOYMENT.wsteth,
      encodeFunctionData({ abi: WSTETH_ABI, functionName: "wrap", args: [amount] }),
      0n,
    ),
    postExecutionTransactions: [erc20ApprovalTransaction(input.chainId, LIDO_MAINNET_DEPLOYMENT.steth, LIDO_MAINNET_DEPLOYMENT.wsteth, 0n)],
    atomicBatchRequired: true,
    details: lidoDetails({ exact_steth_approval_then_cleanup: true, received_token: "wstETH" }),
  });
}

export function prepareLidoUnwrap(input: { chainId: string; sender: string; amount: string }) {
  requireEthereum(input.chainId);
  const sender = getAddress(input.sender);
  const amount = positiveUint(input.amount, "amount");
  return preparedUiAction({
    action: "lido_unwrap_wsteth",
    chainId: input.chainId,
    sender,
    request: { chain_id: input.chainId, sender, amount: amount.toString() },
    transaction: preparedTransaction(
      input.chainId,
      LIDO_MAINNET_DEPLOYMENT.wsteth,
      encodeFunctionData({ abi: WSTETH_ABI, functionName: "unwrap", args: [amount] }),
      0n,
    ),
    details: lidoDetails({ input_token: "wstETH", received_token: "stETH" }),
  });
}

export function prepareLidoWithdrawalRequest(input: {
  chainId: string;
  sender: string;
  amounts: string[];
  owner?: string;
}) {
  requireEthereum(input.chainId);
  const sender = getAddress(input.sender);
  const owner = getAddress(input.owner ?? sender);
  if (input.amounts.length === 0 || input.amounts.length > 64) {
    throw new ServiceError("invalid_withdrawal_batch", "amounts must contain 1 to 64 withdrawal requests");
  }
  const amounts = input.amounts.map((amount, index) => {
    const value = positiveUint(amount, `amounts[${index}]`);
    if (value < MIN_WITHDRAWAL_WEI || value > MAX_WITHDRAWAL_WEI) {
      throw new ServiceError("invalid_lido_withdrawal_amount", `Each request must be between 100 wei and 1000 stETH; amounts[${index}] is out of range`);
    }
    return value;
  });
  const total = amounts.reduce((sum, amount) => sum + amount, 0n);
  return preparedUiAction({
    action: "lido_request_steth_withdrawal",
    chainId: input.chainId,
    sender,
    request: { chain_id: input.chainId, sender, amounts: amounts.map(String), owner, total_steth: total.toString() },
    approvals: [erc20ApprovalTransaction(input.chainId, LIDO_MAINNET_DEPLOYMENT.steth, LIDO_MAINNET_DEPLOYMENT.withdrawal_queue, total)],
    transaction: preparedTransaction(
      input.chainId,
      LIDO_MAINNET_DEPLOYMENT.withdrawal_queue,
      encodeFunctionData({ abi: WITHDRAWAL_QUEUE_ABI, functionName: "requestWithdrawals", args: [amounts, owner] }),
      0n,
    ),
    postExecutionTransactions: [erc20ApprovalTransaction(input.chainId, LIDO_MAINNET_DEPLOYMENT.steth, LIDO_MAINNET_DEPLOYMENT.withdrawal_queue, 0n)],
    atomicBatchRequired: true,
    details: lidoDetails({
      exact_steth_approval_then_cleanup: true,
      result: "one unstETH NFT request ID per amount",
      asynchronous: true,
      irreversible_request: true,
      rewards_stop_while_queued: true,
      extraordinary_loss_can_reduce_claimed_eth: true,
    }),
    onchainValidation: { withdrawals_not_paused_and_balance_sufficient: true },
  });
}

export function prepareLidoWithdrawalClaim(input: {
  chainId: string;
  sender: string;
  requestId: string;
}) {
  requireEthereum(input.chainId);
  const sender = getAddress(input.sender);
  const requestId = positiveUint(input.requestId, "request_id");
  return preparedUiAction({
    action: "lido_claim_withdrawal",
    chainId: input.chainId,
    sender,
    request: { chain_id: input.chainId, sender, request_id: requestId.toString(), recipient: sender },
    transaction: preparedTransaction(
      input.chainId,
      LIDO_MAINNET_DEPLOYMENT.withdrawal_queue,
      encodeFunctionData({ abi: WITHDRAWAL_QUEUE_ABI, functionName: "claimWithdrawal", args: [requestId] }),
      0n,
    ),
    details: lidoDetails({ burns_unsteth_nft: true, eth_recipient_is_sender: true }),
    onchainValidation: { sender_must_own_request_and_request_must_be_finalized_and_unclaimed: true },
  });
}

function lidoDetails(fields: Record<string, unknown>) {
  return {
    deployment: LIDO_MAINNET_DEPLOYMENT,
    server_network_access: "none",
    live_state_not_queried: true,
    exact_wallet_simulation_required: true,
    ...fields,
  };
}

function requireEthereum(chainId: string) {
  if (chainId !== "1") throw new ServiceError("unsupported_lido_chain", "Lido staking and withdrawal preparation is configured only for Ethereum chain 1");
}

function positiveUint(value: string, label: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new ServiceError("invalid_integer", `${label} must be a positive decimal integer`);
  const parsed = BigInt(value);
  if (parsed >= 1n << 256n) throw new ServiceError("integer_overflow", `${label} must fit uint256`);
  return parsed;
}
