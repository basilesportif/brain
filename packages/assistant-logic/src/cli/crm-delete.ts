#!/usr/bin/env node
// @ts-nocheck
/**
 * Delete any CRM entity by ID.
 *
 * Flags:
 *   --id "ct_..." | "bz_..." | "co_..."   required
 *
 * Output: JSON to stdout, errors to stderr.
 */
import { deleteById } from "../lib/crm-store.js";

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
    console.error("Usage: crm-delete.js --id <ct_|bz_|co_>...");
    process.exit(1);
  }
  try {
    const result = deleteById(args.id);
    if (!result.found) {
      console.error(JSON.stringify({ error: `No entity found with id: ${args.id}` }));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, deleted: result.deleted }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
