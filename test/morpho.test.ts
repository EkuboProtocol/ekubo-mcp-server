import { describe, expect, it } from "bun:test";
import { vaultBundlesV1Abi, vaultV2Abi } from "@morpho-org/morpho-sdk/abis";
import { getChainAddresses } from "@morpho-org/morpho-sdk/addresses";
import installedSdk from "../node_modules/@morpho-org/morpho-sdk/package.json" with { type: "json" };
import { decodeFunctionData, erc20Abi, zeroAddress } from "viem";
import {
  MORPHO_SDK_VERSION,
  MORPHO_VAULT_V2_CATALOG,
  getMorphoVaults,
  prepareMorphoVaultDeposit,
  prepareMorphoVaultRedeem,
  prepareMorphoVaultWithdraw,
} from "../src/morpho.js";
import { planStepKinds, planTargets, planTransactions, expectPlanScope } from "./plan-helpers.js";

const sender = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const owner = "0x3333333333333333333333333333333333333333";
const deadline = 4_000_000_000n;
const maxSharePrice = 1_001_000_000_000_000_000_000_000_000n;

// VaultBundlesV1 deployments whose verified source was checked on Sourcify
// for EKU-495. A registry change in a later SDK release must fail here first.
const VAULT_BUNDLES_V1: Record<string, `0x${string}`> = {
  "1": "0x02912516d49dE997db75B9D7858faAE59209650B",
  "8453": "0x2B08A911f48dE25A7e305D910Afb5597aBE8ea7B",
};

