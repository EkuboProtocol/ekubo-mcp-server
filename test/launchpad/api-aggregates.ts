// The launch API's list aggregates (zero-seed-launch-api/v7) over the given wire rows, for mocked list bodies:
// one group per (chain, quote token) in chain then address order, USD sums over priced launches only.
type Row = { chain_id: string; quote_token: { address: string }; market: Record<string, any> };

const micros = (usd: string) => BigInt(usd.replace(".", ""));
const usd = (value: bigint) => `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0")}`;
const usdSum = (rows: Row[], field: string) => {
  const priced = rows.filter((row) => row.market[field] !== null);
  return priced.length === 0 ? null : usd(priced.reduce((sum, row) => sum + micros(row.market[field]), 0n));
};

export function listAggregates(rows: Row[]) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.chain_id}:${row.quote_token.address}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
  const ordered = [...groups.values()].sort((a, b) =>
    cmp(BigInt(a[0].chain_id), BigInt(b[0].chain_id)) || cmp(BigInt(a[0].quote_token.address), BigInt(b[0].quote_token.address)));
  const priced = rows.filter((row) => row.market.volume_usd !== null);
  return {
    launch_count: rows.length,
    trade_count: rows.reduce((sum, row) => sum + row.market.trade_count, 0),
    by_quote: ordered.map((group) => ({
      chain_id: group[0].chain_id, quote_token: group[0].quote_token.address, launch_count: group.length,
      trade_count: group.reduce((sum, row) => sum + row.market.trade_count, 0),
      volume: group.reduce((sum, row) => sum + BigInt(row.market.volume), 0n).toString(),
      market_cap: group.reduce((sum, row) => sum + BigInt(row.market.market_cap), 0n).toString(),
      usd_priced: group[0].market.volume_usd !== null,
      volume_usd: usdSum(group, "volume_usd"), market_cap_usd: usdSum(group, "market_cap_usd"),
    })),
    usd: {
      volume: usdSum(priced, "volume_usd"), market_cap: usdSum(priced, "market_cap_usd"),
      priced_launch_count: priced.length, excluded_launch_count: rows.length - priced.length,
    },
  };
}
