import { describe, expect, it } from "bun:test";
import { decodeFunctionData, decodeFunctionResult, erc20Abi, getAddress } from "viem";
import {
  AERODROME_CHAIN_ID,
  AERODROME_DEPLOYMENT,
  AERODROME_GAUGE_ABI,
  AERODROME_REWARDS_DISTRIBUTOR_ABI,
  AERODROME_ROUTER_ABI,
  AERODROME_VOTER_ABI,
  AERODROME_VOTING_ESCROW_ABI,
  getAerodromeDeployment,
  prepareAerodromeGaugeClaim,
  prepareAerodromeGaugeDeposit,
  prepareAerodromeGaugeWithdraw,
  prepareAerodromeIncentiveClaim,
  prepareAerodromeLiquidityDeposit,
  prepareAerodromeLiquidityWithdraw,
  prepareAerodromeLock,
  prepareAerodromeSugarReads,
  prepareAerodromeVote,
} from "../src/aerodrome.js";
import {
  LP_SUGAR_ALL_RESPONSE,
  VE_SUGAR_BY_ID_RESPONSE,
} from "./aerodrome-fixtures.js";
import { planStepKinds, planTargets, planTransactions } from "./plan-helpers.js";

const sender = getAddress("0x4F2BF7469Bc38d1aE779b1F4affC588f35E60973");
const aero = AERODROME_DEPLOYMENT.aero;
const usdc = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
/** The gauge of the vAMM-tBTC/USDbC pool, from the Lp fixture below. */
const gauge = getAddress("0x50f0249B824033Cf0AF0C8b9fe1c67c2842A34d5");
const farFuture = "4102444800"; // 2100-01-01

/** The details block a prepared action attaches, which is part of its contract. */
// biome-ignore lint/suspicious/noExplicitAny: test helper over prepared results
function details(result: any): Record<string, unknown> {
  return result.details;
}

/** Pull one call's shipped decode plan out of a prepared read bundle. */
// biome-ignore lint/suspicious/noExplicitAny: test helper over prepared results
function readCall(result: any, id: string) {
  const bundle = result.read_calls ?? result.onchain_validation?.read_calls;
  const call = bundle.calls.find((entry: { id: string }) => entry.id === id);
  if (call === undefined) {
    throw new Error(`no read call ${id} in [${bundle.calls.map((c: { id: string }) => c.id)}]`);
  }
  return call;
}

describe("deployment", () => {
  /**
   * These addresses were derived on chain from the Voter outward, not copied
   * from the Velodrome SDKs — `sdk.js` ships Optimism addresses and would be a
   * plausible-looking wrong answer for every one of them. Pinning them here
   * makes a silent edit fail rather than quietly retarget every plan the
   * server builds.
   */
  it("pins the addresses the chain itself points at", () => {
    expect(AERODROME_DEPLOYMENT.voter).toBe(
      getAddress("0x16613524e02ad97eDfeF371bC883F2F5d6C480A5"),
    );
    expect(AERODROME_DEPLOYMENT.voting_escrow).toBe(
      getAddress("0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4"),
    );
    expect(AERODROME_DEPLOYMENT.aero).toBe(
      getAddress("0x940181a94A35A4569E4529A3CDfB74e38FD98631"),
    );
    expect(AERODROME_DEPLOYMENT.router).toBe(
      getAddress("0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43"),
    );
    expect(AERODROME_DEPLOYMENT.pool_factory).toBe(
      getAddress("0x420DD381b31aEf6683db6B902084cB0FFECe40Da"),
    );
    expect(AERODROME_DEPLOYMENT.rewards_distributor).toBe(
      getAddress("0x227f65131A261548b057215bB1D5Ab2997964C7d"),
    );
  });

  /**
   * The current position manager reports the current Slipstream factory, and
   * the legacy pair reports the legacy factory. Confusing the two is the exact
   * mistake the SDK config invited, so the distinction is asserted.
   */
  it("keeps the current and legacy concentrated deployments apart", () => {
    expect(AERODROME_DEPLOYMENT.concentrated.position_manager).toBe(
      getAddress("0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53"),
    );
    expect(AERODROME_DEPLOYMENT.concentrated.factory).toBe(
      getAddress("0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef"),
    );
    expect(AERODROME_DEPLOYMENT.concentrated.legacy_position_manager).not.toBe(
      AERODROME_DEPLOYMENT.concentrated.position_manager,
    );
    expect(AERODROME_DEPLOYMENT.concentrated.legacy_factory).not.toBe(
      AERODROME_DEPLOYMENT.concentrated.factory,
    );
  });

  it("reports no network access and names the Sugar contracts as the data path", () => {
    const deployment = getAerodromeDeployment();
    expect(deployment.network_access).toBe("none");
    expect(deployment.agent_market_data_discovery.server_involvement).toBe("none");
    expect(deployment.deployment.sugar.lp).toBe(AERODROME_DEPLOYMENT.sugar.lp);
  });

  it("refuses every chain but Base", () => {
    expect(() => getAerodromeDeployment({ chainId: "10" })).toThrow(
      /only on Base/,
    );
    expect(() =>
      prepareAerodromeVote({
        chainId: "1",
        sender,
        venftId: "1",
        pools: [{ pool: usdc, weight: "1" }],
      }),
    ).toThrow(/only on Base/);
  });
});

