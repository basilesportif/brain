#!/usr/bin/env node
// @ts-nocheck
/**
 * Link a person to a business (many-to-many).
 *
 * Flags:
 *   --person-id "ct_..."     required
 *   --business-id "bz_..."   required
 *
 * Output: JSON to stdout, errors to stderr.
 */
import { linkPersonBusiness } from "../lib/crm-store.js";

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    if (argv[i] === "--person-id" && argv[i + 1]) { args.personId = argv[++i]; i++; }
    else if (argv[i] === "--business-id" && argv[i + 1]) { args.businessId = argv[++i]; i++; }
    else { i++; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.personId || !args.businessId) {
    console.error("Usage: crm-link.js --person-id ct_... --business-id bz_...");
    process.exit(1);
  }
  try {
    const result = linkPersonBusiness(args.personId, args.businessId);
    console.log(JSON.stringify({ ok: true, linked: result }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
