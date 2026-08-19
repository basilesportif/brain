#!/usr/bin/env node
// @ts-nocheck
/**
 * One-shot, idempotent migration of the projects store from the single
 * data/projects.json document to the markdown layout under data/projects/.
 *
 * Notes are written VERBATIM: the migration does not run the metadata
 * derivation in project-store.ts, so ad-hoc metadata keys, legacy top-level
 * passthrough keys, and note bodies survive byte-for-byte. The only fields it
 * fills in are the ones the layout needs and a legacy note may lack: id
 * (deterministic stableNoteId, so re-running never churns ids), createdAt, and
 * updatedAt.
 *
 * Every migrated note is verified by parsing the .md that was just written and
 * deep-comparing it against the source note. Counts of projects, notes, tasks,
 * and resources are compared too. Only when everything verifies is the legacy
 * file renamed to data/projects.legacy.json (it is never deleted).
 *
 * Re-running once the new layout exists re-verifies and reports migrated:false.
 *
 * Flags:
 *   --dry-run              build and verify the layout in a temp dir; touch nothing
 *   --workspace <path>     workspace root override (for testing)
 *   --markdown             human-readable report instead of JSON
 *
 * Output: report to stdout, errors to stderr. Exit 1 on verification failure.
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getWorkspaceContext } from "../lib/workspace.js";
import {
  LAYOUT_VERSION,
  PROJECTS_DIR,
  createProjectMarkdownStore,
  parseNoteMarkdown,
  stableNoteId,
} from "../lib/project-md-store.js";

const LEGACY_FILE = path.join("data", "projects.json");
const RETIRED_FILE = path.join("data", "projects.legacy.json");

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--dry-run") { args.dryRun = true; i++; }
    else if (arg === "--markdown") { args.markdown = true; i++; }
    else if (arg === "--json") { args.json = true; i++; }
    else if (arg === "--workspace" && argv[i + 1]) { args.workspace = argv[++i]; i++; }
    else { i++; }
  }
  return args;
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Copy a legacy note verbatim, filling only the fields the layout requires.
 * Mirrors normalizeNote()'s fallbacks so ids/dates match what the old store
 * already reported to callers.
 */
function prepareNote(project, note, index, fallbackDate) {
  const source = note && typeof note === "object" && !Array.isArray(note)
    ? { ...note }
    : { text: String(note ?? "") };
  const text = typeof source.text === "string" ? source.text : String(source.text ?? "");
  const createdAt = source.createdAt || fallbackDate || project.createdAt || project.updatedAt || new Date().toISOString();
  const updatedAt = source.updatedAt || createdAt;
  const prepared = { ...source, text, createdAt, updatedAt };
  prepared.id = (typeof source.id === "string" && source.id.trim()) || stableNoteId(project.id, { ...source, text }, index);
  prepared.metadata = source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata)
    ? source.metadata
    : {};
  return {
    prepared,
    backfilled: {
      id: !(typeof source.id === "string" && source.id.trim()),
      createdAt: !source.createdAt,
      updatedAt: !source.updatedAt,
      metadata: !source.metadata,
    },
  };
}

function prepareStore(legacy) {
  const fallbackDate = legacy.updatedAt || new Date().toISOString();
  const backfills = { id: 0, createdAt: 0, updatedAt: 0, metadata: 0 };
  const projects = (Array.isArray(legacy.projects) ? legacy.projects : []).map((project) => {
    const next = { ...project };
    next.notes = (Array.isArray(project.notes) ? project.notes : []).map((note, index) => {
      const { prepared, backfilled } = prepareNote(project, note, index, fallbackDate);
      for (const key of Object.keys(backfills)) if (backfilled[key]) backfills[key] += 1;
      return prepared;
    });
    if (!Array.isArray(next.tasks)) next.tasks = [];
    if (!Array.isArray(next.resources)) next.resources = [];
    return next;
  });
  return {
    store: { version: LAYOUT_VERSION, updatedAt: legacy.updatedAt || fallbackDate, projects },
    backfills,
  };
}

