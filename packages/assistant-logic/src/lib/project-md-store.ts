// @ts-nocheck
/**
 * Markdown-backed storage for the projects domain.
 *
 * The markdown files are the SOURCE OF TRUTH for note bodies and note
 * metadata; the JSON files are a maintained, rebuildable index.
 *
 *   data/projects/
 *     index.json                  {version:2, updatedAt, projects:[{id, slug, dir, name, status, targetDate, noteCount, updatedAt}]}
 *     <slug>/
 *       project.json              {version:2, ...project fields, notes:[<note metadata + path, NO text>]}
 *       notes/
 *         <YYYYMMDDTHHMMSSZ>-<kind>-<title-slug>.md
 *
 * A note .md file is YAML frontmatter (delimited by `---` lines) followed by
 * the note text VERBATIM — nothing is added to or trimmed from the body, so
 * `parse(render(note)).text === note.text` for every input including the empty
 * string and bodies that themselves contain `---` lines.
 *
 * Frontmatter layout:
 *   id / createdAt / updatedAt  — the note's own fields
 *   <metadata keys>             — every key of note.metadata, flat
 *   legacy:                     — top-level passthrough keys some legacy notes
 *                                 carry (category, heading, sourceUrls, ...)
 *   metadata:                   — escape hatch holding ONLY those metadata keys
 *                                 whose names collide with a reserved
 *                                 frontmatter key (live data has notes with a
 *                                 metadata.updatedAt), so the mapping stays
 *                                 lossless in both directions.
 *
 * Concurrency: one advisory lock for the whole domain at data/projects/.lock,
 * taken by every load, save, and transaction.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import { getWorkspaceContext } from "./workspace.js";
import { withFileLock, writeFileAtomic, writeJsonAtomic, readJsonFile } from "./json-store.js";

const LAYOUT_VERSION = 2;
const PROJECTS_DIR = path.join("data", "projects");
const LEGACY_STORE_FILE = path.join("data", "projects.json");
const INDEX_FILE = "index.json";
const PROJECT_FILE = "project.json";
const NOTES_DIR = "notes";
const SLUG_MAX_LENGTH = 60;
const MAX_COLLISION_ATTEMPTS = 1000;

// Note fields that live outside `metadata`; everything else on a note object
// is a legacy top-level passthrough key.
const NOTE_CORE_KEYS = new Set(["id", "createdAt", "updatedAt", "text", "metadata"]);
// Frontmatter keys that a metadata key may not occupy directly.
const RESERVED_FRONTMATTER_KEYS = new Set(["id", "createdAt", "updatedAt", "legacy", "metadata"]);
// Metadata keys rendered first, for readable files.
const METADATA_KEY_ORDER = [
  "schemaVersion",
  "title",
  "summary",
  "kind",
  "category",
  "tags",
  "refs",
  "relationships",
];
// Project fields rendered first in project.json.
const PROJECT_KEY_ORDER = [
  "id",
  "name",
  "slug",
  "description",
  "status",
  "targetDate",
  "personIds",
  "businessIds",
  "tasks",
  "resources",
  "createdAt",
  "updatedAt",
];

/**
 * Deterministic id for a note that never had one (legacy data, hand-written
 * .md files). MUST stay idempotent: the same note always yields the same id,
 * so repeated loads/migrations/reindexes do not churn ids.
 */
function stableNoteId(projectId, note, index = 0) {
  const text = typeof note === "string" ? note : note?.text || "";
  const seed = [projectId || "project", note?.createdAt || "", note?.title || note?.heading || "", index, text].join("\n");
  return `pn_${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

// ── slugs and file names ────────────────────────────────────────────────

function slugify(value, maxLength = SLUG_MAX_LENGTH) {
  return String(value || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

function compactTimestamp(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "00000000T000000Z";
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/**
 * Pick the first free name in `used`, appending -2, -3, ... on collision.
 * `used` is mutated so repeated calls in one pass stay unique.
 */
function uniqueName(base, used, suffix = "") {
  const stem = base || "untitled";
  for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? `${stem}${suffix}` : `${stem}-${attempt}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error(`Could not find a free name for ${stem}`);
}

function projectSlugBase(project) {
  return slugify(project?.name) || slugify(project?.id) || "project";
}

function noteFileBase(note) {
  const metadata = (note && note.metadata) || {};
  const stamp = compactTimestamp(note?.createdAt);
  const kind = slugify(metadata.kind || note?.kind || "note", 32) || "note";
  const title = slugify(metadata.title || note?.title || note?.heading || "", SLUG_MAX_LENGTH);
  return [stamp, kind, title].filter(Boolean).join("-");
}

