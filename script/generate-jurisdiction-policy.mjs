#!/usr/bin/env node
// Generates src/jurisdiction-policy.json, the token jurisdiction policy shared
// byte-for-byte with the Ekubo interface (src/util/common/jurisdictionPolicy.json).
//
//   node script/generate-jurisdiction-policy.mjs \
//     --issuer <rhj-assets.json> --issuer-retrieved-at <ISO-8601> \
//     --curated <curated-tokens.json> --curated-commit <sha>
//
// The class membership is monotone: every address already classified in the
// existing policy file stays classified, so an asset that disappears from a
// source remains restricted until someone removes it deliberately (and with
// review). New issuer-registry or curated listings are added.
//
//   node script/generate-jurisdiction-policy.mjs --check [--issuer <file>]
//
// Fetches (or reads) the live issuer registry and exits non-zero when it lists
// a chain-4663 asset the policy does not classify. That is change detection,
// not a permission: unclassified assets are held by the policy itself.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = join(ROOT, "src/jurisdiction-policy.json");
const ISSUER_REGISTRY_URL = "https://api.robinhood.com/rhj/assets";
const CHAIN_ID = "4663";

const POLICY_VERSION = "ekubo-token-jurisdictions-v2";

// EKU-853 (CLO, 2026-10-06). Both sides; no disposal exemption.
const PRODUCT_POLICY = ["AE", "CA", "CH", "GB", "SG", "US"];
const ISSUER_PROHIBITED_INVESTOR = [
  "BY", "CU", "IR", "KP", "MM", "RU", "SD", "SS", "SY", "UA", "VE",
];

