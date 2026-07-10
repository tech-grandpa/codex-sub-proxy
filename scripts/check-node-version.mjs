import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const version = (await readFile(new URL("../.node-version", import.meta.url), "utf8")).trim();
const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const major = version.split(".")[0];
const nodeTypesVersion = packageJson.devDependencies?.["@types/node"] ?? "";

assert.match(version, /^\d+\.\d+\.\d+$/, ".node-version must contain an exact semantic version");
assert.match(
  dockerfile,
  new RegExp(`^ARG NODE_VERSION=${escapeRegExp(version)}$`, "m"),
  "Dockerfile NODE_VERSION must match .node-version",
);
assert.equal(packageJson.engines?.node, version, "package.json engines.node must match the exact production version");
assert.match(nodeTypesVersion, /^\d+\.\d+\.\d+$/, "@types/node must be pinned to an exact version");
assert.equal(nodeTypesVersion.split(".")[0], major, "@types/node must match the production Node major");
assert.equal(
  (dockerfile.match(/FROM node:\$\{NODE_VERSION\}-alpine/g) ?? []).length,
  2,
  "Docker test/build dependencies and runtime stages must use the pinned Node image",
);

console.log(`Node runtime contract is harmonized at ${version}.`);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
