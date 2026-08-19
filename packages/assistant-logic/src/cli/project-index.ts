#!/usr/bin/env node
// @ts-nocheck
/**
 * Print a compact, body-free index of projects and their routing metadata.
 *
 * Flags:
 *   --status "active"       filter projects by status
 *   --all                   include archived projects
 *   --query "football"     match project name, description, tags, or triggers
 *   --markdown              print a compact Markdown index instead of JSON
 *
 * Output: JSON to stdout, errors to stderr.
 */
import { listProjects, listProjectNoteMetadata } from "../lib/project-store.js";

const KEY_NOTE_KINDS = new Set([
  "runbook",
  "procedure",
  "playbook",
  "workflow",
  "policy",
  "canonical-index",
  "meeting-note",
  "meeting-log",
]);

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "etc",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "project",
  "s",
  "that",
  "the",
  "these",
  "this",
  "those",
  "to",
  "was",
  "were",
  "with",
]);

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--status" && argv[i + 1]) { args.status = argv[++i]; i++; }
    else if (arg === "--all") { args.all = true; i++; }
    else if (arg === "--query" && argv[i + 1]) { args.query = argv[++i]; i++; }
    else if (arg === "--markdown") { args.markdown = true; i++; }
    else { i++; }
  }
  return args;
}

function compactText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function truncate(value, maxLength) {
  const text = compactText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function hasCanonicalKey(metadata = {}) {
  return compactText(metadata.canonicalKey).length > 0;
}

function rankTags(notes) {
  const counts = new Map();
  let order = 0;

  for (const note of notes) {
    const tags = Array.isArray(note.metadata?.tags) ? note.metadata.tags : [];
    for (const value of tags) {
      const tag = compactText(String(value)).toLowerCase();
      if (!tag) continue;
      const existing = counts.get(tag);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(tag, { count: 1, order: order++ });
      }
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].order - b[1].order)
    .slice(0, 20)
    .map(([tag]) => tag);
}

function tokenize(value) {
  return compactText(String(value || "")).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function deriveTriggers(project, notes, tags) {
  const triggers = [];
  const seen = new Set();

  // Curated trigger phrases (project-level + per-note metadata.triggers) are kept
  // WHOLE — they are the intent-match surface the resolver reads, so "build
  // conference web page" must survive as a phrase, not be shredded into tokens.
  function addPhrases(values) {
    for (const value of Array.isArray(values) ? values : [values]) {
      const phrase = compactText(String(value || "")).toLowerCase();
      if (!phrase || STOPWORDS.has(phrase) || seen.has(phrase)) continue;
      seen.add(phrase);
      triggers.push(phrase);
      if (triggers.length >= 30) return true;
    }
    return false;
  }

  // Derived sources (project name, note categories, tags) are tokenized into
  // single keywords so short one-word requests still match.
  function addTokens(values) {
    for (const value of Array.isArray(values) ? values : [values]) {
      for (const token of tokenize(value)) {
        if (STOPWORDS.has(token) || /^(?:19|20)\d{2}$/.test(token) || seen.has(token)) continue;
        seen.add(token);
        triggers.push(token);
        if (triggers.length >= 30) return true;
      }
    }
    return false;
  }

  if (addPhrases(Array.isArray(project.triggers) ? project.triggers : [])) return triggers;
  for (const note of notes) {
    if (addPhrases(Array.isArray(note.metadata?.triggers) ? note.metadata.triggers : [])) return triggers;
  }
  if (addTokens(project.name)) return triggers;
  if (addTokens(notes.map((note) => note.metadata?.category))) return triggers;
  addTokens(tags);
  return triggers;
}

function selectKeyNotes(notes) {
  return notes
    .filter((note) => {
      const metadata = note.metadata || {};
      return metadata.current === true ||
        hasCanonicalKey(metadata) ||
        KEY_NOTE_KINDS.has(compactText(metadata.kind).toLowerCase());
    })
    .sort((a, b) => {
      const aCurrent = a.metadata?.current === true ? 1 : 0;
      const bCurrent = b.metadata?.current === true ? 1 : 0;
      if (aCurrent !== bCurrent) return bCurrent - aCurrent;

      const aCanonical = hasCanonicalKey(a.metadata) ? 1 : 0;
      const bCanonical = hasCanonicalKey(b.metadata) ? 1 : 0;
      if (aCanonical !== bCanonical) return bCanonical - aCanonical;

      const aUpdated = String(a.updatedAt || a.createdAt || "");
      const bUpdated = String(b.updatedAt || b.createdAt || "");
      return bUpdated.localeCompare(aUpdated) || String(a.noteId).localeCompare(String(b.noteId));
    })
    .slice(0, 12)
    .map((note) => {
      const metadata = note.metadata || {};
      return {
        noteId: note.noteId,
        title: compactText(metadata.title) || null,
        summary: compactText(metadata.summary) || null,
        kind: compactText(metadata.kind) || null,
        category: compactText(metadata.category) || null,
        canonicalKey: compactText(metadata.canonicalKey) || null,
        current: metadata.current === true,
      };
    });
}

function projectProjection(project, notes) {
  const tags = rankTags(notes);
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    targetDate: project.targetDate || null,
    description: truncate(project.description, 200),
    tags,
    openTasks: (Array.isArray(project.tasks) ? project.tasks : [])
      .filter((task) => task?.status !== "done")
      .map((task) => compactText(task?.title))
      .filter(Boolean)
      .slice(0, 10),
    triggers: deriveTriggers(project, notes, tags),
    keyNotes: selectKeyNotes(notes),
  };
}

function renderMarkdown(projects) {
  return projects.map((project) => {
    const lines = [
      `### ${compactText(project.name)} [${compactText(project.status)}]`,
      `triggers: ${project.triggers.join(", ")}`,
    ];
    for (const note of project.keyNotes) {
      lines.push(`- ${note.title || "Untitled note"} (${note.kind || "note"}) [${note.noteId}]`);
    }
    return lines.join("\n");
  }).join("\n\n");
}

function main() {
  try {
    const args = parseArgs(process.argv);

    const projects = listProjects({
      status: args.status,
      all: args.status ? false : args.all,
    });
    const notesByProject = new Map();
    for (const note of listProjectNoteMetadata()) {
      if (!notesByProject.has(note.projectId)) notesByProject.set(note.projectId, []);
      notesByProject.get(note.projectId).push(note);
    }

    let indexed = projects.map((project) => ({
      sourceDescription: compactText(project.description),
      projection: projectProjection(project, notesByProject.get(project.id) || []),
    }));

    if (args.query) {
      const query = compactText(args.query).toLowerCase();
      indexed = indexed.filter(({ sourceDescription, projection }) => [
        projection.name,
        sourceDescription,
        ...projection.tags,
        ...projection.triggers,
      ].some((value) => String(value || "").toLowerCase().includes(query)));
    }

    const outputProjects = indexed.map(({ projection }) => projection);
    if (args.markdown) {
      console.log(renderMarkdown(outputProjects));
    } else {
      console.log(JSON.stringify({ ok: true, count: outputProjects.length, projects: outputProjects }, null, 2));
    }
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
