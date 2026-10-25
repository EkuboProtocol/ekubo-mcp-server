import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getAddress, type Hex } from "viem";
import worker from "../../src/index.js";
import { API_SCHEMA_VERSION, LaunchApi } from "../../src/launchpad/zero-seed/api.js";
import { poolKeyOf } from "../../src/launchpad/zero-seed/context.js";
import { fakeArtifactStore } from "../fake-r2.js";

// The indexed launch API's own golden responses (zero-seed-launch-api/v6, written by its replay test from the actual
// handlers over a replayed local chain; see test/fixtures/launchpad/PROVENANCE.md) parsed through the MCP adapter.
type Json = Record<string, any>;
const GOLDEN = readFileSync(new URL("../fixtures/launchpad/zero-seed-launch-api-v6.golden.json", import.meta.url));
const golden = JSON.parse(GOLDEN.toString("utf8")) as Json;
const LABELS = ["l1", "l2", "l4", "l5", "l6", "l7", "l8"];
const API = "https://launch-api.test";
const sample = golden.list.data[0];
const DEPLOYMENT = {
  chainId: "31337", rpcUrl: "https://rpc.launch.test/", core: getAddress(sample.pool_key.core_address),
  extension: getAddress(sample.pool_key.extension), periphery: getAddress(sample.controller), router: getAddress(`0x${"7".repeat(40)}`),
};
const env: Json = {
  ARTIFACT_STORE: fakeArtifactStore(), EKUBO_API_URL: "https://api.test", EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused", ACROSS_API_KEY: "unused", ACROSS_INTEGRATOR_ID: "unused", LAYER_ZERO_API_KEY: "unused",
  LI_FI_API_KEY: "unused", DUNE_API_KEY: "unused", LAUNCHPAD_API_URL: API,
  LAUNCHPAD_DEPLOYMENTS: JSON.stringify([{ chain_id: "31337", rpc_url: DEPLOYMENT.rpcUrl, core: DEPLOYMENT.core,
    extension: DEPLOYMENT.extension, periphery: DEPLOYMENT.periphery, router: DEPLOYMENT.router }]),
};
const byPool = new Map(LABELS.map((label) => [golden[label].pool_id as string, label]));

/** Serves the golden bodies at the v6 paths; the list is sliced by offset/limit like the API's OFFSET/LIMIT + 1. */
function goldenApi(url: URL): Response {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "launches") {
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const rows = golden.list.data as Json[];
    const next = offset + limit < rows.length ? offset + limit : null;
    return Response.json({ ...golden.list, data: rows.slice(offset, offset + limit), next_offset: next });
  }
  const label = parts[1] === "31337" ? byPool.get(parts[2]) : undefined;
  if (label === undefined) return Response.json({ status: 404, error: "Launch not found" }, { status: 404 });
  return Response.json(parts.length === 3 ? golden[label] : golden[`${label}/${parts[3]}?limit=200`]);
}

let api: (url: URL) => Response = goldenApi;
const requests: URL[] = [];
const fetcher = (async (input: RequestInfo | URL) => {
  const url = new URL(input.toString());
  requests.push(url);
  return api(url);
}) as typeof fetch;

beforeEach(() => {
  api = goldenApi;
  requests.length = 0;
  spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = new URL(input.toString());
    if (url.origin !== API) throw new Error(`unexpected fetch ${url}`);
    return fetcher(url);
  }) as typeof fetch);
});
afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

