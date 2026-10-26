import { z } from "zod";
import { type CreateInput, prepareCreate, previewLaunch } from "./create.js";
import type { LaunchpadEnv } from "./deployment.js";
import { type ClaimInput, prepareClaimFees, prepareTransferLaunch, type TransferInput } from "./owner.js";
import { getLaunchDetail, launchHistory, listLaunches } from "./reads.js";
import { prepareTrade, type TradeInput } from "./trade.js";

export type { LaunchpadEnv } from "./deployment.js";

export interface LaunchpadTool {
  name: string;
  title: string;
  description: string;
  schema: z.ZodObject;
  handler: (env: LaunchpadEnv, input: never) => Promise<unknown>;
}

const chainId = z.string().regex(/^[1-9][0-9]*$/).describe("EVM chain id");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const poolId = z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("Launch pool id");
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const cursor = (pattern: RegExp) => z.string().regex(pattern).optional().describe("next_cursor of the previous page");
const sender = address.describe("Wallet that sends the transaction");

const listSchema = z.strictObject({
  chain_id: chainId.optional().describe("EVM chain id; omit for every configured chain"),
  status: z.enum(["all", "trading", "upcoming"]).optional().describe("Default all"),
  owner: address.optional().describe("Only launches this address currently owns (\"mine\")"),
  creator: address.optional().describe("Only launches this address created"),
  sort: z.enum(["newest", "market_cap_usd", "volume", "sold_share", "trade_count"]).optional()
    .describe("Default newest; descending. market_cap_usd, volume: USD-priced first, then by quote amount"),
  cursor: cursor(/^(0|[1-9][0-9]{0,5})$/),
  limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
});
const launchSchema = z.strictObject({ chain_id: chainId, pool_id: poolId });
const historySchema = launchSchema.extend({ cursor: cursor(/^(0|-?[1-9][0-9]{0,18})$/), limit: z.number().int().min(1).max(200).optional().describe("Default 50") });

const createFields = {
  chain_id: chainId,
  sender: sender.describe("Creator; becomes the launch owner"),
  name: z.string().describe("1-31 UTF-8 bytes"),
  symbol: z.string().describe("1-31 UTF-8 bytes"),
  total_supply: z.string().describe("Whole tokens (18 decimals), up to 1000000000000"),
  quote_token: address.optional().describe("Default zero address = native token"),
  start_price: z.string().optional().describe("Quote tokens per launch token at the first sale"),
  upper_price: z.string().optional().describe("Price at which the supply sells out"),
  ask_tick: z.number().int().optional().describe("Instead of prices: economic tick, log base 1.000001 of raw quote per raw token"),
  upper_tick: z.number().int().optional(),
  trading_start: decimal.describe("Unix seconds, 5 min to 24 h after the latest block"),
  initial_fee_percent: z.string().optional().describe("Creator fee at start, percent; default 50"),
  final_fee_percent: z.string().optional().describe("Floor the fee decays toward, percent; default 0.3"),
  half_life_seconds: z.string().optional().describe("Half-life of the fee excess; default 86400"),
  salt: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
};
const previewSchema = z.strictObject({ ...createFields, salt: createFields.salt.describe("Default random") });
const createSchema = z.strictObject({
  ...createFields,
  salt: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("parameters.salt from the preview"),
  preview_id: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("From launchpad_preview_launch"),
  logo_url: z.string().max(2048).optional().describe("Optional https:// or ipfs:// logo; emitted, never stored"),
});
const tradeSchema = z.strictObject({
  chain_id: chainId, sender, pool_id: poolId,
  side: z.enum(["buy", "sell"]).describe("buy spends the quote token, sell spends the launch token"),
  amount: decimal.describe("Exact input, base units of the token spent"),
  slippage_bps: z.number().int().min(0).max(5000).optional().describe("Default 50"),
  deadline_minutes: z.number().int().min(1).max(30).optional().describe("Default 30"),
  recipient: address.optional().describe("Default sender"),
});
const claimSchema = z.strictObject({
  chain_id: chainId, sender: sender.describe("Current launch owner"), pool_id: poolId,
  recipient: address.optional().describe("Default sender"),
});
const transferSchema = z.strictObject({
  chain_id: chainId, sender: sender.describe("Current launch owner"), pool_id: poolId,
  new_owner: address.describe("Receives ownership and every fee right, accrued fees included"),
});

