// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { getWorkspaceContext } from "./lib/workspace.js";
import {
  addNote,
  addProject,
  deleteProject,
  getProject,
  listProjectNoteMetadata,
  loadStore,
  updateNote,
} from "./lib/project-store.js";
import {
  createProjectMarkdownStore,
  parseNoteMarkdown,
  renderNoteMarkdown,
} from "./lib/project-md-store.js";
import { createFixture } from "./test-helpers.js";

function contextFor(fixture) {
  return getWorkspaceContext({
    repoRoot: fixture.repoRoot,
    env: { ASSISTANT_WORKSPACE: fixture.workspacePath },
  });
}

function projectsRoot(fixture) {
  return path.join(fixture.workspacePath, "data", "projects");
}

function slugFor(fixture, projectId) {
  const index = JSON.parse(fs.readFileSync(path.join(projectsRoot(fixture), "index.json"), "utf8"));
  return index.projects.find((entry) => entry.id === projectId).slug;
}

// ── frontmatter round trips ─────────────────────────────────────────────

const ROUND_TRIP_NOTES = {
  "nested ad-hoc metadata": {
    id: "pn_0000000000000001",
    createdAt: "2026-06-23T14:14:44.000Z",
    updatedAt: "2026-06-24T01:02:03.456Z",
    text: "Body line one.\nBody line two.",
    metadata: {
      schemaVersion: 1,
      title: "Nested metadata",
      summary: "Summary.",
      kind: "reference",
      category: "general",
      tags: ["a", "b"],
      refs: [{ type: "url", url: "https://example.test/x?a=1&b=2" }],
      relationships: [{ type: "project", id: "pj_x", relationship: "related" }],
      meetingEntryDefaults: {
        location: null,
        attendees: ["Tim", "Someone Else"],
        nested: { deep: { deeper: [1, 2, { three: true }] } },
      },
      accessRule: "only when explicitly requested",
      current: false,
    },
  },
  "body containing frontmatter delimiters": {
    id: "pn_0000000000000002",
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-02T03:04:05.000Z",
    text: "Intro\n\n---\n\ntitle: not frontmatter\nkind: still body\n\n---\n\nOutro",
    metadata: { schemaVersion: 1, title: "Delimiters", summary: "s", kind: "note", category: "general", tags: [] },
  },
  "unicode and emoji": {
    id: "pn_0000000000000003",
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-02T03:04:05.000Z",
    text: "한국어 — em-dash, “smart quotes”, ünïcödé, 🎧 emoji, tab\there",
    metadata: {
      schemaVersion: 1,
      title: "유니코드 — 제목",
      summary: "요약",
      kind: "note",
      category: "일반",
      tags: ["한국어", "emoji-🎧"],
    },
  },
  "empty text": {
    id: "pn_0000000000000004",
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-02T03:04:05.000Z",
    text: "",
    metadata: { schemaVersion: 1, title: "Empty", summary: "s", kind: "note", category: "general", tags: [] },
  },
  "legacy top-level passthrough keys": {
    id: "pn_0000000000000005",
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-02T03:04:05.000Z",
    text: "INDUSTRY INFO — Roofing software stack",
    category: "INDUSTRY INFO",
    heading: "Roofing software stack",
    sourceUrls: ["https://example.test/frsa"],
    sourceMetadata: { fetchedAt: "2026-01-01T00:00:00.000Z", via: { tool: "browser", version: 2 } },
    insights: ["one", "two"],
    data: { rows: [{ a: 1 }, { a: 2 }] },
    metadata: { schemaVersion: 1, title: "Roofing software stack", summary: "s", kind: "reference", category: "INDUSTRY INFO", tags: [] },
  },
  "metadata key colliding with a reserved frontmatter key": {
    id: "pn_0000000000000006",
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-06-25T14:58:47.730Z",
    text: "Body.",
    metadata: {
      schemaVersion: 1,
      title: "Collision",
      summary: "s",
      kind: "note",
      category: "general",
      tags: [],
      // Live data really does carry a metadata.updatedAt distinct from the
      // note's own updatedAt.
      updatedAt: "2020-01-01T00:00:00.000Z",
    },
  },
  "values that YAML could coerce": {
    id: "pn_0000000000000007",
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-02T03:04:05.000Z",
    text: "yes",
    metadata: {
      schemaVersion: 1,
      title: "1.20",
      summary: "no",
      kind: "note",
      category: "general",
      tags: ["true", "null", "2026-01-02", "007", "~"],
      canonicalKey: "a:b:c",
      triggers: ["- leading dash", "#hash", "@at", "{brace}", "  padded  "],
    },
  },
};

