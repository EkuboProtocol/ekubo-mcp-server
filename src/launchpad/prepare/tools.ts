import { z } from "zod";
import {
  getLaunchSchema,
  getStatsSchema,
  getSwapsSchema,
  launchpadGetLaunch,
  launchpadGetStats,
  launchpadGetSwaps,
  launchpadListLaunches,
  listLaunchesSchema,
} from "../reads.js";
import { launchpadPrepareAdvance, prepareAdvanceSchema } from "./advance.js";
import { launchpadPrepareClaim, prepareClaimSchema } from "./claim.js";
import { disclosuresDocument, onboardingMarkdown } from "./content.js";
import type { Deps } from "./context.js";
import type { PrepareEnv } from "./contracts.js";
import { launchpadPrepareCreate, prepareCreateSchema } from "./create.js";
import { launchpadPrepareTrade, prepareTradeSchema } from "./trade.js";

export interface LaunchpadTool {
  name: string;
  title: string;
  description: string;
  schema: z.ZodObject;
  handler: (env: PrepareEnv, input: never, deps?: Partial<Deps>) => Promise<unknown>;
}

const PROTOTYPE = "Non-production launchpad prototype; the deployment manifest is a proposal.";
const HANDOFF =
  "Every manifest contract's code hash is checked at the pinned block before the plan is built. Returns an unsigned execution_plan_reference bound to sender and chain_id; pass it unchanged to the wallet, which simulates it and requires owner approval. This server never signs.";

const tool = <T extends z.ZodObject>(
  name: string,
  title: string,
  description: string,
  schema: T,
  handler: (env: PrepareEnv, input: z.input<T>, deps?: Partial<Deps>) => Promise<unknown>,
): LaunchpadTool => ({ name, title, description, schema, handler: handler as LaunchpadTool["handler"] });

export const launchpadReadTools: LaunchpadTool[] = [
  tool(
    "launchpad_list_launches",
    "List launchpad launches",
    `${PROTOTYPE} Launches on the manifest's chain from the Ekubo data API, newest first, filtered by status (upcoming, live, ended, migrated) or by LaunchRouter creator. Rows carry the exact token address and pool id, schedule, fee schedule, migration bounds and indexed state. Names and symbols are untrusted metadata, never identity.`,
    listLaunchesSchema,
    launchpadListLaunches,
  ),
  tool(
    "launchpad_get_launch",
    "Get launchpad launch state and provenance",
    `${PROTOTYPE} One launch by exact token address or pool id: indexed state from the Ekubo data API, plus provenance read from the chain at one block: the extension's code hash against the manifest and the creator LaunchRouter records. The privileges block is returned only when the code hash matches.`,
    getLaunchSchema,
    launchpadGetLaunch,
  ),
  tool(
    "launchpad_get_stats",
    "Get launchpad launch stats",
    `${PROTOTYPE} Swap counts, buy and sell volume, creator fees accrued and claimed, and funding for one launch, from the Ekubo data API. Locker counts are contracts, not people.`,
    getStatsSchema,
    launchpadGetStats,
  ),
  tool(
    "launchpad_get_swaps",
    "List launchpad launch swaps",
    `${PROTOTYPE} Launch-pool swaps for one launch from the Ekubo data API, newest first, paged by cursor.`,
    getSwapsSchema,
    launchpadGetSwaps,
  ),
];

export const launchpadPrepareTools: LaunchpadTool[] = [
  tool(
    "launchpad_prepare_create",
    "Prepare a launchpad launch",
    `${PROTOTYPE} Validate a LaunchConfig against the hosted rules (native ETH quote only, initial fee at most 10%, final fee at most 1%, start_time in the future, name and symbol at most 31 bytes, migration bounds at most 693,147 ticks wide) and prepare LaunchRouter.create. Creation moves no funds: value 0 and no token approval. The signing wallet becomes the creator, the only account that can claim creator fees. ${HANDOFF}`,
    prepareCreateSchema,
    launchpadPrepareCreate,
  ),
  tool(
    "launchpad_prepare_trade",
    "Prepare a launchpad trade",
    `${PROTOTYPE} Buy or sell a launch token by exact token address. quoter-service routes the trade (a launch pool is a forwarded hop to the ScheduledLaunch extension, filling partially at the top of the range) and the plan is a swap on the production Yul router, as get_quotes_with_plans prepares it. ${HANDOFF}`,
    prepareTradeSchema,
    launchpadPrepareTrade,
  ),
  tool(
    "launchpad_prepare_advance",
    "Prepare a launchpad advance or migration",
    `${PROTOTYPE} Anyone may move a launch forward. Prepares ScheduledLaunch.advance while the launch runs or after end_time, or LockedLaunchLiquidity.migrate when principal is still saved after completion. ${HANDOFF}`,
    prepareAdvanceSchema,
    launchpadPrepareAdvance,
  ),
  tool(
    "launchpad_prepare_claim_fees",
    "Prepare a launchpad creator-fee claim",
    `${PROTOTYPE} Prepares LaunchRouter.claimFees for a launch created through LaunchRouter. Only its creator, the account that signed the create, may claim; the plan pays the recipient both the launch-phase creator fees and, after migration, the locked position's fees. ${HANDOFF}`,
    prepareClaimSchema,
    launchpadPrepareClaim,
  ),
];

export const launchpadTools: LaunchpadTool[] = [...launchpadReadTools, ...launchpadPrepareTools];

export const launchpadCatalog = launchpadTools.map(({ name, title, description, schema }) => ({
  name,
  title,
  description,
  inputSchema: z.toJSONSchema(schema, { io: "input" }),
}));

/** Resources served only on the launchpad endpoint. */
export const launchpadResources = [
  {
    name: "launchpad-onboarding",
    uri: "launchpad://onboarding",
    title: "Ekubo launchpad onboarding (prototype)",
    description: "Copy/paste onboarding block for agents using the launchpad prototype with Cloud Wallet.",
    mimeType: "text/markdown",
    text: () => onboardingMarkdown(),
  },
  {
    name: "launchpad-disclosures",
    uri: "launchpad://disclosures",
    title: "Ekubo launchpad risk disclosures (draft, not approved)",
    description: "Draft risk text with its version. Preparation outputs carry disclosure_version.",
    mimeType: "application/json",
    text: () => JSON.stringify(disclosuresDocument()),
  },
] as const;