const PLAN = "Returns a summary and execution_plan_reference: pass it unchanged to the wallet to simulate and authorize.";
const REVIEW = `${PLAN} Also owner_review for the wallet.`;

const tool = <T extends z.ZodObject>(
  name: string, title: string, description: string, schema: T,
  handler: (env: LaunchpadEnv, input: z.infer<T>) => Promise<unknown>,
): LaunchpadTool => ({ name, title, description, schema, handler: handler as LaunchpadTool["handler"] });

export const launchpadTools: LaunchpadTool[] = [
  tool("launchpad_list_launches", "List zero-seed launches",
    "List token launches across configured chains; filter by status, current owner or creator. Rows: pool_id, token, quote_token, owner, logo_url, parameters, range, status, market. aggregates spans all matches: per-quote raw volume and market cap; USD sums priced launches only.",
    listSchema, listLaunches),
  tool("launchpad_get_launch", "Get a zero-seed launch",
    "One launch with on-chain owner, controller, current creator fee at the latest block, fee schedule and curve, unclaimed fees and market data.",
    launchSchema, getLaunchDetail),
  tool("launchpad_get_swaps", "List launch swaps", "Swaps of one launch, oldest first, paged.", historySchema,
    (env, input) => launchHistory(env, "swaps", input)),
  tool("launchpad_get_claims", "List launch fee claims", "Creator fee claims of one launch, one row per claim, oldest first, paged, with claimed totals.", historySchema,
    (env, input) => launchHistory(env, "claims", input)),
  tool("launchpad_get_owners", "List launch owners", "Ownership history of one launch: creation, then every transfer, paged.", historySchema,
    (env, input) => launchHistory(env, "owners", input)),
  tool("launchpad_preview_launch", "Preview a token launch",
    "Step 1 of creating a token: validates the launch, derives the tick range and spacing, and returns the contract's installation preview, fee curve and preview_id. No quote deposit; supply sells along the range. Then call launchpad_prepare_create.",
    previewSchema, (env, input) => previewLaunch(env, input as CreateInput)),
  tool("launchpad_prepare_create", "Prepare a token launch",
    `Step 2: the same arguments as the preview plus its salt and preview_id; refuses if the launch no longer matches the preview. ${REVIEW}`,
    createSchema, (env, input) => prepareCreate(env, input as CreateInput)),
  tool("launchpad_prepare_trade", "Prepare a launch trade",
    `Exact-input buy or sell of a launch token through the router, quoted at the latest block including the creator fee, with a minimum output and deadline; adds an ERC-20 approval when needed. ${PLAN}`,
    tradeSchema, (env, input) => prepareTrade(env, input as TradeInput)),
  tool("launchpad_prepare_claim_fees", "Prepare a launch fee claim",
    `Owner only: claim all unclaimed creator fees of a launch, both tokens. ${REVIEW}`,
    claimSchema, (env, input) => prepareClaimFees(env, input as ClaimInput)),
  tool("launchpad_prepare_transfer_launch", "Prepare a launch ownership transfer",
    `Owner only: transfer a launch and all its fee rights to a new owner. ${REVIEW}`,
    transferSchema, (env, input) => prepareTransferLaunch(env, input as TransferInput)),
];

export const launchpadCatalog = launchpadTools.map(({ name, title, description, schema }) => ({
  name, title, description, inputSchema: z.toJSONSchema(schema, { io: "input" }),
}));

const plan = z.looseObject({ action: z.string(), details: z.looseObject({ summary: z.string() }), execution_plan_reference: z.looseObject({}) });
const page = (key: string) => z.looseObject({ [key]: z.array(z.unknown()), next_cursor: z.string().nullable() });

export const launchpadOutputSchemas: Readonly<Record<string, z.ZodObject>> = {
  launchpad_list_launches: page("launches").extend({ aggregates: z.looseObject({}) }),
  launchpad_get_launch: z.looseObject({ launch: z.looseObject({}), onchain: z.looseObject({}) }),
  launchpad_get_swaps: page("swaps"),
  launchpad_get_claims: page("claims"),
  launchpad_get_owners: page("owners"),
  launchpad_preview_launch: z.looseObject({ preview_id: z.string(), installation: z.looseObject({}) }),
  launchpad_prepare_create: plan,
  launchpad_prepare_trade: plan,
  launchpad_prepare_claim_fees: plan,
  launchpad_prepare_transfer_launch: plan,
};
