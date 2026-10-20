import { describe, expect, test } from "bun:test";
import { type Address, keccak256, stringToHex } from "viem";
import { MINTABLE_ERC20_CREATION, MINTABLE_ERC20_CREATION_KECCAK } from "../../src/launchpad/zero-seed/mintable-erc20.js";
import { decodeOwnerCreate, localCreateBody } from "../../src/launchpad/zero-seed/owner.js";
import { LOCAL_INSTANCE_PINS } from "../../src/launchpad/zero-seed/policy.js";
import { launchSalts, predictLaunchToken } from "../../src/launchpad/zero-seed/token.js";
import { chain, fixture, freshTime, launchOf, owner, request } from "./zero-seed-fixture.js";

const instance = (pin = LOCAL_INSTANCE_PINS[0]) => ({ extension: pin.extension as Address, periphery: pin.periphery as Address });

describe("deterministic launch token identity (double-namespaced CREATE2 salt)", () => {
  test("creation code is the pinned 4,419-byte MintableERC20 init code", () => {
    expect((MINTABLE_ERC20_CREATION.length - 2) / 2).toBe(4419);
    expect(keccak256(MINTABLE_ERC20_CREATION)).toBe(MINTABLE_ERC20_CREATION_KECCAK);
  });

  for (const pin of LOCAL_INSTANCE_PINS) test(`prediction equals the token created on the local chain (${pin.quoteKind})`, () => {
    const created = launchOf(pin).events.find((e) => e.event === "LaunchCreated")!;
    expect(predictLaunchToken(instance(pin), owner, request(pin))).toBe(created.args.token as Address);
    expect(created.args.controller).toBe(pin.periphery);
  });

  test("salt = keccak(controller, keccak(owner, userSalt)), not either namespace alone", () => {
    const salt = request(LOCAL_INSTANCE_PINS[0]).salt as `0x${string}`;
    const { ownerSalt, tokenSalt } = launchSalts(owner, instance().periphery, salt);
    expect(ownerSalt).not.toBe(salt);
    expect(tokenSalt).not.toBe(ownerSalt);
    expect(launchSalts(owner, owner, salt).tokenSalt).not.toBe(tokenSalt);
  });

  test("owner, periphery, extension, salt, metadata and decimals each change the address", () => {
    const pin = LOCAL_INSTANCE_PINS[0];
    const base = request(pin);
    const actual = predictLaunchToken(instance(pin), owner, base);
    const other = LOCAL_INSTANCE_PINS[1];
    for (const [where, from, parameters] of [
      [{ ...instance(pin), periphery: other.periphery as Address }, owner, base],
      [{ ...instance(pin), extension: other.extension as Address }, owner, base],
      [instance(pin), chain.accounts.buyer as Address, base],
      [instance(pin), owner, { ...base, salt: `0x${"00".repeat(31)}02` }],
      [instance(pin), owner, { ...base, name: "Zero Seed n2" }],
      [instance(pin), owner, { ...base, symbol: "N2" }],
      [instance(pin), owner, { ...base, decimals: 6 }],
    ] as const) expect(predictLaunchToken(where, from, parameters)).not.toBe(actual);
  });

  test("owner decoder refuses a relabelled token even with a consistent pair", async () => {
    const f = fixture();
    const sealed = localCreateBody(await f.run());
    const expected = { pin: f.pin, owner, requested: request(f.pin) };
    const other = { ...request(f.pin), name: "Zero Seed nx" };
    expect(() => decodeOwnerCreate(sealed, { ...expected, requested: other }, freshTime())).toThrow("requested_mismatch");
    const body = JSON.parse(sealed.body);
    body.requested.name = "Zero Seed nx";
    const text = JSON.stringify(body);
    const resealed = { body: text, integrity: keccak256(stringToHex(text)), bytes: new TextEncoder().encode(text).length };
    expect(() => decodeOwnerCreate(resealed, { ...expected, requested: other }, freshTime())).toThrow("preview_token_mismatch");
  });
});
