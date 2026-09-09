/** Public API smoke test; no wallet or credentials, no transactions. */
import {
  discoverUniswapPools,
  getUniswapPool,
  getUniswapCharts,
  getUniswapPoolTicks,
} from "../src/uniswap/data.js";
import { chainSchema } from "../src/uniswap/common.js";
const results = [];
const chains = process.argv.slice(2).map((chain) => chainSchema.parse(chain));
if (!chains.length) chains.push("8453", "42161");
for (const chain_id of chains) {
  for (const version of ["v2", "v3", "v4"] as const) {
    const discovery = await discoverUniswapPools({
      chain_id,
      version,
      first: 10,
    });
    const pools = Object.values(
      discovery.data as Record<string, { address?: string; poolId?: string }[]>,
    )[0];
    if (!pools?.length)
      throw new Error(`No discovered pools for ${chain_id}/${version}`);
    const pool = pools[0].poolId ?? pools[0].address!;
    const details = await getUniswapPool({ chain_id, version, pool });
    const charts = await getUniswapCharts({
      chain_id,
      version,
      pool,
      duration: "WEEK",
    });
    const history = Object.values(
      charts.data as Record<
        string,
        { priceHistory?: unknown[]; historicalVolume?: unknown[] }
      >,
    )[0];
    if (!history?.historicalVolume?.length)
      throw new Error(`No volume history for ${chain_id}/${version}`);
    const ticks =
      version === "v2"
        ? null
        : await getUniswapPoolTicks({ chain_id, version, pool, first: 10 });
    const record = {
      chain_id,
      version,
      pool,
      discovered: pools.length,
      details: !!Object.values(details.data as object)[0],
      price_points: history.priceHistory?.length ?? 0,
      volume_points: history.historicalVolume.length,
      ticks: ticks
        ? (Object.values(ticks.data as Record<string, { ticks?: unknown[] }>)[0]
            ?.ticks?.length ?? 0)
        : null,
      chart_errors: charts.errors,
      fetched_at: charts.fetched_at,
    };
    console.log(JSON.stringify(record));
    results.push(record);
  }
}
if (results.length !== chains.length * 3)
  throw new Error("Incomplete test matrix");
