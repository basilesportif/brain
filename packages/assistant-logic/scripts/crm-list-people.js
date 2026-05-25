#!/usr/bin/env node
/**
 * List people in the CRM.
 *
 * Flags:
 *   --query "text"          optional substring filter
 *   --status "active"       optional status filter
 *   --business-id "bz_..."  optional filter by linked business
 *   --tag "developer"       optional filter by tag
 *   --sort "name"           optional sort (name/createdAt/updatedAt/lastContactedAt, default: name)
 *   --missing-fields        optional, flag contacts missing email/phone/company
 *
 * Output: JSON to stdout, errors to stderr.
 */
const { listPeople } = require("./lib/crm-store");

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--query" && argv[i + 1]) { args.query = argv[++i]; i++; }
    else if (arg === "--status" && argv[i + 1]) { args.status = argv[++i]; i++; }
    else if (arg === "--business-id" && argv[i + 1]) { args.businessId = argv[++i]; i++; }
    else if (arg === "--tag" && argv[i + 1]) { args.tag = argv[++i]; i++; }
    else if (arg === "--sort" && argv[i + 1]) { args.sort = argv[++i]; i++; }
    else if (arg === "--missing-fields") { args.missingFields = true; i++; }
    else { i++; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  try {
    let people = listPeople(args);

    // Filter by tag
    if (args.tag) {
      people = people.filter((p) => p.tags && p.tags.includes(args.tag));
    }

    // Sort
    const sortField = args.sort || "name";
    people.sort((a, b) => {
      const aVal = a[sortField] || "";
      const bVal = b[sortField] || "";
      if (sortField === "name") return aVal.localeCompare(bVal);
      return String(bVal).localeCompare(String(aVal)); // dates: newest first
    });

    // Annotate missing fields if requested
    if (args.missingFields) {
      people = people.map((p) => {
        const missing = [];
        if (!p.email) missing.push("email");
        if (!p.phone) missing.push("phone");
        if (!p.company) missing.push("company");
        return missing.length > 0 ? { ...p, _missingFields: missing } : p;
      });
    }

    console.log(JSON.stringify({ ok: true, count: people.length, people }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
