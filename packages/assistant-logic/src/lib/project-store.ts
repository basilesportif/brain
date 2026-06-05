// @ts-nocheck
import * as crypto from "node:crypto";
import { createStateStore } from "./state-stores.js";

const SCHEMA_VERSION = 1;
const NOTE_SCHEMA_VERSION = 1;

function generateId() {
  return `pj_${crypto.randomBytes(8).toString("hex")}`;
}

function generateTaskId() {
  return `pt_${crypto.randomBytes(8).toString("hex")}`;
}

function generateNoteId() {
  return `pn_${crypto.randomBytes(8).toString("hex")}`;
}

function stableNoteId(projectId, note, index = 0) {
  const text = typeof note === "string" ? note : note?.text || "";
  const seed = [projectId || "project", note?.createdAt || "", note?.title || note?.heading || "", index, text].join("\n");
  return `pn_${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function ensureTasks(project) {
  if (!Array.isArray(project.tasks)) project.tasks = [];
  return project;
}

function createEmptyStore() {
  return {
    version: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    projects: [],
  };
}

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncate(value, maxLength) {
  const text = collapseWhitespace(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = asTrimmedString(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function coerceStringArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(coerceStringArray);
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function coerceObjectArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object");
  if (value && typeof value === "object") return [value];
  return [];
}

function parseEmbeddedJson(text) {
  const trimmed = asTrimmedString(text);
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function firstNonEmptyLine(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function cleanTitleLine(line) {
  return collapseWhitespace(line)
    .replace(/^#+\s*/, "")
    .replace(/^[-*•]\s*/, "")
    .replace(/^title\s*[:—-]\s*/i, "")
    .replace(/^\{\s*"title"\s*:\s*"/i, "")
    .replace(/[",]+$/g, "")
    .trim();
}

function deriveTitle(text, note = {}) {
  const embedded = parseEmbeddedJson(text);
  const explicit = asTrimmedString(note.title || note.heading || embedded?.title || embedded?.heading);
  if (explicit) return truncate(explicit, 120);
  const first = cleanTitleLine(firstNonEmptyLine(text));
  return truncate(first || "Project note", 120);
}

function deriveSummary(text, title) {
  const embedded = parseEmbeddedJson(text);
  const explicit = asTrimmedString(embedded?.summary || embedded?.purpose);
  if (explicit) return truncate(explicit, 360);

  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => cleanTitleLine(line))
    .filter(Boolean);
  const titleKey = collapseWhitespace(title).toLowerCase();
  const summary = lines.find((line) => collapseWhitespace(line).toLowerCase() !== titleKey) || lines[0] || text;
  return truncate(summary, 360);
}

function inferCategory(text, note = {}) {
  const embedded = parseEmbeddedJson(text);
  const explicit = asTrimmedString(note.category || embedded?.category);
  if (explicit) return explicit;

  const title = deriveTitle(text, note);
  const prefix = title.split(/\s+[—–-]\s+|:\s+/)[0];
  if (prefix && prefix.length >= 3 && prefix.length <= 48 && /[A-Za-z]/.test(prefix)) {
    return slugify(prefix);
  }
  return "general";
}

function inferKind(text, category, note = {}) {
  const embedded = parseEmbeddedJson(text);
  const explicit = asTrimmedString(note.kind || embedded?.kind);
  if (explicit) return explicit;
  const haystack = `${deriveTitle(text, note)}\n${text}`.toLowerCase();
  if (/canonical|index authority|single maintenance note|source of truth/.test(haystack)) return "canonical-index";
  if (/research|sources checked|sources researched|first-pass|candidate/.test(haystack)) return "research";
  if (/checklist|workflow|rules|procedure|tasks?|next action/.test(haystack)) return "workflow";
  if (/status|update|created linked|saved|ordered|flag/.test(haystack)) return "status";
  if (/strategy|positioning|target|priority|plan/.test(haystack)) return "strategy";
  if (/brief|info|reference|background|curriculum|drills/.test(haystack)) return "reference";
  if (category && category !== "general") return "note";
  return "note";
}

function deriveTags(text, project = {}, category = "", kind = "") {
  const haystack = `${project.name || ""}\n${category}\n${kind}\n${text}`.toLowerCase();
  const tags = [];
  const projectTag = slugify(project.name || "");
  if (projectTag) tags.push(projectTag);
  const rules = [
    [/decisive outcomes|it consulting|map & wrap|native node/, "decisive-outcomes"],
    [/conference|expo|trade show|event project|attendee|frsa/, "conferences"],
    [/frsa|roofing|roofers?/, "frsa"],
    [/july 2026|july-conferences-2026/, "july-2026"],
    [/june 2026/, "june-2026"],
    [/case stud/, "case-studies"],
    [/website|homepage|landing page|redesign/, "website"],
    [/linkedin|profile/, "linkedin"],
    [/business card|moo|qr code/, "business-card"],
    [/\btax\b|\btrust\b|\bloan\b|withholding|\bubt\b/, "tax"],
    [/football|wrexham|leverkusen|leipzig|stuttgart|usmnt/, "football"],
    [/dictionary|transcription|vocabulary/, "dictionary"],
    [/homeschool|curriculum|math|vocabulary program/, "homeschool"],
    [/soccer|basketball|drill/, "sports"],
    [/golf|swing/, "golf"],
    [/korean|language/, "korean"],
    [/fieldcraft|agent recruitment|trust establishment/, "agent-recruitment"],
    [/\bcrm\b/, "crm"],
    [/leadgen|outreach/, "leadgen"],
    [/\bfood\b|\bmeals\b|\beating\b/, "food"],
    [/biohacking|daily procedures/, "biohacking"],
  ];
  for (const [pattern, tag] of rules) {
    if (pattern.test(haystack)) tags.push(tag);
  }
  if (category) tags.push(slugify(category));
  if (kind) tags.push(slugify(kind));
  return uniqueStrings(tags).slice(0, 12);
}

function refsFromSourceUrls(sourceUrls) {
  if (!Array.isArray(sourceUrls)) return [];
  return sourceUrls
    .map((url) => asTrimmedString(url))
    .filter(Boolean)
    .map((url) => ({ type: "url", url }));
}

function parseStructuredReference(value) {
  if (value && typeof value === "object") return value;
  const text = asTrimmedString(value);
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return { type: "url", url: text };
  const match = text.match(/^([a-z][a-z0-9_-]*):(.*)$/i);
  if (match) {
    const type = match[1];
    const rest = match[2].trim();
    if (/^https?:\/\//i.test(rest)) return { type, url: rest };
    if (rest.startsWith("/") || rest.includes("/")) return { type, path: rest };
    return { type, id: rest };
  }
  return { type: "reference", label: text };
}

function parseStructuredRelationship(value) {
  if (value && typeof value === "object") return value;
  const ref = parseStructuredReference(value);
  if (!ref) return null;
  if (!ref.relationship) ref.relationship = "related";
  return ref;
}

function mergeReferences(...values) {
  const refs = values
    .flatMap((value) => {
      if (!value) return [];
      if (Array.isArray(value)) return value;
      return [value];
    })
    .map(parseStructuredReference)
    .filter(Boolean);
  const seen = new Set();
  return refs.filter((ref) => {
    const key = JSON.stringify(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeRelationships(...values) {
  const relationships = values
    .flatMap((value) => {
      if (!value) return [];
      if (Array.isArray(value)) return value;
      return [value];
    })
    .map(parseStructuredRelationship)
    .filter(Boolean);
  const seen = new Set();
  return relationships.filter((relationship) => {
    const key = JSON.stringify(relationship);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function coerceRefs(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map(parseStructuredReference).filter(Boolean);
}

function coerceRelationships(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map(parseStructuredRelationship).filter(Boolean);
}

function normalizeMetadataInput(metadata = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const next = { ...metadata };
  if (next.tags !== undefined) next.tags = coerceStringArray(next.tags);
  if (next.refs !== undefined) next.refs = coerceRefs(next.refs);
  if (next.relationships !== undefined) next.relationships = coerceRelationships(next.relationships);
  return next;
}

function buildNoteMetadata({ project = {}, note = {}, text = "", metadata = {} } = {}) {
  const embedded = parseEmbeddedJson(text) || {};
  const existing = normalizeMetadataInput(note.metadata);
  const input = normalizeMetadataInput(metadata);
  const merged = { ...existing, ...input };
  const title = truncate(asTrimmedString(merged.title || note.title || note.heading || embedded.title || embedded.heading) || deriveTitle(text, { ...embedded, ...note }), 120);
  const summary = truncate(asTrimmedString(merged.summary || embedded.summary || embedded.purpose) || deriveSummary(text, title), 360);
  const category = asTrimmedString(merged.category || note.category || embedded.category) || inferCategory(text, { ...embedded, ...note });
  const canonicalKey = asTrimmedString(input.canonicalKey || existing.canonicalKey || note.canonicalKey || embedded.canonicalKey);
  const kind = asTrimmedString(merged.kind || note.kind || embedded.kind) || (canonicalKey ? "canonical-index" : inferKind(text, category, { ...embedded, ...note }));
  const tags = uniqueStrings([
    ...coerceStringArray(existing.tags),
    ...coerceStringArray(input.tags),
    ...coerceStringArray(note.tags),
    ...deriveTags(text, project, category, kind),
  ]);
  const refs = mergeReferences(existing.refs, embedded.refs, note.refs, refsFromSourceUrls(note.sourceUrls), input.refs);
  const relationships = mergeRelationships(existing.relationships, embedded.relationships, note.relationships, input.relationships);
  const metadataVersion = Number(merged.schemaVersion || NOTE_SCHEMA_VERSION) || NOTE_SCHEMA_VERSION;

  const out = {
    ...existing,
    ...input,
    schemaVersion: metadataVersion,
    title,
    summary,
    kind,
    category,
    tags,
    refs,
    relationships,
  };

  if (canonicalKey) out.canonicalKey = canonicalKey;
  if (input.current !== undefined) out.current = Boolean(input.current);
  else if (existing.current !== undefined) out.current = Boolean(existing.current);
  else if (note.current !== undefined) out.current = Boolean(note.current);
  else if (embedded.current !== undefined) out.current = Boolean(embedded.current);
  else if (canonicalKey && /canonical|source of truth|single maintenance note|current reference/i.test(`${title}\n${text}`)) out.current = true;

  return out;
}

function createNote(project, text, metadata = {}, options = {}) {
  const body = asTrimmedString(text);
  if (!body) throw new Error("Note text is required");
  const now = options.now instanceof Date ? options.now.toISOString() : (options.now || new Date().toISOString());
  const note = {
    id: options.id || generateNoteId(),
    createdAt: now,
    updatedAt: now,
    text: body,
  };
  note.metadata = buildNoteMetadata({ project, note, text: body, metadata });
  return note;
}

function normalizeNote(project, note, index = 0, fallbackDate = null) {
  const legacy = note && typeof note === "object" && !Array.isArray(note) ? { ...note } : { text: String(note || "") };
  const text = typeof legacy.text === "string" ? legacy.text : String(legacy.text || "");
  const createdAt = legacy.createdAt || fallbackDate || project.createdAt || project.updatedAt || new Date().toISOString();
  const updatedAt = legacy.updatedAt || createdAt;
  const normalized = {
    ...legacy,
    id: asTrimmedString(legacy.id) || stableNoteId(project.id, { ...legacy, text }, index),
    createdAt,
    updatedAt,
    text,
  };
  normalized.metadata = buildNoteMetadata({ project, note: normalized, text, metadata: legacy.metadata || {} });
  return normalized;
}

function normalizeProject(project, fallbackDate = null) {
  ensureTasks(project);
  if (!Array.isArray(project.notes)) project.notes = [];
  project.notes = project.notes.map((note, index) => normalizeNote(project, note, index, fallbackDate));
  return project;
}

function looksLikeStoreOptions(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (
    value.context || value.workspacePath || value.repoRoot || value.env || value.mustExist !== undefined
  ));
}

function getProjectStore(options = {}) {
  return createStateStore("projects", {
    ...options,
    defaultValue: createEmptyStore,
    onLoad(store) {
      const next = store && typeof store === "object" ? store : createEmptyStore();
      if (!Array.isArray(next.projects)) next.projects = [];
      const fallbackDate = next.updatedAt || new Date().toISOString();
      next.projects.forEach((project) => normalizeProject(project, fallbackDate));
      return next;
    },
  });
}

function loadStore(options = {}) {
  return getProjectStore(options).load();
}

function saveStore(store, options = {}) {
  store.updatedAt = new Date().toISOString();
  return getProjectStore(options).save(store);
}

function addProject(input, options = {}) {
  const name = (input.name || "").trim();
  if (!name) throw new Error("Name is required");
  const store = loadStore(options);
  const now = new Date().toISOString();
  const project = {
    id: generateId(),
    name,
    description: (input.description || "").trim() || null,
    status: input.status || "active",
    targetDate: input.targetDate || null,
    personIds: Array.isArray(input.personIds) ? input.personIds : [],
    businessIds: Array.isArray(input.businessIds) ? input.businessIds : [],
    notes: [],
    resources: [],
    tasks: [],
    createdAt: now,
    updatedAt: now,
  };
  if (input.initialNote) {
    project.notes.push(createNote(project, input.initialNote, input.initialNoteMetadata || input.noteMetadata || {}, { now }));
  }
  store.projects.push(project);
  saveStore(store, options);
  return project;
}

function updateProject(id, updates, options = {}) {
  const store = loadStore(options);
  const project = store.projects.find((p) => p.id === id);
  if (!project) return null;
  const allowed = ["name", "description", "status", "targetDate"];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      project[key] = updates[key];
    }
  }
  if (updates._addPersonIds) {
    for (const pid of updates._addPersonIds) {
      if (!project.personIds.includes(pid)) project.personIds.push(pid);
    }
  }
  if (updates._removePersonIds) {
    project.personIds = project.personIds.filter(
      (pid) => !updates._removePersonIds.includes(pid)
    );
  }
  if (updates._addBusinessIds) {
    for (const bid of updates._addBusinessIds) {
      if (!project.businessIds.includes(bid)) project.businessIds.push(bid);
    }
  }
  if (updates._removeBusinessIds) {
    project.businessIds = project.businessIds.filter(
      (bid) => !updates._removeBusinessIds.includes(bid)
    );
  }
  project.updatedAt = new Date().toISOString();
  saveStore(store, options);
  return project;
}

function listProjects({ query, status, all } = {}, options = {}) {
  const store = loadStore(options);
  let projects = store.projects;
  if (!all) {
    if (status) {
      projects = projects.filter((p) => p.status === status);
    } else {
      projects = projects.filter((p) => p.status !== "archived");
    }
  }
  if (query) {
    const lowerQuery = query.toLowerCase();
    projects = projects.filter(
      (p) =>
        p.name.toLowerCase().includes(lowerQuery) ||
        (p.description && p.description.toLowerCase().includes(lowerQuery))
    );
  }
  return projects;
}

function getProject(id, options = {}) {
  const store = loadStore(options);
  return store.projects.find((p) => p.id === id) || null;
}

function addNote(id, text, metadata = {}, options = {}) {
  if (looksLikeStoreOptions(metadata) && Object.keys(options || {}).length === 0) {
    options = metadata;
    metadata = {};
  }
  const store = loadStore(options);
  const project = store.projects.find((p) => p.id === id);
  if (!project) return null;
  const now = new Date().toISOString();
  const note = createNote(project, text, metadata, { now });
  project.notes.push(note);
  project.updatedAt = now;
  saveStore(store, options);
  return { project, note };
}

function noteMatchesFilters(entry, filters = {}) {
  const metadata = entry.metadata || {};
  if (filters.projectId && entry.projectId !== filters.projectId) return false;
  if (filters.kind && metadata.kind !== filters.kind) return false;
  if (filters.category && metadata.category !== filters.category) return false;
  if (filters.canonicalKey && metadata.canonicalKey !== filters.canonicalKey) return false;
  if (filters.current !== undefined && Boolean(metadata.current) !== Boolean(filters.current)) return false;
  if (filters.tag) {
    const tags = Array.isArray(metadata.tags) ? metadata.tags.map((tag) => String(tag).toLowerCase()) : [];
    if (!tags.includes(String(filters.tag).toLowerCase())) return false;
  }
  if (filters.query) {
    const q = String(filters.query).toLowerCase();
    const haystack = [
      entry.projectName,
      entry.noteId,
      metadata.title,
      metadata.summary,
      metadata.kind,
      metadata.category,
      metadata.canonicalKey,
      ...(Array.isArray(metadata.tags) ? metadata.tags : []),
      entry._text,
    ].filter(Boolean).join("\n").toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

function listProjectNoteMetadata(filters = {}, options = {}) {
  const store = loadStore(options);
  const entries = [];
  for (const project of store.projects) {
    for (const note of project.notes || []) {
      const entry = {
        projectId: project.id,
        projectName: project.name,
        noteId: note.id,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        textLength: typeof note.text === "string" ? note.text.length : 0,
        metadata: note.metadata || buildNoteMetadata({ project, note, text: note.text || "" }),
        _text: note.text || "",
      };
      if (noteMatchesFilters(entry, filters)) {
        delete entry._text;
        entries.push(entry);
      }
    }
  }
  entries.sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  return entries;
}

function validateProjectNotes(storeOrOptions = {}, maybeOptions = {}) {
  const store = storeOrOptions.projects ? storeOrOptions : loadStore(storeOrOptions);
  const errors = [];
  for (const project of store.projects || []) {
    (project.notes || []).forEach((note, index) => {
      const location = `${project.id || project.name || "project"}.notes[${index}]`;
      for (const key of ["id", "createdAt", "updatedAt", "text", "metadata"]) {
        if (note[key] === undefined || note[key] === null || note[key] === "") errors.push(`${location}.${key} missing`);
      }
      const metadata = note.metadata || {};
      for (const key of ["schemaVersion", "title", "summary", "kind", "category", "tags"]) {
        if (metadata[key] === undefined || metadata[key] === null || metadata[key] === "") errors.push(`${location}.metadata.${key} missing`);
      }
      if (!Array.isArray(metadata.tags)) errors.push(`${location}.metadata.tags must be an array`);
      if (metadata.refs !== undefined && !Array.isArray(metadata.refs)) errors.push(`${location}.metadata.refs must be an array`);
      if (metadata.relationships !== undefined && !Array.isArray(metadata.relationships)) errors.push(`${location}.metadata.relationships must be an array`);
    });
  }
  return { ok: errors.length === 0, errors };
}

function addResource(id, { label, url }, options = {}) {
  const store = loadStore(options);
  const project = store.projects.find((p) => p.id === id);
  if (!project) return null;
  const now = new Date().toISOString();
  const resource = { label: label.trim(), url: url.trim(), addedAt: now };
  project.resources.push(resource);
  project.updatedAt = now;
  saveStore(store, options);
  return { project, resource };
}

function removeResource(id, { index, label } = {}, options = {}) {
  const store = loadStore(options);
  const project = store.projects.find((p) => p.id === id);
  if (!project) return null;
  let removeIndex = -1;
  if (index !== undefined && index !== null) {
    removeIndex = Number(index);
  } else if (label) {
    const lowerLabel = label.toLowerCase();
    removeIndex = project.resources.findIndex(
      (r) => r.label.toLowerCase() === lowerLabel
    );
  }
  if (removeIndex < 0 || removeIndex >= project.resources.length) {
    return { project, removed: null, error: "Resource not found" };
  }
  const [removed] = project.resources.splice(removeIndex, 1);
  project.updatedAt = new Date().toISOString();
  saveStore(store, options);
  return { project, removed };
}

function addTask(id, title, options = {}) {
  const store = loadStore(options);
  const project = store.projects.find((p) => p.id === id);
  if (!project) return null;
  ensureTasks(project);
  const now = new Date().toISOString();
  const task = {
    id: generateTaskId(),
    title: title.trim(),
    status: "open",
    createdAt: now,
    completedAt: null,
  };
  project.tasks.push(task);
  project.updatedAt = now;
  saveStore(store, options);
  return { project, task };
}

function completeTask(projectId, taskId, options = {}) {
  const store = loadStore(options);
  const project = store.projects.find((p) => p.id === projectId);
  if (!project) return null;
  ensureTasks(project);
  const task = project.tasks.find((t) => t.id === taskId);
  if (!task) return { project, task: null, error: "Task not found" };
  const now = new Date().toISOString();
  task.status = "done";
  task.completedAt = now;
  project.updatedAt = now;
  saveStore(store, options);
  return { project, task };
}

function reopenTask(projectId, taskId, options = {}) {
  const store = loadStore(options);
  const project = store.projects.find((p) => p.id === projectId);
  if (!project) return null;
  ensureTasks(project);
  const task = project.tasks.find((t) => t.id === taskId);
  if (!task) return { project, task: null, error: "Task not found" };
  task.status = "open";
  task.completedAt = null;
  project.updatedAt = new Date().toISOString();
  saveStore(store, options);
  return { project, task };
}

function removeTask(projectId, taskId, options = {}) {
  const store = loadStore(options);
  const project = store.projects.find((p) => p.id === projectId);
  if (!project) return null;
  ensureTasks(project);
  const index = project.tasks.findIndex((t) => t.id === taskId);
  if (index === -1) return { project, removed: null, error: "Task not found" };
  const [removed] = project.tasks.splice(index, 1);
  project.updatedAt = new Date().toISOString();
  saveStore(store, options);
  return { project, removed };
}

function listTasks(projectId, { status } = {}, options = {}) {
  const store = loadStore(options);
  const project = store.projects.find((p) => p.id === projectId);
  if (!project) return null;
  ensureTasks(project);
  let tasks = project.tasks;
  if (status) {
    tasks = tasks.filter((t) => t.status === status);
  }
  return tasks;
}

function deleteProject(id, options = {}) {
  const store = loadStore(options);
  const index = store.projects.findIndex((p) => p.id === id);
  if (index === -1) return { found: false };
  const [removed] = store.projects.splice(index, 1);
  saveStore(store, options);
  return { found: true, deleted: { id: removed.id, name: removed.name } };
}

export {
  getProjectStore,
  loadStore,
  saveStore,
  addProject,
  updateProject,
  listProjects,
  getProject,
  addNote,
  createNote,
  buildNoteMetadata,
  listProjectNoteMetadata,
  validateProjectNotes,
  addResource,
  removeResource,
  deleteProject,
  addTask,
  completeTask,
  reopenTask,
  removeTask,
  listTasks,
};
