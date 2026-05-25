#!/usr/bin/env node
/**
 * List businesses in the CRM.
 *
 * Flags:
 *   --query "text"      optional substring filter
 *   --status "active"   optional status filter
 *   --sort "name"       optional sort (name/createdAt/updatedAt/status, default: name)
 *   --summary           optional, show pipeline summary by status instead of full list
 *
 * Output: JSON to stdout, errors to stderr.
 */
const { listBusinesses, pipelineSummary } = require("./lib/crm-store");

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--query" && argv[i + 1]) { args.query = argv[++i]; i++; }
    else if (arg === "--status" && argv[i + 1]) { args.status = argv[++i]; i++; }
    else if (arg === "--sort" && argv[i + 1]) { args.sort = argv[++i]; i++; }
    else if (arg === "--summary") { args.summary = true; i++; }
    else { i++; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  try {
    if (args.summary) {
      const summary = pipelineSummary();
      console.log(JSON.stringify({ ok: true, pipeline: summary }, null, 2));
      return;
    }

    let businesses = listBusinesses(args);

    // Sort
    const sortField = args.sort || "name";
    businesses.sort((a, b) => {
      const aVal = a[sortField] || "";
      const bVal = b[sortField] || "";
      if (sortField === "name") return aVal.localeCompare(bVal);
      return String(bVal).localeCompare(String(aVal)); // dates: newest first
    });

    console.log(JSON.stringify({ ok: true, count: businesses.length, businesses }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
