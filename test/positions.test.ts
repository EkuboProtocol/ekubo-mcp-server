import { describe, expect, it } from "bun:test";
import { decodeFunctionData, multicall3Abi } from "viem";
import type { Env } from "../src/core.js";
import {
  buildPositionStateReadPlan,
  MULTICALL3_ADDRESS,
} from "../src/position-state.js";
import { getPosition } from "../src/positions.js";

const env = {
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused",
  ACROSS_API_KEY: "unused",
  ACROSS_INTEGRATOR_ID: "unused",
  DUNE_API_KEY: "unused",
} satisfies Env;

const owner = "0xcd87828f4f279d3c5fd7af531370298964b5eaab";
const positionsAddress = "0xda38ac72ce7220c4dd7719d114ef94edadb8f068";
const token0 = "0x570c5aa79c798e7a418412cc8399ae5bcce570c5";
const token1 = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const ve33 = "0xd18685a514e59b06d59824e16db07e73345d9953";
const tokenId =
  "0x1de0793ad1efad6cbc527c2da7a6a316c7e51eaa28ef0742";

const indexedPosition = {
  id: tokenId,
  chain_id: "0x1237",
  positions_address: positionsAddress,
  owner,
  pool_key: {
    token0,
    token1,
    fee: "0x0",
    tick_spacing: "0x400",
    extension: ve33,
    stableswap_params: null,
  },
  bounds: { lower: -88_722_432, upper: 88_722_432 },
  liquidity: "333332844760819817",
  pool_state: {
    sqrt_ratio: "446905360728097368307543528439808",
    tick: -27_085_893,
    liquidity: "365635487532243263",
  },
  rewards: {},
};

describe("position interface parity", () => {
  it("builds one atomic Ve33 refresh, state, and owner eth_call", () => {
    const plan = buildPositionStateReadPlan(indexedPosition);
    expect(plan.available).toBe(true);
    if (!plan.available) throw new Error("expected an EVM read plan");

    expect(plan.rpc_request.method).toBe("eth_call");
    const rpcCall = plan.rpc_request.params[0];
    if (typeof rpcCall === "string") throw new Error("expected call object");
    expect(rpcCall.to).toBe(MULTICALL3_ADDRESS);
    expect(plan.rpc_request.params[1]).toBe("pending");
    expect(plan.inner_calls.map((call) => call.purpose)).toEqual([
      "accumulate_ve33_rewards_in_simulation",
      "position_state",
      "current_owner",
    ]);
    expect(plan.decode.position_state_result_fields.map((field) => field.name)).toEqual(
      ["liquidity", "principal0", "principal1", "rewardAmount"],
    );
    expect(plan.local_decode_plan).toMatchObject({
      kind: "multicall3",
      function_name: "aggregate3",
      expected_result_count: 3,
      results: [
        {
          index: 0,
          required_success: true,
        },
        {
          index: 1,
          decode: {
            kind: "function_result",
            function_name: "getPositionRewardsAndLiquidity",
          },
        },
        {
          index: 2,
          decode: { kind: "function_result", function_name: "ownerOf" },
        },
      ],
    });
    expect(Object.keys(plan.local_decode_plan).sort()).toEqual([
      "abi",
      "expected_result_count",
      "function_name",
      "kind",
      "required",
      "results",
    ]);
    expect(plan.local_decode_plan.results.map((result) => Object.keys(result).sort())).toEqual([
      ["index", "required_success"],
      ["decode", "index", "required_success"],
      ["decode", "index", "required_success"],
    ]);
    expect(plan.result_decoder).toMatchObject({
      trust_boundary: "execute_and_decode_on_user_device",
      preferred_tool: {
        name: "wallet_batch_eth_call",
        arguments: {
          chain_id: "4663",
          block_parameter: "pending",
          calls: [{ include_raw: true }],
        },
      },
      standalone_tool: { name: "wallet_decode_abi_result" },
    });

    const aggregate = decodeFunctionData({
      abi: multicall3Abi,
      data: rpcCall.data,
    });
    expect(aggregate.functionName).toBe("aggregate3");
    const calls = aggregate.args?.[0] as readonly {
      target: `0x${string}`;
      allowFailure: boolean;
      callData: `0x${string}`;
    }[];
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.allowFailure === false)).toBe(
      true,
    );
    expect(calls[0]?.callData.slice(0, 10)).toBe("0x3d046327");
    expect(calls[1]?.callData.slice(0, 10)).toBe("0x1906054d");
    expect(calls[2]?.callData.slice(0, 10)).toBe("0x6352211e");
  });

  it("selects the canonical standard v2 and v3 result ABIs", () => {
    const managers = [
      {
        address: "0xA37cc341634AFD9E0919D334606E676dbAb63E17",
        version: "positions_v2",
      },
      {
        address: "0x02D9876A21AF7545f8632C3af76eC90b5ad4b66D",
        version: "positions_v3",
      },
    ] as const;

    for (const manager of managers) {
      const plan = buildPositionStateReadPlan({
        ...indexedPosition,
        positions_address: manager.address,
        pool_key: { ...indexedPosition.pool_key, extension: token0 },
      });
      expect(plan).toMatchObject({
        available: true,
        manager_version: manager.version,
        local_decode_plan: {
          kind: "multicall3",
          expected_result_count: 2,
          results: [
            {
              index: 0,
              decode: {
                kind: "function_result",
                function_name: "getPositionFeesAndLiquidity",
              },
            },
            {
              index: 1,
              decode: { function_name: "ownerOf" },
            },
          ],
        },
      });
    }
  });

  it("hydrates indexed, API, USD-token, and onchain-query inputs", async () => {
    const requested: string[] = [];
    const result = await getPosition(
      env,
      {
        owner,
        chainId: "0x1237",
        positionsAddress,
        tokenId,
      },
      (async (input: RequestInfo | URL) => {
        const url = input.toString();
        requested.push(url);
        if (url.includes("/positions/") && url.includes("?chainId=4663")) {
          return Response.json({
            data: [indexedPosition],
            pagination: {
              page: 1,
              pageSize: 200,
              totalPages: 1,
              totalItems: 1,
            },
          });
        }
        if (url.endsWith("/history")) {
          return Response.json({
            chain_id: "0x1237",
            events: [
              {
                type: "update",
                block_number: "100",
                timestamp: "2026-08-01T00:00:00.000Z",
              },
            ],
          });
        }
        if (url.includes("/campaigns?")) {
          return Response.json({ campaigns: [] });
        }
        if (url.includes("/rewards/")) {
          return Response.json({ rewards: [] });
        }
        if (url.includes("/tokens/batch?")) {
          return Response.json([
            {
              chain_id: "0x1237",
              address: token0,
              symbol: "STONX",
              decimals: 18,
              usd_price: 2,
            },
            {
              chain_id: "0x1237",
              address: token1,
              symbol: "USDG",
              decimals: 6,
              usd_price: 1,
            },
          ]);
        }
        if (url.includes("/positions/4663/")) {
          return Response.json({
            attributes: [
              { trait_type: "salt", value: tokenId },
              { trait_type: "chain_id", value: "4663" },
            ],
          });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
    );

    expect(result.chain_id).toBe("4663");
    expect(result.indexed_position.chain_id).toBe("4663");
    expect(result.position_history.events).toHaveLength(1);
    expect(result.tokens.map((token) => token.symbol)).toEqual([
      "STONX",
      "USDG",
    ]);
    expect(result.current_state_query.available).toBe(true);
    expect(result.interface_parity.apr_history).toContain("collect_fees");
    expect(requested.some((url) => url.includes("/rewards/4663/"))).toBe(true);
  });
});