for (const [name, note] of Object.entries(ROUND_TRIP_NOTES)) {
  test(`note markdown round-trips: ${name}`, () => {
    const rendered = renderNoteMarkdown(note);
    assert.equal(rendered.startsWith("---\n"), true);
    const parsed = parseNoteMarkdown(rendered);
    assert.deepEqual(parsed, JSON.parse(JSON.stringify(note)));
    // Body is verbatim: no trimming, no added or removed newlines.
    assert.equal(parsed.text, note.text);
    // Rendering the parsed note reproduces the same bytes.
    assert.equal(renderNoteMarkdown(parsed), rendered);
  });
}

test("note markdown round-trips through the store on disk", () => {
  const fixture = createFixture("project-md-roundtrip");
  const context = contextFor(fixture);
  const store = createProjectMarkdownStore({ context });
  const saved = {
    version: 2,
    updatedAt: "2026-01-02T03:04:05.000Z",
    projects: [
      {
        id: "pj_roundtrip",
        name: "Round Trip",
        description: null,
        status: "active",
        targetDate: null,
        personIds: [],
        businessIds: [],
        resources: [],
        tasks: [],
        createdAt: "2026-01-02T03:04:05.000Z",
        updatedAt: "2026-01-02T03:04:05.000Z",
        calendar: { adHoc: true, nested: [1, 2, 3] },
        notes: Object.values(ROUND_TRIP_NOTES),
      },
    ],
  };
  store.save(saved);

  const reloaded = store.load();
  assert.equal(reloaded.projects.length, 1);
  assert.deepEqual(reloaded.projects[0].notes, JSON.parse(JSON.stringify(Object.values(ROUND_TRIP_NOTES))));
  // Unknown project-level keys survive.
  assert.deepEqual(reloaded.projects[0].calendar, { adHoc: true, nested: [1, 2, 3] });
  // The layout carries no per-project `version`/`slug` leakage into the API shape.
  assert.equal(Object.hasOwn(reloaded.projects[0], "version"), false);
  assert.equal(Object.hasOwn(reloaded.projects[0], "slug"), false);
});

// ── layout ──────────────────────────────────────────────────────────────

test("addNote writes a markdown file and indexes it without the body", () => {
  const fixture = createFixture("project-md-layout");
  const context = contextFor(fixture);
  const project = addProject({ name: "Layout Project" }, { context });
  const added = addNote(project.id, "Body text here.", { title: "Layout note", kind: "workflow" }, { context });

  const slug = slugFor(fixture, project.id);
  assert.equal(slug, "layout-project");
  const dir = path.join(projectsRoot(fixture), slug);

  const doc = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
  assert.equal(doc.version, 2);
  assert.equal(doc.slug, slug);
  assert.equal(doc.notes.length, 1);
  assert.equal(doc.notes[0].id, added.note.id);
  assert.equal(Object.hasOwn(doc.notes[0], "text"), false);
  assert.match(doc.notes[0].path, /^notes\/\d{8}T\d{6}Z-workflow-layout-note\.md$/);

  const index = JSON.parse(fs.readFileSync(path.join(projectsRoot(fixture), "index.json"), "utf8"));
  assert.equal(index.version, 2);
  assert.equal(index.projects[0].noteCount, 1);
  assert.equal(index.projects[0].dir, path.join("data", "projects", slug));
  // Timestamp cascade: note -> project -> index all share one `now`.
  assert.equal(index.updatedAt, added.note.updatedAt);
  assert.equal(index.projects[0].updatedAt, added.note.updatedAt);

  const raw = fs.readFileSync(path.join(dir, doc.notes[0].path), "utf8");
  assert.equal(raw.endsWith("---\nBody text here."), true);
});

