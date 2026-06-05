// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { getWorkspaceContext } from "./lib/workspace.js";
import { createJsonStore } from "./lib/json-store.js";
import { createFixture, removeFixture } from "./test-helpers.js";

const distRoot = path.resolve(new URL(".", import.meta.url).pathname);

test("json store transactions serialize full read-modify-write across processes", async () => {
  const fixture = createFixture("json-store-locks-rmw");
  try {
    const workerPath = path.join(os.tmpdir(), `brain-json-store-worker-${process.pid}.mjs`);
    fs.writeFileSync(workerPath, `
      import { createJsonStore } from ${JSON.stringify(pathToFileURL(path.join(distRoot, "lib", "json-store.js")).href)};
      import { getWorkspaceContext } from ${JSON.stringify(pathToFileURL(path.join(distRoot, "lib", "workspace.js")).href)};
      const context = getWorkspaceContext({ env: { ASSISTANT_WORKSPACE: process.argv[2] } });
      const store = createJsonStore({ context, relativePath: "data/concurrent.json", defaultValue: () => ({ values: [] }) });
      store.transaction((value) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
        value.values.push(process.argv[3]);
      });
    `);

    const children = Array.from({ length: 8 }, (_, index) =>
      spawn(process.execPath, [workerPath, fixture.workspacePath, String(index)], { stdio: ["ignore", "pipe", "pipe"] })
    );
    const exits = await Promise.all(children.map((child) => new Promise((resolve) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("exit", (code) => resolve({ code, stderr }));
    })));
    for (const exit of exits) assert.equal(exit.code, 0, exit.stderr);

    const context = getWorkspaceContext({ repoRoot: fixture.repoRoot, env: { ASSISTANT_WORKSPACE: fixture.workspacePath } });
    const store = createJsonStore({ context, relativePath: "data/concurrent.json", defaultValue: () => ({ values: [] }) });
    const values = store.load().values.sort();
    assert.deepEqual(values, ["0", "1", "2", "3", "4", "5", "6", "7"]);

    const dataDir = path.join(fixture.workspacePath, "data");
    const leftovers = fs.readdirSync(dataDir).filter((file) => file.includes(".tmp") || file.endsWith(".lock"));
    assert.deepEqual(leftovers, []);
  } finally {
    removeFixture(fixture.root);
  }
});

