import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import { z } from "zod";
import { ZeroSeedApi } from "../../src/launchpad/zero-seed/api.js";
import { feeAt, feePhase } from "../../src/launchpad/zero-seed/fee.js";
import { BACKEND_REPLAY_PINS, LOCAL_INSTANCE_PINS } from "../../src/launchpad/zero-seed/policy.js";
import { ClaimPage, LaunchDetail, LaunchList, OwnerPage, SwapPage } from "../../src/launchpad/zero-seed/schema.js";
import golden from "../fixtures/launchpad/zero-seed-api-v3-2429547.golden.json";
import openapi from "../fixtures/launchpad/zero-seed-api-v3-2429547.openapi-launches.json";

// The backend's API v3 golden: actual handler output over the indexer's replayed local chain (api 2429547, the
// final head of api #191; the backend owner confirmed it unchanged in the final report). Byte-identical copy.
const GOLDEN_SHA256 = "edb0a36f9c8fe22b346b2c88223bc12987abfc81e38ca2214dbd13194d0ca516";
// `/launches*` paths of openapi.json at the same head (whole file sha256 ee4a41d1…fb56), extracted with
// json.dumps({openapi, paths}, indent=1, sort_keys=True).
const OPENAPI_SHA256 = "b0d54b5cf714984860e9ed8162a792d33b85b82de2a85d39b816654568cd3a64";

type Json = any;
const CHAIN = "31337";
const local = { localHarness: true, instances: BACKEND_REPLAY_PINS };
const sha256 = (path: string) => createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex");

function client(reply: (url: URL) => Json, seen: URL[] = [], instances = local) {
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    const url = new URL(String(input));
    seen.push(url);
    const body = reply(url);
    return body === undefined ? new Response("{}", { status: 404 }) : Response.json(body);
  }) as typeof fetch;
  return new ZeroSeedApi("https://synthetic.invalid", fetcher, instances);
}

const g = golden as Json;
const pages: Record<string, Record<string, Json>> = {
  [g.nativeDetail.pool_id]: { detail: g.nativeDetail, swaps: g.nativeSwaps, claims: g.nativeClaims, owners: g.nativeOwners },
  [g.erc20Detail.pool_id]: { detail: g.erc20Detail, claims: g.erc20Claims, owners: g.erc20Owners },
};
/** Serves the golden by path. The block-9 list pages answer the paged reads; the head list the rest. */
function routes(url: URL): Json {
  if (url.pathname === "/launches") {
    if (url.searchParams.get("limit") === "1") return url.searchParams.has("before_event_id") ? g.second : g.list;
    return g.canonicalList;
  }
  const [, , chain, pool, kind] = url.pathname.split("/");
  expect(chain).toBe(CHAIN);
  return pages[pool]?.[kind ?? "detail"];
}
const tamper = (body: Json, change: (copy: Json) => void) => {
  const copy = structuredClone(body);
  change(copy);
  return copy;
};
const scheduleOf = (fee: Json) => ({ tradingStart: BigInt(fee.trading_start), feeDuration: BigInt(fee.fee_duration),
  initialFee: BigInt(fee.initial_fee), finalFee: BigInt(fee.final_fee) });
const nativeId = g.nativeDetail.pool_id as Hex;
const erc20Id = g.erc20Detail.pool_id as Hex;

/** JSON Schema forms that differ only in spelling between zod and the API's generator. */
const SAFE_BOUND: Record<string, number> = { maximum: Number.MAX_SAFE_INTEGER, minimum: Number.MIN_SAFE_INTEGER };
function normalizeEntry(out: Json, key: string, value: Json): void {
  if (key === "$schema" || SAFE_BOUND[key] === value) return;
  if (key === "const") out.enum = [value];
  else if (key === "required") out.required = [...(value as string[])].sort();
  else out[key] = normalize(value);
}
function unwrapNullable(out: Json): Json {
  const nullable = out.anyOf?.length === 2 && out.anyOf.some((s: Json) => s.type === "null");
  if (!nullable) return out;
  const { type, ...rest } = out.anyOf.find((s: Json) => s.type !== "null");
  delete out.anyOf;
  return Object.assign(out, rest, { type: [type, "null"] });
}
function normalize(schema: Json): Json {
  if (Array.isArray(schema)) return schema.map(normalize);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Json = {};
  for (const [key, value] of Object.entries(schema)) normalizeEntry(out, key, value);
  return unwrapNullable(out);
}

