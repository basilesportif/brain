#!/usr/bin/env node
// @ts-nocheck
/**
 * Mark a correspondence follow-up as resolved, or reschedule it.
 *
 * Flags:
 *   --id "co_..."               required
 *   --reschedule "2026-04-15"   optional (reschedule instead of resolving)
 *
 * Output: JSON to stdout, errors to stderr.
 */
import { resolveFollowUp, rescheduleFollowUp } from "../lib/crm-store.js";

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    if (argv[i] === "--id" && argv[i + 1]) { args.id = argv[++i]; i++; }
    else if (argv[i] === "--reschedule" && argv[i + 1]) { args.reschedule = argv[++i]; i++; }
    else { i++; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.id) {
    console.error("Usage: crm-resolve.js --id co_... [--reschedule 2026-04-15]");
    process.exit(1);
  }
  try {
    let entry;
    if (args.reschedule) {
      entry = rescheduleFollowUp(args.id, args.reschedule);
      if (!entry) {
        console.error(JSON.stringify({ error: `No correspondence found with id: ${args.id}` }));
        process.exit(1);
      }
      console.log(JSON.stringify({ ok: true, rescheduled: entry }, null, 2));
    } else {
      entry = resolveFollowUp(args.id);
      if (!entry) {
        console.error(JSON.stringify({ error: `No correspondence found with id: ${args.id}` }));
        process.exit(1);
      }
      console.log(JSON.stringify({ ok: true, resolved: entry }, null, 2));
    }
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
