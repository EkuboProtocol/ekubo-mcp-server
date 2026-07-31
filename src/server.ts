import { McpServer } from "@modelcontextprotocol/server";
import type { Address } from "viem";
import { z } from "zod";
import {
  type Env,
  getQuote,
  getToken,
  prepareSwap,
  searchTokens,
  ServiceError,
} from "./core.js";

const chainId = z
  .string()
  .regex(/^[0-9]+$/, "chain_id must contain decimal digits")
  .describe("Decimal EVM chain ID, matching the Ekubo token list");
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte EVM address")
  .describe("20-byte EVM token address; use all-zeroes for the native token");
const quoteType = z.enum(["exact_input", "exact_output"]);
const amount = z
  .string()
  .regex(/^[0-9]*[1-9][0-9]*$/, "amount must be a positive base-unit integer")
  .describe("Positive exact-input or exact-output token amount in base units");

export const searchTokensSchema = z.object({
  chain_id: chainId,
  query: z
    .string()
    .min(1)
    .max(32)
    .describe("Token symbol, name, or address fragment"),
  page_size: z.number().int().min(1).max(100).default(20),
});

export const getTokenSchema = z.object({
  chain_id: chainId,
  address: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, "address must be hexadecimal")
    .describe("EVM or Starknet token address"),
});

export const getQuoteSchema = z.object({
  chain_id: chainId,
  token_in: address,
  token_out: address,
  quote_type: quoteType,
  amount,
});

export const prepareSwapSchema = getQuoteSchema.extend({
  slippage_bps: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .describe("User-selected slippage tolerance in basis points"),
  recipient: address
    .optional()
    .describe("Optional recipient; defaults to the transaction sender"),
  sender: address
    .optional()
    .describe("Optional sender used for exact account-aware simulation"),
  simulate: z
    .boolean()
    .default(true)
    .describe("Simulate at the quote block using the server's allowlisted RPC"),
});

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const publicToolCatalog = [
  {
    name: "ekubo_search_tokens",
    title: "Search Ekubo tokens",
    description:
      "Search the canonical Ekubo token list. Resolve symbols to a unique address and decimals before requesting a quote.",
    inputSchema: z.toJSONSchema(searchTokensSchema),
  },
  {
    name: "ekubo_get_token",
    title: "Get an Ekubo token",
    description:
      "Fetch canonical token metadata for an exact chain and address.",
    inputSchema: z.toJSONSchema(getTokenSchema),
  },
  {
    name: "ekubo_get_quote",
    title: "Get an Ekubo route quote",
    description:
      "Get a block-pinned EVM route quote using explicit input/output intent. This tool translates to the canonical signed-amount quoter URL.",
    inputSchema: z.toJSONSchema(getQuoteSchema),
  },
  {
    name: "ekubo_prepare_swap",
    title: "Prepare and simulate an Ekubo swap",
    description:
      "Fetch a quote, generate slippage-protected unsigned Yul router and ERC20 approval calldata, and simulate it when an allowlisted RPC is configured. The client uses its own wallet and RPC to revalidate, sign, and submit. Never send wallet credentials to this server.",
    inputSchema: z.toJSONSchema(prepareSwapSchema),
  },
] as const;

