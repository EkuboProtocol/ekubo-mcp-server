# LP Position Bounds and Tick Calculations

When creating concentrated liquidity positions using `prepare_lp_position_deposit`, correct tick selection requires understanding how Ekubo ticks encode prices that account for token decimal differences.

## Tick Definition

An Ekubo tick encodes the price of token0 in terms of token1 as:

```
price = 1.000001^tick
```

Where `price = amount_token1 / amount_token0` in base units (accounting for decimals).

**The base is 1.000001, not Uniswap v3's 1.0001.** Ekubo ticks are 100× finer, so a tick produced by a Uniswap-style calculation is 100× too small. `MAX_TICK` is `88722835` (`evm-contracts/src/math/constants.sol`), which spans the intended price range only at 10⁻⁶ per tick; at 10⁻⁴ it would describe a price ratio of e^8872.

A convenient consequence: a tick is the natural log of the base-unit price, scaled by a million.

```
tick = ln(price_ratio) × 10^6
price_ratio = e^(tick / 10^6)
```

## Accounting for Token Decimals

The critical step is converting a human-readable price to the price ratio in base units.

For an ETH/USDC pair where:
- ETH (token0) has 18 decimals
- USDC (token1) has 6 decimals
- Market price: 1 ETH = 1874 USDC

The price ratio in base units is:

```
price_ratio = (1874 USDC × 10^6) / (1 ETH × 10^18)
            = 1874 × 10^(-12)
            = 1.874 × 10^(-9)
```

Then solve for tick:

```
tick = ln(1.874 × 10^(-9)) × 10^6
     = -20.09518 × 10^6
     ≈ -20,095,180
```

Checked against the live pool: mainnet ETH/USDC (pool `0x9efd…e4a4`, tick spacing 1024) reported tick `-20097371`, and `e^(-20.097371) × 10^12 ≈ 1870` USDC per ETH.

## Calculation in Code

Local, decimal-agnostic calculation (runs entirely on your device):

```javascript
const TICK_LOG_STEP = 1e-6; // Ekubo: price = 1.000001^tick

function priceToTick(price, token0Decimals, token1Decimals) {
  // Adjust price for decimals
  const priceRatio = price * Math.pow(10, token1Decimals - token0Decimals);

  // Calculate tick
  return Math.round(Math.log(priceRatio) / TICK_LOG_STEP);
}

function tickToPrice(tick, token0Decimals, token1Decimals) {
  const priceRatio = Math.exp(tick * TICK_LOG_STEP);
  return priceRatio * Math.pow(10, token0Decimals - token1Decimals);
}

// Example: ETH/USDC where ETH=1874 USDC
const tick = priceToTick(1874, 18, 6);
// Result: -20,095,180
```

## Range Width in Ticks

A tick is a log scale, so a range width is a *ratio*, not a percentage offset, and a symmetric tick band is not a symmetric percentage band: ±W ticks reaches `e^(W × 10^-6)` above and `e^(-W × 10^-6)` below.

```
width_ticks = ln(upper_price / lower_price) × 10^6
```

| Band | Ticks from center | Actual span |
| --- | --- | --- |
| ~±1% | ±10,000 | +1.005% / −0.995% |
| ~±5% | ±50,000 | +5.13% / −4.88% |
| ~±10% | ±100,000 | +10.52% / −9.52% |
| 2× up and down | ±693,147 | ×2 / ÷2 |

For an exact percentage, take the log directly: a −10% lower bound is `ln(0.9) × 10^6 = -105,361` ticks from center, while a +10% upper bound is `ln(1.1) × 10^6 = +95,310`.

## Tick Spacing Alignment

Positions must have bounds that are multiples of the pool's `tick_spacing`. Round outward — floor the lower bound, ceil the upper — so alignment never silently narrows the range you intended:

```javascript
function alignTick(tick, spacing, isLower) {
  const quotient = tick / spacing;
  const aligned = isLower ? Math.floor(quotient) : Math.ceil(quotient);
  return aligned * spacing;
}
```

Worked example, base tick -20,095,180 with a ±100,000-tick band and spacing 1024:

