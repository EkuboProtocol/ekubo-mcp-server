/**
 * Map-backed stand-in for the PLAN_STORE KV namespace. Tests read `entries`
 * directly to assert what was stored and with which TTL.
 */
export function fakePlanStore() {
  const entries = new Map<string, { value: string; expirationTtl?: number }>();
  const kv = {
    entries,
    async put(
      key: string,
      value: string,
      options?: { expirationTtl?: number },
    ) {
      entries.set(key, {
        value: String(value),
        expirationTtl: options?.expirationTtl,
      });
    },
    async get(key: string) {
      return entries.get(key)?.value ?? null;
    },
  };
  return kv as unknown as KVNamespace & { entries: typeof entries };
}
