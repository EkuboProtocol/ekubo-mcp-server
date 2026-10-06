import { encodeFunctionData } from "viem";
import { z } from "zod";
import { errorResultDecodePlan } from "../../abi-decode.js";
import { executionPlan } from "../../execution-plan.js";
import { type Deps, type PrepareContext, outputHeader, prepareContext } from "./context.js";
import { type PrepareEnv, launchpadErrorsAbi, lockedLaunchLiquidityAbi, scheduledLaunchAbi } from "./contracts.js";
import { advanceFees } from "./fees.js";
import { type ResolvedLaunch, launchStage, migrationPending, resolveLaunch } from "./launch.js";
import { address, chainId, sender, slippageBps } from "./schema.js";
import { prepareError, warning } from "./templates.js";

export const prepareAdvanceSchema = z.object({
  chain_id: chainId,
  sender,
  slippage_bps: slippageBps.describe(
    "Required on every launchpad preparation call, with no default. advance and migrate move no funds of the sender, so no threshold is derived from it here.",
  ),
  token: address.describe("Exact launch token address."),
});

type Step =
  | { call: "advance"; to: "scheduled_launch"; pending: null }
  | { call: "migrate"; to: "locked_launch_liquidity"; pending: { amount0: bigint; amount1: bigint } };

/**
 * Which direct call, if any, moves this launch forward at the pinned block:
 * `ScheduledLaunch.advance` releases inventory during the launch and finishes
 * it after end_time; `LockedLaunchLiquidity.migrate` deposits principal still
 * saved in Core after the launch completed. Both are permissionless.
 */
async function nextStep(context: PrepareContext, launch: ResolvedLaunch): Promise<Step> {
  const stage = launchStage(launch, context.block.timestamp);
  if (stage === "scheduled") throw prepareError("nothing_to_advance", { phase: "scheduled" });
  if (stage !== "complete") return { call: "advance", to: "scheduled_launch", pending: null };
  const pending = await migrationPending(context, launch);
  if (pending.amount0 === 0n && pending.amount1 === 0n) throw prepareError("nothing_to_advance", { phase: "migrated" });
  return { call: "migrate", to: "locked_launch_liquidity", pending };
}

function calldata(step: Step, launch: ResolvedLaunch) {
  return step.call === "advance"
    ? encodeFunctionData({ abi: scheduledLaunchAbi, functionName: "advance", args: [launch.key] })
    : encodeFunctionData({ abi: lockedLaunchLiquidityAbi, functionName: "migrate", args: [launch.poolId] });
}

export async function launchpadPrepareAdvance(env: PrepareEnv, raw: z.input<typeof prepareAdvanceSchema>, deps: Partial<Deps> = {}) {
  const input = prepareAdvanceSchema.parse(raw);
  const context = await prepareContext(env, input, deps);
  const launch = await resolveLaunch(context, { token: input.token });
  const step = await nextStep(context, launch);
  const chain = context.manifest.chain_id.toString();
  const plan = executionPlan({
    chainId: chain,
    sender: context.sender,
    transaction: { chain_id: chain, to: context.manifest.contracts[step.to], data: calldata(step, launch), value: "0" },
    revertDecode: errorResultDecodePlan(launchpadErrorsAbi),
  });
  return {
    ...outputHeader(context),
    action: step.call,
    contract: context.manifest.contracts[step.to],
    token: launch.token,
    pool_id: launch.poolId,
    phase: launchStage(launch, context.block.timestamp),
    principal_pending:
      step.pending === null ? null : { amount0: step.pending.amount0.toString(), amount1: step.pending.amount1.toString() },
    fees: advanceFees(),
    warnings: [warning("migration_may_stay_pending")],
    execution_plan: plan,
  };
}
