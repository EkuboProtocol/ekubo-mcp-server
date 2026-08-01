import {
  YUL_ROUTER_ABI,
  YUL_ROUTER_ADDRESS,
} from "@ekubo/yul-router-sdk";
import { type Address, getAddress } from "viem";
import generated from "./contracts.generated.json";

type Abi = readonly Record<string, unknown>[];

interface GeneratedDeployment {
  name: string;
  deployment_scripts: string[];
}

interface GeneratedArtifact {
  source: string | null;
  artifact: string;
  abi_sha256: string;
}

interface GeneratedCatalog {
  schema_version: number;
  source: string;
  chains: Record<string, Record<Address, GeneratedDeployment>>;
  artifacts: Record<string, GeneratedArtifact>;
  abis: Record<string, Abi>;
  omitted_deployments_without_current_abi: string[];
}

interface ResolvedContract {
  address: Address;
  name: string;
  deploymentScripts: readonly string[];
  addressSource: string;
  abiSource: string;
  source: string | null;
  abiSha256: string | null;
  abi: Abi;
}

const catalog = generated as unknown as GeneratedCatalog;

// These are the EVM networks on which the published SDK router is supported by
// the Ekubo interface. The address and ABI themselves always come from the SDK.
const YUL_ROUTER_CHAIN_IDS = new Set([
  "1",
  "8453",
  "4663",
  "42161",
  "84532",
  "46630",
  "421614",
  "11155111",
]);

export const CONTRACT_DIRECTORY_URI = "ekubo://contracts/evm";
export const CONTRACT_CHAIN_TEMPLATE =
  "ekubo://contracts/evm/{chain_id}";
export const CONTRACT_ADDRESS_TEMPLATE =
  "ekubo://contracts/evm/{chain_id}/{address}";

export function contractDirectory() {
  const chains = Object.fromEntries(
    contractChainIds().map((chainId) => {
      const contracts = contractsForChain(chainId);
      return [
        chainId,
        {
          contract_count: Object.keys(contracts).length,
          resource_uri: contractChainUri(chainId),
        },
      ];
    }),
  );

  return {
    schema_version: 1,
    purpose:
      "Read-only contract context for actions that are not available as first-class Ekubo MCP tools.",
    usage:
      "Prefer tools/list for supported actions. For an unsupported action, read the chain resource, then the exact chain/address resource for its ABI before constructing and simulating calldata.",
    templates: {
      chain: CONTRACT_CHAIN_TEMPLATE,
      contract: CONTRACT_ADDRESS_TEMPLATE,
    },
    chains,
  };
}

export function contractChainResource(chainId: string) {
  const contracts = contractsForChain(chainId);
  if (Object.keys(contracts).length === 0) return undefined;

  return {
    schema_version: 1,
    chain_id: chainId,
    contracts: Object.fromEntries(
      Object.entries(contracts).map(([address, contract]) => [
        address,
        {
          name: contract.name,
          abi_resource_uri: contractAddressUri(chainId, address),
          address_source: contract.addressSource,
        },
      ]),
    ),
    safety:
      "Treat this as construction metadata, not authorization. Verify chain code, ownership, balances, allowances, and simulate the exact calldata before requesting a signature.",
  };
}

export function contractAddressResource(chainId: string, address: string) {
  const contract = resolveContract(chainId, address);
  if (contract === undefined) return undefined;

  return {
    schema_version: 1,
    chain_id: chainId,
    address: contract.address,
    name: contract.name,
    deployment: {
      address_source: contract.addressSource,
      scripts: contract.deploymentScripts,
    },
    abi_snapshot: {
      source: contract.abiSource,
      solidity_source: contract.source,
      sha256: contract.abiSha256,
    },
    abi: contract.abi,
    safety:
      "Before signing, use the user's RPC/provider to verify deployed code and permissions and simulate the exact transaction. The MCP server never signs or submits it.",
  };
}

export function contractChainIds(): string[] {
  return [...new Set([...Object.keys(catalog.chains), ...YUL_ROUTER_CHAIN_IDS])]
    .sort((left, right) =>
      BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0,
    );
}

export function contractChainCompletions(value: string): string[] {
  return contractChainIds()
    .filter((chainId) => chainId.startsWith(value))
    .slice(0, 100);
}

export function contractAddressCompletions(
  chainId: string | undefined,
  value: string,
): string[] {
  if (chainId === undefined) return [];
  return Object.keys(contractsForChain(chainId))
    .filter((address) => address.toLowerCase().startsWith(value.toLowerCase()))
    .slice(0, 100);
}

export function contractChainUri(chainId: string): string {
  return `ekubo://contracts/evm/${chainId}`;
}

export function contractAddressUri(chainId: string, address: string): string {
  return `ekubo://contracts/evm/${chainId}/${address}`;
}

function contractsForChain(chainId: string): Record<Address, ResolvedContract> {
  const contracts = new Map<string, ResolvedContract>();
  for (const [address, deployment] of Object.entries(
    catalog.chains[chainId] ?? {},
  )) {
    const artifact = catalog.artifacts[deployment.name];
    const abi = catalog.abis[deployment.name];
    if (artifact === undefined || abi === undefined) continue;
    const normalized = getAddress(address);
    contracts.set(normalized.toLowerCase(), {
      address: normalized,
      name: deployment.name,
      deploymentScripts: deployment.deployment_scripts,
      addressSource: catalog.source,
      abiSource: `evm-contracts/${artifact.artifact}`,
      source: artifact.source,
      abiSha256: artifact.abi_sha256,
      abi,
    });
  }

  if (YUL_ROUTER_CHAIN_IDS.has(chainId)) {
    contracts.set(YUL_ROUTER_ADDRESS.toLowerCase(), {
      address: getAddress(YUL_ROUTER_ADDRESS),
      name: "YulRouter",
      deploymentScripts: [],
      addressSource: "@ekubo/yul-router-sdk",
      abiSource: "@ekubo/yul-router-sdk",
      source: null,
      abiSha256: null,
      abi: YUL_ROUTER_ABI as Abi,
    });
  }

  return Object.fromEntries(
    [...contracts.values()]
      .sort((left, right) => left.address.localeCompare(right.address))
      .map((contract) => [contract.address, contract]),
  ) as Record<Address, ResolvedContract>;
}

function resolveContract(
  chainId: string,
  requestedAddress: string,
): ResolvedContract | undefined {
  let normalized: Address;
  try {
    normalized = getAddress(requestedAddress);
  } catch {
    return undefined;
  }
  return Object.values(contractsForChain(chainId)).find(
    ({ address }) => address.toLowerCase() === normalized.toLowerCase(),
  );
}