// ── note <-> markdown ───────────────────────────────────────────────────

/**
 * Canonical metadata key order. It must be reproducible from a parsed .md as
 * well as from an in-memory note, otherwise project-reindex would report drift
 * on a healthy store: the well-known keys first, then the remaining flat keys,
 * then the keys that had to be escaped into the `metadata:` sub-map (which
 * parseNoteMarkdown always merges in last).
 */
function orderedMetadataKeys(metadata) {
  const keys = Object.keys(metadata);
  const known = METADATA_KEY_ORDER.filter((key) => keys.includes(key));
  const flat = keys.filter((key) => !METADATA_KEY_ORDER.includes(key) && !RESERVED_FRONTMATTER_KEYS.has(key));
  const escaped = keys.filter((key) => RESERVED_FRONTMATTER_KEYS.has(key));
  return [...known, ...flat, ...escaped];
}

function buildFrontmatter(note) {
  const frontmatter = {
    id: note.id ?? null,
    createdAt: note.createdAt ?? null,
    updatedAt: note.updatedAt ?? null,
  };
  const metadata = note.metadata && typeof note.metadata === "object" && !Array.isArray(note.metadata)
    ? note.metadata
    : {};
  const escaped = {};
  for (const key of orderedMetadataKeys(metadata)) {
    if (metadata[key] === undefined) continue;
    if (RESERVED_FRONTMATTER_KEYS.has(key)) escaped[key] = metadata[key];
    else frontmatter[key] = metadata[key];
  }
  const legacy = {};
  for (const key of Object.keys(note)) {
    if (NOTE_CORE_KEYS.has(key) || note[key] === undefined) continue;
    legacy[key] = note[key];
  }
  if (Object.keys(legacy).length) frontmatter.legacy = legacy;
  if (Object.keys(escaped).length) frontmatter.metadata = escaped;
  return frontmatter;
}

function renderNoteMarkdown(note) {
  const yaml = YAML.stringify(buildFrontmatter(note), { lineWidth: 0 });
  const body = typeof note.text === "string" ? note.text : String(note.text ?? "");
  return `---\n${yaml}---\n${body}`;
}

/**
 * Split a note file into its frontmatter YAML and its verbatim body. The body
 * starts immediately after the newline that closes the second `---` line, so a
 * body containing `---` lines of its own is untouched.
 */
function splitFrontmatter(content) {
  if (!content.startsWith("---\n")) {
    return { yaml: "", body: content };
  }
  const rest = content.slice(4);
  const match = rest.match(/(^|\n)---(\n|$)/);
  if (!match) return { yaml: "", body: content };
  const yamlEnd = match.index + (match[1] ? 1 : 0);
  const bodyStart = match.index + match[0].length;
  return { yaml: rest.slice(0, yamlEnd), body: rest.slice(bodyStart) };
}

function parseNoteMarkdown(content) {
  const { yaml, body } = splitFrontmatter(content);
  let frontmatter = {};
  if (yaml.trim()) {
    const parsed = YAML.parse(yaml);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) frontmatter = parsed;
  }
  const metadata = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (RESERVED_FRONTMATTER_KEYS.has(key)) continue;
    metadata[key] = value;
  }
  const escaped = frontmatter.metadata;
  if (escaped && typeof escaped === "object" && !Array.isArray(escaped)) {
    Object.assign(metadata, escaped);
  }
  const note = {};
  const legacy = frontmatter.legacy;
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    Object.assign(note, legacy);
  }
  if (frontmatter.id !== undefined && frontmatter.id !== null) note.id = frontmatter.id;
  if (frontmatter.createdAt !== undefined && frontmatter.createdAt !== null) {
    note.createdAt = frontmatter.createdAt;
  }
  if (frontmatter.updatedAt !== undefined && frontmatter.updatedAt !== null) {
    note.updatedAt = frontmatter.updatedAt;
  }
  note.text = body;
  note.metadata = metadata;
  return note;
}

