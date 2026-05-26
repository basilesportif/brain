#!/usr/bin/env node
// @ts-nocheck
/**
 * Add a business to the CRM.
 *
 * Flags:
 *   --name "Name"              required
 *   --description "..."        optional
 *   --status "prospecting"     optional (prospecting/active/on-hold/closed-won/closed-lost)
 *   --deal-value 50000         optional
 *   --notes "..."              optional
 *
 * Output: JSON to stdout, errors to stderr.
 */
import { addBusiness } from "../lib/crm-store.js";

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--name" && argv[i + 1]) { args.name = argv[++i]; i++; }
    else if (arg === "--description" && argv[i + 1]) { args.description = argv[++i]; i++; }
    else if (arg === "--status" && argv[i + 1]) { args.status = argv[++i]; i++; }
    else if (arg === "--deal-value" && argv[i + 1]) { args.dealValue = argv[++i]; i++; }
    else if (arg === "--notes" && argv[i + 1]) { args.notes = argv[++i]; i++; }
    else { i++; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.name) {
    console.error("Usage: crm-add-business.js --name \"Name\" [--description ...] [--status ...] [--deal-value ...] [--notes ...]");
    process.exit(1);
  }
  try {
    const business = addBusiness(args);
    console.log(JSON.stringify({ ok: true, business }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
