#!/usr/bin/env node
/**
 * View full detail for a person or business, including linked entities and correspondence history.
 *
 * Flags:
 *   --id "ct_..." | "bz_..."   required
 *
 * Output: JSON to stdout with the entity, linked entities, correspondence, and pending follow-ups.
 */
const { viewPerson, viewBusiness } = require("./lib/crm-store");

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
    console.error("Usage: crm-view.js --id <ct_|bz_>...");
    process.exit(1);
  }
  try {
    let result;
    if (args.id.startsWith("ct_")) {
      result = viewPerson(args.id);
    } else if (args.id.startsWith("bz_")) {
      result = viewBusiness(args.id);
    } else {
      console.error(JSON.stringify({ error: "ID must start with ct_ or bz_" }));
      process.exit(1);
    }
    if (!result) {
      console.error(JSON.stringify({ error: `Entity not found: ${args.id}` }));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
