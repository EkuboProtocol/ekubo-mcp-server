/**
 * Map-backed stand-in for the ARTIFACT_STORE R2 bucket. Tests read `entries`
 * directly to assert what was stored, and may rewind an entry's `uploaded`
 * timestamp to exercise read-time expiry.
 */
export function fakeArtifactStore() {
  const entries = new Map<string, { value: string; uploaded: Date }>();
  const bucket = {
    entries,
    async put(key: string, value: string) {
      entries.set(key, { value: String(value), uploaded: new Date() });
    },
    async get(key: string) {
      const entry = entries.get(key);
      if (entry === undefined) return null;
      return {
        uploaded: entry.uploaded,
        async text() {
          return entry.value;
        },
      };
    },
  };
  return bucket as unknown as R2Bucket & { entries: typeof entries };
}
