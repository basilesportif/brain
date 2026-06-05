// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  addConferenceRecord,
  listConferences,
  listFavoriteConferences,
  normalizeSelector,
  updateConferenceFavorites,
  updateRowsForSelector,
} from "./lib/conference-favorite-store.js";

const distRoot = path.resolve(new URL(".", import.meta.url).pathname);

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brain-conference-favorite-"));
}

function writeList(root, id, rows) {
  const dir = path.join(root, "data", "conference-lists", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "conferences.json"), `${JSON.stringify(rows, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify({ id, recordCount: rows.length }, null, 2)}\n`);
}

test("normalizes id and name selectors", () => {
  assert.equal(normalizeSelector("FRSA Convention / Florida Roofing & Sheet Metal Expo"), "frsa convention florida roofing sheet metal expo");
  assert.equal(normalizeSelector("frsa-convention-florida-roofing-expo"), "frsa convention florida roofing expo");
});

test("favorites a conference by id across durable lists", () => {
  const root = mktemp();
  try {
    const rows = [
      { id: "frsa-convention-florida-roofing-expo", name: "FRSA Convention", dates: "Jun 10-12" },
      { id: "cleanpower-2026", name: "CLEANPOWER 2026", dates: "Jun 1-4" },
    ];
    writeList(root, "conference-map", rows);
    writeList(root, "june-2026", rows.slice(0, 1));

    const result = updateConferenceFavorites({
      workspacePath: root,
      selector: "frsa-convention-florida-roofing-expo",
      favorite: true,
      note: "Tim wants to go",
      at: "2026-06-05T12:00:00.000Z",
    });

    assert.equal(result.changes.length, 2);
    const favorites = listFavoriteConferences({ workspacePath: root });
    assert.equal(favorites.length, 2);
    assert.equal(favorites[0].favoriteNote, "Tim wants to go");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "data", "conference-lists", "conference-map", "manifest.json"), "utf8"));
    assert.equal(manifest.favoriteCount, 1);
    assert.equal(manifest.favoriteUpdatedAt, "2026-06-05T12:00:00.000Z");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unfavorites and clears favorite note by default", () => {
  const rows = [
    {
      id: "nashville-build-expo-2026",
      name: "Nashville Build Expo",
      favorite: true,
      favoritedAt: "2026-06-01T00:00:00.000Z",
      favoriteNote: "Shortlist",
    },
  ];
  const result = updateRowsForSelector(rows, "Nashville Build Expo", { favorite: false });
  assert.deepEqual(result.updated[0], {
    id: "nashville-build-expo-2026",
    name: "Nashville Build Expo",
    favorite: false,
  });
});

test("ambiguous selectors fail before mutating", () => {
  assert.throws(
    () =>
      updateRowsForSelector(
        [
          { id: "a", name: "Nashville Build Expo" },
          { id: "b", name: "Nashville AI Expo" },
        ],
        "Nashville",
        { favorite: true }
      ),
    /matched multiple conferences/
  );
});

test("adds and lists conferences through locked durable list files", () => {
  const root = mktemp();
  try {
    const result = addConferenceRecord({
      workspacePath: root,
      listId: "new-list",
      record: { id: "new-event-2026", name: "New Event 2026", city: "Houston", region: "TX" },
      at: "2026-06-05T12:00:00.000Z",
    });
    assert.equal(result.ok, true);
    const rows = listConferences({ workspacePath: root, listIds: ["new-list"], query: "houston" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "new-event-2026");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "data", "conference-lists", "new-list", "manifest.json"), "utf8"));
    assert.equal(manifest.recordCount, 1);
    assert.equal(manifest.favoriteCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("favorite updates serialize concurrent writes to one list", async () => {
  const root = mktemp();
  const workerPath = path.join(os.tmpdir(), `brain-conference-favorite-worker-${process.pid}.mjs`);
  try {
    writeList(root, "conference-map", [
      { id: "event-0", name: "Event 0" },
      { id: "event-1", name: "Event 1" },
      { id: "event-2", name: "Event 2" },
      { id: "event-3", name: "Event 3" },
    ]);
    fs.writeFileSync(workerPath, `
      import { updateConferenceFavorites } from ${JSON.stringify(pathToFileURL(path.join(distRoot, "lib", "conference-favorite-store.js")).href)};
      updateConferenceFavorites({
        workspacePath: process.argv[2],
        selector: process.argv[3],
        favorite: true,
        note: process.argv[4],
        at: "2026-06-05T12:00:00.000Z",
        listIds: ["conference-map"],
      });
    `);

    const children = Array.from({ length: 4 }, (_, index) =>
      spawn(process.execPath, [workerPath, root, `event-${index}`, `note-${index}`], { stdio: ["ignore", "pipe", "pipe"] })
    );
    const exits = await Promise.all(children.map((child) => new Promise((resolve) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("exit", (code) => resolve({ code, stderr }));
    })));
    for (const exit of exits) assert.equal(exit.code, 0, exit.stderr);

    const rows = JSON.parse(fs.readFileSync(path.join(root, "data", "conference-lists", "conference-map", "conferences.json"), "utf8"));
    assert.deepEqual(rows.map((row) => row.favorite), [true, true, true, true]);
    assert.deepEqual(rows.map((row) => row.favoriteNote).sort(), ["note-0", "note-1", "note-2", "note-3"]);
    const dataDir = path.join(root, "data", "conference-lists", "conference-map");
    const leftovers = fs.readdirSync(dataDir).filter((file) => file.includes(".tmp") || file.endsWith(".lock"));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workerPath, { force: true });
  }
});
