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
  const tokenAddresses = uniqueAddresses(
    upstreamTokens.map((token, index) =>
      tokenAddress(token.address, `tokens[${index}].address`),
    ),
  );
  const tokens = upstreamTokens.map((token, index) => ({
    ...token,
    address: tokenAddress(token.address, `tokens[${index}].address`),
  }));
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
      token_count: tokenAddresses.length,
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
