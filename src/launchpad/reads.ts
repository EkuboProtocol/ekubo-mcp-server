import { type Address, decodeFunctionResult, encodeFunctionData, getAddress, type Hex, keccak256, zeroAddress } from "viem";
import { z } from "zod";
import { type ApiLaunch, LaunchpadApi } from "./prepare/api.js";
import { type Deps, resolveDeps } from "./prepare/context.js";
import { ABI_REVISION, type PrepareEnv, type PrepareManifest, launchRouterAbi, prepareManifest, requireChain } from "./prepare/contracts.js";
import { feePercent, priceAtTick } from "./prepare/encoding.js";
import { selectedPoolId } from "./prepare/launch.js";
import { address, chainId } from "./prepare/schema.js";
import { PROTOTYPE_NOTE, UNTRUSTED_NOTE, prepareError } from "./prepare/templates.js";

/**
 * Read tools. Launch lists, state, stats and swaps come from the data API
 * over the production indexer; the only chain reads are the provenance checks
 * in launchpad_get_launch (the extension's code hash and the router's
 * recorded creator at one pinned block). Nothing here reads logs.
 */

const CACHE_TTL_SECONDS = { list: 60, detail: 10, stats: 60, swaps: 10 } as const;

const DOES_NOT_PROVE = [
  "who the people or organization behind any address are",
  "that the creator endorses or controls the token beyond claiming its creator fees",
  "that the name or symbol refers to any real project, brand or person",
  "that this is the first, original or official token with this name or symbol",
  "anything about future behavior of any address",
];

/** Verified against the code at this revision of evm-contracts (PR #380 head). */
const PRIVILEGES = {
  verified_at_revision: ABI_REVISION,
  supply: "fixed",
  mint_authority: "renounced",
  creator_powers: ["claim_creator_fees through LaunchRouter.claimFees"],
  principal_withdrawal: "none",
  upgrade: "none",
  pause: "none",
  initial_creator_allocation: "0",
  third_party_liquidity: "rejected",
};

const selector = {
  token: address.optional().describe("Exact launch token address."),
  pool_id: z
    .string()
    .regex(/^0x[0-9a-fA-F]{1,64}$/, "a 0x-prefixed pool id")
    .optional()
    .describe("The launch pool id, as returned by launchpad_list_launches. Pass token or pool_id."),
};

export const listLaunchesSchema = z.object({
  chain_id: chainId,
  status: z.enum(["upcoming", "live", "ended", "migrated"]).optional().describe("Derived by the api from its indexed head block time."),
  creator: address.optional().describe("Only launches LaunchRouter records as created by this account."),
  page: z.number().int().min(1).optional(),
  page_size: z.number().int().min(1).max(200).optional(),
});

export const getLaunchSchema = z.object({ chain_id: chainId, ...selector });
export const getStatsSchema = z.object({ chain_id: chainId, ...selector });
export const getSwapsSchema = z.object({
  chain_id: chainId,
  ...selector,
  cursor: z.string().regex(/^-?\d{1,20}$/).optional().describe("next_cursor from the previous page."),
  limit: z.number().int().min(1).max(100).optional(),
});

interface ReadContext {
  manifest: PrepareManifest;
  api: LaunchpadApi;
}

function readContext(env: PrepareEnv, chain: number, deps: Partial<Deps>): ReadContext {
  const manifest = prepareManifest(env);
  requireChain(manifest, chain);
  return { manifest, api: new LaunchpadApi(env, resolveDeps(deps).fetch) };
}

/** Only launches on the manifest's Core and ScheduledLaunch; any other row the api returns is dropped. */
function onManifest(manifest: PrepareManifest, launch: ApiLaunch): boolean {
  return launch.pool_key.extension === manifest.contracts.scheduled_launch && launch.pool_key.core_address === manifest.contracts.core;
}

function source(context: ReadContext, ttl: number) {
  return { kind: "ekubo_data_api", base_url: context.api.base, cache_ttl_seconds: ttl, log_reads: 0 };
}