test("a note file name never changes when the note is updated", () => {
  const fixture = createFixture("project-md-stable-name");
  const context = contextFor(fixture);
  const project = addProject({ name: "Stable Names" }, { context });
  const added = addNote(project.id, "First body.", { title: "Original title", kind: "note" }, { context });
  const dir = path.join(projectsRoot(fixture), slugFor(fixture, project.id));
  const before = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8")).notes[0].path;

  updateNote(
    project.id,
    added.note.id,
    { text: "Second body entirely.", metadata: { title: "A completely different title", kind: "runbook" } },
    { context }
  );

  const doc = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
  assert.equal(doc.notes[0].path, before);
  assert.equal(fs.readdirSync(path.join(dir, "notes")).length, 1);
  assert.equal(
    fs.readFileSync(path.join(dir, before), "utf8").endsWith("---\nSecond body entirely."),
    true
  );
});

test("a project directory slug never changes when the project is renamed", () => {
  const fixture = createFixture("project-md-stable-slug");
  const context = contextFor(fixture);
  const project = addProject({ name: "Original Name" }, { context });
  assert.equal(slugFor(fixture, project.id), "original-name");

  const store = createProjectMarkdownStore({ context });
  const loaded = store.load();
  loaded.projects[0].name = "Totally Renamed";
  store.save(loaded);

  assert.equal(slugFor(fixture, project.id), "original-name");
  const index = JSON.parse(fs.readFileSync(path.join(projectsRoot(fixture), "index.json"), "utf8"));
  assert.equal(index.projects[0].name, "Totally Renamed");
});

test("colliding project names and note file names get numeric suffixes", () => {
  const fixture = createFixture("project-md-collisions");
  const context = contextFor(fixture);
  const first = addProject({ name: "Same Name" }, { context });
  const second = addProject({ name: "Same Name" }, { context });
  const third = addProject({ name: "same name!" }, { context });

  assert.equal(slugFor(fixture, first.id), "same-name");
  assert.equal(slugFor(fixture, second.id), "same-name-2");
  assert.equal(slugFor(fixture, third.id), "same-name-3");

  // Two notes with the same createdAt, kind, and title collide on file name.
  const store = createProjectMarkdownStore({ context });
  const loaded = store.load();
  const target = loaded.projects.find((entry) => entry.id === first.id);
  const template = (id) => ({
    id,
    createdAt: "2026-03-04T05:06:07.000Z",
    updatedAt: "2026-03-04T05:06:07.000Z",
    text: `body ${id}`,
    metadata: { schemaVersion: 1, title: "Same Title", summary: "s", kind: "note", category: "general", tags: [] },
  });
  target.notes = [template("pn_aaaaaaaaaaaaaaa1"), template("pn_aaaaaaaaaaaaaaa2"), template("pn_aaaaaaaaaaaaaaa3")];
  store.save(loaded);

  const doc = JSON.parse(
    fs.readFileSync(path.join(projectsRoot(fixture), "same-name", "project.json"), "utf8")
  );
  assert.deepEqual(doc.notes.map((note) => note.path), [
    "notes/20260304T050607Z-note-same-title.md",
    "notes/20260304T050607Z-note-same-title-2.md",
    "notes/20260304T050607Z-note-same-title-3.md",
  ]);
  const reloaded = store.load().projects.find((entry) => entry.id === first.id);
  assert.deepEqual(reloaded.notes.map((note) => note.text), ["body pn_aaaaaaaaaaaaaaa1", "body pn_aaaaaaaaaaaaaaa2", "body pn_aaaaaaaaaaaaaaa3"]);
});

