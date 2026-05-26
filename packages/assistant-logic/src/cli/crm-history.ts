#!/usr/bin/env node
// @ts-nocheck
/**
 * List correspondence history for a person or business.
 *
 * Flags:
 *   --person-id "ct_..."     optional (filter by person)
 *   --business-id "bz_..."   optional (filter by business)
 *   --type "email"           optional (filter by type: email/call/meeting/message/other)
 *   --limit N                optional (show only last N entries, default: all)
 *   --full                   optional (include notes in output)
 *
 * At least one of --person-id or --business-id is required.
 * Output: JSON to stdout, sorted newest first.
 */
import { listCorrespondence, loadCrmStore } from "../lib/crm-store.js";

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--person-id" && argv[i + 1]) { args.personId = argv[++i]; i++; }
    else if (arg === "--business-id" && argv[i + 1]) { args.businessId = argv[++i]; i++; }
    else if (arg === "--type" && argv[i + 1]) { args.type = argv[++i]; i++; }
    else if (arg === "--limit" && argv[i + 1]) { args.limit = parseInt(argv[++i], 10); i++; }
    else if (arg === "--full") { args.full = true; i++; }
    else { i++; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.personId && !args.businessId) {
    console.error("Usage: crm-history.js --person-id ct_... [--business-id bz_...] [--type email] [--limit 10] [--full]");
    process.exit(1);
  }
  try {
    let entries = listCorrespondence({ personId: args.personId, businessId: args.businessId });
    if (args.type) {
      entries = entries.filter((e) => e.type === args.type);
    }
    // Sort newest first
    entries.sort((a, b) => (b.date || b.createdAt).localeCompare(a.date || a.createdAt));
    if (args.limit && args.limit > 0) {
      entries = entries.slice(0, args.limit);
    }
    // Enrich with person/business names
    const store = loadCrmStore();
    entries = entries.map((e) => {
      const person = store.people.find((p) => p.id === e.personId);
      const business = e.businessId ? store.businesses.find((b) => b.id === e.businessId) : null;
      const enriched = {
        ...e,
        personName: person ? person.name : null,
        businessName: business ? business.name : null,
      };
      // Strip notes from list view unless --full is passed
      if (!args.full) {
        delete enriched.notes;
      }
      return enriched;
    });
    console.log(JSON.stringify({ ok: true, count: entries.length, correspondence: entries }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
