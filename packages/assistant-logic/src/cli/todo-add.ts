#!/usr/bin/env node
// @ts-nocheck
/**
 * Add a to-do item.
 *
 * Flags:
 *   --title "TEXT"           required
 *   --description "TEXT"     optional
 *   --project-id "pj_..."   optional (link to a project)
 *
 * Output: JSON to stdout, errors to stderr.
 */
import { addTodo } from "../lib/todo-store.js";

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--title" && argv[i + 1]) {
      args.title = argv[++i];
      i++;
    } else if (arg === "--description" && argv[i + 1]) {
      args.description = argv[++i];
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
  if (!args.title) {
    console.error("Usage: todo-add.js --title \"TEXT\" [--description \"TEXT\"] [--project-id \"pj_...\"]");
    process.exit(1);
  }
  try {
    const todo = addTodo({ title: args.title, description: args.description, projectId: args.projectId });
    console.log(JSON.stringify({ ok: true, todo }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
