import { type Address, decodeFunctionResult, encodeFunctionData, erc20Abi, getAddress } from "viem";
import { type PinnedBlock, type PrepareChain, RpcChain } from "./chain.js";
import { DISCLOSURE_VERSION } from "./content.js";
import { NATIVE_TOKEN, type PrepareEnv, type PrepareManifest, prepareManifest, requireChain } from "./contracts.js";
import { PROTOTYPE_NOTE, REFERENCE_RECOVERY, prepareError } from "./templates.js";

export const DEADLINE_SECONDS = 1200n;

export interface PrepareContext {
  manifest: PrepareManifest;
  chain: PrepareChain;
  block: PinnedBlock;
  sender: Address;
}

/** Tests inject a chain; the hosted server reads the configured RPC endpoint. */
export type ChainFactory = (env: PrepareEnv) => PrepareChain;

export const rpcChain: ChainFactory = (env) => {
  if (env.LAUNCHPAD_RPC_URL === undefined || env.LAUNCHPAD_RPC_URL === "") {
    throw prepareError("launchpad_not_configured");
  }
  return new RpcChain(env.LAUNCHPAD_RPC_URL);
};

export async function prepareContext(
  env: PrepareEnv,
  input: { chain_id: number; sender: string },
  chainFactory: ChainFactory,
): Promise<PrepareContext> {
  const manifest = prepareManifest(env);
  requireChain(manifest, input.chain_id);
  const chain = chainFactory(env);
  const block = await chain.latest();
  return { manifest, chain, block, sender: getAddress(input.sender) };
}

/** Fields shared by every preparation output. */
export function outputHeader(context: PrepareContext) {
  return {
    prototype: PROTOTYPE_NOTE,
    as_of: {
      chain_id: context.manifest.chain_id,
      block_number: context.block.number.toString(),
      block_hash: context.block.hash,
      block_timestamp: context.block.timestamp.toString(),
    },
    manifest_revision: context.manifest.git_revision,
    transaction_sender: context.sender,
    payer: context.sender,
    disclosure_version: DISCLOSURE_VERSION,
    disclosures_resource: "launchpad://disclosures",
    reference_recovery: REFERENCE_RECOVERY,
  };
}

export async function quoteDecimals(context: PrepareContext, token: Address): Promise<number> {
  if (token === NATIVE_TOKEN) return 18;
  const result = await context.chain.call({
    from: context.sender,
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "decimals" }),
    block: context.block,
  });
  if (!result.ok) throw prepareError("rpc_unavailable");
  return decodeFunctionResult({ abi: erc20Abi, functionName: "decimals", data: result.data });
}

export function approval(chainId: number, token: Address, spender: Address, amount: bigint) {
  return {
    chain_id: chainId.toString(),
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
    value: "0",
  };
}
