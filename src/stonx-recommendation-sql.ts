/**
 * Exact 10,000-bps STONX Ve33 allocation plan for Robinhood Chain.
 *
 * src/recommendations.ts sends this query to Dune's SQL execution endpoint
 * exactly as written. It reads only Dune-maintained tables:
 * dex.trades and decoded Robinhood Chain events. It must never reference a
 * saved query, a materialized view or any other user-owned dataset. Those can
 * be deleted or renamed outside this repository, and every recommendation then
 * fails; test/recommendations.test.ts enforces that.
 *
 * Stages:
 *   1. Swap-level gross fees for trusted-token pairs over the last 14 days
 *      (Uniswap V3 and V4 on Robinhood Chain).
 *   2. opportunity_snapshot: one row per trusted pair with gross fees in the
 *      last 7 days, its pool role, momentum and evidence confidence. Gross fees
 *      are used because Ve33 voters receive the full voted pool fee. The prior
 *      7 days only diagnose momentum and are summed as their own window, so a
 *      pair with no earlier trades has exactly zero prior fees.
 *   3. Capped proportional production allocation over the USDG hub and spokes,
 *      a STONX/USDG infrastructure floor and direct-route experiments, with
 *      suggested swap fees and their Q64 encodings, summing to 10,000 bps.
 */
