import { type Address, decodeFunctionData, erc20Abi, type Hex } from "viem";

/**
 * Tokens whose `approve` reverts when it would overwrite a nonzero allowance
 * with another nonzero amount, so the allowance has to be set to zero first.
 *
 * This mirrors the Ekubo interface's
 * `EVM_TOKENS_REQUIRING_ALLOWANCE_RESET`, which keys the same rule by symbol
 * because it works from a user-selected token list. Here the exact address is
 * always known, so the entries are addresses: the bridged USDT deployments on
 * other chains are ordinary ERC-20s without the guard, and a symbol match
 * would make them pay for a reset they do not need.
 *
 * Every plan this server builds ends by returning the allowance to zero, so
 * within its own flows the second approval never collides. The collision is
 * cross-tool: the interface grants an *unlimited* allowance to the Positions
 * contract by default, so a user who added liquidity there and then came here
 * hits a standing nonzero allowance that this server, being stateless about
 * chain state, cannot see.
 *
 * - USDT (`TetherToken`) rejects it in `approve` directly.
 * - LDO is an Aragon MiniMe token, which carries the same guard as the
 *   documented mitigation for the ERC-20 approval race.
 */
const TOKENS_REQUIRING_ALLOWANCE_RESET: ReadonlyMap<
  bigint,
  ReadonlySet<bigint>
> = new Map([
  [
    1n,
    new Set([
      0xdac17f958d2ee523a2206206994597c13d831ec7n, // USDT
      0x5a98fcbea516cf06857215779fd812ca3bef1b32n, // LDO
    ]),
  ],
]);

export function requiresAllowanceReset(
  chainId: string | bigint,
  token: string | bigint,
): boolean {
  return (
    TOKENS_REQUIRING_ALLOWANCE_RESET.get(BigInt(chainId))?.has(
      BigInt(token),
    ) === true
  );
}

/**
 * The spender of an `approve` call that sets a nonzero allowance, or null for
 * anything else.
 *
 * A zero approval is excluded deliberately: revocations and the trailing
 * cleanup step are the very calls that clear the collision, and prefixing them
 * with another zero approval would add a step that does nothing. Calldata that
 * is not an `approve` at all decodes to null rather than throwing, because
 * step kinds are producer-assigned labels and a mislabeled step must not take
 * down the whole plan.
 */
export function nonzeroApprovalSpender(data: Hex): Address | null {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: erc20Abi, data });
  } catch {
    return null;
  }
  if (decoded.functionName !== "approve") return null;
  const [spender, amount] = decoded.args;
  return amount === 0n ? null : spender;
}
