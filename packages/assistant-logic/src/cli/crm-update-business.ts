#!/usr/bin/env node
// @ts-nocheck
/**
 * Update an existing business in the CRM.
 *
 * Flags:
 *   --id "bz_..."              required
 *   --name "Name"              optional
 *   --description "..."        optional
 *   --status "active"          optional (prospecting/active/on-hold/closed-won/closed-lost/archived)
 *   --deal-value 50000         optional
 *   --notes "..."              optional
 *
 * Only provided fields are updated; omitted fields are left unchanged.
 * Output: JSON to stdout, errors to stderr.
 */
import { updateBusiness } from "../lib/crm-store.js";

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--id" && argv[i + 1]) { args.id = argv[++i]; i++; }
    else if (arg === "--name" && argv[i + 1]) { args.name = argv[++i]; i++; }
    else if (arg === "--description" && argv[i + 1]) { args.description = argv[++i]; i++; }
    else if (arg === "--status" && argv[i + 1]) { args.status = argv[++i]; i++; }
    else if (arg === "--deal-value" && argv[i + 1]) { args.dealValue = Number(argv[++i]); i++; }
    else if (arg === "--notes" && argv[i + 1]) { args.notes = argv[++i]; i++; }
    else { i++; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.id) {
    console.error("Usage: crm-update-business.js --id bz_... [--name ...] [--description ...] [--status ...] [--deal-value ...] [--notes ...]");
    process.exit(1);
  }
  try {
    const id = args.id;
    delete args.id;
    const business = updateBusiness(id, args);
    if (!business) {
      console.error(JSON.stringify({ error: `Business not found: ${id}` }));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, business }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