function decode(abi: Parameters<typeof decodeFunctionData>[0]["abi"], data: `0x${string}`) {
  return decodeFunctionData({ abi, data });
}

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
    for (const vault of result.vaults) {
      expect(vault.vault_bundles_v1).toBe(VAULT_BUNDLES_V1[vault.chain_id]);
      expect(vault).not.toHaveProperty("bundler3");
      expect(vault).not.toHaveProperty("general_adapter_1");
    }
  });

  it("reports the SDK version that is actually installed", () => {
    expect(MORPHO_SDK_VERSION).toBe(installedSdk.version);
    expect(getMorphoVaults().source.sdk_version).toBe(installedSdk.version);
  });

  for (const vault of MORPHO_VAULT_V2_CATALOG) {
    describe(`${vault.network} ${vault.name}`, () => {
      const spender = VAULT_BUNDLES_V1[vault.chain_id];

      it("resolves VaultBundlesV1 from the SDK for this exact chain", () => {
        expect(getChainAddresses(Number(vault.chain_id)).bundles?.vaultBundlesV1).toBe(
          spender,
        );
      });

      it("deposits through VaultBundlesV1 with the max share price and exact approval cleanup", () => {
        const result = prepareMorphoVaultDeposit({
          chainId: vault.chain_id,
          sender,
          vault: vault.address,
          amount: "1000000",
          maxSharePriceRay: maxSharePrice.toString(),
          deadline: deadline.toString(),
        });
        expectPlanScope(result, "non_trading");
        expect(planStepKinds(result)).toEqual(["approval", "execution", "allowance_cleanup"]);
        expect(planTargets(result)).toEqual([vault.asset.address, spender, vault.asset.address]);
        const [approval, execution, cleanup] = planTransactions(result);
        for (const transaction of [approval, execution, cleanup]) {
          expect(transaction.from).toBe(sender);
          expect(transaction.value).toBe("0");
        }

        expect(decode(erc20Abi, approval.data)).toEqual({
          functionName: "approve",
          args: [spender, 1_000_000n],
        });
        expect(decode(erc20Abi, cleanup.data)).toEqual({
          functionName: "approve",
          args: [spender, 0n],
        });
        // VaultBundlesV1 has no receiver argument: it deposits for msg.sender,
        // which is the plan's `from`.
        expect(decode(vaultBundlesV1Abi, execution.data)).toEqual({
          functionName: "vaultBundlesV1Deposit",
          args: [
            vault.address,
            1_000_000n,
            maxSharePrice,
            { kind: 0, data: "0x" },
            0n,
            zeroAddress,
            deadline,
          ],
        });
        expect(result.details).toMatchObject({
          route: "VaultBundlesV1",
          vault_bundles_v1: spender,
          shares_minted_to_sender_only: true,
          max_share_price_enforced_onchain: true,
          deadline: deadline.toString(),
          server_network_access: "none",
        });
        expect(result.request).toMatchObject({ recipient: sender, deadline: deadline.toString() });
      });

      it("withdraws with a direct vault call that keeps recipient and owner", () => {
        const result = prepareMorphoVaultWithdraw({
          chainId: vault.chain_id,
          sender,
          vault: vault.address,
          amount: "1000000",
          recipient,
          owner,
        });
        expectPlanScope(result, "non_trading");
        expect(planStepKinds(result)).toEqual(["execution"]);
        expect(planTargets(result)).toEqual([vault.address]);
        const [execution] = planTransactions(result);
        expect(execution.value).toBe("0");
        expect(decode(vaultV2Abi, execution.data)).toEqual({
          functionName: "withdraw",
          args: [1_000_000n, recipient, owner],
        });
        expect(result.details).toMatchObject({
          route: "direct vault call",
          delegated_owner_may_require_share_allowance: true,
        });
      });

      it("redeems with a direct vault call that keeps recipient and owner", () => {
        const result = prepareMorphoVaultRedeem({
          chainId: vault.chain_id,
          sender,
          vault: vault.address,
          shares: "1000000000000000000",
          recipient,
          owner,
        });
        expectPlanScope(result, "non_trading");
        expect(planStepKinds(result)).toEqual(["execution"]);
        expect(planTargets(result)).toEqual([vault.address]);
        const [execution] = planTransactions(result);
        expect(execution.value).toBe("0");
        expect(decode(vaultV2Abi, execution.data)).toEqual({
          functionName: "redeem",
          args: [1_000_000_000_000_000_000n, recipient, owner],
        });
      });

      it("defaults withdraw and redeem recipient and owner to the sender", () => {
        const withdraw = prepareMorphoVaultWithdraw({
          chainId: vault.chain_id,
          sender,
          vault: vault.address,
          amount: "1",
        });
        const redeem = prepareMorphoVaultRedeem({
          chainId: vault.chain_id,
          sender,
          vault: vault.address,
          shares: "1",
        });
        expect(decode(vaultV2Abi, planTransactions(withdraw)[0].data).args).toEqual([
          1n,
          sender,
          sender,
        ]);
        expect(decode(vaultV2Abi, planTransactions(redeem)[0].data).args).toEqual([
          1n,
          sender,
          sender,
        ]);
        expect(withdraw.details).toMatchObject({
          delegated_owner_may_require_share_allowance: false,
        });
      });
    });
  }

  it("accepts a deposit recipient that is the sender and rejects any other", () => {
    const input = {
      chainId: baseVault.chain_id,
      sender,
      vault: baseVault.address,
      amount: "1000000",
      maxSharePriceRay: maxSharePrice.toString(),
      deadline: deadline.toString(),
    };
    expect(prepareMorphoVaultDeposit({ ...input, recipient: sender }).request).toMatchObject({
      recipient: sender,
    });
    expect(() => prepareMorphoVaultDeposit({ ...input, recipient })).toThrow(
      "mint vault shares to the sender only",
    );
  });

  it("defaults the deposit deadline to two hours and rejects a past one", () => {
    const before = BigInt(Math.floor(Date.now() / 1000));
    const result = prepareMorphoVaultDeposit({
      chainId: baseVault.chain_id,
      sender,
      vault: baseVault.address,
      amount: "1",
      maxSharePriceRay: "1",
    });
    const args = decode(vaultBundlesV1Abi, planTransactions(result)[1].data).args!;
    const encoded = args[6] as bigint;
    expect(encoded >= before + 7_200n).toBe(true);
    expect(encoded <= before + 7_201n + 5n).toBe(true);
    expect(result.details).toMatchObject({ deadline: encoded.toString() });

    expect(() => prepareMorphoVaultDeposit({
      chainId: baseVault.chain_id,
      sender,
      vault: baseVault.address,
      amount: "1",
      maxSharePriceRay: "1",
      deadline: "1",
    })).toThrow("in the past");
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
