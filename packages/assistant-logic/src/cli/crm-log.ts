#!/usr/bin/env node
// @ts-nocheck
/**
 * Log correspondence in the CRM.
 *
 * Flags:
 *   --person-id "ct_..."       required
 *   --type "email"             required (email/call/meeting/message/other)
 *   --summary "..."            required
 *   --business-id "bz_..."     optional
 *   --notes "..."              optional (long-form transcript / call notes)
 *   --notes-stdin              optional (read notes from stdin for very long content)
 *   --follow-up                optional flag (sets followUpNeeded=true)
 *   --follow-up-date "2026-04-01"  optional
 *   --date "2026-03-22"        optional (defaults to now)
 *
 * Output: JSON to stdout, errors to stderr.
 */
import { addCorrespondence } from "../lib/crm-store.js";

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--person-id" && argv[i + 1]) { args.personId = argv[++i]; i++; }
    else if (arg === "--type" && argv[i + 1]) { args.type = argv[++i]; i++; }
    else if (arg === "--summary" && argv[i + 1]) { args.summary = argv[++i]; i++; }
    else if (arg === "--business-id" && argv[i + 1]) { args.businessId = argv[++i]; i++; }
    else if (arg === "--notes" && argv[i + 1]) { args.notes = argv[++i]; i++; }
    else if (arg === "--notes-stdin") { args.notesStdin = true; i++; }
    else if (arg === "--follow-up") { args.followUpNeeded = true; i++; }
    else if (arg === "--follow-up-date" && argv[i + 1]) { args.followUpDate = argv[++i]; args.followUpNeeded = true; i++; }
    else if (arg === "--date" && argv[i + 1]) { args.date = argv[++i]; i++; }
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
  if (!args.personId || !args.type || !args.summary) {
    console.error("Usage: crm-log.js --person-id ct_... --type email --summary \"...\" [--notes \"...\"] [--notes-stdin] [--business-id bz_...] [--follow-up] [--follow-up-date 2026-04-01]");
    process.exit(1);
  }
  if (args.notesStdin) {
    args.notes = await readStdin();
  }
  try {
    const entry = addCorrespondence(args);
    console.log(JSON.stringify({ ok: true, correspondence: entry }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
