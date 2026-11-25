export type RampModeEnv = {
  /** "live" serves real MoonPay and Coinbase checkouts; anything else, including unset, is sandbox. */
  ONRAMP_MODE?: string;
};

export type RampMode = "sandbox" | "live";

/**
 * Real payments need an explicit opt-in: a missing or mistyped ONRAMP_MODE
 * falls back to sandbox, never to live.
 */
export function rampMode(env: RampModeEnv): RampMode {
  return env.ONRAMP_MODE === "live" ? "live" : "sandbox";
}