describe("API v3 contract: the backend's final golden and OpenAPI", () => {
  test("fixtures are the published bytes", () => {
    expect(sha256("../fixtures/launchpad/zero-seed-api-v3-2429547.golden.json")).toBe(GOLDEN_SHA256);
    expect(sha256("../fixtures/launchpad/zero-seed-api-v3-2429547.openapi-launches.json")).toBe(OPENAPI_SHA256);
    expect(g.schema_version).toBe("zero-seed-launch-api/v3");
  });

  const responses: [string, z.ZodType][] = [
    ["/launches", LaunchList], ["/launches/{chainId}/{poolId}", LaunchDetail],
    ["/launches/{chainId}/{poolId}/swaps", SwapPage], ["/launches/{chainId}/{poolId}/claims", ClaimPage],
    ["/launches/{chainId}/{poolId}/owners", OwnerPage],
  ];
  for (const [path, schema] of responses) {
    test(`${path}: the consumed schema equals the published response schema`, () => {
      const published = (openapi as Json).paths[path].get.responses["200"].content["application/json"].schema;
      expect(normalize(z.toJSONSchema(schema))).toEqual(normalize(published));
    });
  }

  test("every query parameter the client sends is published", async () => {
    const seen: URL[] = [];
    const api = client(routes, seen);
    await api.list(CHAIN, { limit: 1 });
    await api.list(CHAIN, { limit: 1, cursor: g.list.next_cursor });
    await api.list(CHAIN, { owner: g.nativeDetail.owner, creator: g.nativeDetail.creator }).catch(() => undefined);
    for (const kind of ["swaps", "claims", "owners"] as const) await api[kind](CHAIN, nativeId, { cursor: "-1" }).catch(() => undefined);
    for (const url of seen) {
      const template = url.pathname === "/launches" ? "/launches"
        : `/launches/{chainId}/{poolId}${url.pathname.split("/").length > 4 ? `/${url.pathname.split("/")[4]}` : ""}`;
      const published = ((openapi as Json).paths[template].get.parameters as Json[]).filter((p) => p.in === "query").map((p) => p.name);
      for (const key of url.searchParams.keys()) expect(published).toContain(key);
    }
    expect(new Set(seen.flatMap((url) => [...url.searchParams.keys()]))).toEqual(
      new Set(["chainId", "limit", "before_event_id", "owner", "creator", "after_event_id"]));
  });
});