test("frontmatter wins over the cached project.json entry", () => {
  const fixture = createFixture("project-md-frontmatter-authority");
  const context = contextFor(fixture);
  const project = addProject({ name: "Authority" }, { context });
  const added = addNote(project.id, "Body.", { title: "Cached title", kind: "note", tags: ["cached"] }, { context });

  const dir = path.join(projectsRoot(fixture), slugFor(fixture, project.id));
  const notePath = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8")).notes[0].path;
  const absolute = path.join(dir, notePath);
  const edited = fs
    .readFileSync(absolute, "utf8")
    .replace("title: Cached title", "title: Hand-edited title");
  fs.writeFileSync(absolute, edited);

  const note = getProject(project.id, { context }).notes.find((entry) => entry.id === added.note.id);
  assert.equal(note.metadata.title, "Hand-edited title");
  assert.equal(
    listProjectNoteMetadata({ projectId: project.id }, { context })[0].metadata.title,
    "Hand-edited title"
  );
});

test("deleteProject removes the project directory", () => {
  const fixture = createFixture("project-md-delete");
  const context = contextFor(fixture);
  const keep = addProject({ name: "Keep Me" }, { context });
  const drop = addProject({ name: "Drop Me" }, { context });
  addNote(drop.id, "Doomed note.", { title: "Doomed" }, { context });

  const result = deleteProject(drop.id, { context });
  assert.equal(result.found, true);
  assert.equal(fs.existsSync(path.join(projectsRoot(fixture), "drop-me")), false);
  assert.equal(fs.existsSync(path.join(projectsRoot(fixture), "keep-me")), true);
  const index = JSON.parse(fs.readFileSync(path.join(projectsRoot(fixture), "index.json"), "utf8"));
  assert.deepEqual(index.projects.map((entry) => entry.id), [keep.id]);
});

test("removing a note deletes its markdown file", () => {
  const fixture = createFixture("project-md-note-removal");
  const context = contextFor(fixture);
  const project = addProject({ name: "Prune" }, { context });
  addNote(project.id, "Keep this.", { title: "Keeper" }, { context });
  const doomed = addNote(project.id, "Drop this.", { title: "Doomed" }, { context });

  const dir = path.join(projectsRoot(fixture), slugFor(fixture, project.id));
  assert.equal(fs.readdirSync(path.join(dir, "notes")).length, 2);

  const store = createProjectMarkdownStore({ context });
  const loaded = store.load();
  const target = loaded.projects.find((entry) => entry.id === project.id);
  target.notes = target.notes.filter((note) => note.id !== doomed.note.id);
  store.save(loaded);

  const files = fs.readdirSync(path.join(dir, "notes"));
  assert.equal(files.length, 1);
  assert.match(files[0], /keeper/);
});

// ── legacy compatibility ────────────────────────────────────────────────

test("loadStore still reads the legacy data/projects.json before migration", () => {
  const fixture = createFixture("project-md-legacy-read");
  const context = contextFor(fixture);
  fs.writeFileSync(
    path.join(fixture.workspacePath, "data", "projects.json"),
    JSON.stringify(
      {
        version: 1,
        updatedAt: "2026-05-01T00:00:00.000Z",
        projects: [
          {
            id: "pj_legacy_read",
            name: "Legacy Read",
            status: "active",
            createdAt: "2026-05-01T00:00:00.000Z",
            updatedAt: "2026-05-01T00:00:00.000Z",
            notes: [{ text: "Legacy body.", createdAt: "2026-05-02T00:00:00.000Z" }],
          },
        ],
      },
      null,
      2
    )
  );

  const store = loadStore({ context });
  assert.equal(store.projects.length, 1);
  assert.equal(store.projects[0].notes[0].text, "Legacy body.");
  assert.match(store.projects[0].notes[0].id, /^pn_[0-9a-f]{16}$/);

  // Once anything is written, the new layout exists and takes precedence.
  addNote("pj_legacy_read", "New body.", { title: "New note" }, { context });
  assert.equal(fs.existsSync(path.join(projectsRoot(fixture), "index.json")), true);
  const after = loadStore({ context });
  assert.deepEqual(after.projects[0].notes.map((note) => note.text), ["Legacy body.", "New body."]);
});
