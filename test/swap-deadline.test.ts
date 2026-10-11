import { fakeArtifactStore } from "./fake-r2.js";
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { getAddress, type Hex, hexToNumber, sliceHex } from "viem";
import { planTransactions } from "./plan-helpers.js";
import { type Env, prepareSwap, type PrepareSwapIntent } from "../src/core.js";
import {
  getQuotesWithPlansSchema,
  prepareFixPoolPriceSchema,
  prepareVe33ReinvestSchema,
} from "../src/server.js";
import { swapDeadline } from "../src/swap-deadline.js";
import { type EvmQuoterQuote, prepareSwapFromQuote } from "../src/yul-router.js";

const ROUTER = "0x03c8B90854b90AA22448b11e885F692972DA441C";
const NOW_MS = 1_800_000_000_500;
const NOW_SECONDS = 1_800_000_000;

const native = "0x0000000000000000000000000000000000000000";
const token1 = "0x1111111111111111111111111111111111111111";
const sender = "0x2222222222222222222222222222222222222222";
const recipient = "0x3333333333333333333333333333333333333333";

const quote: EvmQuoterQuote = {
  block_number: 123,
  block_hash: "0x01",
  total_calculated: "900",
  estimated_gas_cost: 25_000,
  price_impact: 0.001,
  splits: [
    {
      amount_specified: "1000",
      amount_calculated: "900",
      route: [
        {
          swap: {
            type: "core",
            pool_key: {
              token0: native,
              token1,
              config: `0x${"00".repeat(32)}`,
            },
            sqrt_ratio_limit: "0x000000000000000000000000",
            skip_ahead: 0,
          },
        },
      ],
    },
  ],
};

const env: Env = {
  ARTIFACT_STORE: fakeArtifactStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "unused",
  ACROSS_API_KEY: "unused",
  ACROSS_INTEGRATOR_ID: "unused",
  LAYER_ZERO_API_KEY: "unused",
  LI_FI_API_KEY: "unused",
  DUNE_API_KEY: "unused",
};

// Route header: flags (1) | split count - 1 (1) | specified token (20) |
// calculated token (20) | int128 threshold (16) | [recipient (20)] |
// [uint32 deadline (4)].
const THRESHOLD_END = 1 + 1 + 20 + 20 + 16;

function flags(route: Hex) {
  return hexToNumber(sliceHex(route, 0, 1));
}

function deadlineAt(route: Hex, offset: number) {
  return hexToNumber(sliceHex(route, offset, offset + 4));
}

afterEach(() => {
  setSystemTime();
});

