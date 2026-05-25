#!/usr/bin/env node
/**
 * List projects.
 *
 * Flags:
 *   --status "active"          optional status filter
 *   --query "text"             optional substring filter on name/description
 *   --all                      include archived projects
 *   --sort "name"              optional sort (name/createdAt/updatedAt/targetDate, default: name)
 *
 * Output: JSON to stdout, errors to stderr.
 */
const { listProjects } = require("./lib/project-store");

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--status" && argv[i + 1]) { args.status = argv[++i]; i++; }
    else if (arg === "--query" && argv[i + 1]) { args.query = argv[++i]; i++; }
    else if (arg === "--sort" && argv[i + 1]) { args.sort = argv[++i]; i++; }
    else if (arg === "--all") { args.all = true; i++; }
    else { i++; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  try {
    let projects = listProjects({ query: args.query, status: args.status, all: args.all });

    // Sort
    const sortField = args.sort || "name";
    projects.sort((a, b) => {
      const aVal = a[sortField] || "";
      const bVal = b[sortField] || "";
      if (sortField === "name") return aVal.localeCompare(bVal);
      return String(bVal).localeCompare(String(aVal)); // dates: newest first
    });

    console.log(JSON.stringify({ ok: true, count: projects.length, projects }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
