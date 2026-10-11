/**
 * Every executable Yul router route carries a deadline as well as its
 * fee-inclusive threshold. The threshold bounds amounts, not time, and
 * continuous-auction pool fees can rise from the next second, so a route
 * signed now must not stay executable indefinitely. The default matches the
 * Ekubo interface; callers may only shorten it.
 */
export const DEFAULT_SWAP_DEADLINE_MINUTES = 30;
export const MAX_SWAP_DEADLINE_MINUTES = DEFAULT_SWAP_DEADLINE_MINUTES;

/**
 * Last Unix second, inclusive, at which the router accepts the route. After it
 * the router reverts with DeadlineExpired() (0x1ab7da6b).
 */
export function swapDeadline(
  deadlineMinutes: number = DEFAULT_SWAP_DEADLINE_MINUTES,
  nowMs: number = Date.now(),
): number {
  if (
    !Number.isInteger(deadlineMinutes) ||
    deadlineMinutes < 1 ||
    deadlineMinutes > MAX_SWAP_DEADLINE_MINUTES
  ) {
    throw new Error(
      `swap deadline must be a whole number of minutes from 1 to ${MAX_SWAP_DEADLINE_MINUTES}`,
    );
  }
  return Math.floor(nowMs / 1_000) + deadlineMinutes * 60;
}
