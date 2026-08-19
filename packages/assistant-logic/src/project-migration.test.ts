// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { getWorkspaceContext } from "./lib/workspace.js";
import { addNote, getProject, loadStore } from "./lib/project-store.js";
import { parseNoteMarkdown, stableNoteId } from "./lib/project-md-store.js";
import { createFixture } from "./test-helpers.js";

const distRoot = path.resolve(new URL(".", import.meta.url).pathname);
const SCRIPT = path.join(distRoot, "cli", "migrate-projects-to-markdown.js");


function contextFor(fixture) {
  return getWorkspaceContext({
    repoRoot: fixture.repoRoot,
    env: { ASSISTANT_WORKSPACE: fixture.workspacePath },
  });
}

function runMigration(fixture, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ASSISTANT_WORKSPACE: fixture.workspacePath },
  });
}

/**
 * A legacy store covering the shapes the live data actually contains:
 * ad-hoc project keys, legacy top-level note passthrough keys, notes with no
 * id, ad-hoc nested metadata, a metadata key colliding with a reserved
 * frontmatter key, empty text, and two projects whose names collide.
 */
const LEGACY_STORE = {
  version: 1,
  updatedAt: "2026-06-01T00:00:00.000Z",
  projects: [
    {
      id: "pj_alpha",
      name: "Shared Name",
      description: "First of two projects with the same name.",
      status: "active",
      targetDate: "2026-09-01",
      personIds: ["ct_1"],
      businessIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      calendar: { adHoc: true, sources: [{ url: "https://example.test/cal" }] },
      resources: [{ label: "Site", url: "https://example.test", addedAt: "2026-01-01T00:00:00.000Z" }],
      tasks: [
        { id: "pt_1", title: "Open task", status: "open", createdAt: "2026-01-01T00:00:00.000Z", completedAt: null },
        { id: "pt_2", title: "Done task", status: "done", createdAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-02-01T00:00:00.000Z" },
      ],
      notes: [
        {
          // No id: must get a deterministic stableNoteId.
          category: "INDUSTRY INFO",
          heading: "Roofing software stack",
          text: "INDUSTRY INFO — Roofing software stack\nSources checked.",
          sourceUrls: ["https://example.test/frsa"],
          createdAt: "2026-02-02T00:00:00.000Z",
        },
        {
          id: "pn_withmetadata01",
          createdAt: "2026-02-03T00:00:00.000Z",
          updatedAt: "2026-02-04T00:00:00.000Z",
          text: "Body with a --- delimiter line\n---\nstill body\n",
          metadata: {
            schemaVersion: 1,
            title: "Ad-hoc metadata",
            summary: "Summary",
            kind: "reference",
            category: "general",
            tags: ["one", "two"],
            refs: [{ type: "url", url: "https://example.test/a" }],
            relationships: [],
            meetingEntryDefaults: { attendees: ["Tim"], nested: { deep: [1, { two: null }] } },
            updatedAt: "2020-01-01T00:00:00.000Z",
          },
        },
        {
          id: "pn_emptytext00001",
          createdAt: "2026-02-05T00:00:00.000Z",
          updatedAt: "2026-02-05T00:00:00.000Z",
          text: "",
          metadata: { schemaVersion: 1, title: "Empty", summary: "s", kind: "note", category: "general", tags: [] },
        },
      ],
    },
    {
      id: "pj_beta",
      name: "Shared Name",
      description: null,
      status: "archived",
      targetDate: null,
      personIds: [],
      businessIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      resources: [],
      tasks: [],
      notes: [
        {
          id: "pn_beta00000000001",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
          text: "Unicode 한국어 🎧 body.",
          metadata: { schemaVersion: 1, title: "Beta note", summary: "s", kind: "note", category: "general", tags: [] },
        },
      ],
    },
  ],
};

function seedLegacy(name) {
  const fixture = createFixture(name);
  fs.writeFileSync(
    path.join(fixture.workspacePath, "data", "projects.json"),
    `${JSON.stringify(LEGACY_STORE, null, 2)}\n`
  );
  return fixture;
}

function projectsRoot(fixture) {
  return path.join(fixture.workspacePath, "data", "projects");
}

test("migration writes the markdown layout, verifies it, and retires the legacy file", () => {
  const fixture = seedLegacy("project-migration-basic");
  const cli = runMigration(fixture);
  assert.equal(cli.status, 0, cli.stderr);
  const report = JSON.parse(cli.stdout);

  assert.equal(report.ok, true);
  assert.equal(report.migrated, true);
  assert.equal(report.verified, true);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.counts, { projects: 2, notes: 4, tasks: 2, resources: 1 });
  assert.deepEqual(report.counts, report.expectedCounts);
  assert.equal(report.backfills.id, 1);
  assert.equal(report.backfills.updatedAt, 1);

  // Legacy file renamed, never deleted.
  assert.equal(fs.existsSync(path.join(fixture.workspacePath, "data", "projects.json")), false);
  assert.equal(fs.existsSync(path.join(fixture.workspacePath, "data", "projects.legacy.json")), true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(fixture.workspacePath, "data", "projects.legacy.json"), "utf8")),
    LEGACY_STORE
  );

  // Name collision produced a numeric slug suffix.
  const index = JSON.parse(fs.readFileSync(path.join(projectsRoot(fixture), "index.json"), "utf8"));
  assert.equal(index.version, 2);
  assert.deepEqual(index.projects.map((entry) => entry.slug), ["shared-name", "shared-name-2"]);
  assert.deepEqual(index.projects.map((entry) => entry.noteCount), [3, 1]);

  // Ad-hoc project key survived.
  const alphaDoc = JSON.parse(fs.readFileSync(path.join(projectsRoot(fixture), "shared-name", "project.json"), "utf8"));
  assert.deepEqual(alphaDoc.calendar, LEGACY_STORE.projects[0].calendar);
  assert.equal(alphaDoc.tasks.length, 2);

  // The id-less legacy note got the deterministic id the old store reported.
  const expectedId = stableNoteId("pj_alpha", LEGACY_STORE.projects[0].notes[0], 0);
  assert.equal(alphaDoc.notes[0].id, expectedId);

  // Bodies are verbatim, including an embedded `---` line and empty text.
  const dir = path.join(projectsRoot(fixture), "shared-name");
  const bodies = alphaDoc.notes.map((entry) => parseNoteMarkdown(fs.readFileSync(path.join(dir, entry.path), "utf8")).text);
  assert.equal(bodies[1], LEGACY_STORE.projects[0].notes[1].text);
  assert.equal(bodies[2], "");

  // Legacy top-level passthrough keys round-trip back to the top level.
  const context = contextFor(fixture);
  const note = getProject("pj_alpha", { context }).notes[0];
  assert.equal(note.category, "INDUSTRY INFO");
  assert.equal(note.heading, "Roofing software stack");
  assert.deepEqual(note.sourceUrls, ["https://example.test/frsa"]);

  // Ad-hoc + reserved-name metadata survived.
  const adHoc = getProject("pj_alpha", { context }).notes[1];
  assert.deepEqual(adHoc.metadata.meetingEntryDefaults, LEGACY_STORE.projects[0].notes[1].metadata.meetingEntryDefaults);
  assert.equal(adHoc.metadata.updatedAt, "2020-01-01T00:00:00.000Z");
  assert.equal(adHoc.updatedAt, "2026-02-04T00:00:00.000Z");

  // Everything the API used to return is still reachable.
  const store = loadStore({ context });
  assert.equal(store.projects.length, 2);
  assert.equal(store.projects.reduce((sum, project) => sum + project.notes.length, 0), 4);
});

