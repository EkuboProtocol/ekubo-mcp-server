import { describe, expect, it } from "bun:test";
import {
  MORPHO_VAULT_V2_CATALOG,
  getMorphoVaults,
  prepareMorphoVaultDeposit,
  prepareMorphoVaultRedeem,
  prepareMorphoVaultWithdraw,
} from "../src/morpho.js";
import { planStepKinds, planTargets } from "./plan-helpers.js";

const sender = "0x1111111111111111111111111111111111111111";

describe("Morpho Vault V2 preparations", () => {
  const baseVault = MORPHO_VAULT_V2_CATALOG.find((vault) => vault.chain_id === "8453")!;

  it("returns only a fixed local catalog with direct discovery guidance", () => {
    const result = getMorphoVaults();
    expect(result.network_access).toBe("none");
    expect(result.vaults).toHaveLength(3);
    expect(result.agent_market_data_discovery).toMatchObject({
      server_involvement: "none",
      graphql_endpoint: "https://api.morpho.org/graphql",
      skill_resource: "ekubo://skills/use-morpho",
    });
    expect(getMorphoVaults({ chainId: "8453" }).vaults).toHaveLength(1);
  });

  it("uses the official guarded Bundler3 route with exact approval cleanup", () => {
    const result = prepareMorphoVaultDeposit({
      chainId: baseVault.chain_id,
      sender,
      vault: baseVault.address,
      amount: "1000000",
      maxSharePriceRay: "1001000000000000000000000000",
    });
    const discovery = getMorphoVaults({ chainId: "8453" }).vaults[0];
    expect(planStepKinds(result)).toEqual(["approval", "execution", "allowance_cleanup"]);
    expect(planTargets(result)).toEqual([
      baseVault.asset.address,
      discovery.bundler3,
      baseVault.asset.address,
    ]);
    expect(result.details).toMatchObject({
      route: "Bundler3 via GeneralAdapter1",
      max_share_price_enforced_onchain: true,
      server_network_access: "none",
    });
  });

  it("uses direct vault calls for withdraw and redeem", () => {
    const withdraw = prepareMorphoVaultWithdraw({
      chainId: baseVault.chain_id,
      sender,
      vault: baseVault.address,
      amount: "1",
    });
    const redeem = prepareMorphoVaultRedeem({
      chainId: baseVault.chain_id,
      sender,
      vault: baseVault.address,
      shares: "1",
    });
    expect(planTargets(withdraw)).toEqual([baseVault.address]);
    expect(planTargets(redeem)).toEqual([baseVault.address]);
  });

  it("rejects vaults outside the fixed catalog", () => {
    expect(() => prepareMorphoVaultWithdraw({
      chainId: "8453",
      sender,
      vault: sender,
      amount: "1",
    })).toThrow("fixed Morpho Vault V2 catalog");
  });
});
