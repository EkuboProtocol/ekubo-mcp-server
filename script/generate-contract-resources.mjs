import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { getAddress } from "viem";

const execFileAsync = promisify(execFile);

const repository = path.resolve(process.argv[2] ?? "../evm-contracts");
const output = path.resolve(
  process.argv[3] ?? "src/contracts.generated.json",
);
const releaseSnapshot = JSON.parse(
  await readFile(
    new URL("./evm-contracts-release-deployments.json", import.meta.url),
    "utf8",
  ),
);
const broadcastRoot = path.join(repository, "broadcast");
const artifactRoot = path.join(repository, "out");
const sourceCommit = (
  await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"])
).stdout.trim();
const sourceTag = (
  await execFileAsync("git", [
    "-C",
    repository,
    "describe",
    "--tags",
    "--abbrev=0",
    "HEAD",
  ])
).stdout.trim();
const latestStableTag = (
  await execFileAsync("git", [
    "-C",
    repository,
    "tag",
    "--merged",
    "HEAD",
    "--list",
    "v*",
  ])
).stdout
  .trim()
  .split("\n")
  .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
  .sort(compareSemverTags)
  .at(-1);
if (latestStableTag !== releaseSnapshot.tag) {
  throw new Error(
    `Release deployment snapshot ${releaseSnapshot.tag} does not match latest stable source tag ${latestStableTag ?? "none"}`,
  );
}
const sourceReleaseCommit = (
  await execFileAsync("git", [
    "-C",
    repository,
    "rev-parse",
    `${releaseSnapshot.tag}^{commit}`,
  ])
).stdout.trim();
const sourceWorktreeDirty = (
  await execFileAsync("git", ["-C", repository, "status", "--porcelain"])
).stdout.trim().length > 0;

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
for (const group of releaseSnapshot.deployment_groups) {
  for (const chainId of group.chain_ids) {
    for (const contract of group.contracts) {
      recordDeployment({
        chainId,
        address: contract.address,
        name: contract.name,
        deploymentScript: group.deployment_script,
      });
    }
  }
}

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

    recordDeployment({
      chainId,
      address: transaction.contractAddress,
      name: transaction.contractName,
      deploymentScript: script,
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
  const contracts = (chains[deployment.chainId] ??= {});
  contracts[deployment.address] = {
    name: deployment.name,
    deployment_scripts: [...deployment.deploymentScripts].sort(),
  };
}

const generated = {
  schema_version: 2,
  source:
    "evm-contracts release deployment tables, Foundry broadcasts, and artifact snapshot",
  source_commit: sourceCommit,
  source_tag: sourceTag,
  source_release: {
    tag: releaseSnapshot.tag,
    commit: sourceReleaseCommit,
    url: releaseSnapshot.url,
  },
  source_worktree_dirty: sourceWorktreeDirty,
  chains,
  artifacts,
  abis,
  deployment_names_without_current_abi: unavailable,
};

await writeFile(output, `${JSON.stringify(generated, null, 2)}\n`);
console.log(
  `Wrote ${Object.keys(chains).length} chains, ${Object.keys(artifacts).length} ABIs, and ${
    deployments.size
  } unique deployments to ${output}`,
);
if (unavailable.length > 0) {
  console.warn(
    `Included deployment addresses without a current ABI artifact: ${unavailable.join(", ")}`,
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

function recordDeployment({ chainId, address, name, deploymentScript }) {
  const normalizedAddress = getAddress(address);
  const key = `${chainId}:${normalizedAddress.toLowerCase()}`;
  const previous = deployments.get(key);
  if (previous !== undefined && previous.name !== name) {
    throw new Error(
      `Conflicting contract names for ${key}: ${previous.name} and ${name}`,
    );
  }
  deployments.set(key, {
    chainId,
    address: normalizedAddress,
    name,
    deploymentScripts: new Set([
      ...(previous?.deploymentScripts ?? []),
      deploymentScript,
    ]),
  });
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

function compareSemverTags(left, right) {
  const leftParts = left.slice(1).split(".").map(Number);
  const rightParts = right.slice(1).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}
