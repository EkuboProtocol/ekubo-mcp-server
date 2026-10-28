import { MORPHO_VAULT_V2_CATALOG } from "../src/morpho.js";

const sender = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const deadline = "4000000000";
export const dependencyFixtureNow = 1_800_000_000_000;
const v3 = {
  chain_id: "8453", sender, deadline: "1800001800",
  token0: "0x4200000000000000000000000000000000000006",
  token1: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

export const dependencyPlanCases = [
  ...MORPHO_VAULT_V2_CATALOG.flatMap((vault) => {
    const common = { chain_id: vault.chain_id, sender, vault: vault.address };
    return [
      { name: "prepare_morpho_vault_deposit", arguments: {
        ...common, amount: "9007199254740993", max_share_price_ray: "1001000000000000000000000000", deadline,
      } },
      { name: "prepare_morpho_vault_withdraw", arguments: {
        ...common, amount: "9007199254740993", recipient, owner: sender,
      } },
      { name: "prepare_morpho_vault_redeem", arguments: {
        ...common, shares: "9007199254740993", recipient, owner: sender,
      } },
    ];
  }),
  ...[false, true].map((use_native) => ({
    name: "prepare_uniswap_v3_add_liquidity", arguments: {
      ...v3, use_native, amount0: "9007199254740993", amount1: "2000000",
      amount0_min: "9007199254740000", amount1_min: "1900000",
      tick_lower: -120, tick_upper: 120, tick_spacing: 60, fee: 3000,
    },
  })),
  { name: "prepare_uniswap_v3_remove_liquidity", arguments: {
    ...v3, token_id: "9007199254740993", liquidity: "100",
    amount0_min: "1", amount1_min: "2", burn: true,
  } },
  { name: "prepare_uniswap_v3_collect_fees", arguments: { ...v3, token_id: "9007199254740993" } },
];

export const dependencyQuoteCases = [
  "4295128739", // minimum square-root price
  "78990846045029531151608375686", // lower tick -60
  "79228162514264337593543950336", // in range, tick 0
  "79466191966197645195421774833", // upper tick 60
  "1461446703485210103287273052203988822378723970341", // maximum minus one
].map((sqrt_price_x96) => ({
  tick_lower: -60, tick_upper: 60, tick_spacing: 60, sqrt_price_x96,
  amount0: "9007199254740993", amount1: "9007199254740995", slippage_bps: 1,
}));
