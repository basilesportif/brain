#!/usr/bin/env node
/**
 * List project note metadata without full note bodies.
 *
 * Flags:
 *   --id "pj_..."             optional project filter
 *   --query "text"            optional metadata/text search
 *   --tag "tag"               optional tag filter
 *   --kind "research"         optional kind filter
 *   --category "..."          optional category filter
 *   --canonical-key "key"     optional canonical key filter
 *   --current                 only notes marked metadata.current=true
 *   --not-current             only notes not marked current
 *
 * Output: JSON to stdout, errors to stderr. Note bodies are intentionally omitted.
 */
const { listProjectNoteMetadata } = require("./lib/project-store");

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if ((arg === "--id" || arg === "--project-id") && argv[i + 1]) { args.projectId = argv[++i]; i++; }
    else if (arg === "--query" && argv[i + 1]) { args.query = argv[++i]; i++; }
    else if (arg === "--tag" && argv[i + 1]) { args.tag = argv[++i]; i++; }
    else if (arg === "--kind" && argv[i + 1]) { args.kind = argv[++i]; i++; }
    else if (arg === "--category" && argv[i + 1]) { args.category = argv[++i]; i++; }
    else if (arg === "--canonical-key" && argv[i + 1]) { args.canonicalKey = argv[++i]; i++; }
    else if (arg === "--current") { args.current = true; i++; }
    else if (arg === "--not-current") { args.current = false; i++; }
    else { i++; }
  }
  return args;
}

function main() {
  try {
    const filters = parseArgs(process.argv);
    const notes = listProjectNoteMetadata(filters);
    console.log(JSON.stringify({ ok: true, count: notes.length, notes }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
