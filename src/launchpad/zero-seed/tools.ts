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
const listSchema = z.strictObject({ chain_id: chainId, creator: address.optional(), ...paging });
const launchSchema = z.strictObject({ chain_id: chainId, pool_id: poolId });
const historySchema = z.strictObject({ chain_id: chainId, pool_id: poolId, ...paging });
const createSchema = z.strictObject({ chain_id: chainId, sender: address, parameters: Parameters });
const claimSchema = z.strictObject({ chain_id: chainId, sender: address, pool_id: poolId, recipient: address });
const tradeSchema = z.strictObject({
  chain_id: chainId, sender: address, pool_id: poolId, side: z.enum(["buy", "sell"]),
  amount: decimal.describe("Exact input amount in base units"),
  slippage_bps: z.number().int().min(1).max(10_000),
});

const HOLD =
  "Zero-seed launchpad, support disabled: no launch instance is supported on any hosted or live chain, so this tool fails closed.";

/** Only the empty live pin list reaches the hosted server; there is no local-harness switch here. */
function api(env: LaunchpadEnv): ZeroSeedApi {
  const base = env.LAUNCHPAD_API_URL || env.EKUBO_API_URL;
  if (!base) throw new ZeroSeedError("launchpad_not_configured");
  return new ZeroSeedApi(base, fetch);
}

/** The hosted producer is not wired: it refuses even if a live pin were ever added. */
const live = (chain: string) => LIVE_INSTANCE_PINS.some((pin) => pin.chainId === chain);

/** Support is checked before configuration, so a disabled chain never reaches the API. */
function hosted(env: LaunchpadEnv, chain: string): ZeroSeedApi {
  if (!live(chain)) throw new ZeroSeedError("launch_support_disabled");
  return api(env);
}

function disabled(): never {
  throw new ZeroSeedError("launch_support_disabled");
}

async function listLaunches(env: LaunchpadEnv, input: z.input<typeof listSchema>) {
  const { chain_id: chain, ...page } = listSchema.parse(input);
  if (!live(chain)) {
    return { data: [], next_cursor: null, launch_support: "disabled" };
  }
  return hosted(env, chain).list(chain, page);
}

async function getLaunch(env: LaunchpadEnv, input: z.input<typeof launchSchema>) {
  const { chain_id: chain, pool_id: id } = launchSchema.parse(input);
  return hosted(env, chain).detail(chain, id as `0x${string}`);
}

async function getSwaps(env: LaunchpadEnv, input: z.input<typeof historySchema>) {
  const { chain_id: chain, pool_id: id, ...page } = historySchema.parse(input);
  return hosted(env, chain).swaps(chain, id as `0x${string}`, page);
}

async function getClaims(env: LaunchpadEnv, input: z.input<typeof historySchema>) {
  const { chain_id: chain, pool_id: id, ...page } = historySchema.parse(input);
  return hosted(env, chain).claims(chain, id as `0x${string}`, page);
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
  tool("launchpad_get_claims", "List zero-seed creator-fee claims",
    `${HOLD} Refuses with launch_support_disabled.`, historySchema, getClaims),
  tool("launchpad_prepare_create", "Prepare a zero-seed launch",
    `${HOLD} Refuses with launch_support_disabled; returns no plan or reference.`, createSchema, prepareCreate),
  tool("launchpad_prepare_claim_fees", "Prepare a zero-seed creator-fee claim",
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

/** Resources served only on the launchpad endpoint. */
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
