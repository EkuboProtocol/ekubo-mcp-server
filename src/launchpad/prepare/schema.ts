import { z } from "zod";

export const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an exact 0x-prefixed 20-byte address");

export const chainId = z.number().int().positive().describe("The manifest's chain ID. Plans are bound to it.");

export const sender = address.describe(
  "The wallet account that will sign and pay. Bound into the plan as every step's from address; the wallet refuses a plan for any other account.",
);

export const slippageBps = z
  .number()
  .int()
  .min(0)
  .max(5_000)
  .describe("Required slippage tolerance in basis points. There is no default.");

export const rawAmount = z.string().regex(/^(0|[1-9][0-9]{0,77})$/, "a decimal integer string in raw units");
