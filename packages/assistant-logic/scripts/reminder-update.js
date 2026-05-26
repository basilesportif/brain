#!/usr/bin/env node
/**
 * Update a reminder.
 *
 * Flags:
 *   --id "rm_..."       required
 *   --title "TEXT"       update title
 *   --time "HH:MM"      update scheduled time (daily/weekly only)
 *   --day "DAY"          update scheduled day (weekly only)
 *   --enable             enable the reminder
 *   --disable            disable the reminder
 *
 * Output: JSON to stdout, errors to stderr.
 */
const { updateReminder, describeSchedule, loadStore } = require("./lib/reminder-store");

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--id" && argv[i + 1]) {
      args.id = argv[++i];
    } else if (arg === "--title" && argv[i + 1]) {
      args.title = argv[++i];
    } else if (arg === "--time" && argv[i + 1]) {
      args.time = argv[++i];
    } else if (arg === "--day" && argv[i + 1]) {
      args.day = argv[++i].toLowerCase();
    } else if (arg === "--enable") {
      args.enabled = true;
    } else if (arg === "--disable") {
      args.enabled = false;
    }
    i++;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);

  if (!args.id) {
    console.error('Usage: reminder-update.js --id "rm_..." [--title "TEXT"] [--time "HH:MM"] [--enable|--disable]');
    process.exit(1);
  }

  try {
    const fields = {};
    if (args.title !== undefined) fields.title = args.title;
    if (args.enabled !== undefined) fields.enabled = args.enabled;

    // If updating time or day, we need to modify the schedule
    if (args.time !== undefined || args.day !== undefined) {
      const store = loadStore();
      const existing = store.reminders.find((r) => r.id === args.id);
      if (!existing) {
        console.error(JSON.stringify({ error: `No reminder found with id: ${args.id}` }));
        process.exit(1);
      }
      const newSchedule = { ...existing.schedule };
      if (args.time !== undefined) newSchedule.time = args.time;
      if (args.day !== undefined) newSchedule.day = args.day;
      fields.schedule = newSchedule;
    }

    const result = updateReminder(args.id, fields);

    if (!result.found) {
      console.error(JSON.stringify({ error: `No reminder found with id: ${args.id}` }));
      process.exit(1);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          reminder: result.reminder,
          description: describeSchedule(result.reminder.schedule),
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
