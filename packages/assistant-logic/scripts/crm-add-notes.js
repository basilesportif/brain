#!/usr/bin/env node
/**
 * Add or update notes on an existing correspondence entry.
 *
 * Flags:
 *   --id "co_..."       required
 *   --notes "..."       optional (long-form transcript / call notes)
 *   --notes-stdin       optional (read notes from stdin for very long content)
 *
 * One of --notes or --notes-stdin is required.
 * Output: JSON to stdout, errors to stderr.
 */
const { updateCorrespondenceNotes } = require("./lib/crm-store");

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--id" && argv[i + 1]) { args.id = argv[++i]; i++; }
    else if (arg === "--notes" && argv[i + 1]) { args.notes = argv[++i]; i++; }
    else if (arg === "--notes-stdin") { args.notesStdin = true; i++; }
    else { i++; }
  }
  return args;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.id || (!args.notes && !args.notesStdin)) {
    console.error("Usage: crm-add-notes.js --id co_... --notes \"...\"");
    console.error("       crm-add-notes.js --id co_... --notes-stdin < transcript.txt");
    process.exit(1);
  }
  if (args.notesStdin) {
    args.notes = await readStdin();
  }
  try {
    const entry = updateCorrespondenceNotes(args.id, args.notes);
    if (!entry) {
      console.error(JSON.stringify({ error: `Correspondence not found: ${args.id}` }));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, correspondence: entry }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