async function call(name: string, args: Json) {
  const response = await worker.fetch(new Request("https://mcp.ekubo.org/mcp/launchpad", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), env as never, {} as ExecutionContext);
  const text = await response.text();
  const body = JSON.parse(text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data:"))!.slice(5));
  return body.result as { isError?: boolean; structuredContent: Json; content: { text: string }[] };
}

describe("adapter against the v6 golden responses", () => {
  const client = new LaunchApi(API, fetcher);

  test("the fixture is the v6 golden", () => {
    expect(createHash("sha256").update(GOLDEN).digest("hex")).toBe("553dd01d8d4b43b6840c64d8ac6064fdc0623fc068de3542dcd3539475765ba1");
    expect(golden.list.schema_version).toBe(API_SCHEMA_VERSION);
    expect(golden.list.data).toHaveLength(7);
  });

  test("list parses, checksums addresses and keeps exact values", async () => {
    const list = await client.list({ status: "all", orderBy: "market_cap", offset: 0, limit: 50 });
    expect(requests[0].pathname).toBe("/launches");
    expect(Object.fromEntries(requests[0].searchParams)).toEqual({ status: "all", order_by: "market_cap", offset: "0", limit: "50" });
    expect(list.total).toBe(7);
    expect(list.totals).toEqual({ all: 7, trading: 7, upcoming: 0 });
    expect(list.next_offset).toBeNull();
    for (const [index, row] of list.data.entries()) {
      const wire = golden.list.data[index];
      expect(row.owner).toBe(getAddress(wire.owner));
      expect(row.token.address).toBe(getAddress(wire.token.address));
      expect(row.pool_key.extension).toBe(DEPLOYMENT.extension);
      expect(row.parameters).toMatchObject({ supply: wire.parameters.supply, ask_tick: wire.parameters.ask_tick, initial_fee: wire.parameters.initial_fee });
      expect(row.logo_url).toBe(wire.logo_url);
      expect(row.market.market_cap).toBe(wire.market.market_cap);
    }
    expect(list.data.map((row) => row.logo_url)).toContain("ipfs://bafyélogo 🚀");
  });

  test("every detail parses and hashes to its pool id on the golden deployment", async () => {
    for (const label of LABELS) {
      const wire = golden[label];
      const launch = await client.launch("31337", wire.pool_id as Hex);
      expect(launch.fee_ledger.claim_count).toBe(wire.fee_ledger.claim_count);
      expect(launch.range.tick_spacing).toBe(wire.range.tick_spacing);
      const key = poolKeyOf(launch, DEPLOYMENT);
      expect([key.token0, key.token1]).toEqual([getAddress(wire.pool_key.token0), getAddress(wire.pool_key.token1)]);
    }
    const launch = await client.launch("31337", golden.l1.pool_id);
    expect(() => poolKeyOf(launch, { ...DEPLOYMENT, core: getAddress(`0x${"9".repeat(40)}`) })).toThrow("does not hash");
  });

  test("every history page parses with its after_event_id cursor", async () => {
    for (const label of LABELS) {
      for (const kind of ["swaps", "claims", "owners"] as const) {
        const page = await client.history("31337", golden[label].pool_id, kind, { cursor: "-9223372011084775413", limit: 200 });
        expect(page.data).toHaveLength(golden[`${label}/${kind}?limit=200`].data.length);
        expect(page.next_cursor).toBeNull();
        expect(requests.at(-1)!.searchParams.get("after_event_id")).toBe("-9223372011084775413");
      }
    }
    const claims = await client.history("31337", golden.l1.pool_id, "claims", { limit: 200 }) as Json;
    expect(claims.totals).toEqual({ launch_token: golden.l1.fee_ledger.launch_token.claimed, quote_token: golden.l1.fee_ledger.quote_token.claimed });
    expect(claims.data[0].recipient).toBe(getAddress(golden["l1/claims?limit=200"].data[0].recipient));
  });

  test("a different schema version or launch is refused", async () => {
    api = () => Response.json({ ...golden.list, schema_version: "zero-seed-launch-api/v5" });
    await expect(client.list({ status: "all", orderBy: "created", offset: 0, limit: 5 })).rejects.toMatchObject({ code: "invalid_upstream_response" });
    api = () => Response.json(golden.l2);
    await expect(client.launch("31337", golden.l1.pool_id)).rejects.toMatchObject({ code: "invalid_upstream_response" });
  });
});

describe("tools over the v6 golden responses", () => {
  test("list maps filters and pages the offset through cursor", async () => {
    const owner = getAddress(golden.l8.owner);
    const first = (await call("launchpad_list_launches", { chain_id: "31337", status: "trading", sort: "newest", limit: 3 })).structuredContent;
    expect(Object.fromEntries(requests[0].searchParams)).toEqual({ chainId: "31337", status: "trading", order_by: "created", offset: "0", limit: "3" });
    expect(first.launches).toHaveLength(3);
    expect([first.next_cursor, first.total, first.totals]).toEqual(["3", 7, { all: 7, trading: 7, upcoming: 0 }]);
    expect(first.heads).toEqual(golden.list.heads);
    const second = (await call("launchpad_list_launches", { chain_id: "31337", status: "trading", limit: 3, cursor: first.next_cursor })).structuredContent;
    expect(second.next_cursor).toBe("6");
    const last = (await call("launchpad_list_launches", { chain_id: "31337", status: "trading", limit: 3, cursor: second.next_cursor })).structuredContent;
    expect([last.launches.length, last.next_cursor]).toEqual([1, null]);
    const pools = [...first.launches, ...second.launches, ...last.launches].map((row: Json) => row.pool_id);
    expect(pools).toEqual(golden.list.data.map((row: Json) => row.pool_id));
    requests.length = 0;
    api = () => Response.json({ ...golden.list, data: golden.list.data.filter((row: Json) => getAddress(row.owner) === owner && getAddress(row.creator) === owner).slice(0, 1) });
    const mine = (await call("launchpad_list_launches", { owner: owner.toLowerCase(), creator: owner, sort: "market_cap_usd" })).structuredContent;
    expect(mine.launches[0].owner).toBe(owner);
    expect(Object.fromEntries(requests[0].searchParams)).toMatchObject({ owner, creator: owner, order_by: "market_cap", status: "all" });
  });

  test("history tools pass the cursor as after_event_id and keep claim totals", async () => {
    const claims = (await call("launchpad_get_claims", { chain_id: "31337", pool_id: golden.l1.pool_id, cursor: "-9223372011084775413", limit: 10 })).structuredContent;
    expect(requests[0].pathname).toBe(`/launches/31337/${golden.l1.pool_id}/claims`);
    expect(Object.fromEntries(requests[0].searchParams)).toEqual({ after_event_id: "-9223372011084775413", limit: "10" });
    expect(claims.claims).toHaveLength(golden.l1.fee_ledger.claim_count);
    expect(claims.totals).toEqual(golden["l1/claims?limit=200"].totals);
    expect(claims.next_cursor).toBeNull();
    const owners = (await call("launchpad_get_owners", { chain_id: "31337", pool_id: golden.l1.pool_id })).structuredContent;
    expect(owners.owners[0].previous_owner).toBeNull();
    expect(owners.as_of).toEqual(golden.l1.as_of);
  });

  test("bad cursors fail before any request; API errors map to structured codes", async () => {
    for (const cursor of ["abc", "-1", "200000"]) {
      expect((await call("launchpad_list_launches", { cursor })).isError).toBe(true);
    }
    const badHistory = await call("launchpad_get_swaps", { chain_id: "31337", pool_id: golden.l1.pool_id, cursor: "next" });
    expect(badHistory.isError).toBe(true);
    expect(requests).toHaveLength(0);
    const offset = await call("launchpad_list_launches", { cursor: "200000" });
    expect(offset.structuredContent.error).toMatchObject({ code: "invalid_argument", details: { argument: "cursor" } });
    api = () => Response.json({ status: 400, error: "Invalid query: status: Invalid option" }, { status: 400 });
    const rejected = (await call("launchpad_list_launches", {})).structuredContent.error;
    expect([rejected.code, rejected.details.retryable, rejected.details.upstream_message]).toEqual(["upstream_error", false, "Invalid query: status: Invalid option"]);
    api = () => Response.json({ status: 503, error: "Indexed head of chain 31337 is stale" }, { status: 503 });
    const stale = (await call("launchpad_get_owners", { chain_id: "31337", pool_id: golden.l1.pool_id })).structuredContent.error;
    expect([stale.code, stale.details.retryable]).toEqual(["upstream_error", true]);
    api = goldenApi;
    const missing = (await call("launchpad_get_swaps", { chain_id: "31337", pool_id: `0x${"0".repeat(64)}` })).structuredContent.error;
    expect(missing.code).toBe("launch_not_found");
  });
});
