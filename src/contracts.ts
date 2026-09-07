import { YUL_ROUTER_ABI, YUL_ROUTER_ADDRESS } from "@ekubo/yul-router-sdk";
import { type Abi as ViemAbi, type Address, getAddress } from "viem";
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
  source_release: {
    tag: string;
    commit: string;
    url: string;
  };
  source_worktree_dirty: boolean;
  chains: Record<string, Record<Address, GeneratedDeployment>>;
  artifacts: Record<string, GeneratedArtifact>;
  abis: Record<string, Abi>;
  deployment_names_without_current_abi: string[];
}

interface ResolvedContract {
  address: Address;
  name: string;
  deploymentScripts: readonly string[];
  addressSource: string;
  abiSource: string | null;
  source: string | null;
  abiSha256: string | null;
  abi: Abi | null;
}

const catalog = generated as unknown as GeneratedCatalog;

// These are the EVM networks on which the published SDK router is supported by
// the Ekubo interface. The router is not part of the generated catalog because
// it is built from a separate repository, so its chains are listed here; the
// address and ABI themselves always come from the SDK.
const YUL_ROUTER_CHAIN_IDS = new Set([
  "1",
  "10",
  "56",
  "100",
  "130",
  "137",
  "143",
  "480",
  "4326",
  "4663",
  "8453",
  "42161",
  "57073",
  "84532",
  "46630",
  "421614",
  "11155111",
]);

// evm-contracts v3.2.0 rebuilt the managers with a newer Solidity compiler,
// which changed their init code and so moved their CREATE2 addresses. Chains
// deployed before the recompile run the original managers, chains deployed
// after it run the recompiled ones, and the chains that predate it and were
// redeployed since carry both. Resolving against the generated catalog rather
// than a hand-kept chain list keeps this in step with the interface and the
// indexer, which both stay on the original manager wherever it exists, and
// makes the next chain correct without another edit here.
function preferredDeployment(
  chainId: string,
  candidates: readonly Address[],
): Address {
  const deployed = catalog.chains[chainId];
  const fallback = candidates[candidates.length - 1]!;
  if (deployed === undefined) return fallback;
  return (
    candidates.find((candidate) =>
      Object.hasOwn(deployed, getAddress(candidate)),
    ) ?? fallback
  );
}

// Original first, recompiled second: `preferredDeployment` takes the first of
// these that the chain actually has, and falls back to the recompiled address
// for a chain the catalog does not know, which is what a new deployment gets.
export const POSITIONS_V3_ADDRESSES = [
  getAddress("0x02D9876A21AF7545f8632C3af76eC90b5ad4b66D"),
  getAddress("0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326"),
] as const;

export const ORDERS_V3_ADDRESSES = [
  getAddress("0x3325428adB409c239E88ca472F50b0efe00E98B4"),
  getAddress("0x9bB520B6192F71ec3D015C8a74F914f9c94bF794"),
] as const;

/** The v3 Positions manager to build new transactions against on `chainId`. */
export function positionsV3Address(chainId: string): Address {
  return preferredDeployment(chainId, POSITIONS_V3_ADDRESSES);
}

/** The v3 Orders manager to build new transactions against on `chainId`. */
export function ordersV3Address(chainId: string): Address {
  return preferredDeployment(chainId, ORDERS_V3_ADDRESSES);
}

/**
 * Whether `address` is any generation of the v3 Positions manager. Recognizing
 * an existing position is deliberately not chain-aware: both generations are
 * live on several chains, so one minted through either must still resolve.
 */
export function isPositionsV3Address(address: Address): boolean {
  return POSITIONS_V3_ADDRESSES.includes(address as never);
}

/** Whether `address` is any generation of the v3 Orders manager. */
export function isOrdersV3Address(address: Address): boolean {
  return ORDERS_V3_ADDRESSES.includes(address as never);
}

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
          abi_available: contract.abi !== null,
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
      available: contract.abi !== null,
      source: contract.abiSource,
      solidity_source: contract.source,
      sha256: contract.abiSha256,
    },
    ...(contract.abi === null
      ? {
          abi_unavailable:
            "This release or broadcast deployment has no ABI artifact in the current evm-contracts checkout.",
        }
      : { abi: contract.abi }),
    safety:
      "Before signing, use the user's RPC/provider to verify deployed code and permissions and simulate the exact transaction. The MCP server never signs or submits it.",
    ...(contract.name === "VeToken"
      ? {
          vetoken_safety: {
            preferred_tools: [
              "get_ve33_allocations",
              "prepare_ve33_reallocation",
              "prepare_ve33_vote",
              "prepare_ve33_extend",
              "prepare_ve33_stake",
              "prepare_ve33_claim_all_fees",
              "prepare_ve33_clear_vote",
              "prepare_ve33_reinvest",
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
              "clearVote has a first-class tool: prepare_ve33_clear_vote pairs each clear with a claim of the same pool and reverts on a pool key that is not the stake's active one. Removing vote weight is not destructive to the stake, whose amount, lock end, and ownership all survive and whose vote can be re-applied, but the pool loses that weight and a pool with no vote weight charges a zero extension fee.",
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
    source_release: catalog.source_release,
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

export function tokenDataFetcherContract(chainId: string) {
  return namedContract(chainId, "TokenDataFetcher");
}

export function coreDataFetcherContract(chainId: string) {
  return namedContract(chainId, "CoreDataFetcher");
}

export function poolKeyIndexContract(chainId: string) {
  return namedContract(chainId, "PoolKeyIndex");
}

/**
 * Every BoostedFees extension deployed on a chain. There is more than one on
 * some chains, so this returns the set rather than a single address.
 */
export function boostedFeesAddresses(chainId: string): Address[] {
  return Object.values(contractsForChain(chainId))
    .filter((contract) => contract.name === "BoostedFees")
    .map((contract) => contract.address);
}

function namedContract(chainId: string, name: string) {
  const contract = Object.values(contractsForChain(chainId)).find(
    (candidate) => candidate.name === name,
  );
  if (contract === undefined) return undefined;
  if (contract.abi === null) return undefined;
  return {
    address: contract.address,
    abi: contract.abi as ViemAbi,
    resourceUri: contractAddressUri(chainId, contract.address),
  };
}

function contractsForChain(chainId: string): Record<Address, ResolvedContract> {
  const contracts = new Map<string, ResolvedContract>();
  for (const [address, deployment] of Object.entries(
    catalog.chains[chainId] ?? {},
  )) {
    const artifact = catalog.artifacts[deployment.name];
    const abi = catalog.abis[deployment.name] ?? null;
    const normalized = getAddress(address);
    contracts.set(normalized.toLowerCase(), {
      address: normalized,
      name: deployment.name,
      deploymentScripts: deployment.deployment_scripts,
      addressSource: catalog.source,
      abiSource:
        artifact === undefined ? null : `evm-contracts/${artifact.artifact}`,
      source: artifact?.source ?? null,
      abiSha256: artifact?.abi_sha256 ?? null,
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