describe("swap deadline", () => {
  it("defaults to 30 minutes from the current second", () => {
    expect(swapDeadline(undefined, NOW_MS)).toBe(NOW_SECONDS + 1_800);
    expect(swapDeadline(5, NOW_MS)).toBe(NOW_SECONDS + 300);
  });

  it("only allows the window to be shortened", () => {
    expect(() => swapDeadline(0, NOW_MS)).toThrow();
    expect(() => swapDeadline(31, NOW_MS)).toThrow();
    expect(() => swapDeadline(1.5, NOW_MS)).toThrow();
  });

  it("writes the deadline right after the threshold when there is no recipient", () => {
    const deadline = NOW_SECONDS + 1_800;
    const prepared = prepareSwapFromQuote({
      quote,
      tokenIn: native,
      tokenOut: token1,
      quoteType: "exact_input",
      amount: "1000",
      slippageBps: 25,
      deadline,
    });

    expect(flags(prepared.transaction.data) & 1).toBe(0);
    expect(flags(prepared.transaction.data) & 2).toBe(2);
    expect(deadlineAt(prepared.transaction.data, THRESHOLD_END)).toBe(deadline);
    expect(prepared.transaction.to).toBe(ROUTER);
    expect(prepared.deadline).toBe(deadline);
    // The quote call simulates the same route, deadline included.
    expect(prepared.quoteCalldata).toContain(prepared.route.slice(2));
  });

  it("writes the deadline after the recipient when there is one", () => {
    const deadline = NOW_SECONDS + 600;
    const prepared = prepareSwapFromQuote({
      quote,
      tokenIn: native,
      tokenOut: token1,
      quoteType: "exact_input",
      amount: "1000",
      slippageBps: 25,
      recipient,
      deadline,
    });
    const data = prepared.transaction.data;

    expect(flags(data)).toBe(3);
    expect(getAddress(sliceHex(data, THRESHOLD_END, THRESHOLD_END + 20))).toBe(
      recipient,
    );
    expect(deadlineAt(data, THRESHOLD_END + 20)).toBe(deadline);
  });

  it("sends and approves the redeployed router", () => {
    const prepared = prepareSwapFromQuote({
      quote: {
        ...quote,
        total_calculated: "-201",
        splits: [
          {
            ...quote.splits[0],
            amount_specified: "-100",
            amount_calculated: "-201",
          },
        ],
      },
      tokenIn: token1,
      tokenOut: native,
      quoteType: "exact_output",
      amount: "100",
      slippageBps: 50,
      deadline: NOW_SECONDS + 1_800,
    });

    expect(prepared.transaction.to).toBe(ROUTER);
    expect(prepared.approval?.spender).toBe(ROUTER);
  });

  it("stamps every prepared Ekubo plan and reports the deadline as its expiry", async () => {
    setSystemTime(new Date(NOW_MS));
    const fetcher = (async () => Response.json(quote)) as unknown as typeof fetch;
    const intent: PrepareSwapIntent = {
      chainId: "1",
      tokenIn: native,
      tokenOut: token1,
      quoteType: "exact_input",
      source: "ekubo",
      amount: "1000",
      slippageBps: 25,
      sender,
    };

    const byDefault = await prepareSwap(env, intent, fetcher);
    const shortened = await prepareSwap(
      env,
      { ...intent, swapDeadlineMinutes: 5 },
      fetcher,
    );

    const [defaultTransaction] = planTransactions(byDefault);
    expect(defaultTransaction.to).toBe(ROUTER);
    // recipient defaults to sender, so the deadline follows it.
    expect(flags(defaultTransaction.data)).toBe(3);
    expect(deadlineAt(defaultTransaction.data, THRESHOLD_END + 20)).toBe(
      NOW_SECONDS + 1_800,
    );
    expect(byDefault.quote.quote_expiry_timestamp).toBe(NOW_SECONDS + 1_800);

    const [shortenedTransaction] = planTransactions(shortened);
    expect(deadlineAt(shortenedTransaction.data, THRESHOLD_END + 20)).toBe(
      NOW_SECONDS + 300,
    );
    expect(shortened.quote.quote_expiry_timestamp).toBe(NOW_SECONDS + 300);
    expect(shortened.plan_id).not.toBe(byDefault.plan_id);
  });

  it("accepts the window as an optional tool input, bounded to 1-30 minutes", () => {
    const quoteRequest = {
      chain_id: 1,
      token_in: native,
      token_out: token1,
      quote_type: "exact_input",
      amount: "1000",
    };
    expect(getQuotesWithPlansSchema.safeParse(quoteRequest).success).toBe(true);
    expect(
      getQuotesWithPlansSchema.safeParse({
        ...quoteRequest,
        swap_deadline_minutes: 10,
      }).success,
    ).toBe(true);
    for (const minutes of [0, 31, 2.5]) {
      expect(
        getQuotesWithPlansSchema.safeParse({
          ...quoteRequest,
          swap_deadline_minutes: minutes,
        }).success,
      ).toBe(false);
    }
    expect(prepareFixPoolPriceSchema.shape).toHaveProperty(
      "swap_deadline_minutes",
    );
    expect(
      prepareVe33ReinvestSchema.safeParse({
        phase: "claim",
        chain_id: 1,
        ve_token: token1,
        sender,
        swap_deadline_minutes: 31,
      }).success,
    ).toBe(false);
  });
});
