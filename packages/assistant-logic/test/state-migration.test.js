const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { getWorkspaceContext } = require("../scripts/lib/workspace");
const { getTodoStore } = require("../scripts/lib/todo-store");
const { createFixture, writeFile } = require("./helpers");

test("legacy JSON state at workspace root is detected with helpful error", () => {
  const fixture = createFixture("state-migration-required");
  writeFile(
    path.join(fixture.workspacePath, "todos.json"),
    JSON.stringify({ version: 1, updatedAt: null, todos: [] }, null, 2)
  );

  const context = getWorkspaceContext({
    repoRoot: fixture.repoRoot,
    env: { ASSISTANT_WORKSPACE: fixture.workspacePath },
  });

  assert.throws(
    () => getTodoStore({ context }).load(),
    /Legacy.*path detected/
  );
});

test("state loads normally from data/ subdirectory", () => {
  const fixture = createFixture("state-loads-data");
  writeFile(
    path.join(fixture.workspacePath, "data", "todos.json"),
    JSON.stringify(
      {
        version: 1,
        updatedAt: null,
        todos: [{ id: "td_1", title: "Test todo", description: "", status: "open" }],
      },
      null,
      2
    )
  );

  const context = getWorkspaceContext({
    repoRoot: fixture.repoRoot,
    env: { ASSISTANT_WORKSPACE: fixture.workspacePath },
  });
  const store = getTodoStore({ context }).load();
  assert.equal(store.todos[0].title, "Test todo");
});
