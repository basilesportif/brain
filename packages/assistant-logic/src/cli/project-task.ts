#!/usr/bin/env node
// @ts-nocheck
/**
 * Manage project-scoped tasks (lightweight checklist items per project).
 *
 * Flags:
 *   --id "pj_..."            required — project ID
 *   --add "title"            add a new task
 *   --complete "pt_..."      mark task done
 *   --reopen "pt_..."        reopen a completed task
 *   --remove "pt_..."        delete a task
 *   --list                   list open tasks (default)
 *   --all                    with --list, include done tasks
 *
 * Output: JSON to stdout.
 */
import {
  addTask,
  completeTask,
  reopenTask,
  removeTask,
  listTasks,
} from "../lib/project-store.js";

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    if (argv[i] === "--id" && argv[i + 1]) { args.id = argv[++i]; }
    else if (argv[i] === "--add" && argv[i + 1]) { args.add = argv[++i]; }
    else if (argv[i] === "--complete" && argv[i + 1]) { args.complete = argv[++i]; }
    else if (argv[i] === "--reopen" && argv[i + 1]) { args.reopen = argv[++i]; }
    else if (argv[i] === "--remove" && argv[i + 1]) { args.remove = argv[++i]; }
    else if (argv[i] === "--list") { args.list = true; }
    else if (argv[i] === "--all") { args.all = true; }
    i++;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.id) {
    console.error("Usage: project-task.js --id pj_... [--add|--complete|--reopen|--remove|--list]");
    process.exit(1);
  }

  try {
    if (args.add) {
      const result = addTask(args.id, args.add);
      if (!result) { console.error(JSON.stringify({ error: `Project not found: ${args.id}` })); process.exit(1); }
      console.log(JSON.stringify({ ok: true, task: result.task }, null, 2));
    } else if (args.complete) {
      const result = completeTask(args.id, args.complete);
      if (!result) { console.error(JSON.stringify({ error: `Project not found: ${args.id}` })); process.exit(1); }
      if (result.error) { console.error(JSON.stringify({ error: result.error })); process.exit(1); }
      console.log(JSON.stringify({ ok: true, task: result.task }, null, 2));
    } else if (args.reopen) {
      const result = reopenTask(args.id, args.reopen);
      if (!result) { console.error(JSON.stringify({ error: `Project not found: ${args.id}` })); process.exit(1); }
      if (result.error) { console.error(JSON.stringify({ error: result.error })); process.exit(1); }
      console.log(JSON.stringify({ ok: true, task: result.task }, null, 2));
    } else if (args.remove) {
      const result = removeTask(args.id, args.remove);
      if (!result) { console.error(JSON.stringify({ error: `Project not found: ${args.id}` })); process.exit(1); }
      if (result.error) { console.error(JSON.stringify({ error: result.error })); process.exit(1); }
      console.log(JSON.stringify({ ok: true, removed: result.removed }, null, 2));
    } else {
      // Default: list
      const status = args.all ? undefined : "open";
      const tasks = listTasks(args.id, { status });
      if (tasks === null) { console.error(JSON.stringify({ error: `Project not found: ${args.id}` })); process.exit(1); }
      console.log(JSON.stringify({ ok: true, tasks }, null, 2));
    }
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