export const STONX_RECOMMENDATION_SQL = `
WITH
scan_params AS (
    SELECT now() - INTERVAL '14' DAY AS start_time,
           CAST(date_trunc('month', now() - INTERVAL '14' DAY) AS date) AS start_month,
           CAST(date(now() - INTERVAL '14' DAY) AS date) AS start_date,
           now() - INTERVAL '7' DAY AS recent_start
),
stock_token_versions AS (
    SELECT output_0 AS token_address,
           symbol_ AS canonical_symbol,
           row_number() OVER (
             PARTITION BY output_0
             ORDER BY call_block_number DESC, call_tx_index DESC
           ) AS rn
    FROM robinhood_robinhood.stockfactory_call_deploy
    WHERE call_block_date >= DATE '2026-05-22'
      AND call_success
),
trusted_tokens AS (
    SELECT token_address,
           token_address AS canonical_address,
           canonical_symbol
    FROM stock_token_versions
    WHERE rn = 1

    UNION ALL

    SELECT 0x0000000000000000000000000000000000000000,
           0x0000000000000000000000000000000000000000,
           'ETH'

    UNION ALL

    SELECT 0x0bd7d308f8e1639fab988df18a8011f41eacad73,
           0x0000000000000000000000000000000000000000,
           'ETH'

    UNION ALL

    SELECT 0x5fc5360d0400a0fd4f2af552add042d716f1d168,
           0x5fc5360d0400a0fd4f2af552add042d716f1d168,
           'USDG'
),
v3_pools AS (
    SELECT p.pool,
           p.fee
    FROM uniswap_v3_robinhood.uniswapv3factory_evt_poolcreated p
    LEFT JOIN trusted_tokens t0 ON t0.token_address = p.token0
    LEFT JOIN trusted_tokens t1 ON t1.token_address = p.token1
    WHERE p.evt_block_date >= DATE '2026-05-22'
      AND (t0.token_address IS NOT NULL OR t1.token_address IS NOT NULL)
),
v3_events AS (
    SELECT t.block_time,
           t.token_bought_address,
           t.token_sold_address,
           t.amount_usd,
           CAST(p.fee AS double) / 1000000.0 AS gross_fee_rate
    FROM dex.trades t
    CROSS JOIN scan_params x
    JOIN v3_pools p
      ON p.pool = t.project_contract_address
    WHERE t.blockchain = 'robinhood'
      AND t.project = 'uniswap'
      AND t.version = '3'
      AND t.block_month >= x.start_month
      AND t.block_date >= x.start_date
      AND t.block_time >= x.start_time
),
v4_pools AS (
    SELECT i.contract_address AS manager,
           i.id
    FROM uniswap_v4_robinhood.poolmanager_evt_initialize i
    LEFT JOIN trusted_tokens t0 ON t0.token_address = i.currency0
    LEFT JOIN trusted_tokens t1 ON t1.token_address = i.currency1
    WHERE i.evt_block_date >= DATE '2026-05-22'
      AND (t0.token_address IS NOT NULL OR t1.token_address IS NOT NULL)
),
v4_events AS (
    SELECT t.block_time,
           t.token_bought_address,
           t.token_sold_address,
           t.amount_usd,
           CAST(e.fee AS double) / 1000000.0 AS gross_fee_rate
    FROM dex.trades t
    CROSS JOIN scan_params x
    JOIN uniswap_v4_robinhood.poolmanager_evt_swap e
      ON e.evt_tx_hash = t.tx_hash
     AND e.evt_index = t.evt_index
     AND e.evt_block_date = t.block_date
     AND e.contract_address = t.project_contract_address
    JOIN v4_pools p
      ON p.manager = e.contract_address
     AND p.id = e.id
    WHERE t.blockchain = 'robinhood'
      AND t.project = 'uniswap'
      AND t.version = '4'
      AND t.block_month >= x.start_month
      AND t.block_date >= x.start_date
      AND t.block_time >= x.start_time
),
fee_events AS (
    SELECT * FROM v3_events
    UNION ALL
    SELECT * FROM v4_events
),
trusted_events AS (
    SELECT e.block_time,
           e.amount_usd,
           e.gross_fee_rate,
           least(bought.canonical_address, sold.canonical_address) AS asset0_address,
           greatest(bought.canonical_address, sold.canonical_address) AS asset1_address,
           CASE
             WHEN bought.canonical_address <= sold.canonical_address
               THEN bought.canonical_symbol
             ELSE sold.canonical_symbol
           END AS asset0_symbol,
           CASE
             WHEN bought.canonical_address <= sold.canonical_address
               THEN sold.canonical_symbol
             ELSE bought.canonical_symbol
           END AS asset1_symbol
    FROM fee_events e
    JOIN trusted_tokens bought ON bought.token_address = e.token_bought_address
    JOIN trusted_tokens sold ON sold.token_address = e.token_sold_address
),
pair_windows AS (
    SELECT concat('0x', to_hex(e.asset0_address), ':0x', to_hex(e.asset1_address))
             AS pair_key,
           e.asset0_address,
           max(e.asset0_symbol) AS asset0_symbol,
           e.asset1_address,
           max(e.asset1_symbol) AS asset1_symbol,
           count_if(e.block_time >= x.recent_start) AS recent_swap_count,
           sum(CASE WHEN e.block_time >= x.recent_start THEN e.amount_usd END)
             AS last_7d_volume_usd,
           sum(
             CASE WHEN e.block_time >= x.recent_start
               THEN e.amount_usd * e.gross_fee_rate END
           ) AS last_7d_gross_fees_usd,
           coalesce(
             sum(
               CASE WHEN e.block_time < x.recent_start
                 THEN e.amount_usd * e.gross_fee_rate END
             ),
             0
           ) AS prior_7d_gross_fees_usd
    FROM trusted_events e
    CROSS JOIN scan_params x
    GROUP BY 1, 2, 4
),
windowed AS (
    SELECT concat(asset0_symbol, '/', asset1_symbol) AS pair,
           *
    FROM pair_windows
    WHERE last_7d_gross_fees_usd > 0
),
classified AS (
    SELECT *,
           CASE
             WHEN (
               asset0_address = 0x0000000000000000000000000000000000000000
               OR asset1_address = 0x0000000000000000000000000000000000000000
             ) AND (
               asset0_address = 0x5fc5360d0400a0fd4f2af552add042d716f1d168
               OR asset1_address = 0x5fc5360d0400a0fd4f2af552add042d716f1d168
             ) THEN 'hub'
             WHEN (
               asset0_address = 0x5fc5360d0400a0fd4f2af552add042d716f1d168
               OR asset1_address = 0x5fc5360d0400a0fd4f2af552add042d716f1d168
             ) THEN 'production_spoke'
             WHEN (
               asset0_address = 0x0000000000000000000000000000000000000000
               OR asset1_address = 0x0000000000000000000000000000000000000000
             ) THEN 'direct_route_experiment'
             ELSE 'other_trusted'
           END AS pool_role,
           10000.0 * last_7d_gross_fees_usd / nullif(last_7d_volume_usd, 0)
             AS observed_recent_fee_bps,
           100.0 * (
             last_7d_gross_fees_usd / nullif(prior_7d_gross_fees_usd, 0) - 1
           ) AS recent_vs_prior_fee_trend_pct,
           last_7d_gross_fees_usd AS opportunity_score
    FROM windowed
),
opportunity_snapshot AS (
    SELECT pool_role,
           pair,
           pair_key,
           asset0_address,
           asset0_symbol,
           asset1_address,
           asset1_symbol,
           recent_swap_count,
           last_7d_volume_usd,
           last_7d_gross_fees_usd,
           observed_recent_fee_bps,
           recent_vs_prior_fee_trend_pct,
           opportunity_score,
           row_number() OVER (
             PARTITION BY pool_role
             ORDER BY opportunity_score DESC, pair_key
           ) AS opportunity_rank,
           CASE
             WHEN recent_vs_prior_fee_trend_pct <= -75 THEN 'cooling sharply'
             WHEN recent_vs_prior_fee_trend_pct >= 200 THEN 'recent spike'
             WHEN recent_swap_count < 1000 THEN 'thin activity'
             ELSE 'normal'
           END AS momentum_flag,
           CASE
             WHEN last_7d_gross_fees_usd >= 5000 AND recent_swap_count >= 5000 THEN 'high'
             WHEN last_7d_gross_fees_usd >= 1000 AND recent_swap_count >= 1000 THEN 'medium'
             ELSE 'low'
           END AS evidence_confidence
    FROM classified
),
plan_params AS (
    SELECT CAST(500 AS bigint) AS anchor_bps,
           CAST(500 AS bigint) AS exploration_bps,
           CAST(10000 - 500 - 500 AS bigint) AS production_bps,
           CAST(3000 AS bigint) AS hub_cap_bps,
           CAST(1200 AS bigint) AS spoke_cap_bps,
           CAST(20 AS bigint) AS candidate_count,
           CAST(5 AS bigint) AS experiment_count,
           CAST(20 AS double) AS anchor_fee_bps,
           CAST(25 AS double) AS fee_discount_pct
),
opportunity_fee AS (
    SELECT r.*,
           round(
             least(
               CASE WHEN r.pool_role = 'hub' THEN 5.0 ELSE 100.0 END,
               greatest(
                 CASE WHEN r.pool_role = 'hub' THEN 1.25 ELSE 5.0 END,
                 r.observed_recent_fee_bps * (100.0 - p.fee_discount_pct) / 100.0
               )
             ),
             2
           ) AS plan_swap_fee_bps
    FROM opportunity_snapshot r
    CROSS JOIN plan_params p
),
opportunity AS (
    SELECT f.*,
           CAST(
             CAST(
               floor(
                 CAST(f.plan_swap_fee_bps AS decimal(18, 2))
                   * DECIMAL '18446744073709551616'
                   / DECIMAL '10000'
               ) AS decimal(38, 0)
             ) AS varchar
           ) AS plan_swap_fee_q64
    FROM opportunity_fee f
),
candidates AS (
    SELECT o.*,
           CASE
             WHEN o.pool_role = 'hub' THEN p.hub_cap_bps
             ELSE p.spoke_cap_bps
           END AS allocation_cap_bps
    FROM opportunity o
    CROSS JOIN plan_params p
    WHERE (
      o.pool_role = 'hub'
      OR (o.pool_role = 'production_spoke' AND o.opportunity_rank <= p.candidate_count)
    )
      AND o.evidence_confidence <> 'low'
      AND o.opportunity_score > 0
),
candidate_totals AS (
    SELECT sum(opportunity_score) AS total_score
    FROM candidates
),
threshold_base AS (
    SELECT c.*,
           CAST(allocation_cap_bps AS double) / opportunity_score AS saturation_threshold
    FROM candidates c
),
threshold_order AS (
    SELECT t.*,
           row_number() OVER (
             ORDER BY saturation_threshold, pair_key
           ) AS saturation_rank
    FROM threshold_base t
),
ordered AS (
    SELECT t.*,
           sum(allocation_cap_bps) OVER (
             ORDER BY saturation_rank
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS cumulative_cap_bps,
           sum(opportunity_score) OVER (
             ORDER BY saturation_rank
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS cumulative_score,
           lead(saturation_threshold) OVER (ORDER BY saturation_rank)
             AS next_saturation_threshold
    FROM threshold_order t
),
boundaries AS (
    SELECT CAST(0 AS bigint) AS saturated_count,
           CAST(0 AS double) AS lower_threshold,
           min(saturation_threshold) AS next_threshold,
           CAST(p.production_bps AS double) / totals.total_score AS allocation_lambda
    FROM threshold_order
    CROSS JOIN plan_params p
    CROSS JOIN candidate_totals totals
    GROUP BY 1, 2, p.production_bps, totals.total_score

    UNION ALL

    SELECT saturation_rank,
           saturation_threshold,
           next_saturation_threshold,
           CAST(p.production_bps - cumulative_cap_bps AS double)
             / nullif(totals.total_score - cumulative_score, 0)
             AS allocation_lambda
    FROM ordered
    CROSS JOIN plan_params p
    CROSS JOIN candidate_totals totals
    WHERE p.production_bps >= cumulative_cap_bps
      AND totals.total_score > cumulative_score
),
chosen_lambda AS (
    SELECT allocation_lambda
    FROM boundaries
    WHERE allocation_lambda >= lower_threshold - 1e-15
      AND (
        next_threshold IS NULL
        OR allocation_lambda <= next_threshold + 1e-15
      )
    ORDER BY saturated_count DESC
    LIMIT 1
),
raw_production AS (
    SELECT c.*,
           least(
             CAST(c.allocation_cap_bps AS double),
             l.allocation_lambda * c.opportunity_score
           ) AS raw_target_bps
    FROM candidates c
    CROSS JOIN chosen_lambda l
),
floored_production AS (
    SELECT *,
           CAST(floor(raw_target_bps) AS bigint) AS floor_target_bps,
           raw_target_bps - floor(raw_target_bps) AS fractional_remainder
    FROM raw_production
),
production_rounding AS (
    SELECT p.production_bps - sum(f.floor_target_bps) AS bps_to_distribute
    FROM floored_production f
    CROSS JOIN plan_params p
    GROUP BY p.production_bps
),
ranked_rounding AS (
    SELECT f.*,
           row_number() OVER (
             ORDER BY fractional_remainder DESC, opportunity_score DESC, pair_key
           ) AS remainder_rank
    FROM floored_production f
),
production_plan AS (
    SELECT 'production' AS allocation_bucket,
           CASE WHEN pool_role = 'hub' THEN 1 ELSE 2 END AS bucket_order,
           opportunity_rank AS priority_rank,
           pair,
           pair_key,
           asset0_address,
           asset0_symbol,
           asset1_address,
           asset1_symbol,
           floor_target_bps
             + CASE
                 WHEN remainder_rank <= r.bps_to_distribute
                   AND floor_target_bps < allocation_cap_bps
                 THEN 1
                 ELSE 0
               END AS target_weight_bps,
           plan_swap_fee_bps AS suggested_swap_fee_bps,
           plan_swap_fee_q64 AS suggested_swap_fee_q64,
           last_7d_gross_fees_usd,
           last_7d_volume_usd,
           recent_vs_prior_fee_trend_pct,
           momentum_flag,
           evidence_confidence,
           allocation_cap_bps,
           'Recent gross-fee opportunity, capped and redistributed across the USDG hub-and-spoke network.'
             AS allocation_reason,
           'Create or verify the Ve33 pool, then claim current voter fees before the atomic split/vote reallocation.'
             AS required_action
    FROM ranked_rounding
    CROSS JOIN production_rounding r
),
anchor_plan AS (
    SELECT 'infrastructure' AS allocation_bucket,
           3 AS bucket_order,
           CAST(1 AS bigint) AS priority_rank,
           'STONX/USDG' AS pair,
           '0x570C5AA79C798E7A418412CC8399AE5BCCE570C5:0x5FC5360D0400A0FD4F2AF552ADD042D716F1D168'
             AS pair_key,
           0x570c5aa79c798e7a418412cc8399ae5bcce570c5 AS asset0_address,
           'STONX' AS asset0_symbol,
           0x5fc5360d0400a0fd4f2af552add042d716f1d168 AS asset1_address,
           'USDG' AS asset1_symbol,
           p.anchor_bps AS target_weight_bps,
           p.anchor_fee_bps AS suggested_swap_fee_bps,
           CAST(
             CAST(
               floor(
                 CAST(p.anchor_fee_bps AS decimal(18, 2))
                   * DECIMAL '18446744073709551616'
                   / DECIMAL '10000'
               ) AS decimal(38, 0)
             ) AS varchar
           ) AS suggested_swap_fee_q64,
           CAST(NULL AS double) AS last_7d_gross_fees_usd,
           CAST(NULL AS double) AS last_7d_volume_usd,
           CAST(NULL AS double) AS recent_vs_prior_fee_trend_pct,
           'infrastructure floor' AS momentum_flag,
           'policy' AS evidence_confidence,
           p.anchor_bps AS allocation_cap_bps,
           'Maintains reward-token liquidity and the route used to convert claimed fees back into STONX.'
             AS allocation_reason,
           'Existing canonical STONX/USDG Ve33 pool; claim before changing its zero-fee vote.'
             AS required_action
    FROM plan_params p
),
selected_experiments AS (
    SELECT o.*,
           row_number() OVER (ORDER BY opportunity_rank, pair_key) AS experiment_rank
    FROM opportunity o
    CROSS JOIN plan_params p
    WHERE o.pool_role = 'direct_route_experiment'
      AND o.opportunity_rank <= p.experiment_count
      AND o.evidence_confidence <> 'low'
),
experiment_totals AS (
    SELECT count(*) AS selected_count
    FROM selected_experiments
),
experiment_plan AS (
    SELECT 'exploration' AS allocation_bucket,
           4 AS bucket_order,
           e.experiment_rank AS priority_rank,
           e.pair,
           e.pair_key,
           e.asset0_address,
           e.asset0_symbol,
           e.asset1_address,
           e.asset1_symbol,
           CAST(
             floor(CAST(p.exploration_bps AS double) / nullif(t.selected_count, 0))
               + CASE
                   WHEN e.experiment_rank <= p.exploration_bps % nullif(t.selected_count, 0)
                   THEN 1
                   ELSE 0
                 END
             AS bigint
           ) AS target_weight_bps,
           e.plan_swap_fee_bps AS suggested_swap_fee_bps,
           e.plan_swap_fee_q64 AS suggested_swap_fee_q64,
           e.last_7d_gross_fees_usd,
           e.last_7d_volume_usd,
           e.recent_vs_prior_fee_trend_pct,
           e.momentum_flag,
           e.evidence_confidence,
           CAST(
             ceil(CAST(p.exploration_bps AS double) / nullif(t.selected_count, 0))
             AS bigint
           ) AS allocation_cap_bps,
           'Tests whether a direct ETH/stock route earns more fees per emitted STONX than the two-hop USDG route.'
             AS allocation_reason,
           'Create or verify this direct Ve33 pool; treat its weight as an epoch experiment.'
             AS required_action
    FROM selected_experiments e
    CROSS JOIN plan_params p
    CROSS JOIN experiment_totals t
)
SELECT allocation_bucket,
       priority_rank,
       pair,
       pair_key,
       asset0_address,
       asset0_symbol,
       asset1_address,
       asset1_symbol,
       target_weight_bps,
       CAST(target_weight_bps AS double) / 100.0 AS target_weight_pct,
       suggested_swap_fee_bps,
       suggested_swap_fee_q64,
       last_7d_gross_fees_usd,
       last_7d_volume_usd,
       recent_vs_prior_fee_trend_pct,
       momentum_flag,
       evidence_confidence,
       allocation_cap_bps,
       allocation_reason,
       required_action,
       sum(target_weight_bps) OVER () AS plan_total_weight_bps,
       p.fee_discount_pct
FROM (
    SELECT * FROM production_plan
    UNION ALL
    SELECT * FROM anchor_plan
    UNION ALL
    SELECT * FROM experiment_plan
) plan
CROSS JOIN plan_params p
ORDER BY bucket_order, target_weight_bps DESC, priority_rank, pair
`;