export function createEkuboServer(env: Env) {
  const server = new McpServer({
    name: "ekubo",
    title: "Ekubo Protocol",
    version: "0.1.0",
    websiteUrl: "https://mcp.ekubo.org",
  });

  server.registerTool(
    publicToolCatalog[0].name,
    {
      title: publicToolCatalog[0].title,
      description: publicToolCatalog[0].description,
      inputSchema: searchTokensSchema,
      annotations,
    },
    async ({ chain_id, query, page_size }) =>
      toolResult(async () => ({
        tokens: await searchTokens(env, {
          chainId: chain_id,
          query,
          pageSize: page_size,
        }),
      })),
  );

  server.registerTool(
    publicToolCatalog[1].name,
    {
      title: publicToolCatalog[1].title,
      description: publicToolCatalog[1].description,
      inputSchema: getTokenSchema,
      annotations,
    },
    async ({ chain_id, address: tokenAddress }) =>
      toolResult(async () => ({
        token: await getToken(env, {
          chainId: chain_id,
          address: tokenAddress,
        }),
      })),
  );

  server.registerTool(
    publicToolCatalog[2].name,
    {
      title: publicToolCatalog[2].title,
      description: publicToolCatalog[2].description,
      inputSchema: getQuoteSchema,
      annotations,
    },
    async (input) =>
      toolResult(() =>
        getQuote(env, {
          chainId: input.chain_id,
          tokenIn: input.token_in as Address,
          tokenOut: input.token_out as Address,
          quoteType: input.quote_type,
          amount: input.amount,
        }),
      ),
  );

  server.registerTool(
    publicToolCatalog[3].name,
    {
      title: publicToolCatalog[3].title,
      description: publicToolCatalog[3].description,
      inputSchema: prepareSwapSchema,
      annotations,
    },
    async (input) =>
      toolResult(() =>
        prepareSwap(env, {
          chainId: input.chain_id,
          tokenIn: input.token_in as Address,
          tokenOut: input.token_out as Address,
          quoteType: input.quote_type,
          amount: input.amount,
          slippageBps: input.slippage_bps,
          recipient: input.recipient as Address | undefined,
          sender: input.sender as Address | undefined,
          simulate: input.simulate,
        }),
      ),
  );

  server.registerResource(
    "ekubo-agent-workflow",
    "ekubo://docs/agent-workflow",
    {
      title: "Safe Ekubo swap workflow",
      description:
        "Canonical token lookup, quote, preparation, simulation, and confirmation sequence",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: AGENT_WORKFLOW,
        },
      ],
    }),
  );

  server.registerResource(
    "ekubo-quoter-contract",
    "ekubo://docs/quoter-api",
    {
      title: "Ekubo quoter HTTP contract",
      description: "Canonical signed-path quote semantics used by MCP tools",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: QUOTER_API,
        },
      ],
    }),
  );

  server.registerResource(
    "ekubo-api-openapi",
    "https://prod-api.ekubo.org/openapi.json",
    {
      title: "Ekubo data API OpenAPI",
      description: "Canonical public token and protocol-data HTTP contract",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: await fetchDocumentation(uri.href),
        },
      ],
    }),
  );

  return server;
}

async function toolResult(run: () => unknown | Promise<unknown>) {
  try {
    const result = await run();
    const structuredContent = asRecord(result);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(structuredContent) },
      ],
      structuredContent,
    };
  } catch (error) {
    const details = error instanceof ServiceError ? error.details : undefined;
    const structuredContent = {
      error: {
        code: error instanceof ServiceError ? error.code : "unexpected_error",
        message: error instanceof Error ? error.message : String(error),
        ...(details === undefined ? {} : { details }),
      },
    };
    return {
      isError: true,
      content: [
        { type: "text" as const, text: JSON.stringify(structuredContent) },
      ],
      structuredContent,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { result: value };
}

async function fetchDocumentation(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new ServiceError(
      "documentation_unavailable",
      `${response.status} ${response.statusText} from ${url}`,
    );
  }
  return response.text();
}

const AGENT_WORKFLOW = `# Safe Ekubo swap workflow

1. Search the token list and resolve each symbol to one unambiguous address and decimals.
2. Convert the user amount to base units without floating-point arithmetic.
3. Request a block-pinned route quote with explicit input/output direction.
4. Prepare Yul router calldata with the user's chosen slippage tolerance.
5. Simulate at the quote block. Use a sender for balance/allowance-aware simulation when possible.
6. Present the exact plan ID, token amounts, slippage bound, recipient, approval transaction, and unsigned swap transaction.
7. Re-simulate current state through the user's RPC and require explicit user confirmation.
8. Ask the user's wallet or signature tooling to sign and submit. Never send credentials to this server.
9. Re-quote and re-simulate after any change or stale block.
`;

const QUOTER_API = `# Ekubo quoter HTTP contract

Base URL: https://prod-api-quoter.ekubo.org

Canonical route:

GET /{chainId}/{signedAmount}/{specifiedToken}/{otherToken}

- Exact input X to Y for positive amount A: /{chainId}/{A}/{X}/{Y}
- Exact output X to Y for positive amount B: /{chainId}/-{B}/{Y}/{X}
- Amounts are integer token base units.
- The response contains block_number, block_hash, total_calculated,
  estimated_gas_cost, price_impact, and signed executable route splits.
- MCP callers should use ekubo_get_quote or ekubo_prepare_swap instead of
  constructing this signed URL themselves.
`;
