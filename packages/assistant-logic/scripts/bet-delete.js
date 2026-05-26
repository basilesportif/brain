#!/usr/bin/env node
/**
 * Delete a sports bet entered in error. Exact ID only — no fuzzy matching.
 *
 * Flags:
 *   --id bt_...       required
 *
 * Output: JSON to stdout, errors to stderr.
 */
const { deleteBetById } = require("./lib/bet-store");

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const token = argv[i];
    if (token === "--id" && argv[i + 1]) {
      args.id = argv[++i];
      i++;
      continue;
    }
    if (token.startsWith("--id=")) {
      args.id = token.slice("--id=".length);
      i++;
      continue;
    }
    i++;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.id) {
    console.error("Usage: bet-delete.js --id bt_...");
    process.exit(1);
  }
  try {
    const res = deleteBetById(args.id);
    if (!res.found) {
      console.error(JSON.stringify({ error: `No bet found with id: ${args.id}` }));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, deleted: res.deleted }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
