// Validates the manifest and packs the .mcpb.
//
// manifest.json is the authoritative version — it is what Claude Desktop and the extensions
// directory read. package.json must agree with it, so a drift is a build failure rather than a
// bundle whose filename contradicts the manifest inside it.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const read = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));

const manifest = read("manifest.json");
const pkg = read("package.json");

if (manifest.version !== pkg.version) {
  console.error(
    `\n✗ Version mismatch: manifest.json is ${manifest.version}, package.json is ${pkg.version}.\n` +
    `  Use \`npm version patch|minor|major\` — it bumps both.`
  );
  process.exit(1);
}

// On Windows npx is npx.cmd, and execFile cannot launch a .cmd without a shell.
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const mcpb = (...args) =>
  execFileSync(npx, ["--yes", "@anthropic-ai/mcpb", ...args], { stdio: "inherit" });

mcpb("validate", "manifest.json");
mcpb("pack", ".", `${manifest.name}-${manifest.version}.mcpb`);
