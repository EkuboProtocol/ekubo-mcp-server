import assert from "node:assert/strict";
import { type Hex } from "viem";
import { ZeroSeedApi } from "../src/launchpad/zero-seed/api.js";
import { LOCAL_INSTANCE_PINS } from "../src/launchpad/zero-seed/policy.js";
import { ClaimPage, LaunchDetail, LaunchList, SwapPage } from "../src/launchpad/zero-seed/schema.js";

// Input is the published actual-handler golden, not source-template rows.
// This harness never connects to a provider, wallet, API server or quoter.
const path = Bun.argv[2];
if (!path) throw new Error("Pass actual-handler-golden.json from the accepted API packet");
const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
assert.equal(digest, "5e8e93cef1f23e02f8f54336fdcf0a7a81a3b36bb4984ed57cb991e5783df351");
const golden = JSON.parse(new TextDecoder().decode(bytes));
const requests: URL[] = [];
let reply: unknown = golden.list;
let status = 200;
const fetcher = (async (input: URL | RequestInfo) => {
  requests.push(new URL(String(input)));
  return Response.json(reply, { status });
}) as typeof fetch;
const local = { localHarness: true, instances: LOCAL_INSTANCE_PINS };
const api = new ZeroSeedApi("https://synthetic.invalid", fetcher, local);
let checks = 0;
const checked = () => { checks++; };

for (const key of ["list", "second", "canonicalList"]) {
  reply = golden[key];
  assert.deepEqual(await api.list("31337"), LaunchList.parse(reply));
  checked();
}
for (const key of ["detail", "lowWeth"]) {
  reply = golden[key];
  assert.deepEqual(await api.detail("31337", golden[key].pool_id), LaunchDetail.parse(reply));
  checked();
}
assert.equal(golden.detail.launch_token_is_token1, false);
assert.equal(golden.lowWeth.launch_token_is_token1, true);

const id = golden.detail.pool_id as Hex;
// Histories must be screened through detail first, then bound to its snapshot.
const historyFetcher = (async (input: URL | RequestInfo) => {
  const url = new URL(String(input));
  requests.push(url);
  return Response.json(url.pathname.endsWith("/swaps") ? golden.swaps :
    url.pathname.endsWith("/claims") ? golden.claims : golden.detail);
}) as typeof fetch;
const history = new ZeroSeedApi("https://synthetic.invalid", historyFetcher, local);
assert.deepEqual(await history.swaps("31337", id), SwapPage.parse(golden.swaps)); checked();
assert.deepEqual(await history.claims("31337", id), ClaimPage.parse(golden.claims)); checked();

reply = golden.list;
await api.list("31337", { cursor: "-1", limit: 1 });
assert.equal(requests.at(-1)!.searchParams.get("before_event_id"), "-1");
assert.equal(requests.at(-1)!.searchParams.get("chainId"), "31337"); checked();
await history.swaps("31337", id, { cursor: "-2", limit: 2 });
assert.equal(requests.at(-1)!.searchParams.get("after_event_id"), "-2"); checked();

// Unsupported quote is excluded on list and unusable on detail/history.
const bad = structuredClone(golden.detail);
bad.quote_token.address = "0x0000000000000000000000000000000000000006";
reply = { ...golden.canonicalList, data: [bad] };
// Detail fields are not valid list fields: use an actual summary with bad quote.
reply = { ...golden.list, data: [{ ...golden.list.data[0], quote_token: bad.quote_token }] };
assert.deepEqual((await api.list("31337")).data, []); checked();
reply = bad;
await assert.rejects(api.detail("31337", id), /api_404/); checked();
const unsupportedFetcher = (async () => Response.json(bad)) as typeof fetch;
const unsupported = new ZeroSeedApi("https://synthetic.invalid", unsupportedFetcher, local);
await assert.rejects(unsupported.swaps("31337", id), /api_404/); checked();
await assert.rejects(unsupported.claims("31337", id), /api_404/); checked();
const count = requests.length;
await assert.rejects(new ZeroSeedApi("https://synthetic.invalid", fetcher).list("31337"), /launch_support_disabled/);
assert.equal(requests.length, count); checked();

reply = { ...golden.detail, pool_id: `0x${"0".repeat(64)}` };
await assert.rejects(api.detail("31337", id), /api_pool_identity_mismatch/); checked();
reply = structuredClone(golden.detail);
(reply as typeof golden.detail).fee_schedule.fee_rate = "0";
await assert.rejects(api.detail("31337", id), /api_fee_identity_mismatch/); checked();
reply = { ...golden.detail, status: "migrated" };
await assert.rejects(api.detail("31337", id), /api_invalid_response/); checked();
reply = structuredClone(golden.detail);
(reply as typeof golden.detail).pool_key.config = `0x${"0".repeat(64)}`;
await assert.rejects(api.detail("31337", id), /api_pool_identity_mismatch/); checked();
reply = structuredClone(golden.list);
(reply as typeof golden.list).as_of.block_time++;
await assert.rejects(api.list("31337"), /api_snapshot_mismatch/); checked();
const staleFetcher = (async (input: URL | RequestInfo) => {
  const page = new URL(String(input)).pathname.endsWith("/swaps");
  return Response.json(page ? { ...golden.swaps, as_of: { ...golden.swaps.as_of, block_hash: `0x${"0".repeat(64)}` } } : golden.detail);
}) as typeof fetch;
await assert.rejects(new ZeroSeedApi("https://synthetic.invalid", staleFetcher, local).swaps("31337", id), /api_snapshot_mismatch/); checked();
await assert.rejects(api.list("31337", { cursor: "-9223372036854775809" })); checked();
await assert.rejects(api.list("31337", { limit: 201 })); checked();

for (const code of [400, 404, 503, 500]) {
  status = code;
  await assert.rejects(api.detail("31337", id), new RegExp(`api_${code}`)); checked();
}
console.log(JSON.stringify({ scope: "local synthetic transport over actual API goldens", digest, checks,
  actualApiHead: "230afd458de0bc12463ec1816b047b858a3ecf41", networkCalls: 0,
  executableAcceptance: false, quoterAndOpaqueDecoderParity: "NOT YET PROVEN" }, null, 2));
