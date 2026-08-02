import { YUL_ROUTER_ABI, YUL_ROUTER_ADDRESS } from "@ekubo/yul-router-sdk";
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
  source_commit: string;
  source_tag: string;
  source_worktree_dirty: boolean;
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
export const CONTRACT_CHAIN_TEMPLATE = "ekubo://contracts/evm/{chain_id}";
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
      "Use tools/list for transaction preparation. Contract resources provide provenance and read-only ABI context; wallets and MCP clients must not construct transaction calldata or transaction lists from them.",
    provenance: contractProvenance(),
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
    provenance: contractProvenance(),
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
    provenance: contractProvenance(),
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
    ...(contract.name === "VeToken"
      ? {
          vetoken_safety: {
            preferred_tools: [
              "ekubo_get_ve33_allocations",
              "ekubo_prepare_ve33_reallocation",
              "ekubo_prepare_ve33_vote",
              "ekubo_prepare_ve33_extend",
              "ekubo_prepare_ve33_stake",
              "ekubo_prepare_ve33_claim_all_fees",
              "ekubo_prepare_ve33_reinvest",
            ],
            forbidden_ownership_and_nft_actions: [
              "transferOwnership",
              "requestOwnershipHandover",
              "completeOwnershipHandover",
              "cancelOwnershipHandover",
              "renounceOwnership",
              "transferFrom",
              "safeTransferFrom",
              "approve (ERC721)",
              "setApprovalForAll",
              "burn",
            ],
            claim_current_pool_fees_before: [
              "vote",
              "clearVote",
              "extendStake",
              "extendStakeForDuration",
              "extendStakeMaxDuration",
              "mergeStakes (claim the full source NFT)",
              "withdrawStake",
              "withdrawStakeToSelf",
            ],
            fee_preserving_compound_functions: [
              "claimPoolFeesAndExtendStake",
              "claimPoolFeesAndExtendStakeForDuration",
              "claimPoolFeesAndExtendStakeMaxDuration",
              "claimPoolFeesAndExtendStakeToSelf",
              "claimPoolFeesAndExtendStakeToSelfForDuration",
              "claimPoolFeesAndExtendStakeToSelfMaxDuration",
              "claimPoolFeesAndMergeStakes",
              "claimPoolFeesAndMergeStakesToSelf",
            ],
            notes: [
              "vote replaces the old vote even when the pool and swap fee appear unchanged, so claim first even when claimable amounts are zero.",
              "splitStake preserves a nonzero source stake and its fee accounting; the child NFT starts unvoted.",
              "increaseStakeAmount adjusts a nonzero vote without fully clearing it and does not require a pre-claim.",
              "withdrawStake requires expiry; claim any active-pool fees first and verify the recipient.",
              "Never call burn on a stake-bearing NFT: it burns the representation without withdrawing the underlying Ve33 stake.",
              "Never construct ownership handover, ERC721 approval, or NFT transfer calldata from this ABI resource; those actions are outside the MCP server's safe workflows.",
            ],
          },
        }
      : {}),
  };
}

function contractProvenance() {
  return {
    source_repository: "evm-contracts",
    source_commit: catalog.source_commit,
    source_tag: catalog.source_tag,
    source_worktree_dirty_at_snapshot: catalog.source_worktree_dirty,
    note: catalog.source_worktree_dirty
      ? "The generated address/artifact snapshot included uncommitted source-repository changes; use source_commit plus ABI sha256 and deployment scripts for verification."
      : "The generated address/artifact snapshot came from a clean source-repository worktree.",
  };
}

export function contractChainIds(): string[] {
  return [
    ...new Set([...Object.keys(catalog.chains), ...YUL_ROUTER_CHAIN_IDS]),
  ].sort((left, right) =>
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
