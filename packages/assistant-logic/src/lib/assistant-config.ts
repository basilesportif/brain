// @ts-nocheck
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_REPO_ROOT = path.resolve(__dirname, "../..");
const LEGACY_CONTAINER_ROOT = path.join(os.homedir(), ".assistant-claude");
const DEFAULT_WORKSPACE_PATH = path.join(LEGACY_CONTAINER_ROOT, "workspace");

function existsDir(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function existsFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function requireAbsolutePath(value, envKey) {
  if (!path.isAbsolute(value)) {
    throw new Error(`${envKey} must be an absolute path: ${value}`);
  }
  return value;
}

function resolveAssistantContainerRoot(options = {}) {
  const env = options.env || process.env;
  const candidates = [
    ["ASSISTANT_HOME", "env:ASSISTANT_HOME"],
    ["ASSISTANT_CONTAINER_ROOT", "env:ASSISTANT_CONTAINER_ROOT"],
    ["ASSISTANT_CLAUDE_ROOT", "env:ASSISTANT_CLAUDE_ROOT"],
  ];

  for (const [key, source] of candidates) {
    if (env[key]) {
      return {
        path: requireAbsolutePath(env[key], key),
        source,
      };
    }
  }

  return {
    path: LEGACY_CONTAINER_ROOT,
    source: "legacy-default",
  };
}

function resolveWorkspaceInfo(options = {}) {
  const env = options.env || process.env;
  const mustExist = options.mustExist !== false;

  if (env.ASSISTANT_WORKSPACE) {
    const workspacePath = requireAbsolutePath(
      env.ASSISTANT_WORKSPACE,
      "ASSISTANT_WORKSPACE"
    );
    if (mustExist && !existsDir(workspacePath)) {
      throw new Error(`ASSISTANT_WORKSPACE directory does not exist: ${workspacePath}`);
    }
    return {
      workspacePath,
      containerRoot: path.dirname(workspacePath),
      source: "env:ASSISTANT_WORKSPACE",
    };
  }

  const container = resolveAssistantContainerRoot({ env });
  return {
    workspacePath: path.join(container.path, "workspace"),
    containerRoot: container.path,
    source:
      container.source === "legacy-default"
        ? "legacy-default"
        : `${container.source}/workspace`,
  };
}

function resolveWorkspacePath(options = {}) {
  return resolveWorkspaceInfo(options).workspacePath;
}

function findRepoRootFromCwd(cwd) {
  let current = path.resolve(cwd || process.cwd());
  while (true) {
    if (existsDir(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveRepoRoot(options = {}) {
  return path.resolve(
    options.repoRoot || findRepoRootFromCwd(options.cwd) || DEFAULT_REPO_ROOT
  );
}

function resolveTasksPath(options = {}) {
  return path.join(resolveWorkspacePath(options), "tasks");
}

function resolveRepoRegistryRoot(options = {}) {
  return path.join(resolveWorkspacePath(options), ".claude", "repo-registry");
}

export {
  DEFAULT_REPO_ROOT,
  DEFAULT_WORKSPACE_PATH,
  LEGACY_CONTAINER_ROOT,
  existsDir,
  existsFile,
  findRepoRootFromCwd,
  resolveAssistantContainerRoot,
  resolveRepoRegistryRoot,
  resolveRepoRoot,
  resolveTasksPath,
  resolveWorkspaceInfo,
  resolveWorkspacePath,

};
