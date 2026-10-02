import { z } from "zod";
import { launchpadPrepareAdvance, prepareAdvanceSchema } from "./advance.js";
import { disclosuresDocument, onboardingMarkdown } from "./content.js";
import { type ChainFactory, rpcChain } from "./context.js";
import type { PrepareEnv } from "./contracts.js";
import { launchpadPrepareCreate, prepareCreateSchema } from "./create.js";
import { launchpadPrepareTrade, prepareTradeSchema } from "./trade.js";

interface PrepareTool {
  name: string;
  title: string;
  description: string;
  schema: z.ZodObject;
  handler: (env: PrepareEnv, input: never, chainFactory?: ChainFactory) => Promise<unknown>;
}

const PROTOTYPE = "Non-production launchpad prototype on a local chain.";
const HANDOFF =
  "Returns an unsigned execution_plan_reference bound to sender and chain_id; pass it unchanged to the wallet, which simulates it and requires owner approval. This server never signs.";

export const launchpadPrepareTools: PrepareTool[] = [
  {
    name: "launchpad_prepare_create",
    title: "Prepare a launchpad launch",
    description: `${PROTOTYPE} Validate a LaunchConfig against the hosted caps (initial fee at most 10%, final fee at most 1%, quote asset on the allowlist, start_time in the future, name and symbol at most 31 bytes) and prepare LaunchRouter.create, with an ERC-20 quote approval first when a seed is paid. ${HANDOFF} The output names the fee beneficiary, warns when it is not the sender, and echoes the migration bounds as prices.`,
    schema: prepareCreateSchema,
    handler: ((env, input, chainFactory = rpcChain) => launchpadPrepareCreate(env, input, chainFactory)) as PrepareTool["handler"],
  },
  {
    name: "launchpad_prepare_trade",
    title: "Prepare a launchpad trade",
    description: `${PROTOTYPE} Buy or sell a launch token by exact token address. During the launch this prepares LaunchRouter.swap with a price limit inside the launch range; after the launch completes it prepares a standard Router swap on the terminal pool. The slippage threshold comes from the router's quote at the stated block and bounds the fee-inclusive amount. ${HANDOFF}`,
    schema: prepareTradeSchema,
    handler: ((env, input, chainFactory = rpcChain) => launchpadPrepareTrade(env, input, chainFactory)) as PrepareTool["handler"],
  },
  {
    name: "launchpad_prepare_advance",
    title: "Prepare a launchpad advance or migration",
    description: `${PROTOTYPE} Anyone may move a launch forward. Prepares ScheduledLaunch.advance while the launch runs or after end_time, or LockedLaunchLiquidity.migrate when principal is still waiting after completion. ${HANDOFF}`,
    schema: prepareAdvanceSchema,
    handler: ((env, input, chainFactory = rpcChain) => launchpadPrepareAdvance(env, input, chainFactory)) as PrepareTool["handler"],
  },
];

export const launchpadPrepareCatalog = launchpadPrepareTools.map(({ name, title, description, schema }) => ({
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
