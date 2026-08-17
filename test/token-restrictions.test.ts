import { describe, expect, it } from "bun:test";
import { ServiceError } from "../src/core.js";
import {
  assertAssetsTradable,
  isTokenCountryRestricted,
  requestCountry,
} from "../src/token-restrictions.js";

const ROBINHOOD_CHAIN = "4663";
const NATIVE = "0x0000000000000000000000000000000000000000";
/** NVDA, one of the restricted tokenized equities. */
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
/** AAPL, same list, mixed case to exercise address normalization. */
const AAPL = "0xAF3D76F1834A1D425780943C99EA8A608F8A93F9";
/** USDG on the same chain: not a restricted asset. */
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

function requestWithCountry(country?: string): Request {
  return { cf: country === undefined ? {} : { country } } as unknown as Request;
}

describe("request country", () => {
  it("reads the country Cloudflare resolved from the connecting IP", () => {
    expect(requestCountry(requestWithCountry("US"))).toBe("US");
  });

  it("reports an unresolved country as null", () => {
    expect(requestCountry(requestWithCountry())).toBeNull();
    expect(requestCountry(requestWithCountry(""))).toBeNull();
    expect(requestCountry({} as unknown as Request)).toBeNull();
  });

  it("treats a Tor request as an unresolved country", () => {
    expect(requestCountry(requestWithCountry("T1"))).toBeNull();
    expect(requestCountry(requestWithCountry("t1"))).toBeNull();
  });
});

describe("token country restrictions", () => {
  it("restricts a tokenized equity in a restricted country", () => {
    expect(
      isTokenCountryRestricted({
        chainId: ROBINHOOD_CHAIN,
        token: NVDA,
        country: "US",
      }),
    ).toBe(true);
  });

  it("allows a tokenized equity outside the restricted countries", () => {
    expect(
      isTokenCountryRestricted({
        chainId: ROBINHOOD_CHAIN,
        token: NVDA,
        country: "FR",
      }),
    ).toBe(false);
  });

  it("normalizes the country code and the token address", () => {
    expect(
      isTokenCountryRestricted({
        chainId: ROBINHOOD_CHAIN,
        token: AAPL,
        country: "us",
      }),
    ).toBe(true);
  });

  it("never restricts the native token", () => {
    for (const country of ["US", null]) {
      expect(
        isTokenCountryRestricted({
          chainId: ROBINHOOD_CHAIN,
          token: NATIVE,
          country,
        }),
      ).toBe(false);
    }
  });

  it("fails closed for a restricted asset when the country is unresolved", () => {
    expect(
      isTokenCountryRestricted({
        chainId: ROBINHOOD_CHAIN,
        token: NVDA,
        country: null,
      }),
    ).toBe(true);
  });

  // The chain-wide entry for Robinhood chain names no countries. An entry that
  // restricts nobody must not make an unresolved country restrict everything on
  // the chain — only the assets that are genuinely restricted fail closed.
  it("does not restrict an ordinary token when the country is unresolved", () => {
    expect(
      isTokenCountryRestricted({
        chainId: ROBINHOOD_CHAIN,
        token: USDG,
        country: null,
      }),
    ).toBe(false);
    expect(
      isTokenCountryRestricted({
        chainId: ROBINHOOD_CHAIN,
        token: USDG,
        country: "US",
      }),
    ).toBe(false);
  });

  it("does not restrict the same address on another chain", () => {
    expect(
      isTokenCountryRestricted({ chainId: "1", token: NVDA, country: null }),
    ).toBe(false);
    expect(
      isTokenCountryRestricted({ chainId: "1", token: NVDA, country: "US" }),
    ).toBe(false);
  });
});

describe("assertAssetsTradable", () => {
  it("passes when nothing is restricted", () => {
    expect(() =>
      assertAssetsTradable(
        [
          { chainId: ROBINHOOD_CHAIN, token: USDG },
          { chainId: ROBINHOOD_CHAIN, token: NVDA },
        ],
        "FR",
      ),
    ).not.toThrow();
  });

  it("skips an asset whose token was not supplied", () => {
    expect(() =>
      assertAssetsTradable(
        [{ chainId: ROBINHOOD_CHAIN, token: undefined }],
        "US",
      ),
    ).not.toThrow();
  });

  it("refuses to prepare anything touching a restricted asset", () => {
    let thrown: unknown;
    try {
      assertAssetsTradable(
        [
          { chainId: ROBINHOOD_CHAIN, token: USDG },
          { chainId: ROBINHOOD_CHAIN, token: NVDA },
        ],
        "US",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ServiceError);
    const error = thrown as ServiceError;
    expect(error.code).toBe("restricted_jurisdiction");
    expect(error.message).toContain("US");
    expect(error.details).toEqual({
      country: "US",
      restricted_assets: [{ chain_id: ROBINHOOD_CHAIN, token: NVDA }],
    });
  });

  it("reports an unresolved country without naming a region", () => {
    let thrown: unknown;
    try {
      assertAssetsTradable([{ chainId: ROBINHOOD_CHAIN, token: NVDA }], null);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ServiceError);
    const error = thrown as ServiceError;
    expect(error.code).toBe("restricted_jurisdiction");
    expect(error.message).toContain("could not be determined");
    expect((error.details as { country: unknown }).country).toBeNull();
  });
});