describe("API v3 replay through the MCP client (backend replay chain pins)", () => {
  test("pages the block-9 list with before_event_id and returns the head list unchanged", async () => {
    const seen: URL[] = [];
    const api = client(routes, seen);
    const first = await api.list(CHAIN, { limit: 1 });
    expect(first).toEqual(g.list);
    expect(await api.list(CHAIN, { limit: 1, cursor: first.next_cursor! })).toEqual(g.second);
    expect(await api.list(CHAIN)).toEqual(g.canonicalList);
    expect(seen.map((u) => `${u.pathname}?${u.searchParams}`)).toEqual([
      "/launches?chainId=31337&limit=1", `/launches?chainId=31337&limit=1&before_event_id=${g.list.next_cursor}`,
      "/launches?chainId=31337&limit=50",
    ]);
  });

  test("details, swaps, claims and owners validate unchanged for the native and the ERC-20 launch", async () => {
    const seen: URL[] = [];
    const api = client(routes, seen);
    expect(await api.detail(CHAIN, nativeId)).toEqual(g.nativeDetail);
    expect(await api.detail(CHAIN, erc20Id)).toEqual(g.erc20Detail);
    expect(await api.swaps(CHAIN, nativeId)).toEqual(g.nativeSwaps);
    expect(await api.claims(CHAIN, nativeId)).toEqual(g.nativeClaims);
    expect(await api.claims(CHAIN, erc20Id)).toEqual(g.erc20Claims);
    expect(await api.owners(CHAIN, nativeId)).toEqual(g.nativeOwners);
    expect(await api.owners(CHAIN, erc20Id)).toEqual(g.erc20Owners);
    expect(seen.map((u) => u.pathname)).toContain(`/launches/31337/${nativeId}/owners`);
  });

  test("quote kind: native ETH is address(0), token0, 18 decimals, no metadata; the ERC-20 is the pinned quote", () => {
    expect(g.nativeDetail.quote_token).toEqual({
      address: "0x0000000000000000000000000000000000000000", name: null, symbol: null, decimals: 18, kind: "native" });
    expect(g.nativeDetail.pool_key.token0).toBe(g.nativeDetail.quote_token.address);
    expect(g.nativeDetail.launch_token_is_token1).toBe(true);
    expect(g.erc20Detail.quote_token).toMatchObject({ address: BACKEND_REPLAY_PINS[1].quote, kind: "erc20" });
    expect(g.erc20Detail.launch_token_is_token1).toBe(false);
  });

  test("every served fee_rate and phase equals the fixed-base table at evaluated_at (600 s half-life)", () => {
    const rows = [g.list, g.second, g.canonicalList].flatMap((list) => list.data).concat([g.nativeDetail, g.erc20Detail]);
    const phases = new Set<string>();
    for (const row of rows) {
      const fee = row.fee_schedule;
      expect(fee.decay).toEqual({ kind: "fixed_base_q128", half_life_seconds: 600 });
      expect(feeAt(scheduleOf(fee), BigInt(fee.evaluated_at)).toString()).toBe(fee.fee_rate);
      expect(feePhase(scheduleOf(fee), BigInt(fee.evaluated_at))).toBe(fee.phase);
      phases.add(fee.phase);
    }
    expect(phases).toEqual(new Set(["fee_decay", "final_fee"]));
  });

  test("creator, owner and controller are distinct roles; the current owner holds the transferable ledger", () => {
    const d = g.nativeDetail;
    expect(d.controller).toBe(BACKEND_REPLAY_PINS[0].periphery);
    expect(d.creator).toBe(g.nativeOwners.data[0].new_owner);
    expect(g.nativeOwners.data[0].previous_owner).toBeNull();
    expect(d.owner).toBe(g.nativeOwners.data.at(-1).new_owner);
    expect(d.creator).not.toBe(d.owner);
    expect(d.fee_ledger).toMatchObject({ holder: d.owner, transferable: true, owner_change_count: g.nativeOwners.data.length });
  });

  test("claims are single-counted payouts by the owner of the moment", () => {
    for (const [detail, claims, owners] of [[g.nativeDetail, g.nativeClaims, g.nativeOwners], [g.erc20Detail, g.erc20Claims, g.erc20Owners]]) {
      const ownerAt = (id: bigint) => owners.data.filter((o: Json) => BigInt(o.event.event_id) < id).at(-1).new_owner;
      for (const claim of claims.data) expect(claim.owner).toBe(ownerAt(BigInt(claim.event.event_id)));
      const sum = (key: string) => claims.data.reduce((total: bigint, c: Json) => total + BigInt(c[key]), 0n).toString();
      expect([sum("launch_token_amount"), sum("quote_token_amount")])
        .toEqual([detail.fee_ledger.launch_token.claimed, detail.fee_ledger.quote_token.claimed]);
    }
    // A claim recorded by an earlier owner (the creator) and one after two transfers.
    expect(new Set(g.nativeClaims.data.map((c: Json) => c.owner)).size).toBe(2);
  });

  test("owner= filter: sent as the query and re-checked on every row", async () => {
    const owner = g.canonicalList.data[1].owner;
    const filtered = { ...g.canonicalList, data: g.canonicalList.data.filter((row: Json) => row.owner === owner) };
    const seen: URL[] = [];
    expect(await client(() => filtered, seen).list(CHAIN, { owner })).toEqual(filtered);
    expect(seen[0].searchParams.get("owner")).toBe(owner);
    await expect(client(() => g.canonicalList).list(CHAIN, { owner })).rejects.toThrow("api_filter_mismatch");
    await expect(client(() => filtered).list(CHAIN, { owner: owner.toUpperCase() })).rejects.toThrow();
  });

  test("rows of instances that are not pinned are dropped from lists and refused as details", async () => {
    const mcpChainOnly = { localHarness: true, instances: LOCAL_INSTANCE_PINS };
    expect((await client(routes, [], mcpChainOnly).list(CHAIN)).data).toEqual([]);
    await expect(client(routes, [], mcpChainOnly).detail(CHAIN, nativeId)).rejects.toThrow("api_404");
    const nativeOnly = { localHarness: true, instances: [BACKEND_REPLAY_PINS[0]] };
    expect((await client(routes, [], nativeOnly).list(CHAIN)).data.map((r: Json) => r.pool_id)).toEqual([nativeId]);
  });

  test("support is disabled without the local harness: nothing is requested", async () => {
    const seen: URL[] = [];
    const hosted = new ZeroSeedApi("https://synthetic.invalid", (async (u: URL) => { seen.push(u); }) as never);
    await expect(hosted.list(CHAIN)).rejects.toThrow("launch_support_disabled");
    await expect(hosted.detail(CHAIN, nativeId)).rejects.toThrow("launch_support_disabled");
    await expect(client(routes).detail("8453", nativeId)).rejects.toThrow("launch_support_disabled");
    expect(seen).toEqual([]);
  });
});

