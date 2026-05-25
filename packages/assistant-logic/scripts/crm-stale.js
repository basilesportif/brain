#!/usr/bin/env node
/**
 * Find contacts you haven't interacted with recently.
 *
 * Flags:
 *   --days N   optional (default: 30) — threshold for "stale"
 *
 * Output: JSON list of people with no correspondence in the last N days,
 *         sorted by stalest first.
 */
const { stalePeople } = require("./lib/crm-store");

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    if (argv[i] === "--days" && argv[i + 1]) { args.days = parseInt(argv[++i], 10); i++; }
    else { i++; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  try {
    const people = stalePeople(args);
    console.log(JSON.stringify({ ok: true, count: people.length, people }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
