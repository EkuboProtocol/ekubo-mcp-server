import { type Address, encodeFunctionData, getAddress, type Hex, zeroAddress } from "viem";
import { preparedTransaction, preparedUiAction } from "../../ui-actions.js";
import { abiFunction, peripheryAbi } from "./abi.js";
import { blockSummary, type ChainContext, chainContext, creatorFees, getLaunch, launchApi, launchOwner, poolKeyOf } from "./context.js";
import type { LaunchpadEnv } from "./deployment.js";
import { invalidArgument, LaunchpadError } from "./errors.js";
import type { Block } from "./rpc.js";

async function requireOwner(context: ChainContext, poolId: Hex, sender: Address, block: Block): Promise<void> {
  await getLaunch(context, poolId, block);
  const owner = await launchOwner(context, poolId, block);
  if (owner === zeroAddress) {
    throw new LaunchpadError("launch_not_owned_by_periphery", "This launch was not created through the configured periphery, so it has no owner who can claim or transfer it here.", { argument: "pool_id", retryable: false });
  }
  if (owner !== sender) {
    throw new LaunchpadError("not_launch_owner", `Only the current owner ${owner} can do this; sender is ${sender}. Nothing was prepared.`, { argument: "sender", retryable: false, owner });
  }
}

export interface ClaimInput {
  chain_id: string;
  sender: string;
  pool_id: string;
  recipient?: string;
}

export async function prepareClaimFees(env: LaunchpadEnv, input: ClaimInput) {
  const sender = getAddress(input.sender);
  const recipient = getAddress(input.recipient ?? sender);
  const context = await chainContext(env, input.chain_id);
  const launch = await launchApi(env).launch(input.chain_id, input.pool_id.toLowerCase() as Hex);
  const key = poolKeyOf(launch, context.deployment);
  const { core, extension, periphery } = context.deployment;
  if ([zeroAddress, core, extension, periphery, key.token0, key.token1].some((sink) => getAddress(sink) === recipient)) {
    throw invalidArgument("recipient", "must not be the zero address, Core, the launch contracts or either pool token (the periphery refuses them with InvalidRecipient)");
  }
  const block = await context.rpc.latestBlock();
  await requireOwner(context, launch.pool_id, sender, block);
  const [amount0, amount1] = await creatorFees(context, key, block);
  if (amount0 === 0n && amount1 === 0n) {
    throw new LaunchpadError("no_fees_to_claim", "This launch has no unclaimed creator fees at the latest block. Nothing was prepared; fees accrue as people trade.", { retryable: true });
  }
  const data = encodeFunctionData({ abi: [abiFunction(peripheryAbi, "claimFees")], functionName: "claimFees", args: [key, recipient] });
  return preparedUiAction({
    action: "launchpad_claim_fees",
    chainId: input.chain_id,
    sender,
    request: { chain_id: input.chain_id, sender, pool_id: launch.pool_id, recipient },
    transaction: preparedTransaction(input.chain_id, periphery, data, 0n),
    details: {
      summary: `Claim every unclaimed creator fee of this launch to ${recipient}: currently ${amount0} base units of ${key.token0} and ${amount1} of ${key.token1}; the claim pays whatever has accrued when it executes.`,
      unclaimed: { token0: key.token0, amount0: amount0.toString(), token1: key.token1, amount1: amount1.toString() },
      as_of: blockSummary(block),
    },
  });
}

export interface TransferInput {
  chain_id: string;
  sender: string;
  pool_id: string;
  new_owner: string;
}

export async function prepareTransferLaunch(env: LaunchpadEnv, input: TransferInput) {
  const sender = getAddress(input.sender);
  const newOwner = getAddress(input.new_owner);
  if (newOwner === zeroAddress) throw invalidArgument("new_owner", "must not be the zero address (the periphery refuses it with InvalidOwner)");
  if (newOwner === sender) throw invalidArgument("new_owner", "is already the owner; give a different address");
  const context = await chainContext(env, input.chain_id);
  const poolId = input.pool_id.toLowerCase() as Hex;
  const block = await context.rpc.latestBlock();
  await requireOwner(context, poolId, sender, block);
  const data = encodeFunctionData({ abi: [abiFunction(peripheryAbi, "transferLaunch")], functionName: "transferLaunch", args: [poolId, newOwner] });
  return preparedUiAction({
    action: "launchpad_transfer_launch",
    chainId: input.chain_id,
    sender,
    request: { chain_id: input.chain_id, sender, pool_id: poolId, new_owner: newOwner },
    transaction: preparedTransaction(input.chain_id, context.deployment.periphery, data, 0n),
    details: {
      summary: `Transfer ownership of launch ${poolId} from ${sender} to ${newOwner}. The new owner receives every fee right, including fees already accrued and unclaimed. This cannot be undone by the sender.`,
      previous_owner: sender, new_owner: newOwner,
    },
  });
}
