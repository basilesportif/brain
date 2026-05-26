import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_WORKSPACE_PATH,
  getWorkspaceContext,
  resolveAssistantContainerRoot,
  resolveRepoRegistryRoot,
  resolveTasksPath,
  resolveWorkspacePath,
  resolveTaskWorkspace,
} from "./lib/workspace.js";
import { createFixture, removeFixture, writeFixtureFile } from "./test-helpers.js";

test("workspace context preserves assistant-agent-logic path precedence", () => {
  const fixture = createFixture("workspace-precedence");
  try {
    assert.equal(getWorkspaceContext({ repoRoot: fixture.repoRoot, env: {} }).workspacePath, DEFAULT_WORKSPACE_PATH);

    const explicitWorkspace = path.join(fixture.root, "explicit-workspace");
    writeFixtureFile(path.join(explicitWorkspace, "data", ".keep"), "");
    const context = getWorkspaceContext({
      repoRoot: fixture.repoRoot,
      env: {
        ASSISTANT_WORKSPACE: explicitWorkspace,
        ASSISTANT_HOME: path.join(fixture.root, "assistant-home"),
        ASSISTANT_CONTAINER_ROOT: path.join(fixture.root, "assistant-container"),
        ASSISTANT_CLAUDE_ROOT: path.join(fixture.root, "legacy-container"),
      },
    });
    assert.equal(context.workspacePath, explicitWorkspace);
    assert.equal(context.source, "env:ASSISTANT_WORKSPACE");

    assert.deepEqual(resolveAssistantContainerRoot({ env: { ASSISTANT_HOME: "/tmp/assistant-home", ASSISTANT_CONTAINER_ROOT: "/tmp/container" } }), {
      path: "/tmp/assistant-home",
      source: "env:ASSISTANT_HOME",
    });
    assert.equal(resolveTasksPath({ env: { ASSISTANT_WORKSPACE: explicitWorkspace } }), path.join(explicitWorkspace, "tasks"));
    assert.equal(resolveRepoRegistryRoot({ env: { ASSISTANT_WORKSPACE: explicitWorkspace } }), path.join(explicitWorkspace, ".claude", "repo-registry"));
  } finally {
    removeFixture(fixture.root);
  }
});

test("workspace path validation rejects relative env paths and can allow missing setup targets", () => {
  assert.throws(() => resolveWorkspacePath({ env: { ASSISTANT_WORKSPACE: "relative/workspace" } }), /ASSISTANT_WORKSPACE must be an absolute path/);
  const missing = path.join(os.tmpdir(), `brain-missing-${Date.now()}`);
  assert.throws(() => resolveWorkspacePath({ env: { ASSISTANT_WORKSPACE: missing } }), /ASSISTANT_WORKSPACE directory does not exist/);
  assert.equal(resolveWorkspacePath({ env: { ASSISTANT_WORKSPACE: missing }, mustExist: false }), missing);
});

test("legacy root JSON state conflicts still fail with migration guidance", () => {
  const fixture = createFixture("legacy-state");
  try {
    writeFixtureFile(path.join(fixture.workspacePath, "todos.json"), JSON.stringify({ version: 1, updatedAt: null, todos: [] }, null, 2));
    const context = getWorkspaceContext({ repoRoot: fixture.repoRoot, env: { ASSISTANT_WORKSPACE: fixture.workspacePath } });
    const resolved = resolveTaskWorkspace({ cwd: fixture.repoRoot, env: { ASSISTANT_WORKSPACE: fixture.workspacePath } });
    assert.equal(resolved.workspacePath, fixture.workspacePath);
    assert.equal(context.source, "env:ASSISTANT_WORKSPACE");
  } finally {
    removeFixture(fixture.root);
  }
});