describe("API v3 refusals", () => {
  const detail = (change: (d: Json) => void) => client(() => tamper(g.nativeDetail, change)).detail(CHAIN, nativeId);
  const history = (kind: "swaps" | "claims" | "owners", change: (p: Json) => void) =>
    client((url) => (url.pathname.endsWith(`/${kind}`) ? tamper(pages[nativeId][kind], change) : routes(url)))[kind](CHAIN, nativeId);

  test("other schema versions and v2 fee fields", async () => {
    await expect(detail((d) => { d.schema_version = "zero-seed-launch-api/v2"; })).rejects.toThrow("api_invalid_response");
    await expect(detail((d) => { d.fee_schedule.decay_factor = "1"; })).rejects.toThrow("api_invalid_response");
    await expect(detail((d) => { delete d.fee_schedule.decay; })).rejects.toThrow("api_invalid_response");
    await expect(detail((d) => { d.fee_schedule.decay.half_life_seconds = 3600; })).rejects.toThrow("api_invalid_response");
    await expect(detail((d) => { delete d.quote_token.kind; })).rejects.toThrow("api_invalid_response");
    await expect(detail((d) => { d.fee_ledger.transferable = false; })).rejects.toThrow("api_invalid_response");
  });

  test("a served rate or phase the schedule does not produce", async () => {
    await expect(detail((d) => { d.fee_schedule.fee_rate = (BigInt(d.fee_schedule.fee_rate) + 1n).toString(); }))
      .rejects.toThrow("api_fee_identity_mismatch");
    await expect(detail((d) => { d.fee_schedule.phase = "fee_decay"; })).rejects.toThrow("api_fee_identity_mismatch");
    await expect(detail((d) => { d.fee_schedule.evaluated_at -= 1; })).rejects.toThrow("api_fee_identity_mismatch");
    await expect(detail((d) => { d.fee_schedule.fee_end += 1; })).rejects.toThrow("api_fee_identity_mismatch");
  });

  test("quote, pool and instance identity", async () => {
    await expect(detail((d) => { d.quote_token.name = "Ether"; })).rejects.toThrow("api_quote_identity_mismatch");
    await expect(detail((d) => { d.quote_token.decimals = 6; })).rejects.toThrow("api_quote_identity_mismatch");
    await expect(detail((d) => { d.pool_key.config = `0x${"00".repeat(32)}`; })).rejects.toThrow("api_pool_identity_mismatch");
    await expect(detail((d) => { d.launch_token_is_token1 = false; })).rejects.toThrow("api_quote_identity_mismatch");
    // The MCP local chain's periphery for the same extension is another instance.
    await expect(detail((d) => { d.controller = LOCAL_INSTANCE_PINS[0].periphery; })).rejects.toThrow("api_404");
    await expect(detail((d) => { d.quote_token.kind = "erc20"; })).rejects.toThrow("api_404");
    await expect(detail((d) => { d.pool_id = erc20Id; })).rejects.toThrow("api_pool_identity_mismatch");
  });

  test("ledger holder, sides and position range", async () => {
    await expect(detail((d) => { d.fee_ledger.holder = d.creator; })).rejects.toThrow("api_ledger_mismatch");
    await expect(detail((d) => { d.fee_ledger.quote_token.unclaimed = "1"; })).rejects.toThrow("api_ledger_mismatch");
    await expect(detail((d) => { d.principal.tick_lower = d.ask_tick; })).rejects.toThrow("api_position_identity_mismatch");
  });

  test("history snapshot, order and ledger totals", async () => {
    await expect(history("swaps", (p) => { p.as_of.block_number = "14"; })).rejects.toThrow("api_snapshot_mismatch");
    await expect(history("swaps", (p) => { p.data.reverse(); })).rejects.toThrow("api_page_order_mismatch");
    await expect(history("swaps", (p) => { p.data[3].fee_amount = (BigInt(p.data[3].fee_amount) + 1n).toString(); }))
      .rejects.toThrow("api_ledger_mismatch");
    await expect(history("swaps", (p) => { p.data.pop(); })).rejects.toThrow("api_ledger_mismatch");
    // Counting the extension ledger event and the periphery payout as two claims doubles the total.
    await expect(history("claims", (p) => { p.data.splice(1, 0, { ...p.data[0], event: { ...p.data[0].event,
      event_id: (BigInt(p.data[0].event.event_id) + 1n).toString() } }); })).rejects.toThrow("api_ledger_mismatch");
    await expect(history("claims", (p) => { p.data[0].ledger_event_id = p.data[0].event.event_id; })).rejects.toThrow("api_ledger_mismatch");
  });

  test("owner history must chain from the creator to the current owner", async () => {
    await expect(history("owners", (p) => { p.data[0].previous_owner = p.data[1].new_owner; })).rejects.toThrow("api_owner_history_mismatch");
    await expect(history("owners", (p) => { p.data[1].previous_owner = p.data[2].new_owner; })).rejects.toThrow("api_owner_history_mismatch");
    await expect(history("owners", (p) => { p.data.pop(); })).rejects.toThrow("api_owner_history_mismatch");
    await expect(history("owners", (p) => { p.data[0].new_owner = p.data[2].new_owner; })).rejects.toThrow("api_owner_history_mismatch");
    // A later page starts mid-chain and is not held to the creator or the total.
    const later = client((url) => (url.pathname.endsWith("/owners") ? { ...g.nativeOwners, data: g.nativeOwners.data.slice(1) } : routes(url)));
    expect((await later.owners(CHAIN, nativeId, { cursor: g.nativeOwners.data[0].event.event_id })).data).toHaveLength(2);
  });

  test("metadata is untrusted: names and symbols never select a launch", async () => {
    const renamed = await detail((d) => { d.token.name = "Zero Seed l2"; d.token.symbol = "L2"; });
    expect(renamed.pool_id).toBe(nativeId);
  });
});