// Exact addresses verified outside the RHJ Stock Token class. Being outside
// this class is not being outside all law; it only means this rule does not
// apply to them.
const OUTSIDE_CLASS = [
  { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", basis: "native" },
  { address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", symbol: "WETH", basis: "issuer_token_contracts_page" },
  { address: "0x570c5aa79c798e7a418412cc8399ae5bcce570c5", symbol: "STONX", basis: "ekubo_issued" },
  { address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", symbol: "USDG", basis: "issuer_token_contracts_page" },
];

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`unexpected argument ${key}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key.slice(2)] = true;
    else out[key.slice(2)] = argv[++i];
  }
  return out;
}

const lower = (address) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`bad address ${address}`);
  return address.toLowerCase();
};

function issuerAssets(bytes) {
  const parsed = JSON.parse(bytes);
  if (!Array.isArray(parsed.assets)) throw new Error("issuer registry: no assets array");
  const out = new Map();
  for (const asset of parsed.assets) {
    for (const deployment of asset.deployments ?? []) {
      if (String(deployment.chainId) !== CHAIN_ID) continue;
      out.set(lower(deployment.contractAddress), {
        symbol: asset.tokenSymbol,
        status: asset.status,
      });
    }
  }
  return out;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readIssuer(path) {
  if (typeof path === "string") return readFileSync(path);
  const response = await fetch(ISSUER_REGISTRY_URL);
  if (!response.ok) throw new Error(`issuer registry: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function existingPolicy() {
  try {
    return JSON.parse(readFileSync(POLICY_PATH, "utf8"));
  } catch {
    return undefined;
  }
}

async function check(options) {
  const policy = existingPolicy();
  if (!policy) throw new Error(`${POLICY_PATH} missing`);
  const chain = policy.chains[CHAIN_ID];
  const known = new Set([
    ...chain.rhj_stock_token.map((entry) => entry.address),
    ...chain.outside_class.map((entry) => entry.address),
  ]);
  const issuer = issuerAssets(await readIssuer(options.issuer));
  const missing = [...issuer.entries()].filter(([address]) => !known.has(address));
  const outside = new Set(chain.outside_class.map((entry) => entry.address));
  const conflicting = [...issuer.keys()].filter((address) => outside.has(address));
  for (const [address, { symbol }] of missing) {
    console.log(`unclassified issuer listing: ${symbol} ${address}`);
  }
  for (const address of conflicting) {
    console.log(`issuer lists an address the policy places outside the class: ${address}`);
  }
  console.log(`issuer registry: ${issuer.size} chain-${CHAIN_ID} assets; policy class: ${chain.rhj_stock_token.length}`);
  if (missing.length > 0 || conflicting.length > 0) process.exit(1);
}

function requireOptions(options, names) {
  for (const name of names) {
    if (typeof options[name] !== "string") throw new Error(`--${name} is required`);
  }
}

// Lines are "<address> [symbol]"; the symbol is used only when no other source
// names the asset. The v1 list is a one-time seed: once it is in the policy
// file, the monotone carry-over keeps it.
function readLegacy(path) {
  if (typeof path !== "string") return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([address]) => address)
    .map(([address, symbol]) => ({ address: lower(address), symbol }));
}

function classMembers({ previousClass, legacy, issuer, curated }) {
  const outside = new Set(OUTSIDE_CLASS.map((entry) => entry.address));
  const members = new Map();
  const add = (address, symbol, source) => {
    if (outside.has(address)) {
      if (source === "issuer_registry") {
        throw new Error(`issuer registry lists ${address}, which is configured outside the class`);
      }
      return;
    }
    const entry = members.get(address) ?? { address, symbol, sources: new Set() };
    entry.symbol ??= symbol;
    entry.sources.add(source);
    members.set(address, entry);
  };
  for (const entry of previousClass) {
    for (const source of entry.sources) add(entry.address, entry.symbol, source);
  }
  for (const { address, symbol } of legacy) add(address, symbol, "ekubo_v1");
  for (const [address, { symbol }] of issuer) add(address, symbol, "issuer_registry");
  for (const [address, symbol] of curated) add(address, symbol, "curated");
  return [...members.values()]
    .sort((a, b) => (a.address < b.address ? -1 : 1))
    .map((entry) => {
      // Issuer symbol wins; fall back to curated, then earlier sources.
      const symbol = issuer.get(entry.address)?.symbol ?? curated.get(entry.address) ?? entry.symbol;
      if (symbol === undefined) throw new Error(`no symbol for ${entry.address}`);
      return { address: entry.address, symbol, sources: [...entry.sources].sort() };
    });
}

async function generate(options) {
  requireOptions(options, ["issuer", "issuer-retrieved-at", "curated", "curated-commit"]);
  const issuerBytes = await readIssuer(options.issuer);
  const issuer = issuerAssets(issuerBytes);
  const curatedBytes = readFileSync(options.curated);
  const curated = new Map(
    JSON.parse(curatedBytes)
      .tokens.filter((token) => String(token.chain_id) === CHAIN_ID)
      .map((token) => [lower(token.token_address), token.token_symbol]),
  );
  const previous = existingPolicy();
  const legacy = readLegacy(options.legacy);
  const members = classMembers({
    previousClass: previous?.chains?.[CHAIN_ID]?.rhj_stock_token ?? [],
    legacy,
    issuer,
    curated,
  });

  const policy = {
    policy_version: POLICY_VERSION,
    decision: "EKU-853 (CLO, 2026-10-06)",
    classes: {
      rhj_stock_token: {
        description:
          "Robinhood Assets (Jersey) Limited Stock Tokens: tokenised debt securities tracking equities or ETFs, identified by chain ID and exact contract address.",
        sides: ["buy", "sell"],
        restricted_jurisdictions: {
          product_policy: PRODUCT_POLICY,
          issuer_prohibited_investor: ISSUER_PROHIBITED_INVESTOR,
        },
      },
    },
    sources: {
      issuer_registry: {
        url: ISSUER_REGISTRY_URL,
        retrieved_at: options["issuer-retrieved-at"],
        sha256: sha256(issuerBytes),
        chain_assets: issuer.size,
      },
      curated: {
        repository: "EkuboProtocol/default-tokens",
        path: "curated-tokens.json",
        commit: options["curated-commit"],
        sha256: sha256(curatedBytes),
        chain_tokens: curated.size,
      },
      ekubo_v1: previous?.sources?.ekubo_v1 ?? {
        policy_version: "ekubo-token-jurisdictions-v1",
        addresses: legacy.length,
      },
    },
    chains: {
      [CHAIN_ID]: {
        unclassified: "hold",
        outside_class: OUTSIDE_CLASS,
        rhj_stock_token: members,
      },
    },
  };
  const text = `${JSON.stringify(policy, null, 2)}\n`;
  writeFileSync(POLICY_PATH, text);
  console.log(`wrote ${POLICY_PATH}: ${members.length} class members, sha256 ${sha256(text)}`);
}

const options = args();
await (options.check ? check(options) : generate(options));