function countStore(store) {
  let notes = 0;
  let tasks = 0;
  let resources = 0;
  for (const project of store.projects || []) {
    notes += (project.notes || []).length;
    tasks += (project.tasks || []).length;
    resources += (project.resources || []).length;
  }
  return { projects: (store.projects || []).length, notes, tasks, resources };
}

/**
 * Read every written .md back and deep-compare it against the note we asked to
 * be written. Any mismatch is a hard failure: the legacy file must not be
 * retired if a single byte was lost.
 */
function verify(targetWorkspace, expectedStore) {
  const root = path.join(targetWorkspace, PROJECTS_DIR);
  const index = readJsonIfExists(path.join(root, "index.json"));
  const failures = [];
  if (!index) {
    failures.push({ kind: "missing-index", detail: "index.json was not written" });
    return { ok: false, failures, counts: { projects: 0, notes: 0, tasks: 0, resources: 0 } };
  }

  const readBack = { version: index.version, updatedAt: index.updatedAt, projects: [] };
  for (const entry of index.projects || []) {
    const dir = path.join(root, entry.slug);
    const doc = readJsonIfExists(path.join(dir, "project.json"));
    if (!doc) {
      failures.push({ kind: "missing-project-json", detail: entry.slug });
      continue;
    }
    const project = {};
    for (const [key, value] of Object.entries(doc)) {
      if (key === "notes" || key === "version" || key === "slug") continue;
      project[key] = value;
    }
    project.notes = (doc.notes || []).map((noteEntry) => {
      const filePath = path.join(dir, noteEntry.path);
      return parseNoteMarkdown(fs.readFileSync(filePath, "utf8"));
    });
    readBack.projects.push(project);
  }

  const expectedById = new Map(expectedStore.projects.map((project) => [project.id, project]));
  for (const project of readBack.projects) {
    const expected = expectedById.get(project.id);
    if (!expected) {
      failures.push({ kind: "unexpected-project", detail: project.id });
      continue;
    }
    expectedById.delete(project.id);
    const notesById = new Map(project.notes.map((note) => [note.id, note]));
    for (const expectedNote of expected.notes) {
      const actual = notesById.get(expectedNote.id);
      if (!actual) {
        failures.push({ kind: "missing-note", detail: `${project.id}/${expectedNote.id}` });
        continue;
      }
      try {
        assert.deepStrictEqual(actual, JSON.parse(JSON.stringify(expectedNote)));
      } catch (error) {
        failures.push({
          kind: "note-round-trip",
          detail: `${project.id}/${expectedNote.id}: ${error.message.split("\n")[0]}`,
        });
      }
    }
  }
  for (const missing of expectedById.keys()) {
    failures.push({ kind: "missing-project", detail: missing });
  }

  const expectedCounts = countStore(expectedStore);
  const actualCounts = countStore(readBack);
  for (const key of Object.keys(expectedCounts)) {
    if (expectedCounts[key] !== actualCounts[key]) {
      failures.push({ kind: "count-mismatch", detail: `${key}: expected ${expectedCounts[key]}, got ${actualCounts[key]}` });
    }
  }

  return { ok: failures.length === 0, failures, counts: actualCounts, expectedCounts };
}

