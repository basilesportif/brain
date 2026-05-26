#!/usr/bin/env node
// @ts-nocheck
/**
 * Delete a reminder.
 *
 * Flags:
 *   --id "rm_..."       delete by exact ID
 *   --title "TEXT"       delete by title match (confirm if ambiguous)
 *
 * Output: JSON to stdout, errors to stderr.
 * Exit 2 if title match is ambiguous (lists matches on stderr).
 */
import { removeReminder, removeReminderByTitle } from "../lib/reminder-store.js";

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--id" && argv[i + 1]) {
      args.id = argv[++i];
    } else if (arg === "--title" && argv[i + 1]) {
      args.title = argv[++i];
    }
    i++;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);

  if (!args.id && !args.title) {
    console.error('Usage: reminder-delete.js --id "rm_..." | --title "TEXT"');
    process.exit(1);
  }

  try {
    let result;

    if (args.id) {
      result = removeReminder(args.id);
      if (!result.found) {
        console.error(JSON.stringify({ error: `No reminder found with id: ${args.id}` }));
        process.exit(1);
      }
    } else {
      result = removeReminderByTitle(args.title);
      if (!result.found && result.ambiguous) {
        console.error("Ambiguous title match. Multiple reminders match:");
        for (const m of result.matches) {
          console.error(`  ${m.id}  ${m.title}`);
        }
        console.error("\nUse --id to delete a specific one.");
        process.exit(2);
      }
      if (!result.found) {
        console.error(JSON.stringify({ error: `No reminder found matching title: "${args.title}"` }));
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
