// Copies package.json's version into manifest.json.
//
// Run automatically by npm's `version` lifecycle hook, so `npm version patch|minor|major` bumps
// both files as one step. Edits only the version line — rewriting the whole file through
// JSON.stringify would reformat a manifest that is otherwise hand-maintained.

import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const path = new URL("../manifest.json", import.meta.url);
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const before = readFileSync(path, "utf8");
const found = /("version":\s*)"([^"]*)"/.exec(before);

if (!found) {
  console.error("✗ No version field found in manifest.json.");
  process.exit(1);
}

if (found[2] === version) {
  console.log(`manifest.json already at ${version}`);
  process.exit(0);
}

writeFileSync(path, before.replace(found[0], `${found[1]}"${version}"`));
console.log(`manifest.json ${found[2]} -> ${version}`);
