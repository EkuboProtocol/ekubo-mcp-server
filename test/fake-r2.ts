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