/** project.json note index entry: the whole note minus its body, plus `path`. */
function noteIndexEntry(note, relativePath) {
  const entry = { id: note.id, path: relativePath };
  if (note.createdAt !== undefined) entry.createdAt = note.createdAt;
  if (note.updatedAt !== undefined) entry.updatedAt = note.updatedAt;
  for (const key of Object.keys(note)) {
    if (NOTE_CORE_KEYS.has(key)) continue;
    entry[key] = note[key];
  }
  // Key order must match what the frontmatter round-trip produces, otherwise
  // project-reindex would report drift on a perfectly healthy store.
  const metadata = note.metadata && typeof note.metadata === "object" && !Array.isArray(note.metadata)
    ? note.metadata
    : {};
  entry.metadata = {};
  for (const key of orderedMetadataKeys(metadata)) {
    if (metadata[key] === undefined) continue;
    entry.metadata[key] = metadata[key];
  }
  return entry;
}

function buildProjectDoc(project, slug, noteEntries) {
  const doc = { version: LAYOUT_VERSION };
  for (const key of PROJECT_KEY_ORDER) {
    if (key === "slug") {
      doc.slug = slug;
      continue;
    }
    if (project[key] !== undefined) doc[key] = project[key];
  }
  for (const key of Object.keys(project)) {
    if (key === "notes" || key === "version" || key === "slug") continue;
    if (doc[key] !== undefined) continue;
    doc[key] = project[key];
  }
  doc.notes = noteEntries;
  return doc;
}

function buildIndexEntry(project, slug, noteCount) {
  return {
    id: project.id,
    slug,
    dir: path.join(PROJECTS_DIR, slug),
    name: project.name ?? null,
    status: project.status ?? null,
    targetDate: project.targetDate ?? null,
    noteCount,
    updatedAt: project.updatedAt ?? null,
  };
}

// ── disk helpers ────────────────────────────────────────────────────────

function readFileIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR") return null;
    throw error;
  }
}