describe("sugar reads", () => {
  /**
   * The point of the whole integration: a read bundle whose decode plan is
   * correct against what the deployed lens actually returns.
   *
   * The fixture is a real `all(1, 0, 0)` response, and it is decoded through
   * the plan the server ships rather than through a copy — so a struct-layout
   * mistake fails here instead of silently misreading every field. That is not
   * hypothetical: `sdk.js`'s struct for this data has drifted from the
   * deployed contract, and decoding with it yields well-formed nonsense rather
   * than an error.
   */
  it("decodes a real LpSugar response through the shipped decode plan", () => {
    const result = prepareAerodromeSugarReads({
      chainId: AERODROME_CHAIN_ID,
      dataset: "pools",
      limit: 1,
    });
    const call = readCall(result, "pools");
    const decoded = decodeFunctionResult({
      abi: call.decode.abi,
      functionName: call.decode.function_name,
      data: LP_SUGAR_ALL_RESPONSE,
      // biome-ignore lint/suspicious/noExplicitAny: decoded struct shape is the assertion
    }) as any;

    expect(decoded).toHaveLength(1);
    const pool = decoded[0];
    expect(pool.symbol).toBe("vAMM-tBTC/USDbC");
    // -1 is the volatile marker, and it only lands here if every preceding
    // field is the right width — an off-by-one layout shifts it to 0.
    expect(pool.type).toBe(-1);
    expect(pool.factory).toBe(AERODROME_DEPLOYMENT.pool_factory);
    expect(pool.emissions_token).toBe(AERODROME_DEPLOYMENT.aero);
    expect(pool.gauge).toBe(gauge);
    expect(pool.gauge_alive).toBe(true);
    expect(pool.token0).toBe(getAddress("0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b"));
    expect(pool.token1).toBe(getAddress("0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA"));
  });

  /**
   * The escrow struct carries a trailing `managed_id` that the Sugar README's
   * field list omits. veNFT #1 is deposited into managed NFT 10294, so a
   * struct that stopped at `delegate_id` would drop a non-zero field that
   * changes what the NFT can do.
   */
  it("decodes a real VeSugar response including the trailing managed_id", () => {
    const result = prepareAerodromeSugarReads({
      chainId: AERODROME_CHAIN_ID,
      dataset: "venft_by_id",
      venftId: "1",
    });
    const call = readCall(result, "venft");
    const decoded = decodeFunctionResult({
      abi: call.decode.abi,
      functionName: call.decode.function_name,
      data: VE_SUGAR_BY_ID_RESPONSE,
      // biome-ignore lint/suspicious/noExplicitAny: decoded struct shape is the assertion
    }) as any;

    expect(decoded.id).toBe(1n);
    expect(decoded.token).toBe(AERODROME_DEPLOYMENT.aero);
    expect(decoded.managed_id).toBe(10294n);
    expect(decoded.account).toBe(getAddress("0xBDE0c70BdC242577c52dFAD53389F82fd149EA5a"));
  });

  it("targets the right lens contract per dataset", () => {
    const positions = prepareAerodromeSugarReads({
      chainId: AERODROME_CHAIN_ID,
      dataset: "positions",
      account: sender,
    });
    expect(readCall(positions, "positions").to).toBe(AERODROME_DEPLOYMENT.sugar.lp);

    const rewards = prepareAerodromeSugarReads({
      chainId: AERODROME_CHAIN_ID,
      dataset: "venft_rewards",
      venftId: "1",
    });
    expect(readCall(rewards, "rewards").to).toBe(AERODROME_DEPLOYMENT.sugar.rewards);

    const venfts = prepareAerodromeSugarReads({
      chainId: AERODROME_CHAIN_ID,
      dataset: "venfts_by_account",
      account: sender,
    });
    expect(readCall(venfts, "venfts").to).toBe(AERODROME_DEPLOYMENT.sugar.ve);
  });

  it("refuses a page larger than the contract's own maximum", () => {
    expect(() =>
      prepareAerodromeSugarReads({
        chainId: AERODROME_CHAIN_ID,
        dataset: "pools",
        limit: 501,
      }),
    ).toThrow(/maximum of 500/);
    // MAX_POSITIONS is a different constant, and a positions page is capped by it.
    expect(() =>
      prepareAerodromeSugarReads({
        chainId: AERODROME_CHAIN_ID,
        dataset: "positions",
        account: sender,
        limit: 201,
      }),
    ).toThrow(/maximum of 200/);
  });

  it("requires the argument its dataset actually needs", () => {
    expect(() =>
      prepareAerodromeSugarReads({ chainId: AERODROME_CHAIN_ID, dataset: "positions" }),
    ).toThrow(/account is required/);
    expect(() =>
      prepareAerodromeSugarReads({ chainId: AERODROME_CHAIN_ID, dataset: "pool_epochs" }),
    ).toThrow(/pool is required/);
  });
});