function renderMarkdown(report) {
  const lines = [
    `# Projects markdown migration${report.dryRun ? " (dry run)" : ""}`,
    "",
    `Workspace: ${report.workspace}`,
    `Target: ${report.target}`,
    `Migrated: ${report.migrated}`,
    `Verified: ${report.verified}`,
    "",
    "## Counts",
    "",
    `- projects: ${report.counts.projects}`,
    `- notes: ${report.counts.notes}`,
    `- tasks: ${report.counts.tasks}`,
    `- resources: ${report.counts.resources}`,
    "",
  ];
  if (report.backfills) {
    lines.push(
      "## Backfilled fields",
      "",
      `- ids: ${report.backfills.id}`,
      `- createdAt: ${report.backfills.createdAt}`,
      `- updatedAt: ${report.backfills.updatedAt}`,
      `- metadata: ${report.backfills.metadata}`,
      ""
    );
  }
  if (report.failures.length) {
    lines.push("## Failures", "");
    for (const failure of report.failures) lines.push(`- ${failure.kind}: ${failure.detail}`);
    lines.push("");
  }
  if (report.legacyRenamedTo) lines.push(`Legacy store renamed to ${report.legacyRenamedTo}`, "");
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv);

  const context = args.workspace
    ? getWorkspaceContext({ workspacePath: path.resolve(args.workspace) })
    : getWorkspaceContext();
  const workspace = context.workspacePath;
  const legacyPath = path.join(workspace, LEGACY_FILE);
  const retiredPath = path.join(workspace, RETIRED_FILE);
  const indexPath = path.join(workspace, PROJECTS_DIR, "index.json");

  // Only the LIVE legacy file is a migration source. data/projects.legacy.json
  // is the retired copy this script renames on success; re-reading it as a
  // source would clobber everything written since the migration.
  const legacy = readJsonIfExists(legacyPath);
  const retired = readJsonIfExists(retiredPath);
  const layoutExists = fs.existsSync(indexPath);

  if (!legacy && !retired && !layoutExists) {
    throw new Error(`Nothing to migrate: neither ${legacyPath} nor ${indexPath} exists`);
  }

  // Already migrated: re-verify (the layout loads, every .md parses) and
  // report a no-op. Counts are reported next to the retired file's counts for
  // eyeballing, but they legitimately diverge once the store is used.
  if (!legacy && layoutExists) {
    const loaded = createProjectMarkdownStore({ context }).load();
    const report = {
      ok: true,
      dryRun: Boolean(args.dryRun),
      migrated: false,
      verified: true,
      workspace,
      target: path.join(workspace, PROJECTS_DIR),
      counts: countStore(loaded),
      legacyCounts: retired ? countStore(retired) : null,
      failures: [],
      note: "layout already present and no live legacy store; re-verified only",
    };
    console.log(args.markdown ? renderMarkdown(report) : JSON.stringify(report, null, 2));
    return;
  }

  // Falling back to the retired copy only happens when there is no layout at
  // all (a recovery re-run after the layout was lost).
  const { store: prepared, backfills } = prepareStore(legacy || retired);

  let targetWorkspace = workspace;
  let tempRoot = null;
  if (args.dryRun) {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "projects-migration-dry-"));
    targetWorkspace = path.join(tempRoot, "workspace");
    fs.mkdirSync(path.join(targetWorkspace, "data"), { recursive: true });
  }

  const targetContext = getWorkspaceContext({ workspacePath: targetWorkspace });
  const targetStore = createProjectMarkdownStore({ context: targetContext });
  targetStore.save(prepared);

  const verification = verify(targetWorkspace, prepared);

  let legacyRenamedTo = null;
  if (verification.ok && !args.dryRun && fs.existsSync(legacyPath)) {
    fs.renameSync(legacyPath, retiredPath);
    legacyRenamedTo = retiredPath;
  }

  const report = {
    ok: verification.ok,
    dryRun: Boolean(args.dryRun),
    migrated: verification.ok && !args.dryRun,
    verified: verification.ok,
    workspace,
    target: path.join(targetWorkspace, PROJECTS_DIR),
    counts: verification.counts,
    expectedCounts: verification.expectedCounts,
    backfills,
    failures: verification.failures,
    legacyRenamedTo,
  };

  console.log(args.markdown ? renderMarkdown(report) : JSON.stringify(report, null, 2));

  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  if (!verification.ok) process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
}
