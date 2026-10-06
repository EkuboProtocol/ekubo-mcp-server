import { describe, expect, it } from "bun:test";
import { keccak256 } from "viem";
import { TOKEN_LOOKUP_MAX_PAGES } from "../../src/launchpad/prepare/api.js";
import { launchpadGetLaunch, launchpadGetStats, launchpadGetSwaps, launchpadListLaunches } from "../../src/launchpad/reads.js";
import { API_URL, apiDetail, C, CODE, env, failure, harness, type Json, launchFixture, launchPoolId, OTHER, SENDER, TOKEN } from "./fake.js";

describe("launchpad_list_launches", () => {
  it("returns the api's launches on the manifest's extension, with untrusted metadata kept apart", async () => {
    const { deps, services, chain } = harness();
    services.details.set("0x01", apiDetail(launchFixture(), { pool_id: "0x01", pool_key: { ...apiDetail(launchFixture()).pool_key, extension: OTHER.toLowerCase() } }));
    const result: Json = await launchpadListLaunches(env(), { chain_id: 1, creator: SENDER, page_size: 20 }, deps);
    expect(services.requests).toEqual([`${API_URL}/launches?chainId=1&creator=${SENDER}&pageSize=20`]);
    expect(result.launches).toHaveLength(1);
    expect(result.launches[0]).toMatchObject({
      pool_id: launchPoolId(),
      token: TOKEN,
      status: "live",
      creator: SENDER,
      metadata: { name: "Untrusted", symbol: "UNT", trust: "untrusted" },
    });
    expect(result.source).toEqual({ kind: "ekubo_data_api", base_url: API_URL, cache_ttl_seconds: 60, log_reads: 0 });
    expect(chain.methods).toEqual({});
  });
});

describe("launchpad_get_launch", () => {
  it("joins the api detail with provenance read at one block: extension code hash and the router's creator", async () => {
    const { deps, chain } = harness();
    const result: Json = await launchpadGetLaunch(env(), { chain_id: 1, token: TOKEN }, deps);
    expect(result.provenance).toMatchObject({
      owner_of_record: C.launch_router,
      creator: SENDER,
      creator_indexed: SENDER,
      creator_matches_index: true,
      emitting_contract: {
        address: C.scheduled_launch,
        address_matches_manifest: true,
        manifest_code_hash: keccak256(CODE.scheduled_launch),
        observed_code_hash: keccak256(CODE.scheduled_launch),
        code_hash_matches_manifest: true,
      },
    });
    expect(result.privileges).toMatchObject({ verified_at_revision: "40e5bb11f7d4a8b40bb40232027fa7888052eacb", third_party_liquidity: "rejected" });
    expect(chain.methods).toEqual({ eth_getBlockByNumber: 1, eth_getCode: 1, eth_call: 1 });
  });

  it("withholds privileges when the extension's code hash differs from the manifest", async () => {
    const { deps, chain } = harness();
    chain.codes[C.scheduled_launch] = "0x6000";
    const result: Json = await launchpadGetLaunch(env(), { chain_id: 1, pool_id: launchPoolId() }, deps);
    expect(result.provenance.emitting_contract.code_hash_matches_manifest).toBe(false);
    expect(result.privileges).toBeNull();
  });

  it("finds a launch by token by paging the list, up to a fixed page limit", async () => {
    const { deps, services } = harness();
    await launchpadGetLaunch(env(), { chain_id: 1, token: TOKEN }, deps);
    expect(services.requests[0]).toBe(`${API_URL}/launches?chainId=1&page=1&pageSize=200`);
    expect(services.requests[1]).toBe(`${API_URL}/launches/1/${launchPoolId()}`);
    const missing = harness();
    expect(await failure(() => launchpadGetLaunch(env(), { chain_id: 1, token: OTHER }, missing.deps))).toMatchObject({
      code: "launch_not_found",
      details: { lookup_page_limit: TOKEN_LOOKUP_MAX_PAGES },
    });
  });
});

describe("launchpad_get_stats and launchpad_get_swaps", () => {
  it("pass the api's figures through with their attribution, with no chain reads", async () => {
    const { deps, chain, services } = harness();
    const stats: Json = await launchpadGetStats(env(), { chain_id: 1, pool_id: launchPoolId() }, deps);
    expect(stats.stats.swaps.distinct_transaction_senders).toBeNull();
    expect(stats.counting_note).toContain("not counts of people");
    const swaps: Json = await launchpadGetSwaps(env(), { chain_id: 1, pool_id: launchPoolId(), limit: 10 }, deps);
    expect(swaps).toMatchObject({ swaps: [], has_more: false, next_cursor: null });
    expect(services.requests.at(-1)).toBe(`${API_URL}/launches/1/${launchPoolId()}/swaps?limit=10`);
    expect(chain.methods).toEqual({});
  });

  it("refuses another chain and an api row that fails the documented shape", async () => {
    const { deps, services } = harness();
    expect((await failure(() => launchpadGetStats(env(), { chain_id: 8453, pool_id: launchPoolId() }, deps))).code).toBe("unsupported_chain");
    services.details.get(launchPoolId())!.start_time = "soon";
    expect(await failure(() => launchpadGetStats(env(), { chain_id: 1, pool_id: launchPoolId() }, deps))).toMatchObject({
      code: "api_invalid_response",
      details: { field: "start_time" },
    });
  });
});
