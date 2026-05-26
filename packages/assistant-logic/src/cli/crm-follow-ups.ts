#!/usr/bin/env node
// @ts-nocheck
/**
 * List unresolved follow-ups.
 *
 * Flags:
 *   --due                     optional, show only overdue follow-ups (followUpDate <= today, or no date set)
 *   --person-id "ct_..."      optional, filter by person
 *   --business-id "bz_..."    optional, filter by business
 *
 * Output: JSON to stdout, errors to stderr.
 */
import { listFollowUps } from "../lib/crm-store.js";

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    if (argv[i] === "--due") { args.dueOnly = true; i++; }
    else if (argv[i] === "--person-id" && argv[i + 1]) { args.personId = argv[++i]; i++; }
    else if (argv[i] === "--business-id" && argv[i + 1]) { args.businessId = argv[++i]; i++; }
    else { i++; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  try {
    const followUps = listFollowUps(args);
    console.log(JSON.stringify({ ok: true, count: followUps.length, followUps }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
