import { fakePlanStore } from "./fake-kv.js";
import { describe, expect, it } from "bun:test";
import { encodeAbiParameters, keccak256 } from "viem";
import type { Env } from "../src/core.js";
import {
  canonicalChainId,
  decodePoolConfig,
  derivePoolId,
  getPool,
  getPoolLiquidity,
  getPositionPoolCandidates,
  getPositionsByOwner,
} from "../src/pools.js";

const env = {
  PLAN_STORE: fakePlanStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused",
  ACROSS_API_KEY: "unused",
  ACROSS_INTEGRATOR_ID: "unused",
  DUNE_API_KEY: "unused",
} satisfies Env;

const token0 = "0x0000000000000000000000000000000000000000";
const token1 = "0x1111111111111111111111111111111111111111";
const core = "0x00000000000014aA86C5d3c41765bb24e11bd701";

describe("pool and position reads", () => {
  it("accepts chain IDs in integer, decimal, and hexadecimal form", () => {
    expect(canonicalChainId(4663)).toBe("4663");
    expect(canonicalChainId("4663")).toBe("4663");
    expect(canonicalChainId("0x1237")).toBe("4663");
  });

  it("decodes the concentrated discriminator separately from tick spacing", () => {
    const config =
      "0xd18685a514e59b06d59824e16db07e73345d9953000000000000000080000400";
    expect(decodePoolConfig(config)).toMatchObject({
      extension: "0xD18685a514E59b06d59824e16Db07e73345d9953",
      fee: "0",
      fee_hex: "0x0000000000000000",
      pool_type: "concentrated",
      type_config: "0x80000400",
      discriminator_bit_set: true,
      tick_spacing: 1024,
    });
  });

  it("keeps uint64 Q64 fees exact while deriving a pool ID", () => {
    const derived = derivePoolId({
      token0,
      token1,
      fee: "18446744073709551615",
      extension: token0,
      tickSpacing: 1024,
    });
    expect(derived.pool_key.config).toBe(
      "0x0000000000000000000000000000000000000000ffffffffffffffff80000400",
    );
    expect(derived.decoded_config.fee).toBe("18446744073709551615");
    expect(derived.pool_id).toBe(
      keccak256(
        encodeAbiParameters(
          [
            {
              type: "tuple",
              components: [
                { name: "token0", type: "address" },
                { name: "token1", type: "address" },
                { name: "config", type: "bytes32" },
              ],
            },
          ],
          [derived.pool_key],
        ),
      ),
    );
  });

  it("enumerates owner positions and canonicalizes response chain IDs", async () => {
    let requested = "";
    const result = await getPositionsByOwner(
      env,
      {
        owner: token1,
        chainId: "4663",
        state: "opened",
        pageSize: 25,
        page: 2,
      },
      (async (input: RequestInfo | URL) => {
        requested = input.toString();
        return Response.json({
          data: [
            {
              id: "0x1",
              chain_id: "0x1237",
              owner: token1,
              pool_key: { token0, token1 },
            },
          ],
          pagination: { page: 2, pageSize: 25, totalPages: 2, totalItems: 26 },
        });
      }) as typeof fetch,
    );

    expect(requested).toBe(
      `https://api.test/positions/${token1}?chainId=4663&state=opened&pageSize=25&page=2`,
    );
    expect(result.positions[0]).toMatchObject({ chain_id: "4663" });
    expect(result.cache.upstream_cache_control).toBe("no-cache");
  });

  it("joins token prices and pending state queries into owner positions", async () => {
    const result = await getPositionsByOwner(
      env,
      {
        owner: token1,
        chainId: "4663",
        state: "opened",
        pageSize: 25,
        page: 1,
      },
      (async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/tokens/batch?")) {
          return Response.json([
            {
              chain_id: "0x1237",
              address: token0,
              symbol: "ZERO",
              decimals: 18,
              usd_price: 1,
            },
            {
              chain_id: "0x1237",
              address: token1,
              symbol: "ONE",
              decimals: 6,
              usd_price: 2,
            },
          ]);
        }
        return Response.json({
          data: [
            {
              id: "0x1",
              chain_id: "0x1237",
              positions_address:
                "0x02D9876A21AF7545f8632C3af76eC90b5ad4b66D",
              owner: token1,
              pool_key: {
                token0,
                token1,
                fee: "0x0",
                tick_spacing: "0x400",
                extension: token0,
                stableswap_params: null,
              },
              bounds: { lower: -1024, upper: 1024 },
              liquidity: "100",
              pool_state: { sqrt_ratio: "1", tick: 0, liquidity: "100" },
            },
          ],
          pagination: { page: 1, pageSize: 25, totalPages: 1, totalItems: 1 },
        });
      }) as typeof fetch,
    );

    expect(result.tokens.map((token) => token.usd_price)).toEqual([1, 2]);
    expect(result.positions[0]).toMatchObject({
      chain_id: "4663",
      current_state_query: {
        available: true,
        manager_version: "positions_v3",
        block_parameter: "pending",
      },
    });
  });

  it("emits one shared decode plan for positions of the same manager", async () => {
    const indexedPosition = (id: string) => ({
      id,
      chain_id: "0x1237",
      positions_address: "0x02D9876A21AF7545f8632C3af76eC90b5ad4b66D",
      owner: token1,
      pool_key: {
        token0,
        token1,
        fee: "0x0",
        tick_spacing: "0x400",
        extension: token0,
        stableswap_params: null,
      },
      bounds: { lower: -1024, upper: 1024 },
      liquidity: "100",
      pool_state: { sqrt_ratio: "1", tick: 0, liquidity: "100" },
    });

    const result = await getPositionsByOwner(
      env,
      {
        owner: token1,
        chainId: "4663",
        state: "opened",
        pageSize: 25,
        page: 1,
      },
      (async (input: RequestInfo | URL) => {
        if (input.toString().includes("/tokens/batch?")) {
          return Response.json([]);
        }
        return Response.json({
          data: [indexedPosition("0x1"), indexedPosition("0x2")],
          pagination: { page: 1, pageSize: 25, totalPages: 1, totalItems: 2 },
        });
      }) as typeof fetch,
    );

    const queries = result.positions.map(
      (position: any) => position.current_state_query,
    );
    // Both positions use the same manager, so the byte-identical decode plan
    // and read semantics are emitted once rather than per position.
    expect(queries[0].local_decode_plan_ref).toBe(
      queries[1].local_decode_plan_ref,
    );
    expect(queries[0].semantics_ref).toBe(queries[1].semantics_ref);
    expect(Object.keys(result.shared_decode_plans)).toHaveLength(1);
    expect(Object.keys(result.shared_read_semantics)).toHaveLength(1);
    expect(
      result.shared_decode_plans[queries[0].local_decode_plan_ref],
    ).toMatchObject({ kind: "multicall3", function_name: "aggregate3" });

    // The plan itself must not be inlined again per position.
    for (const query of queries) {
      expect(query).not.toHaveProperty("local_decode_plan");
      expect(query).not.toHaveProperty("semantics");
    }
    // Each position still carries its own distinct call.
    expect(queries[0].rpc_request.params[0].data).not.toBe(
      queries[1].rpc_request.params[0].data,
    );
  });

  it("resolves and verifies an exact pool key and indexed state", async () => {
    const derived = derivePoolId({
      token0,
      token1,
      fee: "0",
      extension: token0,
      tickSpacing: 1024,
    });
    const requested: string[] = [];
    const result = await getPool(
      env,
      { chainId: "4663", coreAddress: core, poolId: derived.pool_id },
      (async (input: RequestInfo | URL) => {
        const url = input.toString();
        requested.push(url);
        if (url.endsWith("/key")) {
          return Response.json({
            pool_key: {
              token0,
              token1,
              fee: "0x0",
              tick_spacing: "0x400",
              extension: token0,
              stableswap_params: null,
            },
          });
        }
        return Response.json({
          data: [
            {
              pool_state: { sqrt_ratio: "18446744073709551616", tick: 0, liquidity: "10" },
            },
          ],
        });
      }) as typeof fetch,
    );

    expect(requested).toHaveLength(2);
    expect(result.pool_id).toBe(derived.pool_id);
    expect(result.pool_key.config).toBe(derived.pool_key.config);
    expect(result.pool_state).toEqual({
      sqrt_ratio: "18446744073709551616",
      tick: 0,
      liquidity: "10",
    });
  });

  it("returns tick liquidity deltas with their reconstruction semantics", async () => {
    const result = await getPoolLiquidity(
      env,
      { chainId: "1", coreAddress: core, poolId: "1" },
      (async () =>
        Response.json({
          data: [
            { tick: "-1024", net_liquidity_delta_diff: "100" },
            { tick: "1024", net_liquidity_delta_diff: "-100" },
          ],
        })) as unknown as typeof fetch,
    );
    expect(result.liquidity_deltas).toHaveLength(2);
    expect(result.interpretation).toContain("cumulatively");
  });

  it("returns verified pair candidates with the correct Ve33 manager", async () => {
    const ve33 = "0xD18685a514E59b06d59824e16Db07e73345d9953";
    const ve33Positions = "0xdA38ac72CE7220c4dd7719d114ef94eDadb8f068";
    const derived = derivePoolId({
      token0,
      token1,
      fee: "0",
      extension: ve33,
      tickSpacing: 1024,
    });
    const result = await getPositionPoolCandidates(
      env,
      {
        chainId: "4663",
        tokenA: token1,
        tokenB: token0,
        minTvlUsd: 0,
      },
      (async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/tokens/batch?")) {
          return Response.json([
            { chain_id: "4663", address: token0, symbol: "ZERO", decimals: 18 },
            { chain_id: "4663", address: token1, symbol: "ONE", decimals: 6 },
          ]);
        }
        return Response.json({
          topPools: [
            {
              pool_id: BigInt(derived.pool_id).toString(),
              core_address: BigInt(core).toString(),
              extension: BigInt(ve33).toString(),
              fee: "0",
              tick_spacing: 1024,
              stableswap_params: null,
              tvl0_total: "1",
              tvl1_total: "2",
            },
          ],
        });
      }) as typeof fetch,
    );

    expect(result.pair).toEqual({ token0, token1 });
    expect(result.candidate_count).toBe(1);
    expect(result.candidates[0]).toMatchObject({
      pool_id: derived.pool_id,
      core_generation: "v3",
      pool_type: "concentrated",
      extension: { type: "ve33" },
      position_manager: {
        address: ve33Positions,
        contract: "Ve33Positions",
      },
    });
  });
});
