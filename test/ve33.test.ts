import { describe, expect, it } from "bun:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  erc20Abi,
  keccak256,
  parseAbi,
} from "viem";
import {
  prepareAllVe33FeeClaims,
  prepareVe33Claim,
  prepareVe33Extend,
  prepareVe33Reinvest,
  prepareVe33Split,
  prepareVe33Vote,
  saltToId,
  toPoolKeyArgument,
} from "../src/ve33.js";

const veToken = "0x9d7008E169D040B6c0140eb92E7cA82B12643497" as const;
const sender = "0x1111111111111111111111111111111111111111" as const;
const token0 = "0x0000000000000000000000000000000000000000" as const;
const token1 = "0x2222222222222222222222222222222222222222" as const;
const token2 = "0x3333333333333333333333333333333333333333" as const;
const extension = "0x4444444444444444444444444444444444444444" as const;
const salt = `0x${"12".repeat(32)}` as const;
const saltNonce = `0x${"34".repeat(32)}` as const;

const poolA = {
  token0,
  token1,
  fee: "0",
  tickSpacing: 4,
  extension,
};
const poolB = {
  token0,
  token1: token2,
  fee: "0",
  tickSpacing: 16,
  extension,
};

describe("ve(3,3) call generation", () => {
  it("encodes v3 pool configuration from data-API fields", () => {
    const result = toPoolKeyArgument(poolA);
    const expected =
      (BigInt(extension) << 96n) | (1n << 31n) | 4n;
    expect(result).toEqual({
      token0,
      token1,
      config: `0x${expected.toString(16).padStart(64, "0")}`,
    });
  });

  it("reconstructs the live Robinhood STONX/USDG pool ID", () => {
    const poolKey = toPoolKeyArgument({
      token0: "0x570c5aa79c798e7a418412cc8399ae5bcce570c5",
      token1: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      fee: "0x0",
      tickSpacing: 1024,
      extension: "0xd18685a514e59b06d59824e16db07e73345d9953",
    });
    const poolId = keccak256(
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
        [poolKey],
      ),
    );
    expect(poolId).toBe(
      "0xd417e0b172ef08dae1a661cd00fbb4d24d724622d096929db818b9ac82690aa6",
    );

    expect(
      toPoolKeyArgument({
        token0: "0x0",
        token1:
          "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
        fee: "0",
        tickSpacing: 1024,
        extension: "0xd18685a514e59b06d59824e16db07e73345d9953",
      }).token0,
    ).toBe("0x0000000000000000000000000000000000000000");
  });

  it("returns the deterministic child ID and split invariants", () => {
    const result = prepareVe33Split({
      chainId: "4663",
      veToken,
      sender,
      veId: "123",
      amount: "40",
      salt,
    });
    expect(result.split_ve_id).toBe(
      saltToId(sender, salt, 4663n, veToken).toString(),
    );
    expect(result.source_vote_is_preserved_with_reduced_weight).toBe(true);
    expect(result.split_token_starts_unvoted).toBe(true);
    expect(result.transaction?.data).toStartWith("0x");
  });

  it("claims before split and re-vote when changing a current fee", () => {
    const result = prepareVe33Vote({
      chainId: "4663",
      veToken,
      sender,
      sourceVeId: "123",
      sourceAmount: "1000",
      currentVote: {
        poolKeyId: "pool-a",
        poolKey: poolA,
        swapFee: "10",
      },
      allocations: [
        {
          poolKeyId: "pool-a",
          poolKey: poolA,
          swapFee: "11",
          permille: 600,
        },
        {
          poolKeyId: "pool-b",
          poolKey: poolB,
          swapFee: "20",
          permille: 400,
        },
      ],
      unallocatedPermille: 0,
      saltNonce,
    });

    expect(result.calls.map((call) => call.type)).toEqual([
      "claim_pool_fees",
      "split_stake",
      "vote",
      "vote",
    ]);
    expect(result.resulting_nfts.map((nft) => nft.amount)).toEqual([
      "600",
      "400",
    ]);
    expect(result.resulting_nfts[0].pool_key_id).toBe("pool-a");
    expect(result.resulting_nfts[1].pool_key_id).toBe("pool-b");
    expect(
      result.safety.current_pool_fees_are_claimed_unconditionally_first,
    ).toBe(true);
    expect(result.transaction?.data).toStartWith("0x");
  });

  it("claims even when keeping the source vote unchanged before splitting", () => {
    const result = prepareVe33Vote({
      chainId: "4663",
      veToken,
      sender,
      sourceVeId: "123",
      sourceAmount: "1000",
      currentVote: {
        poolKeyId: "pool-a",
        poolKey: poolA,
        swapFee: "10",
      },
      allocations: [
        {
          poolKeyId: "pool-a",
          poolKey: poolA,
          swapFee: "10",
          permille: 600,
        },
        {
          poolKeyId: "pool-b",
          poolKey: poolB,
          swapFee: "20",
          permille: 400,
        },
      ],
      unallocatedPermille: 0,
      saltNonce,
    });

    expect(result.calls.map((call) => call.type)).toEqual([
      "claim_pool_fees",
      "split_stake",
      "vote",
    ]);
  });

  it("uses the fee-preserving compound extension when a pool key is known", () => {
    const result = prepareVe33Extend({
      chainId: "4663",
      veToken,
      sender,
      veId: "123",
      maxDuration: true,
      currentPoolKey: poolA,
    });
    expect(result.calls[0].type).toBe(
      "claim_fees_and_extend_max_duration",
    );
    expect(result.claims_current_pool_fees_first).toBe(true);
    expect(result.clears_current_vote).toBe(true);
  });

  it("batches claims across multiple ve-tokens", () => {
    const result = prepareVe33Claim({
      chainId: "4663",
      veToken,
      sender,
      claims: [
        { veId: "123", poolKey: poolA },
        { veId: "456", poolKey: poolB },
      ],
    });
    expect(result.calls).toHaveLength(2);
    expect(result.calls.every((call) => call.type === "claim_pool_fees")).toBe(
      true,
    );
    expect(result.transaction?.data).toStartWith("0xac9650d8");
  });

  it("discovers every active owned vote and prepares one claim-all multicall", async () => {
    const poolAArgument = toPoolKeyArgument(poolA);
    const poolBArgument = toPoolKeyArgument(poolB);
    const poolId = (poolKey: typeof poolAArgument) =>
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
          [poolKey],
        ),
      );
    let requestedUrl = "";
    const result = await prepareAllVe33FeeClaims(
      {
        EKUBO_API_URL: "https://api.test",
        EKUBO_QUOTER_URL: "https://quoter.test",
      },
      { chainId: "4663", veToken, sender },
      (async (input: RequestInfo | URL) => {
        requestedUrl = input.toString();
        return Response.json({
          data: [
            {
              chain_id: "0x1237",
              owner: sender,
              ve_token_address: veToken,
              ve33_address: extension,
              token_id: "0x7b",
              voted_pool_id: poolId(poolAArgument),
              voted_pool_key: {
                token0: poolA.token0,
                token1: poolA.token1,
                fee: "0x0",
                tick_spacing: "0x4",
                extension,
                stableswap_params: null,
              },
              pool_key_id: "1",
              last_stake_changed_event_id: "10",
              last_transfer_event_id: "9",
            },
            {
              chain_id: "4663",
              owner: sender,
              ve_token_address: veToken,
              ve33_address: extension,
              token_id: "456",
              voted_pool_id: poolId(poolBArgument),
              voted_pool_key: {
                token0: poolB.token0,
                token1: poolB.token1,
                fee: "0",
                tick_spacing: "16",
                extension,
                stableswap_params: null,
              },
              pool_key_id: "2",
            },
            {
              chain_id: "4663",
              owner: sender,
              ve_token_address: veToken,
              ve33_address: extension,
              token_id: "789",
              voted_pool_id: null,
              voted_pool_key: null,
            },
          ],
          pagination: {
            page: 1,
            pageSize: 100,
            totalPages: 1,
            totalItems: 3,
          },
        });
      }) as typeof fetch,
    );

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe(`/ve33/${veToken}/${sender}`);
    expect(url.searchParams.get("chainId")).toBe("4663");
    expect(url.searchParams.get("pageSize")).toBe("100");
    expect(result.calls).toHaveLength(2);
    expect(result.discovery).toMatchObject({
      indexed_owned_ve_tokens: 3,
      active_vote_claims: 2,
      skipped_unvoted: 1,
    });
    expect(result.discovery.state_validation).toHaveLength(2);
    expect(result.discovery.state_validation[0]).toMatchObject({
      ve_id: "123",
      expected_pool_id: poolId(poolAArgument),
    });
    const decoded = decodeFunctionData({
      abi: parseAbi([
        "function multicall(bytes[] data) payable returns (bytes[] results)",
      ]),
      data: result.transaction?.data ?? "0x",
    });
    expect(decoded.functionName).toBe("multicall");
    expect(decoded.args[0]).toHaveLength(2);
  });

  it("builds the final full-amount approval and restake phase", async () => {
    const amount = "987654321";
    const result = await prepareVe33Reinvest(
      {
        EKUBO_API_URL: "https://api.test",
        EKUBO_QUOTER_URL: "https://quoter.test",
      },
      {
        phase: "stake",
        chainId: "4663",
        veToken,
        sender,
        stakeToken: token1,
        veId: "123",
        amount,
      },
    );
    expect(result.phase).toBe("stake");
    if (result.phase !== "stake") throw new Error("unexpected phase");
    const approval = decodeFunctionData({
      abi: erc20Abi,
      data: result.plan.approvals[0].data,
    });
    expect(approval.args).toEqual([veToken, BigInt(amount)]);
    expect(result.plan.transaction?.value).toBe("0");
  });
});
