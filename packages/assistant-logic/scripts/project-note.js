#!/usr/bin/env node
/**
 * Add a timestamped note to a project.
 *
 * Flags:
 *   --id "pj_..."    required
 *   --text "..."     required
 *
 * Output: JSON to stdout, errors to stderr.
 */
const { addNote } = require("./lib/project-store");

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--id" && argv[i + 1]) { args.id = argv[++i]; i++; }
    else if (arg === "--text" && argv[i + 1]) { args.text = argv[++i]; i++; }
    else { i++; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.id || !args.text) {
    console.error("Usage: project-note.js --id pj_... --text \"...\"");
    process.exit(1);
  }
  try {
    const result = addNote(args.id, args.text);
    if (!result) {
      console.error(JSON.stringify({ error: `Project not found: ${args.id}` }));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, project: result.project, note: result.note }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