function launchRow(launch: ApiLaunch) {
  const quoteDecimals = launch.quote_token.decimals;
  const price = (tick: number) => (quoteDecimals === null ? null : priceAtTick(tick, launch.launch_token.decimals, quoteDecimals));
  return {
    chain_id: Number(launch.chain_id),
    pool_id: launch.pool_id,
    token: launch.launch_token.address,
    quote_token: { address: launch.quote_token.address, decimals: quoteDecimals },
    status: launch.status,
    status_as_of: launch.status_as_of,
    status_basis: "the api's indexed head block time, not the wall clock",
    decimals: launch.launch_token.decimals,
    total_supply: launch.launch_token.total_supply,
    schedule: { start_time: launch.start_time, end_time: launch.end_time },
    fees: {
      initial: { q64: launch.initial_fee, percent: feePercent(BigInt(launch.initial_fee)) },
      final: { q64: launch.final_fee, percent: feePercent(BigInt(launch.final_fee)) },
    },
    range: { target_tick: launch.target_tick, upper_tick: launch.upper_tick, tick_spacing: launch.tick_spacing },
    migration_bounds: {
      tick_lower: launch.migration_tick_lower,
      tick_upper: launch.migration_tick_upper,
      price_lower: price(launch.migration_tick_lower),
      price_upper: price(launch.migration_tick_upper),
      unit: "quote per whole launch token",
    },
    released_deployed: launch.deployed,
    reserves: { reserve0: launch.reserve0, reserve1: launch.reserve1 },
    complete: launch.complete,
    creator: launch.creator,
    creator_basis: "LaunchRouter.LaunchCreatedBy as indexed; null when the launch was not created through LaunchRouter",
    created: { block_number: launch.created_block_number, transaction_hash: launch.created_transaction_hash, time: launch.created_time },
    metadata: { name: launch.launch_token.name, symbol: launch.launch_token.symbol, trust: "untrusted", note: UNTRUSTED_NOTE },
  };
}

export async function launchpadListLaunches(env: PrepareEnv, raw: z.input<typeof listLaunchesSchema>, deps: Partial<Deps> = {}) {
  const input = listLaunchesSchema.parse(raw);
  const context = readContext(env, input.chain_id, deps);
  const page = await context.api.list({
    chainId: input.chain_id,
    status: input.status,
    creator: input.creator === undefined ? undefined : getAddress(input.creator),
    page: input.page,
    pageSize: input.page_size,
  });
  return {
    prototype: PROTOTYPE_NOTE,
    launches: page.data.filter((launch) => onManifest(context.manifest, launch)).map(launchRow),
    pagination: page.pagination,
    order: "newest first",
    identity_note: "Identify a launch by chain and exact token address or pool id. Several launches can share a name or symbol.",
    source: source(context, CACHE_TTL_SECONDS.list),
  };
}

async function detailFor(context: ReadContext, chain: number, input: { token?: string; pool_id?: string }) {
  if (input.token === undefined && input.pool_id === undefined) throw prepareError("launch_not_found");
  const id = await selectedPoolId(context.api, chain, input);
  const detail = await context.api.detail(chain, id);
  if (detail === null || !onManifest(context.manifest, detail)) throw prepareError("launch_not_found");
  if (input.token !== undefined && getAddress(input.token) !== detail.launch_token.address) throw prepareError("launch_not_found");
  return detail;
}

/** The provenance chain reads: one block, the extension's code and the router's creator record. */
async function provenance(env: PrepareEnv, manifest: PrepareManifest, deps: Partial<Deps>, poolId: Hex, emitter: Address) {
  const chain = resolveDeps(deps).chain(env);
  const block = await chain.latest();
  const [code, creatorCall] = await Promise.all([
    chain.code(emitter, block),
    chain.call({
      from: zeroAddress,
      to: manifest.contracts.launch_router,
      data: encodeFunctionData({ abi: launchRouterAbi, functionName: "creator", args: [poolId] }),
      block,
    }),
  ]);
  const observed = code === "0x" ? null : keccak256(code);
  const creator = creatorCall.ok
    ? getAddress(decodeFunctionResult({ abi: launchRouterAbi, functionName: "creator", data: creatorCall.data }) as Address)
    : null;
  return { block, observed, creator: creator === zeroAddress ? null : creator, creatorReadOk: creatorCall.ok };
}

