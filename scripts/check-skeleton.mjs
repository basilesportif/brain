#!/usr/bin/env node
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const requiredPaths = [
  "package.json",
  "tsconfig.build.json",
  "tsconfig.base.json",
  "src/brainctl.ts",
  "pnpm-workspace.yaml",
  "README.md",
  "AGENTS.md",
  "entrypoints/telegram/package.json",
  "apps/web/package.json",
  "packages/runtime-core/package.json",
  "packages/config/workspace-schema/src/index.ts",
  "packages/config/workspace-schema/package.json",
  "packages/entrypoint-protocol/package.json",
  "packages/providers/codex/package.json",
  "packages/providers/claude-code/package.json",
  "packages/assistant-pack-schema/package.json",
  "assistant-packs/core/package.json",
  "assistant-packs/core/skills/setup-self-host/SKILL.md",
  "assistant-packs/core/skills/generated-web-page/SKILL.md",
  "assistant-packs/core/assistant-pack.json",
  "docs/directory-structure.md",
  "docs/brainctl.md",
  "docs/private-workspace-boundary.md",
  "docs/provider-abstraction.md",
  "docs/entrypoint-protocol.md",
  "docs/runtime-configuration.md",
  "docs/self-hosting.md",
  "docs/deployment.md",
  "docs/testing.md",
  "docs/public-readiness.md",
  "plans/2026-05-21-brain-monorepo-consolidation.md",
  "examples/config/runtime.yaml",
  "examples/config/runtime.toml"
];

const privateBoundaryDirs = ["workspace", "private", "data"];
let failed = false;

async function exists(relativePath) {
  try {
    await stat(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

for (const relativePath of requiredPaths) {
  if (!(await exists(relativePath))) {
    console.error(`missing required path: ${relativePath}`);
    failed = true;
  }
}

for (const dir of privateBoundaryDirs) {
  const entries = await readdir(path.join(root, dir));
  const unexpected = entries.filter((entry) => entry !== "README.md");
  if (unexpected.length > 0) {
    console.error(`${dir}/ contains non-placeholder entries: ${unexpected.join(", ")}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

console.log("brain skeleton check passed");
