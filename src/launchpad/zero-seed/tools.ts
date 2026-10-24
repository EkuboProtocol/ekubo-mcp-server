import type { Hex } from "viem";
import { z } from "zod";
import { ZeroSeedApi } from "./api.js";
import { disclosuresDocument } from "./disclosures.js";
import { address, bytes32, decimal, Parameters } from "./installation.js";
import { LIVE_INSTANCE_PINS, refuseExecutableUse, ZeroSeedError } from "./policy.js";

export interface LaunchpadEnv {
  /** The Ekubo data API serving `/launches`. Falls back to EKUBO_API_URL. */
  LAUNCHPAD_API_URL?: string;
  EKUBO_API_URL?: string;
}

export interface LaunchpadTool {
  name: string;
  title: string;
  description: string;
  schema: z.ZodObject;
  handler: (env: LaunchpadEnv, input: never) => Promise<unknown>;
}

const chainId = decimal.describe("EVM chain id, decimal string");
const poolId = bytes32.describe("Exact launch pool id (lowercase 0x-prefixed 32 bytes)");
const paging = {
  cursor: z.string().regex(/^(0|-?[1-9][0-9]*)$/).optional().describe("Event-id cursor from next_cursor"),
  limit: z.number().int().min(1).max(200).optional(),
};
const listSchema = z.strictObject({ chain_id: chainId, owner: address.optional().describe("Current launch owner"), ...paging });
const launchSchema = z.strictObject({ chain_id: chainId, pool_id: poolId });
const historySchema = z.strictObject({ chain_id: chainId, pool_id: poolId, ...paging });
const createSchema = z.strictObject({
  chain_id: chainId, sender: address.describe("Calls the periphery and becomes the launch owner"), parameters: Parameters,
});
const claimSchema = z.strictObject({ chain_id: chainId, sender: address, pool_id: poolId, recipient: address });
const tradeSchema = z.strictObject({
  chain_id: chainId, sender: address, pool_id: poolId, side: z.enum(["buy", "sell"]),
  amount: decimal.describe("Exact input amount in base units"),
  slippage_bps: z.number().int().min(1).max(10_000),
});

const HOLD =
  "Zero-seed launchpad, support disabled: no launch instance is supported on any hosted or live chain, so this tool fails closed.";

/** Live support needs a live pin; there is none, so a hosted read never reaches the API. */
const live = (chain: string) => LIVE_INSTANCE_PINS.some((pin) => pin.chainId === chain);

/** Support is checked before configuration, so a disabled chain never reaches the API. */
function hosted(env: LaunchpadEnv, chain: string): ZeroSeedApi {
  if (!live(chain)) throw new ZeroSeedError("launch_support_disabled");
  const base = env.LAUNCHPAD_API_URL || env.EKUBO_API_URL;
  if (!base) throw new ZeroSeedError("launchpad_not_configured");
  return new ZeroSeedApi(base, fetch);
}

function disabled(): never {
  throw new ZeroSeedError("launch_support_disabled");
}

async function listLaunches(env: LaunchpadEnv, input: z.input<typeof listSchema>) {
  const { chain_id: chain, owner, ...page } = listSchema.parse(input);
  if (!live(chain)) {
    return { data: [], next_cursor: null, launch_support: "disabled" };
  }
  return hosted(env, chain).list(chain, { ...page, owner });
}

async function getLaunch(env: LaunchpadEnv, input: z.input<typeof launchSchema>) {
  const { chain_id: chain, pool_id: id } = launchSchema.parse(input);
  return hosted(env, chain).detail(chain, id as Hex);
}

async function getSwaps(env: LaunchpadEnv, input: z.input<typeof historySchema>) {
  const { chain_id: chain, pool_id: id, ...page } = historySchema.parse(input);
  return hosted(env, chain).swaps(chain, id as Hex, page);
}

async function getClaims(env: LaunchpadEnv, input: z.input<typeof historySchema>) {
  const { chain_id: chain, pool_id: id, ...page } = historySchema.parse(input);
  return hosted(env, chain).claims(chain, id as Hex, page);
}