export async function launchpadGetLaunch(env: PrepareEnv, raw: z.input<typeof getLaunchSchema>, deps: Partial<Deps> = {}) {
  const input = getLaunchSchema.parse(raw);
  const context = readContext(env, input.chain_id, deps);
  const detail = await detailFor(context, input.chain_id, input);
  const chainReads = await provenance(env, context.manifest, deps, detail.pool_id, detail.pool_key.extension);
  const expected = context.manifest.code_hashes.scheduled_launch;
  const matches = chainReads.observed === expected;
  return {
    prototype: PROTOTYPE_NOTE,
    launch: {
      ...launchRow(detail),
      pool_state: detail.pool_state,
      latest_advance: detail.latest_advance,
      terminal: detail.terminal,
      creator_fees_claimed: detail.creator_fees_claimed,
    },
    provenance: {
      created: { block_number: detail.created_block_number, transaction_hash: detail.created_transaction_hash, time: detail.created_time },
      owner_of_record: detail.owner,
      owner_of_record_note: "LaunchCreated.owner. For a LaunchRouter launch it is the router; anyone can name the router as owner, so it proves nothing about who created the launch.",
      creator: chainReads.creator,
      creator_basis: "LaunchRouter.creator(pool_id) read from the manifest's LaunchRouter at as_of; the account that signed LaunchRouter.create and the only one that can claim creator fees",
      creator_indexed: detail.creator,
      creator_matches_index: chainReads.creatorReadOk ? chainReads.creator === detail.creator : null,
      emitting_contract: {
        address: detail.pool_key.extension,
        manifest_name: "scheduled_launch",
        address_matches_manifest: detail.pool_key.extension === context.manifest.contracts.scheduled_launch,
        manifest_code_hash: expected,
        observed_code_hash: chainReads.observed,
        code_hash_matches_manifest: matches,
      },
      does_not_prove: DOES_NOT_PROVE,
    },
    privileges: matches ? { ...PRIVILEGES, emitter_code_hash: chainReads.observed } : null,
    privileges_note: matches ? null : "privileges is null: the extension's code hash does not match the manifest, so the code they were read from is not established.",
    as_of: {
      chain_id: context.manifest.chain_id,
      block_number: chainReads.block.number.toString(),
      block_hash: chainReads.block.hash,
      block_timestamp: chainReads.block.timestamp.toString(),
      applies_to: "provenance chain reads; launch fields are as of the api's indexed head (status_as_of)",
    },
    source: source(context, CACHE_TTL_SECONDS.detail),
  };
}

export async function launchpadGetStats(env: PrepareEnv, raw: z.input<typeof getStatsSchema>, deps: Partial<Deps> = {}) {
  const input = getStatsSchema.parse(raw);
  const context = readContext(env, input.chain_id, deps);
  const detail = await detailFor(context, input.chain_id, input);
  const stats = await context.api.stats(input.chain_id, detail.pool_id);
  if (stats === null) throw prepareError("launch_not_found");
  return {
    prototype: PROTOTYPE_NOTE,
    token: detail.launch_token.address,
    quote_token: detail.quote_token.address,
    stats,
    counting_note: "distinct_lockers counts the contracts that forwarded swaps (usually a router), not people or wallets. Address counts are not counts of people.",
    source: source(context, CACHE_TTL_SECONDS.stats),
  };
}

export async function launchpadGetSwaps(env: PrepareEnv, raw: z.input<typeof getSwapsSchema>, deps: Partial<Deps> = {}) {
  const input = getSwapsSchema.parse(raw);
  const context = readContext(env, input.chain_id, deps);
  const detail = await detailFor(context, input.chain_id, input);
  const page = await context.api.swaps(input.chain_id, detail.pool_id, input.cursor, input.limit ?? 50);
  if (page === null) throw prepareError("launch_not_found");
  return {
    prototype: PROTOTYPE_NOTE,
    token: detail.launch_token.address,
    launch_token_is_token1: detail.launch_token_is_token1,
    ...page,
    delta_sign: "pool perspective, fee-inclusive: positive was paid into the pool",
    locker_note: "locker is the contract that forwarded the swap, usually a router, not the trader.",
    source: source(context, CACHE_TTL_SECONDS.swaps),
  };
}