describe("liquidity", () => {
  const deposit = () =>
    prepareAerodromeLiquidityDeposit({
      chainId: AERODROME_CHAIN_ID,
      sender,
      tokenA: aero,
      tokenB: usdc,
      stable: false,
      amountADesired: "1000000000000000000",
      amountBDesired: "1000000",
      amountAMin: "990000000000000000",
      amountBMin: "990000",
      deadline: farFuture,
    });

  it("approves both sides, deposits, then zeroes both allowances", () => {
    const result = deposit();
    expect(planStepKinds(result)).toEqual([
      "approval",
      "approval",
      "execution",
      "allowance_cleanup",
      "allowance_cleanup",
    ]);
    expect(planTargets(result)).toEqual([
      aero,
      usdc,
      AERODROME_DEPLOYMENT.router,
      aero,
      usdc,
    ]);
    const call = decodeFunctionData({
      abi: AERODROME_ROUTER_ABI,
      data: planTransactions(result)[2].data,
    });
    expect(call.functionName).toBe("addLiquidity");
    expect(call.args?.[2]).toBe(false);
    expect(call.args?.[7]).toBe(sender);
  });

  /**
   * addLiquidity refunds whatever the pool ratio does not take, so an exact
   * approval routinely goes partly unspent. Without the cleanup a stale
   * allowance outlives the deposit that justified it.
   */
  it("requires atomic batching so the cleanup cannot be dropped", () => {
    expect(deposit().execution_plan.required_capabilities).toContain("atomic_batch");
  });

  /**
   * A user who already LP'd through Aerodrome's own UI arrives with a standing
   * router allowance, and for the tokens on the reset list an exact approval
   * over a nonzero one reverts. The plan builder injects the approve(0) for
   * every step marked `approval`, so this passes only while these approvals
   * keep that kind — which is the thing worth pinning.
   */
  it("inherits the approve(0) reset for a Base token that needs it", () => {
    const kta = getAddress("0xc0634090f2fe6c6d75e61be2b949464abb498973");
    const result = prepareAerodromeLiquidityDeposit({
      chainId: AERODROME_CHAIN_ID,
      sender,
      tokenA: kta,
      tokenB: usdc,
      stable: false,
      amountADesired: "1000",
      amountBDesired: "1000",
      amountAMin: "1",
      amountBMin: "1",
      deadline: farFuture,
    });
    expect(planStepKinds(result)).toEqual([
      "approval",
      "approval",
      "approval",
      "execution",
      "allowance_cleanup",
      "allowance_cleanup",
    ]);
    // The injected reset precedes KTA's real approval and zeroes it.
    expect(planTargets(result).slice(0, 2)).toEqual([kta, kta]);
    const reset = decodeFunctionData({
      abi: erc20Abi,
      data: planTransactions(result)[0].data,
    });
    expect(reset.args?.[1]).toBe(0n);
  });

  it("rejects a minimum that exceeds its own desired amount", () => {
    expect(() =>
      prepareAerodromeLiquidityDeposit({
        chainId: AERODROME_CHAIN_ID,
        sender,
        tokenA: aero,
        tokenB: usdc,
        stable: false,
        amountADesired: "1000",
        amountBDesired: "1000",
        amountAMin: "1001",
        amountBMin: "1000",
        deadline: farFuture,
      }),
    ).toThrow(/amount_a_min exceeds amount_a_desired/);
  });

  /**
   * A deadline in the past is a transaction that cannot succeed, and the user
   * still pays gas to find that out.
   */
  it("rejects a deadline already in the past", () => {
    expect(() =>
      prepareAerodromeLiquidityDeposit({
        chainId: AERODROME_CHAIN_ID,
        sender,
        tokenA: aero,
        tokenB: usdc,
        stable: false,
        amountADesired: "1000",
        amountBDesired: "1000",
        amountAMin: "0",
        amountBMin: "0",
        deadline: "1700000000",
      }),
    ).toThrow(/would revert on arrival/);
  });

  it("quotes the real split and the pool address for review", () => {
    const result = deposit();
    expect(readCall(result, "quote_add_liquidity").to).toBe(AERODROME_DEPLOYMENT.router);
    expect(readCall(result, "pool").to).toBe(AERODROME_DEPLOYMENT.router);
  });

  it("withdraws through the router and quotes what comes back", () => {
    const result = prepareAerodromeLiquidityWithdraw({
      chainId: AERODROME_CHAIN_ID,
      sender,
      tokenA: aero,
      tokenB: usdc,
      stable: false,
      liquidity: "1000000",
      amountAMin: "1",
      amountBMin: "1",
      deadline: farFuture,
    });
    const call = decodeFunctionData({
      abi: AERODROME_ROUTER_ABI,
      data: planTransactions(result)[0].data,
    });
    expect(call.functionName).toBe("removeLiquidity");
    expect(readCall(result, "quote_remove_liquidity").to).toBe(AERODROME_DEPLOYMENT.router);
  });

  it("rejects a pair of one token", () => {
    expect(() =>
      prepareAerodromeLiquidityDeposit({
        chainId: AERODROME_CHAIN_ID,
        sender,
        tokenA: aero,
        tokenB: aero,
        stable: false,
        amountADesired: "1",
        amountBDesired: "1",
        amountAMin: "0",
        amountBMin: "0",
        deadline: farFuture,
      }),
    ).toThrow(/two different tokens/);
  });
});

