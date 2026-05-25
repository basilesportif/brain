const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const {
  DEFAULT_WORKSPACE_PATH,
  getWorkspaceContext,
  resolveAssistantContainerRoot,
  resolveRepoRegistryRoot,
  resolveTasksPath,
  resolveWorkspacePath,
  resolveTaskWorkspace,
} = require("../scripts/lib/workspace");
const { createFixture, writeFile } = require("./helpers");

test("workspace context uses default workspace path", () => {
  const fixture = createFixture("workspace-default");
  const context = getWorkspaceContext({
    repoRoot: fixture.repoRoot,
    env: {},
  });

  assert.equal(context.source, "legacy-default");
  assert.equal(context.containerRoot, path.join(os.homedir(), ".assistant-claude"));
  assert.equal(context.workspacePath, DEFAULT_WORKSPACE_PATH);
});

test("workspace env path overrides default", () => {
  const fixture = createFixture("workspace-env-path");
  const externalWorkspace = path.join(fixture.root, "external-workspace");
  writeFile(path.join(externalWorkspace, "data", ".keep"), "");
  writeFile(path.join(externalWorkspace, "tasks", "README.md"), "ok");

  const context = getWorkspaceContext({
    repoRoot: fixture.repoRoot,
    env: {
      ASSISTANT_WORKSPACE: externalWorkspace,
    },
  });

  assert.equal(context.workspacePath, externalWorkspace);
  assert.equal(context.source, "env:ASSISTANT_WORKSPACE");
  assert.equal(context.containerRoot, fixture.root);
});

test("workspace env path must exist by default but setup can opt out", () => {
  const fixture = createFixture("workspace-env-path-missing");
  const externalWorkspace = path.join(
    fixture.root,
    "nonexistent-assistant-workspace-review"
  );

  assert.throws(
    () => resolveWorkspacePath({ env: { ASSISTANT_WORKSPACE: externalWorkspace } }),
    /ASSISTANT_WORKSPACE directory does not exist/
  );
  assert.equal(
    resolveWorkspacePath({
      env: { ASSISTANT_WORKSPACE: externalWorkspace },
      mustExist: false,
    }),
    externalWorkspace
  );
});

test("generic assistant home resolves to workspace below the container root", () => {
  const fixture = createFixture("assistant-home");
  const assistantHome = path.join(fixture.root, "assistant-home");
  const context = getWorkspaceContext({
    repoRoot: fixture.repoRoot,
    env: {
      ASSISTANT_HOME: assistantHome,
    },
  });

  assert.equal(context.containerRoot, assistantHome);
  assert.equal(context.workspacePath, path.join(assistantHome, "workspace"));
  assert.equal(context.source, "env:ASSISTANT_HOME/workspace");
});

test("assistant container root resolves to workspace below the container root", () => {
  const fixture = createFixture("assistant-container-root");
  const containerRoot = path.join(fixture.root, "assistant-container");

  assert.equal(
    resolveWorkspacePath({
      env: {
        ASSISTANT_CONTAINER_ROOT: containerRoot,
      },
    }),
    path.join(containerRoot, "workspace")
  );
});

test("legacy assistant claude root resolves to workspace below the container root", () => {
  const fixture = createFixture("assistant-claude-root");
  const containerRoot = path.join(fixture.root, "legacy-container");
  const context = getWorkspaceContext({
    repoRoot: fixture.repoRoot,
    env: {
      ASSISTANT_CLAUDE_ROOT: containerRoot,
    },
  });

  assert.equal(context.containerRoot, containerRoot);
  assert.equal(context.workspacePath, path.join(containerRoot, "workspace"));
  assert.equal(context.source, "env:ASSISTANT_CLAUDE_ROOT/workspace");
});

test("assistant workspace has highest precedence", () => {
  const fixture = createFixture("assistant-workspace-precedence");
  const externalWorkspace = path.join(fixture.root, "explicit-workspace");
  writeFile(path.join(externalWorkspace, "data", ".keep"), "");

  const context = getWorkspaceContext({
    repoRoot: fixture.repoRoot,
    env: {
      ASSISTANT_WORKSPACE: externalWorkspace,
      ASSISTANT_HOME: path.join(fixture.root, "assistant-home"),
      ASSISTANT_CONTAINER_ROOT: path.join(fixture.root, "assistant-container"),
      ASSISTANT_CLAUDE_ROOT: path.join(fixture.root, "legacy-container"),
    },
  });

  assert.equal(context.workspacePath, externalWorkspace);
  assert.equal(context.source, "env:ASSISTANT_WORKSPACE");
});

test("container root precedence prefers generic roots before legacy root", () => {
  const fixture = createFixture("container-precedence");
  const homeRoot = path.join(fixture.root, "assistant-home");
  const containerRoot = path.join(fixture.root, "assistant-container");
  const legacyRoot = path.join(fixture.root, "legacy");

  assert.deepEqual(
    resolveAssistantContainerRoot({
      env: {
        ASSISTANT_HOME: homeRoot,
        ASSISTANT_CONTAINER_ROOT: containerRoot,
        ASSISTANT_CLAUDE_ROOT: legacyRoot,
      },
    }),
    {
      path: homeRoot,
      source: "env:ASSISTANT_HOME",
    }
  );

  assert.deepEqual(
    resolveAssistantContainerRoot({
      env: {
        ASSISTANT_CONTAINER_ROOT: containerRoot,
        ASSISTANT_CLAUDE_ROOT: legacyRoot,
      },
    }),
    {
      path: containerRoot,
      source: "env:ASSISTANT_CONTAINER_ROOT",
    }
  );
});

test("relative explicit paths are rejected", () => {
  assert.throws(
    () => resolveWorkspacePath({ env: { ASSISTANT_WORKSPACE: "relative/workspace" } }),
    /ASSISTANT_WORKSPACE must be an absolute path/
  );
  assert.throws(
    () => resolveWorkspacePath({ env: { ASSISTANT_HOME: "relative/home" } }),
    /ASSISTANT_HOME must be an absolute path/
  );
});

test("helper paths derive from the resolved workspace", () => {
  const fixture = createFixture("helper-paths");
  const env = { ASSISTANT_WORKSPACE: fixture.workspacePath };

  assert.equal(resolveTasksPath({ env }), path.join(fixture.workspacePath, "tasks"));
  assert.equal(
    resolveRepoRegistryRoot({ env }),
    path.join(fixture.workspacePath, ".claude", "repo-registry")
  );
});

test("resolveTaskWorkspace uses ASSISTANT_WORKSPACE when set", () => {
  const fixture = createFixture("task-workspace");

  const resolved = resolveTaskWorkspace({
    cwd: fixture.repoRoot,
    env: {
      ASSISTANT_WORKSPACE: fixture.workspacePath,
    },
  });

  assert.equal(resolved.workspacePath, fixture.workspacePath);
  assert.equal(resolved.source, "env:ASSISTANT_WORKSPACE");
});

test("resolveTaskWorkspace falls back to default path", () => {
  const fixture = createFixture("task-workspace-default");

  const resolved = resolveTaskWorkspace({
    cwd: fixture.repoRoot,
    env: {},
  });

  assert.equal(resolved.source, "legacy-default");
  assert.equal(resolved.workspacePath, DEFAULT_WORKSPACE_PATH);
});
