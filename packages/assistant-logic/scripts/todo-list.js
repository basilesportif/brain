#!/usr/bin/env node
/**
 * List to-do items.
 *
 * Flags:
 *   --query "TEXT"           optional substring filter on title/description
 *   --project-id "pj_..."   optional filter by project
 *
 * Output: JSON to stdout, errors to stderr.
 */
const { listTodos } = require("./lib/todo-store");

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--query" && argv[i + 1]) {
      args.query = argv[++i];
      i++;
    } else if (arg === "--project-id" && argv[i + 1]) {
      args.projectId = argv[++i];
      i++;
    } else {
      i++;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  try {
    let todos = listTodos({ query: args.query });

    // Filter by project
    if (args.projectId) {
      todos = todos.filter((t) => t.projectId === args.projectId);
    }

    // Annotate project names if any todos have projectId
    const projectIds = [...new Set(todos.filter((t) => t.projectId).map((t) => t.projectId))];
    if (projectIds.length) {
      try {
        const { listProjects } = require("./lib/project-store");
        const allProjects = listProjects({ all: true });
        const projectMap = {};
        for (const p of allProjects) projectMap[p.id] = p.name;
        todos = todos.map((t) =>
          t.projectId && projectMap[t.projectId]
            ? { ...t, _projectName: projectMap[t.projectId] }
            : t
        );
      } catch (_) {
        // Project store may not exist yet — that's fine
      }
    }

    console.log(JSON.stringify({ ok: true, count: todos.length, todos }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
