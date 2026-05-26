import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { getWorkspaceContext } from "./lib/workspace.js";
import { getTodoStore } from "./lib/todo-store.js";
import { createFixture, removeFixture, writeFixtureFile } from "./test-helpers.js";

test("legacy JSON state at workspace root is detected with helpful error", () => {
  const fixture = createFixture("state-migration-required");
  try {
    writeFixtureFile(path.join(fixture.workspacePath, "todos.json"), JSON.stringify({ version: 1, updatedAt: null, todos: [] }, null, 2));
    const context = getWorkspaceContext({ repoRoot: fixture.repoRoot, env: { ASSISTANT_WORKSPACE: fixture.workspacePath } });
    assert.throws(() => getTodoStore({ context }).load(), /Legacy.*path detected/);
  } finally {
    removeFixture(fixture.root);
  }
});

test("state loads normally from data/ subdirectory", () => {
  const fixture = createFixture("state-loads-data");
  try {
    writeFixtureFile(path.join(fixture.workspacePath, "data", "todos.json"), JSON.stringify({ version: 1, updatedAt: null, todos: [{ id: "td_1", title: "Test todo", description: "", status: "open" }] }, null, 2));
    const context = getWorkspaceContext({ repoRoot: fixture.repoRoot, env: { ASSISTANT_WORKSPACE: fixture.workspacePath } });
    const store = getTodoStore({ context }).load();
    assert.equal(store.todos[0].title, "Test todo");
  } finally {
    removeFixture(fixture.root);
  }
});
