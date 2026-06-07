#!/usr/bin/env node
// @ts-nocheck
/**
 * Delete a to-do item.
 *
 * Flags:
 *   --id "td_..."       delete by exact ID
 *   --title "TEXT"       delete by title match (confirm if ambiguous); "#2" maps to numbered list item 2
 *   --number "2"         delete by current numbered list position
 *
 * Output: JSON to stdout, errors to stderr.
 * Exit 2 if title match is ambiguous (lists matches on stderr).
 */
import { deleteTodoById, deleteTodoByTitle, deleteTodoByNumber } from "../lib/todo-store.js";

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--id" && argv[i + 1]) {
      args.id = argv[++i];
      i++;
    } else if (arg === "--number" && argv[i + 1]) {
      args.number = argv[++i];
      i++;
    } else if (arg === "--title" && argv[i + 1]) {
      args.title = argv[++i];
      i++;
    } else {
      i++;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);

  if (!args.id && !args.title && !args.number) {
    console.error("Usage: todo-delete.js --id \"td_...\" | --title \"TEXT\" | --number 2");
    process.exit(1);
  }

  try {
    let result;

    if (args.id) {
      result = deleteTodoById(args.id);
      if (!result.found) {
        console.error(JSON.stringify({ error: `No to-do found with id: ${args.id}` }));
        process.exit(1);
      }
    } else if (args.number) {
      result = deleteTodoByNumber(Number(args.number));
      if (!result.found) {
        console.error(JSON.stringify({ error: `No to-do found at number: ${args.number}` }));
        process.exit(1);
      }
    } else {
      result = deleteTodoByTitle(args.title);
      if (!result.found && result.ambiguous) {
        console.error("Ambiguous title match. Multiple to-dos match:");
        for (const m of result.matches) {
          console.error(`  ${m.id}  ${m.title}`);
        }
        console.error("\nUse --id to delete a specific one.");
        process.exit(2);
      }
      if (!result.found) {
        console.error(JSON.stringify({ error: `No to-do found matching title: "${args.title}"` }));
        process.exit(1);
      }
    }

    console.log(JSON.stringify({ ok: true, deleted: result.deleted }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
