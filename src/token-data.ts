import {
  type Address,
  encodeFunctionData,
  getAddress,
  type Hex,
} from "viem";
import { localFunctionResultMetadata } from "./abi-decode.js";
import { tokenDataFetcherContract } from "./contracts.js";
import { type Env, getChainTokens, ServiceError } from "./core.js";

const FUNCTION_NAME = "getNonzeroBalancesAndAllowances";

export async function prepareTokenBalancesAndAllowances(
  env: Env,
  input: {
    chainId: string;
    owner: string;
    spenders: string[];
    tokens?: string[];
  },
  fetcher: typeof fetch = fetch,
) {
  const contract = tokenDataFetcherContract(input.chainId);
  if (contract === undefined) {
    throw new ServiceError(
      "unsupported_chain",
      `TokenDataFetcher is not available on EVM chain ${input.chainId}`,
      { chain_id: input.chainId },
    );
  }

  const owner = getAddress(input.owner);
  const spenders = uniqueAddresses(input.spenders);
  const { tokens: upstreamTokens, sourceUrl } = await getChainTokens(
    env,
    { chainId: input.chainId },
    fetcher,
  );
  const canonicalTokens = upstreamTokens.map((token, index) => ({
    ...token,
    address: tokenAddress(token.address, `tokens[${index}].address`),
  }));
  const requested =
    input.tokens === undefined
      ? undefined
      : new Set(uniqueAddresses(input.tokens).map((value) => value.toLowerCase()));
  if (requested !== undefined) {
    const known = new Set(
      canonicalTokens.map((token) => token.address.toLowerCase()),
    );
    const unknown = [...requested].filter((value) => !known.has(value));
    if (unknown.length > 0) {
      throw new ServiceError(
        "unknown_token",
        `No canonical token on EVM chain ${input.chainId} matches ${unknown.join(", ")}`,
        { chain_id: input.chainId, unknown_tokens: unknown },
      );
    }
  }
  const selectedTokens =
    requested === undefined
      ? canonicalTokens
      : canonicalTokens.filter((token) =>
          requested.has(token.address.toLowerCase()),
        );
  const tokenAddresses = uniqueAddresses(
    selectedTokens.map((token) => token.address),
  );
  // Only the fields needed to join a returned balance back to a token. The
  // full upstream record carries logos, supply, and bridge metadata that this
  // read never uses, and at several hundred tokens that is the bulk of the
  // response. Callers wanting the rest have ekubo_get_token(s).
  const tokens = selectedTokens.map((token) => {
    const record = token as Record<string, unknown>;
    return {
      chain_id: record.chain_id,
      address: token.address,
      symbol: record.symbol,
      decimals: record.decimals,
      usd_price: record.usd_price,
    };
  });
  const data = encodeFunctionData({
    abi: contract.abi,
    functionName: FUNCTION_NAME,
    args: [owner, tokenAddresses, spenders],
  });

  return {
    action: "ekubo_read_token_balances_and_allowances",
    status: "not_executed",
    chain_id: input.chainId,
    caip2_chain_id: `eip155:${input.chainId}`,
    owner,
    spenders,
    token_universe: {
      source_url: sourceUrl,
      minimum_visibility_priority: 0,
      interface_equivalent_page_size: 10_000,
      scope: requested === undefined ? "entire_chain_list" : "requested_tokens",
      canonical_token_count: canonicalTokens.length,
      token_count: tokenAddresses.length,
      fields:
        "Join fields only. Call ekubo_get_token or ekubo_get_tokens for names, logos, supply, or bridge metadata.",
      tokens,
    },
    contract: {
      address: contract.address,
      name: "TokenDataFetcher",
      resource_uri: contract.resourceUri,
      function_name: FUNCTION_NAME,
    },
    block_parameter: "pending",
    rpc_request: {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: contract.address, data }, "pending"],
    },
    ...localFunctionResultMetadata({
      chainId: input.chainId,
      id: "ekubo-token-balances-and-allowances",
      to: contract.address,
      data,
      abi: contract.abi,
      functionName: FUNCTION_NAME,
    }),
    result_semantics: {
      balances:
        "One entry per requested token with a nonzero owner balance; the all-zero address represents the native token.",
      allowances:
        "One entry per non-native token and requested spender with a nonzero allowance.",
      omitted_values_are_zero: true,
      integers: "decimal_strings",
      addresses: "checksum",
    },
    instruction:
      "Execute rpc_request unchanged through the wallet's local provider, decode it with local_decode_plan, and join returned token addresses to token_universe.tokens. Never broadcast this read-only call.",
    cache: { mcp_result_storage: "none" },
  };
}

function uniqueAddresses(values: string[]): Address[] {
  const unique = new Map<string, Address>();
  for (const value of values) {
    const normalized = getAddress(value);
    unique.set(normalized.toLowerCase(), normalized);
  }
  return [...unique.values()];
}

function tokenAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw invalidTokenAddress(label, value);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw invalidTokenAddress(label, value);
  }
  if (parsed >= 1n << 160n) throw invalidTokenAddress(label, value);
  return getAddress(`0x${parsed.toString(16).padStart(40, "0")}` as Hex);
}

function invalidTokenAddress(label: string, value: unknown): ServiceError {
  return new ServiceError(
    "invalid_upstream_response",
    `${label} must be an EVM address`,
    { value },
  );
}