async function getOwners(env: LaunchpadEnv, input: z.input<typeof historySchema>) {
  const { chain_id: chain, pool_id: id, ...page } = historySchema.parse(input);
  return hosted(env, chain).owners(chain, id as Hex, page);
}

async function prepareCreate(_env: LaunchpadEnv, input: z.input<typeof createSchema>) {
  createSchema.parse(input);
  return disabled();
}

async function prepareClaim(_env: LaunchpadEnv, input: z.input<typeof claimSchema>) {
  claimSchema.parse(input);
  return disabled();
}

/** The accepted quoter gas estimate is not an execution budget; executable swaps stay refused. */
async function prepareTrade(_env: LaunchpadEnv, input: z.input<typeof tradeSchema>) {
  tradeSchema.parse(input);
  return refuseExecutableUse();
}

const tool = <T extends z.ZodObject>(
  name: string,
  title: string,
  description: string,
  schema: T,
  handler: (env: LaunchpadEnv, input: z.input<T>) => Promise<unknown>,
): LaunchpadTool => ({ name, title, description, schema, handler: handler as LaunchpadTool["handler"] });

export const launchpadTools: LaunchpadTool[] = [
  tool("launchpad_list_launches", "List zero-seed launches",
    `${HOLD} Returns an empty list with launch_support "disabled" and makes no request. Names and symbols are untrusted metadata, never identity.`,
    listSchema, listLaunches),
  tool("launchpad_get_launch", "Get a zero-seed launch",
    `${HOLD} Refuses with launch_support_disabled. Exact chain and pool id only, never names or symbols.`,
    launchSchema, getLaunch),
  tool("launchpad_get_swaps", "List zero-seed launch swaps",
    `${HOLD} Refuses with launch_support_disabled.`, historySchema, getSwaps),
  tool("launchpad_get_claims", "List zero-seed launch fee claims",
    `${HOLD} Refuses with launch_support_disabled.`, historySchema, getClaims),
  tool("launchpad_get_owners", "List zero-seed launch owners",
    `${HOLD} Refuses with launch_support_disabled. The creation owner, then every ownership transfer.`, historySchema, getOwners),
  tool("launchpad_prepare_create", "Prepare a zero-seed launch",
    `${HOLD} Refuses with launch_support_disabled; returns no plan or reference.`, createSchema, prepareCreate),
  tool("launchpad_prepare_claim_fees", "Prepare a zero-seed launch fee claim",
    `${HOLD} Refuses with launch_support_disabled; returns no plan or reference.`, claimSchema, prepareClaim),
  tool("launchpad_prepare_trade", "Prepare a zero-seed launch trade",
    `${HOLD} Refuses with executable_budget_not_proven: a quoter gas estimate is not an execution budget. Returns no plan or reference.`,
    tradeSchema, prepareTrade),
];

export const launchpadCatalog = launchpadTools.map(({ name, title, description, schema }) => ({
  name,
  title,
  description,
  inputSchema: z.toJSONSchema(schema, { io: "input" }),
}));

const page = z.looseObject({ data: z.array(z.unknown()), next_cursor: z.string().nullable() });
const refusalOnly = z.looseObject({});

/** Result shapes; the refusing tools never return a plan or reference. */
export const launchpadOutputSchemas: Readonly<Record<string, z.ZodObject>> = {
  launchpad_list_launches: page.extend({ launch_support: z.literal("disabled").optional() }),
  launchpad_get_launch: z.looseObject({ chain_id: z.string(), pool_id: z.string() }),
  launchpad_get_swaps: page,
  launchpad_get_claims: page,
  launchpad_get_owners: page,
  launchpad_prepare_create: refusalOnly,
  launchpad_prepare_claim_fees: refusalOnly,
  launchpad_prepare_trade: refusalOnly,
};

/** Resources served with the Ekubo Protocol tools. */
export const launchpadResources = [
  {
    name: "launchpad-disclosures",
    uri: "launchpad://disclosures",
    title: "Ekubo zero-seed launchpad mechanism disclosures (draft, not approved)",
    description: "Versioned mechanism facts that every owner summary carries.",
    mimeType: "application/json",
    text: () => JSON.stringify(disclosuresDocument()),
  },
] as const;