test("re-running the migration is a no-op that re-verifies", () => {
  const fixture = seedLegacy("project-migration-idempotent");
  assert.equal(runMigration(fixture).status, 0);

  const context = contextFor(fixture);
  const added = addNote("pj_beta", "Written after migration.", { title: "Post migration" }, { context });

  const second = runMigration(fixture);
  assert.equal(second.status, 0, second.stderr);
  const report = JSON.parse(second.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.migrated, false);
  assert.equal(report.verified, true);
  assert.deepEqual(report.counts, { projects: 2, notes: 5, tasks: 2, resources: 1 });
  assert.deepEqual(report.legacyCounts, { projects: 2, notes: 4, tasks: 2, resources: 1 });

  // The post-migration write was NOT clobbered by the retired legacy copy.
  const beta = getProject("pj_beta", { context });
  assert.equal(beta.notes.length, 2);
  assert.equal(beta.notes[1].id, added.note.id);
  assert.equal(beta.notes[1].text, "Written after migration.");
});

test("migration --dry-run verifies without touching the workspace", () => {
  const fixture = seedLegacy("project-migration-dry-run");
  const cli = runMigration(fixture, ["--dry-run", "--markdown"]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /# Projects markdown migration \(dry run\)/);
  assert.match(cli.stdout, /- notes: 4/);

  assert.equal(fs.existsSync(path.join(fixture.workspacePath, "data", "projects.json")), true);
  assert.equal(fs.existsSync(path.join(fixture.workspacePath, "data", "projects.legacy.json")), false);
  assert.equal(fs.existsSync(path.join(projectsRoot(fixture), "index.json")), false);
});

test("migration accepts an explicit --workspace override", () => {
  const fixture = seedLegacy("project-migration-workspace-flag");
  const cli = spawnSync(process.execPath, [SCRIPT, "--workspace", fixture.workspacePath], {
    encoding: "utf8",
    env: { ...process.env, ASSISTANT_WORKSPACE: fixture.workspacePath },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).migrated, true);
  assert.equal(fs.existsSync(path.join(projectsRoot(fixture), "index.json")), true);
});

test("migration fails loudly when there is nothing to migrate", () => {
  const fixture = createFixture("project-migration-empty");
  const cli = runMigration(fixture);
  assert.equal(cli.status, 1);
  assert.match(JSON.parse(cli.stderr).error, /Nothing to migrate/);
});
