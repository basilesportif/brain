// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { getWorkspaceContext } from "./lib/workspace.js";
import { addNote, addProject, getProject } from "./lib/project-store.js";
import { createFixture } from "./test-helpers.js";

const distRoot = path.resolve(new URL(".", import.meta.url).pathname);
const cliRoot = path.join(distRoot, "cli");

function contextFor(fixture) {
  return getWorkspaceContext({
    repoRoot: fixture.repoRoot,
    env: { ASSISTANT_WORKSPACE: fixture.workspacePath },
  });
}

function runCli(fixture, args = []) {
  return spawnSync(process.execPath, [path.join(cliRoot, "project-reindex.js"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ASSISTANT_WORKSPACE: fixture.workspacePath },
  });
}

function projectsRoot(fixture) {
  return path.join(fixture.workspacePath, "data", "projects");
}

function projectDir(fixture, projectId) {
  const index = JSON.parse(fs.readFileSync(path.join(projectsRoot(fixture), "index.json"), "utf8"));
  return path.join(projectsRoot(fixture), index.projects.find((entry) => entry.id === projectId).slug);
}

function seed(name) {
  const fixture = createFixture(name);
  const context = contextFor(fixture);
  const project = addProject({ name: "Reindex Project" }, { context });
  const note = addNote(
    project.id,
    "The body.",
    { title: "Cached title", kind: "note", tags: ["cached-tag"] },
    { context }
  );
  return { fixture, context, project, note: note.note };
}

test("project-reindex --check is clean on a freshly written store", () => {
  const { fixture } = seed("project-reindex-clean");
  const cli = runCli(fixture, ["--check"]);
  assert.equal(cli.status, 0, cli.stderr);
  const report = JSON.parse(cli.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.drift, []);
  assert.equal(report.changed, false);
  assert.deepEqual(report.counts, { projects: 1, notes: 1 });
});

test("project-reindex picks up hand-edited frontmatter", () => {
  const { fixture, context, project, note } = seed("project-reindex-handedit");
  const dir = projectDir(fixture, project.id);
  const notePath = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8")).notes[0].path;
  const absolute = path.join(dir, notePath);
  fs.writeFileSync(
    absolute,
    fs
      .readFileSync(absolute, "utf8")
      .replace("title: Cached title", "title: Hand-edited title")
      .replace("  - cached-tag", "  - rewritten-tag")
  );

  const check = runCli(fixture, ["--check"]);
  assert.equal(check.status, 1);
  const checkReport = JSON.parse(check.stdout);
  assert.equal(checkReport.ok, false);
  assert.ok(checkReport.drift.some((item) => item.kind === "stale-project-json"));
  // --check writes nothing.
  const stillStale = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
  assert.equal(stillStale.notes[0].metadata.title, "Cached title");

  const apply = runCli(fixture);
  assert.equal(apply.status, 0, apply.stderr);
  const applyReport = JSON.parse(apply.stdout);
  assert.equal(applyReport.changed, true);

  const rebuilt = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
  assert.equal(rebuilt.notes[0].metadata.title, "Hand-edited title");
  assert.ok(rebuilt.notes[0].metadata.tags.includes("rewritten-tag"));
  assert.equal(rebuilt.notes[0].metadata.tags.includes("cached-tag"), false);
  assert.equal(rebuilt.notes[0].id, note.id);

  // Clean afterwards.
  assert.equal(runCli(fixture, ["--check"]).status, 0);
  assert.equal(getProject(project.id, { context }).notes[0].metadata.title, "Hand-edited title");
});

test("project-reindex adopts a hand-added note file", () => {
  const { fixture, project } = seed("project-reindex-adopt");
  const dir = projectDir(fixture, project.id);
  fs.writeFileSync(
    path.join(dir, "notes", "20260707T080910Z-note-hand-added.md"),
    [
      "---",
      "id: pn_handadded00001",
      "createdAt: 2026-07-07T08:09:10.000Z",
      "updatedAt: 2026-07-07T08:09:10.000Z",
      "schemaVersion: 1",
      "title: Hand added",
      "summary: Added by hand",
      "kind: note",
      "category: general",
      "tags:",
      "  - handmade",
      "---",
      "Hand-added body.",
    ].join("\n")
  );

  const check = runCli(fixture, ["--check"]);
  assert.equal(check.status, 1);
  assert.ok(JSON.parse(check.stdout).drift.some((item) => item.kind === "unindexed-note-file"));

  assert.equal(runCli(fixture).status, 0);
  const rebuilt = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
  assert.equal(rebuilt.notes.length, 2);
  // Known notes keep their order; the adopted file is appended.
  assert.equal(rebuilt.notes[1].id, "pn_handadded00001");
  const index = JSON.parse(fs.readFileSync(path.join(projectsRoot(fixture), "index.json"), "utf8"));
  assert.equal(index.projects[0].noteCount, 2);
});

test("project-reindex reports a note file listed in project.json but missing on disk", () => {
  const { fixture, project } = seed("project-reindex-missing");
  const dir = projectDir(fixture, project.id);
  const notePath = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8")).notes[0].path;
  fs.unlinkSync(path.join(dir, notePath));

  const check = runCli(fixture, ["--check"]);
  assert.equal(check.status, 1);
  const report = JSON.parse(check.stdout);
  assert.ok(report.drift.some((item) => item.kind === "missing-note-file"));

  assert.equal(runCli(fixture).status, 0);
  const rebuilt = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
  assert.deepEqual(rebuilt.notes, []);
});

test("project-reindex rebuilds a deleted index.json and renders markdown", () => {
  const { fixture } = seed("project-reindex-index");
  fs.unlinkSync(path.join(projectsRoot(fixture), "index.json"));

  const check = runCli(fixture, ["--check"]);
  assert.equal(check.status, 1);
  assert.ok(JSON.parse(check.stdout).drift.some((item) => item.kind === "missing-index-json"));

  const apply = runCli(fixture, ["--markdown"]);
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /# Project reindex \(applied\)/);
  assert.match(apply.stdout, /reindex-project \(pj_[0-9a-f]{16}\) — 1 note\(s\)/);
  assert.equal(fs.existsSync(path.join(projectsRoot(fixture), "index.json")), true);
  assert.equal(runCli(fixture, ["--check"]).status, 0);
});
