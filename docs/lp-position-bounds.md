# LP Position Bounds and Tick Calculations

When creating concentrated liquidity positions using `ekubo_prepare_lp_position_deposit`, correct tick selection requires understanding how Uniswap v3 ticks encode prices that account for token decimal differences.

## Tick Definition

A tick encodes the price of token0 in terms of token1 as:

```
price = 1.0001^tick
```

Where `price = amount_token1 / amount_token0` in base units (accounting for decimals).

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
tick = log₁.₀₀₀₀₁(1.874 × 10^(-9))
     = ln(1.874 × 10^(-9)) / ln(1.0001)
     ≈ -20,095,200
```

## Calculation in Code

Local, decimal-agnostic calculation (runs entirely on your device):

```javascript
function priceToTick(price, token0Decimals, token1Decimals) {
  // Adjust price for decimals
  const priceRatio = price * Math.pow(10, token1Decimals - token0Decimals);
  
  // Calculate tick
  const tick = Math.log(priceRatio) / Math.log(1.0001);
  
  return Math.round(tick);
}

// Example: ETH/USDC where ETH=1874 USDC
const tick = priceToTick(1874, 18, 6);
// Result: ~-20,095,200
```

## Tick Spacing Alignment

Positions must have bounds that are multiples of the pool's `tick_spacing`. For the standard 1024 spacing:

```
aligned_tick = (tick / 1024) * 1024
```

For example, with base tick -20,095,200:
- ±10% price range = ±2,000,000 ticks (approximately)
- Lower bound: -20,095,200 - 2,000,000 = -22,095,200
  - Aligned: -22,095,200 / 1024 = -21,577.5 → floor(-21,577.5) = -21,577 → -21,577 × 1024 = **-22,094,848**
- Upper bound: -20,095,200 + 2,000,000 = -18,095,200
  - Aligned: -18,095,200 / 1024 = -17,673.8 → ceil(-17,673.8) = -17,673 → -17,673 × 1024 = **-18,093,952**

Always verify alignment:
```javascript
const aligned = (Math.floor(tick / tickSpacing)) * tickSpacing;
```

## Common Mistakes

**❌ Treating price as tick directly**
```javascript
const tick = 1874;  // WRONG: this is 1874× too high
```

**❌ Forgetting decimal adjustment**
```javascript
const priceRatio = price;  // WRONG: ignores decimals
```

**✓ Correct approach**
```javascript
const priceRatio = 1874 * Math.pow(10, 6 - 18);
const tick = Math.log(priceRatio) / Math.log(1.0001);
```

## Tool Requirements

When calling `ekubo_prepare_lp_position_deposit`:

1. **Specify aligned bounds only**
   - `tick_lower` and `tick_upper` must be exact multiples of `pool.tick_spacing`
   - The MCP server validates this and returns `"invalid_bounds"` if not aligned

2. **For new pools**: provide `pool_key` and `initial_tick`
   - `initial_tick` should be aligned to the pool's tick spacing
   - Example: -20,095,200 for ETH/USDC at 1874

3. **For existing pools**: provide `pool_id` or use discovery first
   - Call `ekubo_get_position_pool_candidates` to find existing pools
   - Verify the pool's `tick_spacing` before calculating bounds

## Debugging Misaligned Ticks

If you receive `"invalid_bounds"` error:

1. Divide your tick by the pool's `tick_spacing`
2. Round to the nearest integer (floor for lower, ceil for upper)
3. Multiply back by `tick_spacing`
4. Verify no precision is lost in the calculation

Example:
```javascript
function alignTick(tick, spacing, isLower = true) {
  const quotient = tick / spacing;
  const aligned = isLower ? Math.floor(quotient) : Math.ceil(quotient);
  return aligned * spacing;
}

const lower = alignTick(-22095200, 1024, true);   // -22,094,848
const upper = alignTick(-18095200, 1024, false);  // -18,095,168
```