describe("gauges", () => {
  it("stakes into the gauge and reads back the staking token it pulls", () => {
    const result = prepareAerodromeGaugeDeposit({
      chainId: AERODROME_CHAIN_ID,
      sender,
      gauge,
      amount: "1000",
    });
    expect(planTargets(result)).toEqual([gauge]);
    const call = decodeFunctionData({
      abi: AERODROME_GAUGE_ABI,
      data: planTransactions(result)[0].data,
    });
    expect(call.functionName).toBe("deposit");
    expect(call.args?.[0]).toBe(1000n);
    // The approval target is the gauge's own stakingToken(), never assumed.
    expect(readCall(result, "staking_token").to).toBe(gauge);
    expect(readCall(result, "gauge_alive").to).toBe(AERODROME_DEPLOYMENT.voter);
  });

  it("surfaces unclaimed emissions when unstaking", () => {
    const result = prepareAerodromeGaugeWithdraw({
      chainId: AERODROME_CHAIN_ID,
      sender,
      gauge,
      amount: "1000",
    });
    expect(
      decodeFunctionData({ abi: AERODROME_GAUGE_ABI, data: planTransactions(result)[0].data })
        .functionName,
    ).toBe("withdraw");
    expect(readCall(result, "earned").to).toBe(gauge);
  });

  /**
   * getReward credits its argument, not the sender, so a claim can pay a
   * different address than the one paying gas. The plan says so explicitly.
   */
  it("names the account a claim actually pays", () => {
    const other = getAddress("0xBDE0c70BdC242577c52dFAD53389F82fd149EA5a");
    const result = prepareAerodromeGaugeClaim({
      chainId: AERODROME_CHAIN_ID,
      sender,
      gauge,
      account: other,
    });
    const call = decodeFunctionData({
      abi: AERODROME_GAUGE_ABI,
      data: planTransactions(result)[0].data,
    });
    expect(call.functionName).toBe("getReward");
    expect(call.args?.[0]).toBe(other);
    expect(details(result).pays_the_account_not_the_sender).toContain("pays that address");

    const self = prepareAerodromeGaugeClaim({ chainId: AERODROME_CHAIN_ID, sender, gauge });
    expect(details(self).pays_the_account_not_the_sender).toBe(false);
  });
});

