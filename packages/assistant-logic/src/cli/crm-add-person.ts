#!/usr/bin/env node
// @ts-nocheck
/**
 * Add a person to the CRM.
 *
 * Flags:
 *   --name "Name"          required
 *   --email "x@y.com"      optional
 *   --phone "+1..."        optional
 *   --company "Acme"       optional
 *   --title "CEO"          optional
 *   --status "active"      optional (lead/active/inactive, default: active)
 *   --priority "normal"    optional (low/normal/high, default: normal)
 *   --source "referral"    optional
 *   --notes "..."          optional
 *   --business-id "bz_..." optional (link to business on creation, repeatable)
 *   --force                optional (skip duplicate check)
 *
 * Quick-add: just --name is enough.
 * Output: JSON to stdout, errors to stderr.
 */
import { addPerson, findDuplicates } from "../lib/crm-store.js";

function parseArgs(argv) {
  const args = {};
  const businessIds = [];
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--name" && argv[i + 1]) { args.name = argv[++i]; i++; }
    else if (arg === "--email" && argv[i + 1]) { args.email = argv[++i]; i++; }
    else if (arg === "--phone" && argv[i + 1]) { args.phone = argv[++i]; i++; }
    else if (arg === "--company" && argv[i + 1]) { args.company = argv[++i]; i++; }
    else if (arg === "--title" && argv[i + 1]) { args.title = argv[++i]; i++; }
    else if (arg === "--status" && argv[i + 1]) { args.status = argv[++i]; i++; }
    else if (arg === "--priority" && argv[i + 1]) { args.priority = argv[++i]; i++; }
    else if (arg === "--source" && argv[i + 1]) { args.source = argv[++i]; i++; }
    else if (arg === "--notes" && argv[i + 1]) { args.notes = argv[++i]; i++; }
    else if (arg === "--business-id" && argv[i + 1]) { businessIds.push(argv[++i]); i++; }
    else if (arg === "--force") { args.force = true; i++; }
    else { i++; }
  }
  if (businessIds.length) args.businessIds = businessIds;
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.name) {
    console.error("Usage: crm-add-person.js --name \"Name\" [--email ...] [--phone ...] [--company ...] [--title ...] [--status ...] [--source ...] [--notes ...] [--business-id ...] [--force]");
    process.exit(1);
  }
  try {
    // Duplicate detection (#15)
    if (!args.force) {
      const dupes = findDuplicates(args.name);
      if (dupes.length > 0) {
        console.error(JSON.stringify({
          warning: "Possible duplicate(s) found. Use --force to add anyway.",
          duplicates: dupes.map((d) => ({ id: d.id, name: d.name, email: d.email, company: d.company })),
        }));
        process.exit(1);
      }
    }
    const force = args.force;
    delete args.force;
    const person = addPerson(args);
    console.log(JSON.stringify({ ok: true, person }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
