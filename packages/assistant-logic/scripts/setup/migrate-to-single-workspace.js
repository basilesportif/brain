#!/usr/bin/env node

/**
 * Migrates from multi-workspace layout to single-workspace layout.
 *
 * Old: <assistant container>/workspaces/<slug>/
 * New: <resolved workspace path>/
 *
 * With no env/config, the resolved destination remains the legacy
 * ~/.assistant-claude/workspace path. Generic destinations are opt-in through
 * ASSISTANT_WORKSPACE, ASSISTANT_HOME, or ASSISTANT_CONTAINER_ROOT.
 */

const fs = require("fs");
const path = require("path");
const {
  existsDir,
  existsFile,
  resolveRepoRoot,
  resolveWorkspaceInfo,
} = require("../lib/workspace");

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unknown argument: ${token}`);
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function usage() {
  return [
    "Usage: migrate-to-single-workspace.js [--dry-run] [--repo-root /abs/path]",
    "",
    "Destination resolution priority:",
    "  ASSISTANT_WORKSPACE",
    "  ASSISTANT_HOME/workspace or ASSISTANT_CONTAINER_ROOT/workspace",
    "  ASSISTANT_CLAUDE_ROOT/workspace",
    "  ~/.assistant-claude/workspace",
  ].join("\n");
}

function isSymlink(targetPath) {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink();
  } catch {
    return false;
  }
}

function pathExists(targetPath) {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function readSymlinkResolved(symlinkPath, repoRoot) {
  const target = fs.readlinkSync(symlinkPath);
  return path.resolve(repoRoot, target);
}

function removeAndCreateSymlink({ dryRun, prefix, symlinkPath, targetPath }) {
  if (pathExists(symlinkPath) && !isSymlink(symlinkPath)) {
    throw new Error(`workspace path exists but is not a symlink: ${symlinkPath}`);
  }
  if (isSymlink(symlinkPath) && !dryRun) {
    fs.unlinkSync(symlinkPath);
  }
  if (!dryRun) {
    fs.symlinkSync(targetPath, symlinkPath, "dir");
  }
  log(`${prefix}Updated workspace symlink: ${symlinkPath} -> ${targetPath}`);
}

function resolveMigrationPaths({ args, env }) {
  const repoRoot = resolveRepoRoot({
    repoRoot: typeof args["repo-root"] === "string" ? args["repo-root"] : undefined,
  });
  const workspaceInfo = resolveWorkspaceInfo({ env, mustExist: false });

  return {
    repoRoot,
    containerRoot: workspaceInfo.containerRoot,
    oldWorkspacesDir: path.join(workspaceInfo.containerRoot, "workspaces"),
    newWorkspacePath: workspaceInfo.workspacePath,
    pointerFile: path.join(repoRoot, ".workspace-path"),
    symlinkPath: path.join(repoRoot, "workspace"),
    workspaceSource: workspaceInfo.source,
  };
}

function printResolvedPaths(paths, prefix) {
  log(`${prefix}Resolved migration paths:`);
  log(`${prefix}  workspace source: ${paths.workspaceSource}`);
  log(`${prefix}  source workspaces dir: ${paths.oldWorkspacesDir}`);
  log(`${prefix}  destination: ${paths.newWorkspacePath}`);
  log(`${prefix}  symlink: ${paths.symlinkPath}`);
  log(`${prefix}  pointer file: ${paths.pointerFile}`);
}

function resolvePointer(pointer, repoRoot) {
  if (!pointer) return null;
  return path.isAbsolute(pointer) ? pointer : path.resolve(repoRoot, pointer);
}

function detectSourceWorkspace(paths) {
  if (existsFile(paths.pointerFile)) {
    const pointer = fs.readFileSync(paths.pointerFile, "utf-8").trim();
    const resolved = resolvePointer(pointer, paths.repoRoot);
    if (resolved && existsDir(resolved)) {
      return {
        sourceWorkspacePath: resolved,
        source: ".workspace-path",
      };
    }
  }

  if (isSymlink(paths.symlinkPath)) {
    const resolved = readSymlinkResolved(paths.symlinkPath, paths.repoRoot);
    if (existsDir(resolved)) {
      return {
        sourceWorkspacePath: resolved,
        source: "symlink",
      };
    }
  }

  if (existsDir(paths.oldWorkspacesDir)) {
    const entries = fs
      .readdirSync(paths.oldWorkspacesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    if (entries.length === 1) {
      return {
        sourceWorkspacePath: path.join(paths.oldWorkspacesDir, entries[0].name),
        source: "only workspace in workspaces/",
      };
    }
    if (entries.length > 1) {
      log(`ERROR: Multiple workspaces found under ${paths.oldWorkspacesDir}:`);
      for (const entry of entries) log(`  - ${entry.name}`);
      log(`Cannot auto-migrate. Move the desired workspace manually to ${paths.newWorkspacePath}`);
      process.exit(1);
    }
  }

  return {
    sourceWorkspacePath: null,
    source: null,
  };
}

function cleanupPointer({ dryRun, prefix, pointerFile }) {
  if (existsFile(pointerFile)) {
    if (!dryRun) fs.unlinkSync(pointerFile);
    log(`${prefix}Removed .workspace-path`);
  }
}

function cleanupOldWorkspacesDir({ dryRun, prefix, oldWorkspacesDir }) {
  if (!existsDir(oldWorkspacesDir)) return;
  const remaining = fs.readdirSync(oldWorkspacesDir);
  if (remaining.length === 0) {
    if (!dryRun) fs.rmdirSync(oldWorkspacesDir);
    log(`${prefix}Removed empty workspaces directory: ${oldWorkspacesDir}`);
  } else {
    log(`Note: ${oldWorkspacesDir} still has entries: ${remaining.join(", ")}`);
  }
}

function runMigration({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    log(usage());
    return;
  }

  const dryRun = args["dry-run"] === true;
  const prefix = dryRun ? "[dry-run] " : "";
  const paths = resolveMigrationPaths({ args, env });

  if (dryRun) {
    printResolvedPaths(paths, prefix);
  }

  if (existsDir(paths.newWorkspacePath)) {
    if (isSymlink(paths.symlinkPath)) {
      const resolved = readSymlinkResolved(paths.symlinkPath, paths.repoRoot);
      if (resolved === paths.newWorkspacePath) {
        log(`Already migrated. ${paths.newWorkspacePath} exists and symlink is correct.`);
        cleanupPointer({ dryRun, prefix, pointerFile: paths.pointerFile });
        return;
      }
    }

    removeAndCreateSymlink({
      dryRun,
      prefix,
      symlinkPath: paths.symlinkPath,
      targetPath: paths.newWorkspacePath,
    });
    cleanupPointer({ dryRun, prefix, pointerFile: paths.pointerFile });
    log("Migration complete (workspace already existed, fixed symlink).");
    return;
  }

  const { sourceWorkspacePath, source } = detectSourceWorkspace(paths);

  if (!sourceWorkspacePath) {
    log("No existing workspace found. Nothing to migrate.");
    log(`The workspace will be created at ${paths.newWorkspacePath} on next /setup.`);
    return;
  }

  log(`Source workspace: ${sourceWorkspacePath} (detected via ${source})`);
  log(`Destination: ${paths.newWorkspacePath}`);

  if (path.resolve(sourceWorkspacePath) === path.resolve(paths.newWorkspacePath)) {
    log("Source is already at the destination. Nothing to move.");
    return;
  }

  log(`${prefix}Moving ${sourceWorkspacePath} -> ${paths.newWorkspacePath}`);
  if (!dryRun) {
    fs.mkdirSync(path.dirname(paths.newWorkspacePath), { recursive: true });
    fs.renameSync(sourceWorkspacePath, paths.newWorkspacePath);
  }

  removeAndCreateSymlink({
    dryRun,
    prefix,
    symlinkPath: paths.symlinkPath,
    targetPath: paths.newWorkspacePath,
  });
  cleanupPointer({ dryRun, prefix, pointerFile: paths.pointerFile });
  cleanupOldWorkspacesDir({
    dryRun,
    prefix,
    oldWorkspacesDir: paths.oldWorkspacesDir,
  });

  log("");
  log(`${prefix}Migration complete!`);
  log(`Workspace is now at: ${paths.newWorkspacePath}`);
}

if (require.main === module) {
  try {
    runMigration();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exit(1);
  }
}

module.exports = {
  detectSourceWorkspace,
  parseArgs,
  resolveMigrationPaths,
  runMigration,
};
