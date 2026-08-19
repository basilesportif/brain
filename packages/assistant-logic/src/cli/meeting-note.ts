#!/usr/bin/env node
// @ts-nocheck
/**
 * Capture a structured, CRM-free meeting note in a project.
 *
 * Flags:
 *   --project-id "pj_..."          target project id (preferred)
 *   --project "Project name"       target project name/query
 *   --person "Person name"         required
 *   --company "Company name"       optional
 *   --date "YYYY-MM-DD|ISO"        optional; defaults to today
 *   --time "11:30 AM"              optional
 *   --location "Event/context"     optional
 *   --notes "Meeting notes"        optional; --text is an alias
 *   --card-path "/path/to/card"     optional reference only
 *   --follow-up "Next action"      optional
 *   --tag "tag"                    optional; repeatable
 *
 * Output: JSON to stdout, JSON errors to stderr.
 */
import { addNote, getProject, listProjects } from "../lib/project-store.js";

function parseArgs(argv) {
  const args = { tags: [] };
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--project-id" && argv[i + 1]) { args.projectId = argv[++i]; i++; }
    else if (arg === "--project" && argv[i + 1]) { args.project = argv[++i]; i++; }
    else if (arg === "--person" && argv[i + 1]) { args.person = argv[++i]; i++; }
    else if (arg === "--company" && argv[i + 1]) { args.company = argv[++i]; i++; }
    else if (arg === "--date" && argv[i + 1]) { args.date = argv[++i]; i++; }
    else if (arg === "--time" && argv[i + 1]) { args.time = argv[++i]; i++; }
    else if (arg === "--location" && argv[i + 1]) { args.location = argv[++i]; i++; }
    else if ((arg === "--notes" || arg === "--text") && argv[i + 1]) { args.notes = argv[++i]; i++; }
    else if (arg === "--card-path" && argv[i + 1]) { args.cardPath = argv[++i]; i++; }
    else if (arg === "--follow-up" && argv[i + 1]) { args.followUp = argv[++i]; i++; }
    else if (arg === "--tag" && argv[i + 1]) { args.tags.push(argv[++i]); i++; }
    else { i++; }
  }
  return args;
}

class ProjectResolutionError extends Error {
  constructor(message, candidates) {
    super(message);
    this.candidates = candidates;
  }
}

function resolveProjectByName(name) {
  const query = String(name || "").trim();
  const matches = listProjects({ query });
  const lowerQuery = query.toLowerCase();
  const exactMatches = matches.filter(
    (project) => project.name.toLowerCase() === lowerQuery
  );

  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length === 0 && matches.length === 1) return matches[0];

  const candidates = (exactMatches.length > 1 ? exactMatches : matches).map(
    (project) => project.name
  );
  const reason = matches.length === 0
    ? `Project not found: ${query}`
    : `Project name is ambiguous: ${query}`;
  throw new ProjectResolutionError(reason, candidates);
}

function normalizeDate(value) {
  if (value === undefined) return new Date().toISOString().slice(0, 10);

  const date = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const normalized = new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10);
    if (normalized !== date) throw new Error(`Invalid --date: ${value}`);
    return normalized;
  }
  if (!date || Number.isNaN(Date.parse(date))) {
    throw new Error(`Invalid --date: ${value}`);
  }
  return date;
}

function uniqueTags(values) {
  const tags = [];
  const seen = new Set();
  for (const value of values) {
    const tag = String(value || "").trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

function buildNoteText(args, date) {
  const meeting = args.company
    ? `${args.person} / ${args.company}`
    : args.person;
  const lines = [
    `Meeting: ${meeting}`,
    `Date/time: ${date}${args.time ? ` ${args.time}` : ""}`,
  ];
  if (args.location) lines.push(`Location/context: ${args.location}`);
  if (args.cardPath) lines.push(`Business card: ${args.cardPath}`);
  if (args.followUp) lines.push(`Follow-up: ${args.followUp}`);
  lines.push("", "Notes:", args.notes || "");
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv);
  args.person = String(args.person || "").trim();
  args.company = String(args.company || "").trim();
  args.time = String(args.time || "").trim();
  args.location = String(args.location || "").trim();
  args.cardPath = String(args.cardPath || "").trim();
  args.followUp = String(args.followUp || "").trim();
  args.notes = String(args.notes || "").trim();

  if ((!args.projectId && !args.project) || !args.person) {
    throw new Error(
      "Usage: meeting-note.js (--project-id pj_... | --project \"name\") --person \"name\" [--company ...] [--date ...] [--time ...] [--location ...] [--notes ... | --text ...] [--card-path ...] [--follow-up ...] [--tag ...]"
    );
  }

  const resolvedByName = args.projectId
    ? null
    : resolveProjectByName(args.project);
  const projectId = args.projectId || resolvedByName.id;

  const project = getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const date = normalizeDate(args.date);
  const titleSubject = args.company
    ? `${args.person} / ${args.company}`
    : args.person;
  const metadata = {
    kind: "meeting-note",
    category: "meetings",
    title: `${titleSubject} meeting`,
    tags: uniqueTags(["meeting-note", "meetings", ...(args.tags || [])]),
    refs: args.cardPath ? [{ type: "file", path: args.cardPath }] : [],
  };
  const result = addNote(projectId, buildNoteText(args, date), metadata);
  if (!result) throw new Error(`Project not found: ${projectId}`);

  console.log(JSON.stringify({
    ok: true,
    project: { id: result.project.id, name: result.project.name },
    note: result.note,
  }, null, 2));
}

try {
  main();
} catch (err) {
  const body = { error: err.message };
  if (Array.isArray(err.candidates)) body.candidates = err.candidates;
  console.error(JSON.stringify(body));
  process.exit(1);
}
