import { type Address, decodeFunctionResult, encodeFunctionData, getAddress, type Hex, zeroAddress } from "viem";
import { z } from "zod";
import { errorResultDecodePlan } from "../../abi-decode.js";
import { executionPlan } from "../../execution-plan.js";
import { type Deps, type PrepareContext, outputHeader, prepareContext } from "./context.js";
import { type PrepareEnv, launchRouterAbi, launchpadErrorsAbi, revertErrorName } from "./contracts.js";
import { claimFees } from "./fees.js";
import { type ResolvedLaunch, resolveLaunch } from "./launch.js";
import { address, chainId, sender, slippageBps } from "./schema.js";
import { prepareError, warning } from "./templates.js";

export const prepareClaimSchema = z.object({
  chain_id: chainId,
  sender: sender.describe(
    "The launch's creator: the account that signed LaunchRouter.create. Any other sender is refused, as the router would refuse it.",
  ),
  slippage_bps: slippageBps.describe(
    "Required on every launchpad preparation call, with no default. A claim pays nothing, so no threshold is derived from it here.",
  ),
  token: address.describe("Exact launch token address."),
  recipient: address.optional().describe("Where the claimed fees go. Defaults to sender. Must be nonzero."),
});

async function readCreator(context: PrepareContext, launch: ResolvedLaunch): Promise<Address> {
  const result = await context.chain.call({
    from: context.sender,
    to: context.manifest.contracts.launch_router,
    data: encodeFunctionData({ abi: launchRouterAbi, functionName: "creator", args: [launch.poolId] }),
    block: context.block,
  });
  if (!result.ok) throw prepareError("rpc_unavailable");
  return getAddress(decodeFunctionResult({ abi: launchRouterAbi, functionName: "creator", data: result.data }) as Address);
}

/** The amounts the claim would pay at the pinned block, by calling it from the sender. */
async function simulateClaim(context: PrepareContext, data: Hex): Promise<readonly [bigint, bigint]> {
  const result = await context.chain.call({ from: context.sender, to: context.manifest.contracts.launch_router, data, block: context.block });
  if (!result.ok) throw prepareError("claim_reverted", { revert_data: result.revert, error_name: revertErrorName(result.revert) });
  return decodeFunctionResult({ abi: launchRouterAbi, functionName: "claimFees", data: result.data }) as readonly [bigint, bigint];
}

/**
 * Creator fees of a router-created launch: `LaunchRouter.claimFees`, which
 * claims the ScheduledLaunch ledger and, once migrated, the locked position's
 * fees, and pays both to the recipient. Only the router's recorded creator
 * may call it; `LaunchCreated.owner` is never used to decide who that is.
 */
export async function launchpadPrepareClaim(env: PrepareEnv, raw: z.input<typeof prepareClaimSchema>, deps: Partial<Deps> = {}) {
  const input = prepareClaimSchema.parse(raw);
  const recipient = getAddress(input.recipient ?? input.sender);
  if (recipient === zeroAddress) throw prepareError("invalid_recipient");
  const context = await prepareContext(env, input, deps);
  const launch = await resolveLaunch(context, { token: input.token });
  const creator = await readCreator(context, launch);
  if (creator === zeroAddress) throw prepareError("not_router_launch");
  if (creator !== context.sender) throw prepareError("creator_only", { creator });
  const data = encodeFunctionData({ abi: launchRouterAbi, functionName: "claimFees", args: [launch.key, recipient] });
  const [amount0, amount1] = await simulateClaim(context, data);
  const chain = context.manifest.chain_id.toString();
  const plan = executionPlan({
    chainId: chain,
    sender: context.sender,
    transaction: { chain_id: chain, to: context.manifest.contracts.launch_router, data, value: "0" },
    revertDecode: errorResultDecodePlan(launchpadErrorsAbi),
  });
  return {
    ...outputHeader(context),
    action: "claim_creator_fees",
    contract: context.manifest.contracts.launch_router,
    token: launch.token,
    pool_id: launch.poolId,
    creator,
    recipient,
    claimable_at_block: [
      { token: launch.key.token0, amount: amount0.toString() },
      { token: launch.key.token1, amount: amount1.toString() },
    ],
    fees: claimFees(),
    warnings: amount0 === 0n && amount1 === 0n ? [warning("nothing_to_claim")] : [],
    execution_plan: plan,
  };
}
