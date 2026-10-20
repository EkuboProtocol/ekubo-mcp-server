import { describe, expect, test } from "bun:test";
import { type Address, decodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import { storeArtifact } from "../../src/artifact-store.js";
import type { Env } from "../../src/core.js";
import { zeroSeedAbi } from "../../src/launchpad/zero-seed/abi.js";
import { ZeroSeedApi } from "../../src/launchpad/zero-seed/api.js";
import { feeAt } from "../../src/launchpad/zero-seed/fee.js";
import { decodeOwnerCreate, localCreateBody } from "../../src/launchpad/zero-seed/owner.js";
import { LOCAL_INSTANCE_PINS } from "../../src/launchpad/zero-seed/policy.js";
import { localInstallationPreview, PREVIEW_ID, type SyntheticPreviewWallet } from "../../src/launchpad/zero-seed/preview.js";
import snapshot from "../fixtures/launchpad/zero-seed-api-v2-snapshot.json";
import router from "../fixtures/launchpad/zero-seed-router-vectors.json";

// Served API v2 bodies captured at two local blocks; synthetic transport, no network.
type Json = any;
const local = { localHarness: true, instances: LOCAL_INSTANCE_PINS };
function api(reply: (url: URL) => Json) {
  const fetcher = (async (input: URL | RequestInfo) => Response.json(reply(new URL(String(input))))) as typeof fetch;
  return new ZeroSeedApi("https://synthetic.invalid", fetcher, local);
}
const routes = (read: Json) => (url: URL) => url.pathname === "/launches" ? read.list
  : url.pathname.endsWith("/swaps") ? read[label(read, url)].swaps
  : url.pathname.endsWith("/claims") ? read[label(read, url)].claims : read[label(read, url)].detail;
const label = (read: Json, url: URL) => (url.pathname.includes(read.l1.detail.pool_id) ? "l1" : "l3");

describe("exact API v2 consumption (draft exponential fee)", () => {
  for (const [block, read] of Object.entries(snapshot.reads) as [string, Json][]) {
    test(`block ${block}: list, both orders' detail and histories validate unchanged`, async () => {
      const client = api(routes(read));
      expect(await client.list("31337")).toEqual(read.list);
      for (const key of ["l1", "l3"]) {
        const detail = read[key].detail;
        expect(await client.detail("31337", detail.pool_id as Hex)).toEqual(detail);
        expect(await client.swaps("31337", detail.pool_id as Hex)).toEqual(read[key].swaps);
        expect(await client.claims("31337", detail.pool_id as Hex)).toEqual(read[key].claims);
      }
      expect(new Set([read.l1.detail.launch_token_is_token1, read.l3.detail.launch_token_is_token1])).toEqual(new Set([false, true]));
    });
  }

  test("served fee_rate equals the MCP schedule and the executed launch's pool", () => {
    for (const read of Object.values(snapshot.reads) as Json[]) {
      for (const key of ["l1", "l3"]) {
        const fee = read[key].detail.fee_schedule;
        const rate = feeAt({ tradingStart: BigInt(fee.trading_start), feeDuration: BigInt(fee.fee_duration),
          initialFee: BigInt(fee.initial_fee), finalFee: BigInt(fee.final_fee), decayFactor: BigInt(fee.decay_factor) }, BigInt(fee.evaluated_at));
        expect(rate.toString()).toBe(fee.fee_rate);
        expect(read[key].detail.pool_id).toBe(router.launches[key as "l1" | "l3"].pool_id);
      }
    }
  });

  const read = snapshot.reads.s as Json;
  const id = read.l1.detail.pool_id as Hex;
  const tampered = (change: (detail: Json) => void) => {
    const detail = structuredClone(read.l1.detail);
    change(detail);
    return api(() => detail).detail("31337", id);
  };
  test("v1 bodies, a missing or zero factor and a linear-rate body refuse", async () => {
    await expect(tampered((d) => { d.schema_version = "zero-seed-launch-api/v1"; })).rejects.toThrow("api_invalid_response");
    await expect(tampered((d) => { delete d.fee_schedule.decay_factor; })).rejects.toThrow("api_invalid_response");
    await expect(tampered((d) => { d.fee_schedule.decay_factor = "0"; })).rejects.toThrow("api_fee_identity_mismatch");
    await expect(tampered((d) => { d.fee_schedule.decay_factor = (1n << 64n).toString(); })).rejects.toThrow("unsigned_domain");
    await expect(tampered((d) => { d.fee_schedule.decay_factor = "18319323104848571946"; })).rejects.toThrow("api_fee_identity_mismatch");
    const fee = read.l1.detail.fee_schedule;
    const elapsed = BigInt(fee.evaluated_at - fee.trading_start);
    const linear = BigInt(fee.initial_fee) - ((BigInt(fee.initial_fee) - BigInt(fee.final_fee)) * elapsed) / BigInt(fee.fee_duration);
    await expect(tampered((d) => { d.fee_schedule.fee_rate = linear.toString(); })).rejects.toThrow("api_fee_identity_mismatch");
    await expect(tampered((d) => { d.fee_schedule.phase = "final_fee"; })).rejects.toThrow("api_fee_identity_mismatch");
  });

  test("metadata is untrusted: names and symbols never select a launch", async () => {
    const renamed = await tampered((d) => { d.token.name = "Zero Seed l3"; d.token.symbol = "L3"; });
    expect(renamed.pool_id).toBe(id);
  });
});

describe("common local snapshot: preview -> producer -> owner decoder equals the created launch and API v2", () => {
  for (const key of ["l1", "l3"] as const) {
    test(`${key}: summary is the emitted LaunchCreated parameters and the served detail`, async () => {
      const preview = snapshot.previews[key] as Json;
      const pin = LOCAL_INSTANCE_PINS[key === "l1" ? 0 : 1];
      const creator = snapshot.creator as Address;
      const h = preview.header;
      const build = { buildTime: String(preview.buildTime), executionExpiry: String(preview.executionExpiry),
        blockNumber: String(h.number), blockHash: h.hash, blockTime: String(h.timestamp) };
      const storage = new Map<string, string>();
      const env = { ARTIFACT_STORE: { put: async (k: string, body: string) => { storage.set(k, body); } } } as unknown as Env;
      const c = preview.contractPreview;
      const result = { token: c.token, poolKey: c.poolKey, positionId: c.positionId, initialTick: c.initialTick,
        liquidity: BigInt(c.liquidity), installedSupply: BigInt(c.installedSupply) };
      const wallet: SyntheticPreviewWallet = {
        storeRead: (body) => storeArtifact(env, "https://synthetic.invalid", { artifactType: "read_calls", body }),
        async read() {
          return { chainId: pin.chainId, ...build, results: [{ id: PREVIEW_ID, success: true,
            data: encodeFunctionResult({ abi: zeroSeedAbi, functionName: "previewInstallation", result }) }] };
        },
      };
      const prepared = await localInstallationPreview({ creator, request: preview.requested, pin, build }, wallet, () => BigInt(h.timestamp));
      const sealed = localCreateBody(prepared);
      const call = decodeFunctionData({ abi: zeroSeedAbi, data: JSON.parse(sealed.body).data });
      if (call.functionName !== "create") throw new Error("create");
      const encoded = Object.fromEntries(Object.entries(call.args[0]).map(([k, v]) =>
        [k, typeof v === "bigint" ? v.toString() : typeof v === "string" && v.startsWith("0x") ? v.toLowerCase() : v]));
      expect(encoded).toEqual(preview.launchCreatedParameters);
      expect(encoded).toEqual({ ...preview.createParameters, quoteToken: preview.createParameters.quoteToken.toLowerCase() });

      const summary = decodeOwnerCreate(sealed, { pin, creator, requested: preview.requested }, BigInt(h.timestamp));
      const detail = (snapshot.reads.s as Json)[key].detail;
      const f = summary.fields;
      expect([f.creator, f.binding.token, f.supply, f.liquidity, f.ask_tick, f.upper_tick, f.trading_start, f.fee_duration,
        f.initial_fee, f.final_fee, f.decay_factor]).toEqual([detail.creator, detail.token.address, detail.principal.installed_supply,
        detail.principal.liquidity, detail.ask_tick, detail.upper_tick, detail.fee_schedule.trading_start, detail.fee_schedule.fee_duration,
        detail.fee_schedule.initial_fee, detail.fee_schedule.final_fee, detail.fee_schedule.decay_factor]);
      expect(f.binding.pool_key).toEqual({ token0: detail.pool_key.token0, token1: detail.pool_key.token1, config: detail.pool_key.config });
      expect(f.binding.launch_token_is_token1).toBe(detail.launch_token_is_token1);
      expect(summary.statements[3]).toContain(`factor ${detail.fee_schedule.decay_factor} / 2^64`);
      // The API's served rate at the snapshot equals the schedule the owner was shown.
      const shown = { tradingStart: BigInt(f.trading_start), feeDuration: BigInt(f.fee_duration), initialFee: BigInt(f.initial_fee),
        finalFee: BigInt(f.final_fee), decayFactor: BigInt(f.decay_factor) };
      expect(feeAt(shown, BigInt(detail.fee_schedule.evaluated_at)).toString()).toBe(detail.fee_schedule.fee_rate);
    });
  }

  test("a preview built after the start-margin window refuses (strict pre-start margin)", async () => {
    const preview = snapshot.previews.l1 as Json;
    const late = { ...preview.requested, tradingStart: String(preview.buildTime + 299) };
    const pin = LOCAL_INSTANCE_PINS[0];
    const build = { buildTime: String(preview.buildTime), executionExpiry: String(preview.executionExpiry),
      blockNumber: String(preview.header.number), blockHash: preview.header.hash, blockTime: String(preview.header.timestamp) };
    const wallet = { storeRead: () => { throw new Error("no read"); }, read: () => { throw new Error("no read"); } } as unknown as SyntheticPreviewWallet;
    await expect(localInstallationPreview({ creator: snapshot.creator as Address, request: late, pin, build }, wallet,
      () => BigInt(preview.buildTime))).rejects.toThrow("invalid_trading_start");
  });
});
