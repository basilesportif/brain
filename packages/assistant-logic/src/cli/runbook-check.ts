#!/usr/bin/env node
// @ts-nocheck
/**
 * Report incomplete runbooks and procedure notes that may merit promotion.
 *
 * Flags:
 *   --markdown              print a compact Markdown report instead of JSON
 *   --strict                exit 1 when any WARN-level items are present
 *
 * Output: JSON (or Markdown) to stdout, JSON errors to stderr.
 */
import { listProjects, listProjectNoteMetadata } from "../lib/project-store.js";

const PROMOTION_KINDS = new Set(["workflow", "procedure", "playbook"]);

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--markdown") { args.markdown = true; i++; }
    else if (arg === "--strict") { args.strict = true; i++; }
    else { i++; }
  }
  return args;
}

function compactText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function kindOf(note) {
  return compactText(note.metadata?.kind).toLowerCase();
}

function noteEntry(note) {
  return {
    projectId: note.projectId,
    projectName: note.projectName,
    noteId: note.noteId,
    title: compactText(note.metadata?.title) || null,
  };
}

function buildReport(projects, notes) {
  const activeProjectIds = new Set(projects.map((project) => project.id));
  const activeNotes = notes.filter((note) => activeProjectIds.has(note.projectId));
  const runbooksMissingTriggers = [];
  const runbooksNotCurrent = [];
  const promotionCandidates = [];
  const procedureProjects = new Set();

  for (const note of activeNotes) {
    const kind = kindOf(note);
    if (kind === "runbook") {
      procedureProjects.add(note.projectId);
      const triggers = Array.isArray(note.metadata?.triggers)
        ? note.metadata.triggers.filter((trigger) => compactText(trigger))
        : [];
      if (!triggers.length) runbooksMissingTriggers.push(noteEntry(note));
      if (note.metadata?.current !== true) runbooksNotCurrent.push(noteEntry(note));
    } else if (PROMOTION_KINDS.has(kind)) {
      procedureProjects.add(note.projectId);
      promotionCandidates.push(noteEntry(note));
    }
  }

  const projectsWithoutRunbook = projects
    .filter((project) => !procedureProjects.has(project.id))
    .map((project) => ({ projectId: project.id, projectName: project.name }));

  return {
    ok: true,
    summary: {
      activeProjects: projects.length,
      runbooksMissingTriggers: runbooksMissingTriggers.length,
      runbooksNotCurrent: runbooksNotCurrent.length,
      promotionCandidates: promotionCandidates.length,
      projectsWithoutRunbook: projectsWithoutRunbook.length,
    },
    runbooksMissingTriggers,
    runbooksNotCurrent,
    promotionCandidates,
    projectsWithoutRunbook,
  };
}

function renderMarkdown(report) {
  const sections = [
    ["Runbooks missing triggers", report.runbooksMissingTriggers],
    ["Runbooks not current", report.runbooksNotCurrent],
    ["Promotion candidates", report.promotionCandidates],
    ["Projects without a runbook", report.projectsWithoutRunbook],
  ];
  const lines = [
    "# Runbook check",
    "",
    `Active projects: ${report.summary.activeProjects}; warnings: ${report.summary.runbooksMissingTriggers + report.summary.runbooksNotCurrent}`,
  ];

  for (const [title, entries] of sections) {
    lines.push("", `## ${title} (${entries.length})`, "");
    if (!entries.length) {
      lines.push("- None");
      continue;
    }
    for (const entry of entries) {
      const note = entry.noteId
        ? ` — ${entry.title || "Untitled note"} [${entry.noteId}]`
        : "";
      lines.push(`- ${entry.projectName} [${entry.projectId}]${note}`);
    }
  }

  return lines.join("\n");
}

function main() {
  try {
    const args = parseArgs(process.argv);

    const projects = listProjects({ status: "active" });
    const report = buildReport(projects, listProjectNoteMetadata());
    if (args.markdown) console.log(renderMarkdown(report));
    else console.log(JSON.stringify(report, null, 2));

    const hasWarnings = report.runbooksMissingTriggers.length > 0 || report.runbooksNotCurrent.length > 0;
    if (args.strict && hasWarnings) process.exitCode = 1;
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
