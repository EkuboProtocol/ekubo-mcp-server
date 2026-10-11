import { describe, expect, test } from "bun:test";
import { type Address, keccak256 } from "viem";
import { MINTABLE_ERC20_CREATION, MINTABLE_ERC20_CREATION_KECCAK } from "../../src/launchpad/zero-seed/mintable-erc20.js";
import { localCreateBody, decodeOwnerCreate } from "../../src/launchpad/zero-seed/owner.js";
import { LOCAL_INSTANCE_PINS } from "../../src/launchpad/zero-seed/policy.js";
import { predictLaunchToken } from "../../src/launchpad/zero-seed/token.js";
import { CAPTURED, creator, fixture, request } from "./zero-seed-fixture.js";

describe("deterministic launch token identity", () => {
  test("creation code is the pinned 4,419-byte MintableERC20 init code", () => {
    expect((MINTABLE_ERC20_CREATION.length - 2) / 2).toBe(4419);
    expect(keccak256(MINTABLE_ERC20_CREATION)).toBe(MINTABLE_ERC20_CREATION_KECCAK);
  });

  test("CREATE2 prediction reproduces the actual emitted l1 and l3 tokens", () => {
    const [high, low] = LOCAL_INSTANCE_PINS;
    expect(predictLaunchToken(high.address as Address, creator, request(high))).toBe(CAPTURED.l1.token);
    expect(predictLaunchToken(low.address as Address, creator, request(low))).toBe(CAPTURED.l3.token);
  });

  test("creator, salt, metadata, decimals and extension each change the address", () => {
    const pin = LOCAL_INSTANCE_PINS[0];
    const base = request(pin);
    const actual = predictLaunchToken(pin.address as Address, creator, base);
    for (const [extension, from, parameters] of [
      [LOCAL_INSTANCE_PINS[1].address, creator, base],
      [pin.address, "0x0000000000000000000000000000000000000123", base],
      [pin.address, creator, { ...base, salt: `0x${"00".repeat(31)}02` }],
      [pin.address, creator, { ...base, name: "Zero Seed l2" }],
      [pin.address, creator, { ...base, symbol: "L2" }],
      [pin.address, creator, { ...base, decimals: 6 }],
    ] as const) expect(predictLaunchToken(extension as Address, from as Address, parameters)).not.toBe(actual);
  });

  test("preview whose token is not the deterministic address refuses", async () => {
    const f = fixture();
    const [token0, token1] = ["0x1000000000000000000000000000000000000000" as Address, f.pin.quote as Address];
    f.setInstallation({ ...f.installation, token: token0, poolKey: { ...f.installation.poolKey, token0, token1 } });
    await expect(f.run()).rejects.toThrow("preview_token_mismatch");
  });

  test("owner decoder refuses a relabelled token even with a consistent pair", async () => {
    const f = fixture();
    const sealed = localCreateBody(await f.run());
    const expected = { pin: f.pin, creator, requested: request(f.pin) };
    const other = { ...request(f.pin), name: "Zero Seed lx" };
    expect(() => decodeOwnerCreate(sealed, { ...expected, requested: other }, 1000n)).toThrow("requested_mismatch");
    const body = JSON.parse(sealed.body);
    body.requested.name = "Zero Seed lx";
    const text = JSON.stringify(body);
    const resealed = { body: text, integrity: keccak256(new TextEncoder().encode(text)), bytes: new TextEncoder().encode(text).length };
    expect(() => decodeOwnerCreate(resealed, { ...expected, requested: other }, 1000n)).toThrow("preview_token_mismatch");
  });
});
