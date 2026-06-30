import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJsonStore } from "./lib/json-store.js";
import { getWorkspaceContext } from "./lib/workspace.js";
import { addProject, addNote, getProject } from "./lib/project-store.js";
import { addPerson, addCorrespondence, deleteBusiness, deletePerson, getCrmStore, loadCrmStore } from "./lib/crm-store.js";
import { createFixture, removeFixture } from "./test-helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runWorkers(workerSource: string, argsList: string[][]): Promise<void> {
  const workerPath = path.join(os.tmpdir(), `brain-json-store-worker-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  try {
    fs.writeFileSync(workerPath, workerSource);
    const children = argsList.map((args) => spawn(process.execPath, [workerPath, ...args], { stdio: ["ignore", "pipe", "pipe"] }));
    const exits = await Promise.all(children.map((child) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("exit", (code) => resolve({ code, stderr }));
    })));
    for (const exit of exits) assert.equal(exit.code, 0, exit.stderr);
  } finally {
    fs.rmSync(workerPath, { force: true });
  }
}

test("json store transactions serialize full read-modify-write across processes", async () => {
  const fixture = createFixture("json-store-locks-rmw");
  try {
    const jsonStoreUrl = pathToFileURL(path.join(__dirname, "lib", "json-store.js")).href;
    const workspaceUrl = pathToFileURL(path.join(__dirname, "lib", "workspace.js")).href;
    await runWorkers(`
      import { createJsonStore } from ${JSON.stringify(jsonStoreUrl)};
      import { getWorkspaceContext } from ${JSON.stringify(workspaceUrl)};
      const context = getWorkspaceContext({ env: { ASSISTANT_WORKSPACE: process.argv[2] } });
      const store = createJsonStore({ context, relativePath: "data/concurrent.json", defaultValue: () => ({ values: [] }) });
      store.transaction((value) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
        value.values.push(process.argv[3]);
      });
    `, Array.from({ length: 8 }, (_, index) => [fixture.workspacePath, String(index)]));

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

test("project mutators do not lose concurrent note additions", async () => {
  const fixture = createFixture("project-store-locks-rmw");
  try {
    const options = { env: { ASSISTANT_WORKSPACE: fixture.workspacePath } };
    const project = addProject({ name: "Concurrent Project" }, options);
    const projectStoreUrl = pathToFileURL(path.join(__dirname, "lib", "project-store.js")).href;
    await runWorkers(`
      import { addNote } from ${JSON.stringify(projectStoreUrl)};
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      addNote(process.argv[3], \`worker note \${process.argv[4]}\`, {}, { env: { ASSISTANT_WORKSPACE: process.argv[2] } });
    `, Array.from({ length: 8 }, (_, index) => [fixture.workspacePath, project.id, String(index)]));

    const reloaded = getProject(project.id, options);
    assert.equal(reloaded?.notes.length, 8);
    assert.deepEqual(reloaded?.notes.map((note: { text: string }) => note.text).sort(), Array.from({ length: 8 }, (_, index) => `worker note ${index}`));
  } finally {
    removeFixture(fixture.root);
  }
});

test("CRM mutators do not lose concurrent correspondence additions", async () => {
  const fixture = createFixture("crm-store-locks-rmw");
  try {
    const options = { env: { ASSISTANT_WORKSPACE: fixture.workspacePath } };
    const person = addPerson({ name: "Ada Lovelace" }, options);
    const crmStoreUrl = pathToFileURL(path.join(__dirname, "lib", "crm-store.js")).href;
    await runWorkers(`
      import { addCorrespondence } from ${JSON.stringify(crmStoreUrl)};
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      addCorrespondence({ personId: process.argv[3], type: "email", summary: \`worker email \${process.argv[4]}\` }, { env: { ASSISTANT_WORKSPACE: process.argv[2] } });
    `, Array.from({ length: 8 }, (_, index) => [fixture.workspacePath, person.id, String(index)]));

    const store = loadCrmStore(options);
    assert.equal(store.correspondence.length, 8);
    assert.deepEqual(store.correspondence.map((entry: { summary: string }) => entry.summary).sort(), Array.from({ length: 8 }, (_, index) => `worker email ${index}`));
  } finally {
    removeFixture(fixture.root);
  }
});

test("CRM delete updates linked entity timestamps", () => {
  const fixture = createFixture("crm-delete-linked-timestamps");
  try {
    const options = { env: { ASSISTANT_WORKSPACE: fixture.workspacePath } };
    getCrmStore(options).save({
      version: 1,
      updatedAt: "2000-01-01T00:00:00.000Z",
      people: [{ id: "ct_aaaaaaaaaaaaaaaa", name: "Ada", email: null, phone: null, company: null, title: null, tags: [], businessIds: ["bz_bbbbbbbbbbbbbbbb"], status: "active", priority: "normal", source: null, notes: null, lastContactedAt: null, createdAt: "2000-01-01T00:00:00.000Z", updatedAt: "2000-01-01T00:00:00.000Z" }],
      businesses: [{ id: "bz_bbbbbbbbbbbbbbbb", name: "Analytical Engines", description: null, status: "prospecting", dealValue: null, personIds: ["ct_aaaaaaaaaaaaaaaa"], notes: null, createdAt: "2000-01-01T00:00:00.000Z", updatedAt: "2000-01-01T00:00:00.000Z" }],
      correspondence: [],
    });

    assert.equal(deletePerson("ct_aaaaaaaaaaaaaaaa", options).found, true);
    let store = loadCrmStore(options);
    assert.equal(store.businesses[0].personIds.length, 0);
    assert.notEqual(store.businesses[0].updatedAt, "2000-01-01T00:00:00.000Z");

    getCrmStore(options).save({
      version: 1,
      updatedAt: "2000-01-01T00:00:00.000Z",
      people: [{ id: "ct_cccccccccccccccc", name: "Grace", email: null, phone: null, company: null, title: null, tags: [], businessIds: ["bz_dddddddddddddddd"], status: "active", priority: "normal", source: null, notes: null, lastContactedAt: null, createdAt: "2000-01-01T00:00:00.000Z", updatedAt: "2000-01-01T00:00:00.000Z" }],
      businesses: [{ id: "bz_dddddddddddddddd", name: "Compiler Co", description: null, status: "prospecting", dealValue: null, personIds: ["ct_cccccccccccccccc"], notes: null, createdAt: "2000-01-01T00:00:00.000Z", updatedAt: "2000-01-01T00:00:00.000Z" }],
      correspondence: [],
    });

    assert.equal(deleteBusiness("bz_dddddddddddddddd", options).found, true);
    store = loadCrmStore(options);
    assert.equal(store.people[0].businessIds.length, 0);
    assert.notEqual(store.people[0].updatedAt, "2000-01-01T00:00:00.000Z");
  } finally {
    removeFixture(fixture.root);
  }
});
