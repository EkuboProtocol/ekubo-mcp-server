import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { getAddress } from "viem";

const repository = path.resolve(process.argv[2] ?? "../evm-contracts");
const output = path.resolve(
  process.argv[3] ?? "src/contracts.generated.json",
);
const broadcastRoot = path.join(repository, "broadcast");
const artifactRoot = path.join(repository, "out");

const broadcastFiles = (await walk(broadcastRoot)).filter((file) => {
  const relative = path.relative(broadcastRoot, file);
  return (
    !relative.split(path.sep).includes("dry-run") &&
    /(?:^|\/)run-(?:[0-9]+|latest)\.json$/.test(
      relative.replaceAll(path.sep, "/"),
    )
  );
});

const deployments = new Map();
for (const file of broadcastFiles.sort()) {
  const broadcast = JSON.parse(await readFile(file, "utf8"));
  const chainId = String(broadcast.chain);
  if (chainId === "31337") continue;

  const script = path.relative(broadcastRoot, file).split(path.sep)[0];
  for (const transaction of broadcast.transactions ?? []) {
    if (
      !["CREATE", "CREATE2"].includes(transaction.transactionType) ||
      typeof transaction.contractAddress !== "string" ||
      typeof transaction.contractName !== "string"
    ) {
      continue;
    }

    const address = getAddress(transaction.contractAddress);
    const key = `${chainId}:${address.toLowerCase()}`;
    const previous = deployments.get(key);
    if (previous !== undefined && previous.name !== transaction.contractName) {
      throw new Error(
        `Conflicting contract names for ${key}: ${previous.name} and ${transaction.contractName}`,
      );
    }
    deployments.set(key, {
      chainId,
      address,
      name: transaction.contractName,
      deploymentScripts: new Set([
        ...(previous?.deploymentScripts ?? []),
        script,
      ]),
    });
  }
}

const names = [...new Set([...deployments.values()].map(({ name }) => name))]
  .sort();
const abis = {};
const artifacts = {};
const unavailable = [];

for (const name of names) {
  const artifactPath = path.join(artifactRoot, `${name}.sol`, `${name}.json`);
  let artifact;
  try {
    artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      unavailable.push(name);
      continue;
    }
    throw error;
  }

  const abi = artifact.abi;
  if (!Array.isArray(abi)) {
    throw new Error(`Artifact ${artifactPath} has no ABI array`);
  }
  const rawMetadata = JSON.parse(artifact.rawMetadata);
  const compilationTarget = rawMetadata.settings?.compilationTarget ?? {};
  const source = Object.entries(compilationTarget).find(
    ([, contractName]) => contractName === name,
  )?.[0];
  const serializedAbi = JSON.stringify(abi);

  abis[name] = abi;
  artifacts[name] = {
    source: source ?? null,
    artifact: path.posix.join("out", `${name}.sol`, `${name}.json`),
    abi_sha256: createHash("sha256").update(serializedAbi).digest("hex"),
  };
}

const chains = {};
for (const deployment of [...deployments.values()].sort(compareDeployments)) {
  if (abis[deployment.name] === undefined) continue;
  const contracts = (chains[deployment.chainId] ??= {});
  contracts[deployment.address] = {
    name: deployment.name,
    deployment_scripts: [...deployment.deploymentScripts].sort(),
  };
}

const generated = {
  schema_version: 1,
  source: "evm-contracts Foundry broadcast and artifact snapshot",
  chains,
  artifacts,
  abis,
  omitted_deployments_without_current_abi: unavailable,
};

await writeFile(output, `${JSON.stringify(generated, null, 2)}\n`);
console.log(
  `Wrote ${Object.keys(chains).length} chains, ${Object.keys(artifacts).length} ABIs, and ${
    [...deployments.values()].filter(({ name }) => abis[name] !== undefined).length
  } unique deployments to ${output}`,
);
if (unavailable.length > 0) {
  console.warn(
    `Omitted deployments without a current ABI artifact: ${unavailable.join(", ")}`,
  );
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(target)));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function compareDeployments(left, right) {
  return (
    BigInt(left.chainId) < BigInt(right.chainId)
      ? -1
      : BigInt(left.chainId) > BigInt(right.chainId)
        ? 1
        : left.address.localeCompare(right.address)
  );
}
