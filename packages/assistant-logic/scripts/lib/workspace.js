const path = require("path");
const {
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
} = require("./assistant-config");

const CONTAINER_ROOT = LEGACY_CONTAINER_ROOT;

function getDefaultRepoRoot() {
  return DEFAULT_REPO_ROOT;
}

function getRepoRoot(options = {}) {
  return options.repoRoot || resolveRepoRoot(options);
}

function getContainerRoot(options = {}) {
  return resolveAssistantContainerRoot(options).path;
}

function getWorkspaceSymlink(options = {}) {
  return path.join(getRepoRoot(options), "workspace");
}

function getWorkspaceContext(options = {}) {
  const env = options.env || process.env;
  const repoRoot = resolveRepoRoot(options);
  const workspaceInfo = options.workspacePath
    ? {
        workspacePath: options.workspacePath,
        containerRoot: path.dirname(options.workspacePath),
        source: "option:workspacePath",
      }
    : resolveWorkspaceInfo({ env, mustExist: options.mustExist });

  return {
    repoRoot,
    containerRoot: workspaceInfo.containerRoot,
    workspacePath: workspaceInfo.workspacePath,
    source: workspaceInfo.source,
    symlinkPath: getWorkspaceSymlink({ repoRoot }),
  };
}

function getWorkspacePaths(contextOrOptions = {}) {
  const context = contextOrOptions.workspacePath
    ? contextOrOptions
    : getWorkspaceContext(contextOrOptions);

  return {
    ...context,
    dataDir: path.join(context.workspacePath, "data"),
    workspaceEnvPath: path.join(context.workspacePath, ".env"),
    composioPath: path.join(context.workspacePath, "composio.yaml"),
    messagingPath: path.join(context.workspacePath, "messaging.yaml"),
    protonmailPath: path.join(context.workspacePath, "protonmail.yaml"),
  };
}

function resolveTaskWorkspace(options = {}) {
  const taskEnv = options.env || process.env;
  const repoRoot = resolveRepoRoot({ cwd: options.cwd || process.cwd() });
  const workspaceInfo = resolveWorkspaceInfo({
    env: taskEnv,
    mustExist: options.mustExist,
  });

  return {
    workspacePath: workspaceInfo.workspacePath,
    source: workspaceInfo.source,
    repoRoot,
  };
}

function getCurrentWorkspacePath(options = {}) {
  return resolveWorkspacePath({ env: process.env, ...options });
}

const exportsObject = {
  DEFAULT_REPO_ROOT,
  DEFAULT_WORKSPACE_PATH,
  existsDir,
  existsFile,
  getDefaultRepoRoot,
  getRepoRoot,
  getContainerRoot,
  getWorkspaceSymlink,
  resolveAssistantContainerRoot,
  resolveRepoRegistryRoot,
  resolveRepoRoot,
  resolveTasksPath,
  resolveWorkspaceInfo,
  resolveWorkspacePath,
  findRepoRootFromCwd,
  getWorkspaceContext,
  getWorkspacePaths,
  resolveTaskWorkspace,
  getCurrentWorkspacePath,
};

Object.defineProperty(exportsObject, "WORKSPACE", {
  enumerable: true,
  get: getCurrentWorkspacePath,
});

module.exports = exportsObject;
