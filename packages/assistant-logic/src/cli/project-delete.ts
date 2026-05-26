#!/usr/bin/env node
// @ts-nocheck
/**
 * Delete a project.
 *
 * Flags:
 *   --id "pj_..."   required
 *
 * Consider using --status archived via project-update.js instead.
 * Output: JSON to stdout, errors to stderr.
 */
import { deleteProject } from "../lib/project-store.js";

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    if (argv[i] === "--id" && argv[i + 1]) { args.id = argv[++i]; i++; }
    else { i++; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.id) {
    console.error("Usage: project-delete.js --id pj_...");
    process.exit(1);
  }
  try {
    const result = deleteProject(args.id);
    if (!result.found) {
      console.error(JSON.stringify({ error: `Project not found: ${args.id}` }));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, deleted: result.deleted }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
