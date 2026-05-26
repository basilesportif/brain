#!/usr/bin/env node
/**
 * View full detail for a project, including linked CRM entities, todos, notes, and resources.
 *
 * Flags:
 *   --id "pj_..."   required
 *
 * Output: JSON to stdout with the project, linked people, linked businesses, linked todos, notes, and resources.
 */
const { getProject } = require("./lib/project-store");
const { loadCrmStore } = require("./lib/crm-store");
const { listTodos } = require("./lib/todo-store");

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    if (argv[i] === "--id" && argv[i + 1]) { args.id = argv[++i]; i++; }
    else { i++; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.id) {
    console.error("Usage: project-view.js --id pj_...");
    process.exit(1);
  }
  try {
    const project = getProject(args.id);
    if (!project) {
      console.error(JSON.stringify({ error: `Project not found: ${args.id}` }));
      process.exit(1);
    }

    // Resolve linked CRM entities
    let linkedPeople = [];
    let linkedBusinesses = [];
    try {
      const crmStore = loadCrmStore();
      if (project.personIds.length) {
        linkedPeople = crmStore.people
          .filter((p) => project.personIds.includes(p.id))
          .map((p) => ({ id: p.id, name: p.name, email: p.email, company: p.company, status: p.status }));
      }
      if (project.businessIds.length) {
        linkedBusinesses = crmStore.businesses
          .filter((b) => project.businessIds.includes(b.id))
          .map((b) => ({ id: b.id, name: b.name, status: b.status, dealValue: b.dealValue }));
      }
    } catch (_) {
      // CRM store may not exist yet — that's fine
    }

    // Resolve linked todos
    let linkedTodos = [];
    try {
      const allTodos = listTodos();
      linkedTodos = allTodos.filter((t) => t.projectId === args.id);
    } catch (_) {
      // Todo store may not exist yet — that's fine
    }

    // Collect open project tasks
    const openTasks = Array.isArray(project.tasks)
      ? project.tasks.filter((t) => t.status === "open")
      : [];

    console.log(JSON.stringify({
      ok: true,
      project,
      linkedPeople,
      linkedBusinesses,
      linkedTodos,
      openTasks,
    }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