describe("locks", () => {
  it("approves AERO, locks, then zeroes the allowance", () => {
    const result = prepareAerodromeLock({
      chainId: AERODROME_CHAIN_ID,
      sender,
      action: "create",
      amount: "1000000000000000000",
      lockDuration: String(126_144_000),
    });
    expect(planStepKinds(result)).toEqual(["approval", "execution", "allowance_cleanup"]);
    expect(planTargets(result)).toEqual([
      aero,
      AERODROME_DEPLOYMENT.voting_escrow,
      aero,
    ]);
    const call = decodeFunctionData({
      abi: AERODROME_VOTING_ESCROW_ABI,
      data: planTransactions(result)[1].data,
    });
    expect(call.functionName).toBe("createLock");
  });

  /**
   * The escrow floors an unlock time to a week boundary, so anything under a
   * week locks nothing at all — better refused here than signed.
   */
  it("refuses a duration that would round down to nothing", () => {
    expect(() =>
      prepareAerodromeLock({
        chainId: AERODROME_CHAIN_ID,
        sender,
        action: "create",
        amount: "1",
        lockDuration: "3600",
      }),
    ).toThrow(/at least 604800 seconds/);
  });

  it("caps a lock at four years", () => {
    expect(() =>
      prepareAerodromeLock({
        chainId: AERODROME_CHAIN_ID,
        sender,
        action: "create",
        amount: "1",
        lockDuration: String(5 * 365 * 24 * 3600),
      }),
    ).toThrow(/caps a lock/);
  });

  it("builds each single-call lock action against the escrow", () => {
    for (const [action, fn] of [
      ["extend", "increaseUnlockTime"],
      ["lock_permanent", "lockPermanent"],
      ["unlock_permanent", "unlockPermanent"],
      ["withdraw", "withdraw"],
    ] as const) {
      const result = prepareAerodromeLock({
        chainId: AERODROME_CHAIN_ID,
        sender,
        action,
        venftId: "42",
        lockDuration: String(126_144_000),
      });
      expect(planTargets(result)).toEqual([AERODROME_DEPLOYMENT.voting_escrow]);
      expect(
        decodeFunctionData({
          abi: AERODROME_VOTING_ESCROW_ABI,
          data: planTransactions(result)[0].data,
        }).functionName,
      ).toBe(fn);
      // Ownership and lock state are what decide whether these can succeed.
      expect(readCall(result, "owner").to).toBe(AERODROME_DEPLOYMENT.voting_escrow);
      expect(readCall(result, "locked").to).toBe(AERODROME_DEPLOYMENT.voting_escrow);
    }
  });

  it("requires the veNFT id for anything but a fresh lock", () => {
    expect(() =>
      prepareAerodromeLock({ chainId: AERODROME_CHAIN_ID, sender, action: "withdraw" }),
    ).toThrow(/venft_id is required/);
  });
});

