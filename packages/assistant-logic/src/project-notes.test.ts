// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { getWorkspaceContext } from "./lib/workspace.js";
import {
  addNote,
  addProject,
  getProject,
  listProjectNoteMetadata,
  validateProjectNotes,
} from "./lib/project-store.js";
import { createFixture, removeFixture, writeFixtureFile } from "./test-helpers.js";

const distRoot = path.resolve(new URL(".", import.meta.url).pathname);
const cliRoot = path.join(distRoot, "cli");

function contextFor(fixture: ReturnType<typeof createFixture>) {
  return getWorkspaceContext({ repoRoot: fixture.repoRoot, env: { ASSISTANT_WORKSPACE: fixture.workspacePath } });
}

function runCli(fixture: ReturnType<typeof createFixture>, script: string, args: string[] = []) {
  return spawnSync(process.execPath, [path.join(cliRoot, script), ...args], {
    encoding: "utf8",
    env: { ...process.env, ASSISTANT_WORKSPACE: fixture.workspacePath },
  });
}

test("new project notes get stable structured metadata", () => {
  const fixture = createFixture("project-note-metadata-new");
  try {
    const context = contextFor(fixture);
    const project = addProject(
      {
        name: "Decisive Outcomes",
        initialNote: "CONFERENCE RESEARCH — July 2026 targets\nUse this as the current shortlist.",
        initialNoteMetadata: {
          canonicalKey: "decisive-outcomes.conference-listings",
          current: true,
          tags: ["july-2026"],
        },
      },
      { context }
    );

    assert.match(project.notes[0].id, /^pn_[0-9a-f]{16}$/);
    assert.equal(project.notes[0].text, "CONFERENCE RESEARCH — July 2026 targets\nUse this as the current shortlist.");
    assert.equal(project.notes[0].createdAt, project.notes[0].updatedAt);
    assert.equal(project.notes[0].metadata.schemaVersion, 1);
    assert.equal(project.notes[0].metadata.canonicalKey, "decisive-outcomes.conference-listings");
    assert.equal(project.notes[0].metadata.current, true);
    assert.equal(project.notes[0].metadata.kind, "canonical-index");
    assert.ok(project.notes[0].metadata.tags.includes("july-2026"));
    assert.ok(project.notes[0].metadata.tags.includes("conferences"));

    const parsed = JSON.parse(fs.readFileSync(path.join(fixture.workspacePath, "data", "projects.json"), "utf8"));
    assert.equal(validateProjectNotes(parsed).ok, true);
  } finally {
    removeFixture(fixture.root);
  }
});

test("legacy notes are normalized without losing ad hoc fields", () => {
  const fixture = createFixture("project-note-metadata-legacy");
  try {
    const projectId = "pj_legacy";
    writeFixtureFile(
      path.join(fixture.workspacePath, "data", "projects.json"),
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-06-01T00:00:00.000Z",
          projects: [
            {
              id: projectId,
              name: "FRSA 2026 Conference",
              status: "active",
              createdAt: "2026-06-01T00:00:00.000Z",
              updatedAt: "2026-06-01T00:00:00.000Z",
              notes: [
                {
                  category: "INDUSTRY INFO",
                  heading: "Roofing software stack",
                  text: "INDUSTRY INFO — Roofing software stack\nSources checked and integration gaps.",
                  sourceUrls: ["https://example.test/frsa"],
                  createdAt: "2026-06-02T00:00:00.000Z",
                },
              ],
            },
          ],
        },
        null,
        2
      )
    );

    const project = getProject(projectId, { context: contextFor(fixture) });
    const note = project.notes[0];
    assert.match(note.id, /^pn_[0-9a-f]{16}$/);
    assert.equal(note.text, "INDUSTRY INFO — Roofing software stack\nSources checked and integration gaps.");
    assert.equal(note.category, "INDUSTRY INFO");
    assert.equal(note.heading, "Roofing software stack");
    assert.equal(note.updatedAt, note.createdAt);
    assert.equal(note.metadata.title, "Roofing software stack");
    assert.equal(note.metadata.category, "INDUSTRY INFO");
    assert.ok(note.metadata.tags.includes("frsa"));
    assert.deepEqual(note.metadata.refs, [{ type: "url", url: "https://example.test/frsa" }]);
    assert.equal(validateProjectNotes({ projects: [project] }).ok, true);
  } finally {
    removeFixture(fixture.root);
  }
});

test("project-notes-list returns metadata only and supports filters", () => {
  const fixture = createFixture("project-note-metadata-list");
  try {
    const context = contextFor(fixture);
    const project = addProject({ name: "Research Project" }, { context });
    addNote(
      project.id,
      "Canonical customer research index\nUse this before opening detailed notes.",
      { title: "Customer research index", kind: "canonical-index", category: "research", tags: ["customers"], canonicalKey: "research.customers", current: true },
      { context }
    );

    const listed = listProjectNoteMetadata({ canonicalKey: "research.customers", current: true }, { context });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].metadata.title, "Customer research index");
    assert.equal(Object.hasOwn(listed[0], "text"), false);
    assert.equal(listed[0].textLength > 0, true);

    const cli = runCli(fixture, "project-notes-list.js", ["--tag", "customers", "--current"]);
    assert.equal(cli.status, 0, cli.stderr);
    const parsed = JSON.parse(cli.stdout);
    assert.equal(parsed.count, 1);
    assert.equal(parsed.notes[0].metadata.canonicalKey, "research.customers");
    assert.equal(Object.hasOwn(parsed.notes[0], "text"), false);
  } finally {
    removeFixture(fixture.root);
  }
});
