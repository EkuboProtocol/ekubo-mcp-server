import { ServiceError } from "../../core.js";

/**
 * A structured launchpad failure. `details.argument` names the input to change; `details.retryable` says whether the
 * same call may succeed later unchanged.
 */
export class LaunchpadError extends ServiceError {
  constructor(code: string, message: string, details?: { argument?: string; retryable?: boolean; [key: string]: unknown }) {
    super(code, message, details);
    this.name = "LaunchpadError";
  }
}

export function invalidArgument(argument: string, message: string, extra: Record<string, unknown> = {}): LaunchpadError {
  return new LaunchpadError("invalid_argument", `${argument}: ${message}`, { argument, retryable: false, ...extra });
}

export function supportDisabled(chainId: string | undefined): LaunchpadError {
  return new LaunchpadError(
    "launch_support_disabled",
    `No final zero-seed launch deployment is configured${chainId === undefined ? "" : ` for chain ${chainId}`}. Nothing was requested or prepared; launches cannot be read, created or traded here until a deployment is configured.`,
    { retryable: false, ...(chainId === undefined ? {} : { argument: "chain_id" }) },
  );
}