describe("voting", () => {
  it("passes weights through untouched as the relative shares they are", () => {
    const result = prepareAerodromeVote({
      chainId: AERODROME_CHAIN_ID,
      sender,
      venftId: "42",
      pools: [
        { pool: usdc, weight: "70" },
        { pool: aero, weight: "30" },
      ],
    });
    const call = decodeFunctionData({
      abi: AERODROME_VOTER_ABI,
      data: planTransactions(result)[0].data,
    });
    expect(call.functionName).toBe("vote");
    expect(call.args?.[0]).toBe(42n);
    expect(call.args?.[1]).toEqual([usdc, aero]);
    expect(call.args?.[2]).toEqual([70n, 30n]);
    expect(planTargets(result)).toEqual([AERODROME_DEPLOYMENT.voter]);
  });

  /**
   * Voting twice in one epoch reverts, so the plan hands the wallet the read
   * that detects it rather than letting the user discover it by paying gas.
   */
  it("reads last_voted and every pool's gauge liveness", () => {
    const result = prepareAerodromeVote({
      chainId: AERODROME_CHAIN_ID,
      sender,
      venftId: "42",
      pools: [{ pool: usdc, weight: "1" }],
    });
    expect(readCall(result, "last_voted").to).toBe(AERODROME_DEPLOYMENT.voter);
    expect(readCall(result, "gauge_0").to).toBe(AERODROME_DEPLOYMENT.voter);
    expect(readCall(result, "gauge_alive_0").to).toBe(AERODROME_DEPLOYMENT.voter);
    expect(details(result).one_vote_per_epoch).toContain("AlreadyVotedOrDeposited");
  });

  /**
   * The likely failure of a vote is a named epoch revert, not a balance. If
   * the plan ships without the decode the user sees four opaque bytes for the
   * one error they were most likely to hit.
   */
  it("carries the revert decode that names the epoch errors", () => {
    const result = prepareAerodromeVote({
      chainId: AERODROME_CHAIN_ID,
      sender,
      venftId: "42",
      pools: [{ pool: usdc, weight: "1" }],
    });
    const decode = result.execution_plan.ordered_steps[0].revert_decode as {
      kind: string;
      abi: { name: string }[];
    };
    expect(decode.kind).toBe("error_result");
    expect(decode.abi.map((entry) => entry.name)).toContain(
      "AlreadyVotedOrDeposited",
    );
  });

  it("resets instead of voting when asked", () => {
    const result = prepareAerodromeVote({
      chainId: AERODROME_CHAIN_ID,
      sender,
      venftId: "42",
      reset: true,
    });
    expect(
      decodeFunctionData({ abi: AERODROME_VOTER_ABI, data: planTransactions(result)[0].data })
        .functionName,
    ).toBe("reset");
  });

  it("refuses a reset that also carries weights", () => {
    expect(() =>
      prepareAerodromeVote({
        chainId: AERODROME_CHAIN_ID,
        sender,
        venftId: "42",
        reset: true,
        pools: [{ pool: usdc, weight: "1" }],
      }),
    ).toThrow(/cannot be combined/);
  });

  it("refuses a vote with no pools and one that repeats a pool", () => {
    expect(() =>
      prepareAerodromeVote({ chainId: AERODROME_CHAIN_ID, sender, venftId: "42", pools: [] }),
    ).toThrow(/at least one pool/i);
    expect(() =>
      prepareAerodromeVote({
        chainId: AERODROME_CHAIN_ID,
        sender,
        venftId: "42",
        pools: [
          { pool: usdc, weight: "1" },
          { pool: usdc, weight: "2" },
        ],
      }),
    ).toThrow(/appears more than once/);
  });
});

