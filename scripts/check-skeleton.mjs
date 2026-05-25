#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
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
  "CLAUDE.md",
  "entrypoints/telegram/package.json",
  "apps/web/package.json",
  "packages/runtime-core/package.json",
  "packages/config/workspace-schema/src/index.ts",
  "packages/config/workspace-schema/package.json",
  "packages/entrypoint-protocol/package.json",
  "packages/providers/codex/package.json",
  "packages/providers/claude-code/package.json",
  "packages/assistant-pack-schema/package.json",
  "packages/assistant-logic/package.json",
  "packages/assistant-logic/scripts/todo-add.js",
  "packages/assistant-logic/scripts/lib/todo-store.js",
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
  const allowed = dir === "private"
    ? new Set(["README.md", "setup-context.json"])
    : new Set(["README.md"]);
  const unexpected = entries.filter((entry) => !allowed.has(entry));
  if (unexpected.length > 0) {
    console.error(`${dir}/ contains non-placeholder entries: ${unexpected.join(", ")}`);
    failed = true;
  }
}

for (const relativePath of ["AGENTS.md", "docs/setup-plan.md", "assistant-packs/core/skills/setup-self-host/SKILL.md"]) {
  const content = await readFile(path.join(root, relativePath), "utf8");
  if (!content.includes("first-user")) {
    console.error(`${relativePath} must document first-user Telegram pairing as the default setup path`);
    failed = true;
  }
}

for (const relativePath of [
  "README.md",
  "docs/setup-plan.md",
  "docs/self-hosting.md",
  "entrypoints/telegram/README.md",
  "assistant-packs/core/skills/setup-self-host/SKILL.md"
]) {
  const content = await readFile(path.join(root, relativePath), "utf8");
  if (!content.includes("@BotFather") || !content.includes("/newbot") || !content.includes("/revoke")) {
    console.error(`${relativePath} must document BotFather /newbot setup and /revoke rotation guidance`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

console.log("brain skeleton check passed");
