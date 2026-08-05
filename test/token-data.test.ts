import { fakePlanStore } from "./fake-kv.js";
import { describe, expect, it } from "bun:test";
import { decodeFunctionData } from "viem";
import { tokenDataFetcherContract } from "../src/contracts.js";
import { type Env } from "../src/core.js";
import { prepareTokenBalancesAndAllowances } from "../src/token-data.js";

const owner = "0x1111111111111111111111111111111111111111";
const spender = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const nativeToken = "0x0000000000000000000000000000000000000000";
const env = {
  PLAN_STORE: fakePlanStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused",
  ACROSS_API_KEY: "unused",
  ACROSS_INTEGRATOR_ID: "unused",
  DUNE_API_KEY: "unused",
} satisfies Env;

describe("TokenDataFetcher read preparation", () => {
  it("fetches the interface token universe and prepares one decodable pending call", async () => {
    let requested = "";
    const fetcher = async (input: RequestInfo | URL) => {
      requested = input.toString();
      return Response.json([
        {
          chain_id: "0x1",
          address: "0x0",
          symbol: "ETH",
          decimals: 18,
          visibility_priority: 1,
        },
        {
          chain_id: 1,
          address: token,
          symbol: "TEST",
          decimals: 6,
          visibility_priority: 1,
        },
      ]);
    };

    const result = await prepareTokenBalancesAndAllowances(
      env,
      { chainId: "1", owner, spenders: [spender, spender] },
      fetcher as typeof fetch,
    );

    expect(requested).toBe(
      "https://api.test/tokens?chainId=1&pageSize=10000&minVisibilityPriority=0",
    );
    expect(result).toMatchObject({
      action: "ekubo_read_token_balances_and_allowances",
      status: "not_executed",
      chain_id: "1",
      owner,
      spenders: [spender],
      block_parameter: "pending",
      rpc_request: {
        method: "eth_call",
        params: [
          {
            to: "0x305Cf9A34dCb265522780D1D64544d3f7C450407",
          },
          "pending",
        ],
      },
      result_semantics: { omitted_values_are_zero: true },
    });
    expect(result.token_universe).toMatchObject({
      token_count: 2,
      minimum_visibility_priority: 0,
      interface_equivalent_page_size: 10_000,
      tokens: [
        { chain_id: "1", address: nativeToken },
        { chain_id: "1", address: token },
      ],
    });

    const contract = tokenDataFetcherContract("1");
    expect(contract).toBeDefined();
    const transaction = result.rpc_request.params[0];
    if (typeof transaction === "string") {
      throw new Error("expected an eth_call transaction object");
    }
    const decoded = decodeFunctionData({
      abi: contract!.abi,
      data: transaction.data,
    });
    expect(decoded).toEqual({
      functionName: "getNonzeroBalancesAndAllowances",
      args: [owner, [nativeToken, token], [spender]],
    });
    expect(result.local_decode_plan).toEqual({
      kind: "function_result",
      abi: contract!.abi,
      function_name: "getNonzeroBalancesAndAllowances",
      required: true,
    });
  });

  it("restricts the read and the join table to requested tokens", async () => {
    const fetcher = async (_input: RequestInfo | URL) =>
      Response.json([
        {
          chain_id: 1,
          address: "0x0",
          symbol: "ETH",
          decimals: 18,
          visibility_priority: 1,
          logo_url: "https://logos.test/eth",
          total_supply: 1234,
          bridgeInfos: { some: "metadata" },
        },
        {
          chain_id: 1,
          address: token,
          symbol: "TEST",
          decimals: 6,
          visibility_priority: 1,
          logo_url: "https://logos.test/test",
          total_supply: 5678,
          bridgeInfos: { some: "metadata" },
        },
      ]);

    const result = await prepareTokenBalancesAndAllowances(
      env,
      { chainId: "1", owner, spenders: [], tokens: [token] },
      fetcher as typeof fetch,
    );

    expect(result.token_universe).toMatchObject({
      scope: "requested_tokens",
      canonical_token_count: 2,
      token_count: 1,
    });
    expect(result.token_universe.tokens).toEqual([
      { chain_id: "1", address: token, symbol: "TEST", decimals: 6, usd_price: undefined },
    ]);

    // Reading one balance before a swap must not drag in the whole chain list.
    const contract = tokenDataFetcherContract("1");
    const transaction = result.rpc_request.params[0];
    if (typeof transaction === "string") {
      throw new Error("expected an eth_call transaction object");
    }
    expect(
      decodeFunctionData({ abi: contract!.abi, data: transaction.data }),
    ).toEqual({
      functionName: "getNonzeroBalancesAndAllowances",
      args: [owner, [token], []],
    });

    // Display metadata is not part of a balance read's join table.
    const serialized = JSON.stringify(result.token_universe);
    expect(serialized).not.toContain("logo_url");
    expect(serialized).not.toContain("bridgeInfos");
    expect(serialized).not.toContain("total_supply");
  });

  it("fails closed when a requested token is not canonical for the chain", async () => {
    const fetcher = async (_input: RequestInfo | URL) =>
      Response.json([
        { chain_id: 1, address: token, symbol: "TEST", decimals: 6 },
      ]);
    await expect(
      prepareTokenBalancesAndAllowances(
        env,
        {
          chainId: "1",
          owner,
          spenders: [],
          tokens: ["0x4444444444444444444444444444444444444444"],
        },
        fetcher as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: "unknown_token" });
  });

  it("fails closed when a chain has no TokenDataFetcher deployment", async () => {
    await expect(
      prepareTokenBalancesAndAllowances(env, {
        chainId: "999999",
        owner,
        spenders: [],
      }),
    ).rejects.toMatchObject({ code: "unsupported_chain" });
  });

  it("rejects malformed token addresses from the canonical API", async () => {
    const fetcher = async (_input: RequestInfo | URL) =>
      Response.json([{ address: "not-an-address" }]);
    await expect(
      prepareTokenBalancesAndAllowances(
        env,
        { chainId: "1", owner, spenders: [] },
        fetcher as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: "invalid_upstream_response" });
  });
});