describe("incentive claims", () => {
  it("claims fees, bribes, and the rebase as one reviewable plan", () => {
    const fee = getAddress("0x958A5612390BB4134e1e7505c7cB6b0652941174");
    const bribe = getAddress("0xB0b88cA338f183d2fBABAb0f75Ba3C90424131d9");
    const result = prepareAerodromeIncentiveClaim({
      chainId: AERODROME_CHAIN_ID,
      sender,
      venftId: "42",
      fees: [{ contract: fee, tokens: [aero] }],
      bribes: [{ contract: bribe, tokens: [usdc] }],
      claimRebase: true,
    });

    expect(planTargets(result)).toEqual([
      AERODROME_DEPLOYMENT.voter,
      AERODROME_DEPLOYMENT.voter,
      AERODROME_DEPLOYMENT.rewards_distributor,
    ]);
    const transactions = planTransactions(result);
    expect(
      decodeFunctionData({ abi: AERODROME_VOTER_ABI, data: transactions[0].data }).functionName,
    ).toBe("claimFees");
    expect(
      decodeFunctionData({ abi: AERODROME_VOTER_ABI, data: transactions[1].data }).functionName,
    ).toBe("claimBribes");
    expect(
      decodeFunctionData({
        abi: AERODROME_REWARDS_DISTRIBUTOR_ABI,
        data: transactions[2].data,
      }).functionName,
    ).toBe("claim");
    expect(readCall(result, "claimable_rebase").to).toBe(
      AERODROME_DEPLOYMENT.rewards_distributor,
    );
  });

  /**
   * A claim naming no source is a transaction that succeeds and moves nothing,
   * which is the failure mode this whole tool is shaped to avoid.
   */
  it("refuses a claim with nothing to claim", () => {
    expect(() =>
      prepareAerodromeIncentiveClaim({ chainId: AERODROME_CHAIN_ID, sender, venftId: "42" }),
    ).toThrow(/at least one fee or bribe source/);
  });

  it("refuses a source with an empty token list", () => {
    expect(() =>
      prepareAerodromeIncentiveClaim({
        chainId: AERODROME_CHAIN_ID,
        sender,
        venftId: "42",
        fees: [{ contract: aero, tokens: [] }],
      }),
    ).toThrow(/transfers nothing/);
  });

  it("refuses a repeated source contract", () => {
    expect(() =>
      prepareAerodromeIncentiveClaim({
        chainId: AERODROME_CHAIN_ID,
        sender,
        venftId: "42",
        bribes: [
          { contract: aero, tokens: [usdc] },
          { contract: aero, tokens: [aero] },
        ],
      }),
    ).toThrow(/appears more than once/);
  });

  it("claims only the rebase when that is all that was asked for", () => {
    const result = prepareAerodromeIncentiveClaim({
      chainId: AERODROME_CHAIN_ID,
      sender,
      venftId: "42",
      claimRebase: true,
    });
    expect(planTargets(result)).toEqual([AERODROME_DEPLOYMENT.rewards_distributor]);
  });
});