- Lower raw: -20,095,180 - 100,000 = -20,195,180
  - -20,195,180 / 1024 = -19,721.85 → floor = -19,722 → **-20,195,328**
- Upper raw: -20,095,180 + 100,000 = -19,995,180
  - -19,995,180 / 1024 = -19,526.54 → ceil = -19,526 → **-19,994,624**

That spans roughly $1,695 to $2,072 around $1,874.

## Composition Is a Property of Price, Not of Deposit

A concentrated position's token ratio is a function of `(range, current pool price)` alone. It is **not** a function of what you deposited. Depositing equal values buys a 50/50 position only at the instant of the mint, at the tick that was current then.

With `s = √p`, `sa = √lower_price`, `sb = √upper_price`, the share of position value held in token1 is:

```
fraction_token1 = (s - sa) / (2s - sa - s²/sb)
```

Narrow ranges amplify price moves into composition swings. In a ±3.8% range, a 0.5% price move shifts composition about 6.5 percentage points — roughly 13× amplification.

### Do every swap before minting, never after

When rebalancing to a target composition:

1. Gather every input first — withdrawn principal, claimed fees and rewards, wallet dust.
2. Swap all of it to the target ratio.
3. **Re-read the pool tick** with the pool's `current_state_query`, after the last swap has settled.
4. Pick bounds around that freshly read tick.
5. Mint once.

A swap executed after the mint moves the pool tick, and the position just created re-prices against it immediately. Observed on chain 4663 (USDG/SNDK): a position minted at 50.15/49.85 was followed by a small 12.93 USDG→SNDK top-up swap; that swap moved the tick from 20,461,447 to 20,466,586 — 5,139 ticks, about 0.51% in price — and the fresh position immediately read 43.4/56.6. The mint was correct; the swap after it caused the skew.

### Centering a 50/50 position

For 50/50, the center `(tick_lower + tick_upper) / 2` must land on the current tick. Both bounds are multiples of `tick_spacing`, so the center can only be a multiple of `tick_spacing / 2` — with spacing 1024, a multiple of 512. The current tick will rarely be one, so accept the small offset and expect the binding side to leave dust. Do not chase exactness with another swap afterward; that is the mistake above.

## Common Mistakes

**❌ Using the Uniswap tick base**
```javascript
const tick = Math.log(priceRatio) / Math.log(1.0001);  // WRONG: 100× too small
```

**❌ Treating price as tick directly**
```javascript
const tick = 1874;  // WRONG: this is not a tick at all
```

**❌ Forgetting decimal adjustment**
```javascript
const priceRatio = price;  // WRONG: ignores decimals
```

**❌ Swapping after the mint to fix the ratio**
The swap moves the tick and re-skews the position. Swap first, read the tick, then mint.

**✓ Correct approach**
```javascript
const priceRatio = 1874 * Math.pow(10, 6 - 18);
const tick = Math.round(Math.log(priceRatio) / 1e-6);
```

## Tool Requirements

When calling `prepare_lp_position_deposit`:

1. **Specify aligned bounds only**
   - `tick_lower` and `tick_upper` must be exact multiples of `pool.tick_spacing`
   - The MCP server validates this and returns `"invalid_bounds"` if not aligned

2. **For new pools**: provide `pool_key` and `initial_tick`
   - `initial_tick` should be aligned to the pool's tick spacing
   - Example: -20,095,180 for ETH/USDC at 1874

3. **For existing pools**: provide `pool_id` or use discovery first
   - Call `get_position_pool_candidates` to find existing pools
   - Verify the pool's `tick_spacing` before calculating bounds
   - Read the current tick with `current_state_query` rather than trusting the indexed snapshot, and read it *after* any swap you intend to make

## Debugging Misaligned Ticks

If you receive an `"invalid_bounds"` error:

1. Divide your tick by the pool's `tick_spacing`
2. Round outward (floor for lower, ceil for upper)
3. Multiply back by `tick_spacing`
4. Verify no precision is lost in the calculation

If the bounds are aligned but the resulting price range is absurd — off by roughly 100× in log terms — check that you used base 1.000001 rather than 1.0001.