/** Project directories: real subdirectories, never dotfiles such as .lock. */
function listProjectDirNames(dir) {
  return listDirEntries(dir)
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

function listDirEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function listNoteFiles(notesDir) {
  return listDirEntries(notesDir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Read the on-disk layout: which slug each project id occupies and which file
 * each note id occupies. Used to keep slugs and note file names stable across
 * saves (a name is chosen once and never changes afterwards).
 */
function scanLayout(root) {
  const slugById = new Map();
  const pathByNote = new Map();
  const usedSlugs = new Set();
  const projectDocs = new Map();

  for (const entry of listDirEntries(root)) {
    if (!entry.name.startsWith(".")) usedSlugs.add(entry.name);
  }
  for (const entry of listDirEntries(root).filter((item) => item.isDirectory() && !item.name.startsWith("."))) {
    const docPath = path.join(root, entry.name, PROJECT_FILE);
    const raw = readFileIfExists(docPath);
    if (raw === null) continue;
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!doc || typeof doc !== "object" || !doc.id) continue;
    if (!slugById.has(doc.id)) slugById.set(doc.id, entry.name);
    projectDocs.set(entry.name, doc);
    for (const note of Array.isArray(doc.notes) ? doc.notes : []) {
      if (note && note.id && note.path) pathByNote.set(`${doc.id}::${note.id}`, note.path);
    }
  }

  return { slugById, pathByNote, usedSlugs, projectDocs };
}

// ── store ───────────────────────────────────────────────────────────────

function cloneDefaultValue(defaultValue) {
  if (typeof defaultValue === "function") return defaultValue();
  return JSON.parse(JSON.stringify(defaultValue));
}

/**
 * @param {object} options
 * @param {object} [options.context]     workspace context
 * @param {Function} options.defaultValue empty-store factory
 * @param {Function} [options.onLoad]     normalizer applied to loaded values
 */
function createProjectMarkdownStore(options = {}) {
  const context = options.context || getWorkspaceContext(options);
  const root = path.join(context.workspacePath, PROJECTS_DIR);
  const indexPath = path.join(root, INDEX_FILE);
  const legacyPath = path.join(context.workspacePath, LEGACY_STORE_FILE);
  const defaultValue = options.defaultValue || (() => ({ version: LAYOUT_VERSION, updatedAt: null, projects: [] }));

  function lockDomain(fn) {
    fs.mkdirSync(root, { recursive: true });
    // acquireFileLock() appends ".lock" to the path it is handed, so passing
    // "<root>/" lands the domain lock at <root>/.lock.
    return withFileLock(`${root}${path.sep}`, fn, options.lock);
  }

  function readProjectFromDir(slug) {
    const dir = path.join(root, slug);
    const raw = readFileIfExists(path.join(dir, PROJECT_FILE));
    if (raw === null) return null;
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Corrupt project.json in ${dir}: ${error.message}`);
    }
    if (!doc || typeof doc !== "object") return null;

    const project = {};
    for (const [key, value] of Object.entries(doc)) {
      if (key === "notes" || key === "version" || key === "slug") continue;
      project[key] = value;
    }

    const notesDir = path.join(dir, NOTES_DIR);
    const seenFiles = new Set();
    const notes = [];
    for (const entry of Array.isArray(doc.notes) ? doc.notes : []) {
      const relative = entry && typeof entry.path === "string" ? entry.path : null;
      if (!relative) continue;
      const content = readFileIfExists(path.join(dir, relative));
      if (content === null) continue; // the .md is the source of truth: no file, no note
      seenFiles.add(path.basename(relative));
      notes.push(parseNoteMarkdown(content));
    }
    // Pick up .md files the index does not know about (hand-added or
    // hand-renamed) so nothing on disk is silently invisible.
    for (const fileName of listNoteFiles(notesDir)) {
      if (seenFiles.has(fileName)) continue;
      const content = readFileIfExists(path.join(notesDir, fileName));
      if (content === null) continue;
      notes.push(parseNoteMarkdown(content));
    }
    project.notes = notes;
    return project;
  }

  function loadUnlocked() {
    if (!fs.existsSync(indexPath)) {
      // Backward compatibility: read the pre-migration single-file store.
      const legacyRaw = readFileIfExists(legacyPath);
      if (legacyRaw !== null) {
        let parsed;
        try {
          parsed = JSON.parse(legacyRaw);
        } catch (error) {
          throw new Error(`Corrupt JSON in legacy projects store at ${legacyPath} (${error.message})`);
        }
        return finishLoad(parsed);
      }
      // No index but possibly project dirs (e.g. a half-written layout).
      const slugs = listProjectDirNames(root);
      if (slugs.length === 0) return finishLoad(cloneDefaultValue(defaultValue));
      const store = cloneDefaultValue(defaultValue);
      store.projects = [];
      for (const slug of slugs) {
        const project = readProjectFromDir(slug);
        if (project) store.projects.push(project);
      }
      return finishLoad(store);
    }

    let index;
    try {
      index = readJsonFile(indexPath);
    } catch (error) {
      throw new Error(`Corrupt JSON in projects index at ${indexPath} (${error.message})`);
    }
    const store = cloneDefaultValue(defaultValue);
    store.version = index.version || LAYOUT_VERSION;
    store.updatedAt = index.updatedAt || store.updatedAt || null;
    store.projects = [];

    const loadedSlugs = new Set();
    for (const entry of Array.isArray(index.projects) ? index.projects : []) {
      const slug = entry && typeof entry.slug === "string" ? entry.slug : null;
      if (!slug || loadedSlugs.has(slug)) continue;
      const project = readProjectFromDir(slug);
      if (!project) continue;
      loadedSlugs.add(slug);
      store.projects.push(project);
    }
    // Project dirs missing from index.json are still real data.
    for (const slug of listProjectDirNames(root)) {
      if (loadedSlugs.has(slug)) continue;
      const project = readProjectFromDir(slug);
      if (!project) continue;
      loadedSlugs.add(slug);
      store.projects.push(project);
    }
    return finishLoad(store);
  }

  function finishLoad(value) {
    const next = value && typeof value === "object" ? value : cloneDefaultValue(defaultValue);
    return typeof options.onLoad === "function" ? options.onLoad(next) : next;
  }

  function saveUnlocked(store) {
    fs.mkdirSync(root, { recursive: true });
    const layout = scanLayout(root);
    const usedSlugs = new Set(layout.usedSlugs);
    const keptSlugs = new Set();
    const indexEntries = [];

    for (const project of Array.isArray(store.projects) ? store.projects : []) {
      let slug = layout.slugById.get(project.id);
      if (!slug) slug = uniqueName(projectSlugBase(project), usedSlugs);
      keptSlugs.add(slug);

      const dir = path.join(root, slug);
      const notesDir = path.join(dir, NOTES_DIR);
      fs.mkdirSync(notesDir, { recursive: true });

      const existingFiles = new Set(listNoteFiles(notesDir));
      const usedFiles = new Set(existingFiles);
      const keptFiles = new Set();
      const noteEntries = [];

      for (const note of Array.isArray(project.notes) ? project.notes : []) {
        let relative = note.id ? layout.pathByNote.get(`${project.id}::${note.id}`) : null;
        if (relative && keptFiles.has(relative)) relative = null;
        if (relative && !existingFiles.has(path.basename(relative))) relative = null;
        if (!relative) {
          relative = path.posix.join(NOTES_DIR, uniqueName(noteFileBase(note), usedFiles, ".md"));
        }
        const absolute = path.join(dir, relative);
        const content = renderNoteMarkdown(note);
        if (readFileIfExists(absolute) !== content) {
          writeFileAtomic(absolute, content, { mode: 0o600 });
        }
        keptFiles.add(relative);
        noteEntries.push(noteIndexEntry(note, relative));
      }

      for (const fileName of existingFiles) {
        if (keptFiles.has(path.posix.join(NOTES_DIR, fileName))) continue;
        fs.unlinkSync(path.join(notesDir, fileName));
      }

      writeJsonAtomic(path.join(dir, PROJECT_FILE), buildProjectDoc(project, slug, noteEntries));
      indexEntries.push(buildIndexEntry(project, slug, noteEntries.length));
    }

    // Hard-delete directories for projects that are gone.
    for (const slug of listProjectDirNames(root)) {
      if (keptSlugs.has(slug) || !layout.projectDocs.has(slug)) continue;
      fs.rmSync(path.join(root, slug), { recursive: true, force: true });
    }

    writeJsonAtomic(indexPath, {
      version: LAYOUT_VERSION,
      updatedAt: store.updatedAt || new Date().toISOString(),
      projects: indexEntries,
    });
    return store;
  }

  return {
    context,
    root,
    path: indexPath,
    indexPath,
    legacyPath,
    legacyPaths: [],
    exists() {
      return fs.existsSync(indexPath) || fs.existsSync(legacyPath);
    },
    getLegacyConflicts() {
      return fs.existsSync(indexPath) || !fs.existsSync(legacyPath) ? [] : [legacyPath];
    },
    assertNoLegacyConflict() {},
    load() {
      return lockDomain(loadUnlocked);
    },
    save(value) {
      return lockDomain(() => saveUnlocked(value));
    },
    transaction(mutator) {
      return lockDomain(() => {
        const value = loadUnlocked();
        let shouldSave = true;
        const controls = {
          skipSave() {
            shouldSave = false;
          },
          markDirty() {
            shouldSave = true;
          },
        };
        const result = mutator(value, controls);
        if (shouldSave) saveUnlocked(value);
        return result;
      });
    },
    // Escape hatches for the reindex/migration scripts.
    lockDomain,
    saveUnlocked,
    loadUnlocked,
    scanLayout: () => scanLayout(root),
    readProjectFromDir,
  };
}

// ── reindex ─────────────────────────────────────────────────────────────

function stringifyDoc(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Rebuild every project.json note index and index.json purely from the .md
 * files' frontmatter plus each project.json's non-note fields.
 *
 * Note ORDER is preserved for notes the current project.json already knows
 * (by id); unknown files are appended in file-name order. That keeps a healthy
 * store drift-free while still absorbing hand-added files.
 *
 * @returns {{changed:boolean, projects:Array, drift:Array, indexChanged:boolean, counts:object}}
 */
function rebuildProjectIndexes(root, { apply = false } = {}) {
  const currentIndexRaw = readFileIfExists(path.join(root, INDEX_FILE));
  let currentIndex = null;
  if (currentIndexRaw !== null) {
    try {
      currentIndex = JSON.parse(currentIndexRaw);
    } catch (error) {
      currentIndex = null;
    }
  }

  const indexOrder = [];
  for (const entry of currentIndex && Array.isArray(currentIndex.projects) ? currentIndex.projects : []) {
    if (entry && typeof entry.slug === "string" && !indexOrder.includes(entry.slug)) indexOrder.push(entry.slug);
  }
  const onDisk = listProjectDirNames(root);
  const slugs = [
    ...indexOrder.filter((slug) => onDisk.includes(slug)),
    ...onDisk.filter((slug) => !indexOrder.includes(slug)),
  ];

  const drift = [];
  const projects = [];
  const indexEntries = [];
  let noteCount = 0;

  for (const slug of slugs) {
    const dir = path.join(root, slug);
    const rawDoc = readFileIfExists(path.join(dir, PROJECT_FILE));
    if (rawDoc === null) {
      drift.push({ slug, kind: "missing-project-json", detail: `${PROJECT_FILE} missing; directory skipped` });
      continue;
    }
    let currentDoc;
    try {
      currentDoc = JSON.parse(rawDoc);
    } catch (error) {
      drift.push({ slug, kind: "corrupt-project-json", detail: error.message });
      continue;
    }

    const projectFields = {};
    for (const [key, value] of Object.entries(currentDoc)) {
      if (key === "notes" || key === "version" || key === "slug") continue;
      projectFields[key] = value;
    }
    const projectId = projectFields.id || `pj_${slug}`;

    const notesDir = path.join(dir, NOTES_DIR);
    const files = listNoteFiles(notesDir);
    const parsedByFile = new Map();
    for (const fileName of files) {
      const content = readFileIfExists(path.join(notesDir, fileName));
      if (content === null) continue;
      parsedByFile.set(fileName, parseNoteMarkdown(content));
    }

    const currentEntries = Array.isArray(currentDoc.notes) ? currentDoc.notes : [];
    const orderedFiles = [];
    for (const entry of currentEntries) {
      const fileName = entry && typeof entry.path === "string" ? path.basename(entry.path) : null;
      if (!fileName) continue;
      if (!parsedByFile.has(fileName)) {
        drift.push({ slug, kind: "missing-note-file", detail: `${entry.path} listed in ${PROJECT_FILE} but absent` });
        continue;
      }
      if (!orderedFiles.includes(fileName)) orderedFiles.push(fileName);
    }
    for (const fileName of files) {
      if (!orderedFiles.includes(fileName)) {
        if (currentEntries.length) {
          drift.push({ slug, kind: "unindexed-note-file", detail: `${NOTES_DIR}/${fileName} is not listed in ${PROJECT_FILE}` });
        }
        orderedFiles.push(fileName);
      }
    }

    const noteEntries = orderedFiles.map((fileName, index) => {
      const note = parsedByFile.get(fileName);
      if (!note.id) {
        note.id = stableNoteId(projectId, note, index);
        drift.push({ slug, kind: "note-missing-id", detail: `${NOTES_DIR}/${fileName} had no id; derived ${note.id}` });
      }
      return noteIndexEntry(note, path.posix.join(NOTES_DIR, fileName));
    });

    const desiredDoc = buildProjectDoc(projectFields, slug, noteEntries);
    const desiredRaw = stringifyDoc(desiredDoc);
    const changed = desiredRaw !== rawDoc;
    if (changed) {
      drift.push({ slug, kind: "stale-project-json", detail: `${PROJECT_FILE} note index does not match the .md files` });
      if (apply) writeJsonAtomic(path.join(dir, PROJECT_FILE), desiredDoc);
    }

    noteCount += noteEntries.length;
    projects.push({ slug, id: projectId, name: projectFields.name ?? null, noteCount: noteEntries.length, changed });
    indexEntries.push(buildIndexEntry(projectFields, slug, noteEntries.length));
  }

  // index.updatedAt is intentionally compared as "whatever is on disk" so a
  // healthy store never reports drift just because time passed.
  const keptUpdatedAt = currentIndex && currentIndex.updatedAt ? currentIndex.updatedAt : null;
  const comparableIndex = { version: LAYOUT_VERSION, updatedAt: keptUpdatedAt, projects: indexEntries };
  const indexChanged = currentIndexRaw === null || stringifyDoc(comparableIndex) !== currentIndexRaw;
  if (indexChanged) {
    drift.push({
      slug: null,
      kind: currentIndexRaw === null ? "missing-index-json" : "stale-index-json",
      detail: `${INDEX_FILE} does not match the project directories`,
    });
    if (apply) {
      writeJsonAtomic(path.join(root, INDEX_FILE), {
        version: LAYOUT_VERSION,
        updatedAt: new Date().toISOString(),
        projects: indexEntries,
      });
    }
  }

  return {
    changed: indexChanged || projects.some((project) => project.changed),
    indexChanged,
    projects,
    drift,
    counts: { projects: projects.length, notes: noteCount },
  };
}

export {
  LAYOUT_VERSION,
  PROJECTS_DIR,
  LEGACY_STORE_FILE,
  INDEX_FILE,
  PROJECT_FILE,
  NOTES_DIR,
  buildFrontmatter,
  buildIndexEntry,
  buildProjectDoc,
  compactTimestamp,
  createProjectMarkdownStore,
  listNoteFiles,
  listProjectDirNames,
  noteFileBase,
  rebuildProjectIndexes,
  stableNoteId,
  noteIndexEntry,
  parseNoteMarkdown,
  projectSlugBase,
  renderNoteMarkdown,
  scanLayout,
  slugify,
  splitFrontmatter,
  uniqueName,
};
