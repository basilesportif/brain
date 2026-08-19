#!/usr/bin/env node
// @ts-nocheck
/**
 * Rebuild the projects JSON index from the markdown files.
 *
 * The .md files under data/projects/<slug>/notes/ are the source of truth.
 * This script regenerates every project.json note index and data/projects/index.json
 * from those files' frontmatter plus each project.json's non-note fields, so a
 * hand-edited or hand-added note file becomes visible to the CLI.
 *
 * Flags:
 *   --check       report drift and exit 1 without writing anything
 *   --json        JSON report (default)
 *   --markdown    human-readable report
 *   --workspace   workspace root override
 *
 * Output: report to stdout, errors to stderr.
 * Exit 1 when --check finds drift, or on error.
 */
import * as path from "node:path";
import { getWorkspaceContext } from "../lib/workspace.js";
import {
  PROJECTS_DIR,
  createProjectMarkdownStore,
  rebuildProjectIndexes,
} from "../lib/project-md-store.js";

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--check") { args.check = true; i++; }
    else if (arg === "--json") { args.json = true; i++; }
    else if (arg === "--markdown") { args.markdown = true; i++; }
    else if (arg === "--workspace" && argv[i + 1]) { args.workspace = argv[++i]; i++; }
    else { i++; }
  }
  return args;
}

function renderMarkdown(report) {
  const lines = [
    `# Project reindex ${report.check ? "(check)" : "(applied)"}`,
    "",
    `Root: ${report.root}`,
    `Projects: ${report.counts.projects}; notes: ${report.counts.notes}`,
    `Drift: ${report.drift.length === 0 ? "none" : `${report.drift.length} item(s)`}`,
    "",
  ];
  if (report.drift.length) {
    lines.push("## Drift", "");
    for (const item of report.drift) {
      lines.push(`- ${item.slug ? `${item.slug}: ` : ""}${item.kind} — ${item.detail}`);
    }
    lines.push("");
  }
  lines.push("## Projects", "");
  for (const project of report.projects) {
    lines.push(`- ${project.slug} (${project.id}) — ${project.noteCount} note(s)${project.changed ? " [rebuilt]" : ""}`);
  }
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv);
  try {
    const context = args.workspace
      ? getWorkspaceContext({ workspacePath: path.resolve(args.workspace) })
      : getWorkspaceContext();
    const store = createProjectMarkdownStore({ context });
    const root = path.join(context.workspacePath, PROJECTS_DIR);

    // The whole rebuild runs under the domain lock so no writer interleaves.
    const result = store.lockDomain(() => rebuildProjectIndexes(root, { apply: !args.check }));

    const report = {
      ok: args.check ? result.drift.length === 0 : true,
      check: Boolean(args.check),
      root,
      changed: result.changed,
      counts: result.counts,
      drift: result.drift,
      projects: result.projects,
    };

    if (args.markdown) console.log(renderMarkdown(report));
    else console.log(JSON.stringify(report, null, 2));

    if (args.check && result.drift.length > 0) process.exit(1);
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
