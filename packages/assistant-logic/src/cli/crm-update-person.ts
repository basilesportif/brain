#!/usr/bin/env node
// @ts-nocheck
/**
 * Update an existing person in the CRM.
 *
 * Flags:
 *   --id "ct_..."          required
 *   --name "Name"          optional
 *   --email "x@y.com"      optional
 *   --phone "+1..."        optional
 *   --company "Acme"       optional
 *   --title "CEO"          optional
 *   --status "active"      optional (lead/active/inactive/archived)
 *   --priority "normal"    optional (low/normal/high)
 *   --source "referral"    optional
 *   --notes "..."          optional
 *   --add-tag "tag"        optional (repeatable)
 *   --remove-tag "tag"     optional (repeatable)
 *
 * Only provided fields are updated; omitted fields are left unchanged.
 * Output: JSON to stdout, errors to stderr.
 */
import { updatePerson, loadCrmStore } from "../lib/crm-store.js";

function parseArgs(argv) {
  const args = {};
  const addTags = [];
  const removeTags = [];
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--id" && argv[i + 1]) { args.id = argv[++i]; i++; }
    else if (arg === "--name" && argv[i + 1]) { args.name = argv[++i]; i++; }
    else if (arg === "--email" && argv[i + 1]) { args.email = argv[++i]; i++; }
    else if (arg === "--phone" && argv[i + 1]) { args.phone = argv[++i]; i++; }
    else if (arg === "--company" && argv[i + 1]) { args.company = argv[++i]; i++; }
    else if (arg === "--title" && argv[i + 1]) { args.title = argv[++i]; i++; }
    else if (arg === "--status" && argv[i + 1]) { args.status = argv[++i]; i++; }
    else if (arg === "--priority" && argv[i + 1]) { args.priority = argv[++i]; i++; }
    else if (arg === "--source" && argv[i + 1]) { args.source = argv[++i]; i++; }
    else if (arg === "--notes" && argv[i + 1]) { args.notes = argv[++i]; i++; }
    else if (arg === "--add-tag" && argv[i + 1]) { addTags.push(argv[++i]); i++; }
    else if (arg === "--remove-tag" && argv[i + 1]) { removeTags.push(argv[++i]); i++; }
    else { i++; }
  }
  if (addTags.length || removeTags.length) {
    args._addTags = addTags;
    args._removeTags = removeTags;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.id) {
    console.error("Usage: crm-update-person.js --id ct_... [--name ...] [--email ...] [--phone ...] [--company ...] [--title ...] [--status ...] [--priority ...] [--source ...] [--notes ...] [--add-tag ...] [--remove-tag ...]");
    process.exit(1);
  }
  try {
    const id = args.id;
    delete args.id;

    // Handle tag updates
    if (args._addTags || args._removeTags) {
      const store = loadCrmStore();
      const person = store.people.find((p) => p.id === id);
      if (!person) {
        console.error(JSON.stringify({ error: `Person not found: ${id}` }));
        process.exit(1);
      }
      let tags = [...(person.tags || [])];
      for (const t of (args._addTags || [])) {
        if (!tags.includes(t)) tags.push(t);
      }
      for (const t of (args._removeTags || [])) {
        tags = tags.filter((x) => x !== t);
      }
      args.tags = tags;
      delete args._addTags;
      delete args._removeTags;
    }

    const person = updatePerson(id, args);
    if (!person) {
      console.error(JSON.stringify({ error: `Person not found: ${id}` }));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, person }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
