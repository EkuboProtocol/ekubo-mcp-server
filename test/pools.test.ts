import { describe, expect, it } from "bun:test";
import { encodeAbiParameters, keccak256 } from "viem";
import type { Env } from "../src/core.js";
import {
  canonicalChainId,
  decodePoolConfig,
  derivePoolId,
  getPool,
  getPoolLiquidity,
  getPositionsByOwner,
} from "../src/pools.js";

const env = {
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
});
