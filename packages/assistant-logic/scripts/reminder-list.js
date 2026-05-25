#!/usr/bin/env node
/**
 * List reminders.
 *
 * Flags:
 *   --all              include disabled reminders
 *   --query "TEXT"      search by title substring
 *
 * Output: JSON to stdout, errors to stderr.
 */
const { listReminders, describeSchedule } = require("./lib/reminder-store");

function parseArgs(argv) {
  const args = { all: false };
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--all") {
      args.all = true;
    } else if (arg === "--query" && argv[i + 1]) {
      args.query = argv[++i];
    }
    i++;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);

  try {
    const filterOpts = {};
    if (!args.all) filterOpts.enabled = true;
    if (args.query) filterOpts.query = args.query;

    const reminders = listReminders(filterOpts);
    const annotated = reminders.map((r) => ({
      ...r,
      _description: describeSchedule(r.schedule),
    }));

    console.log(
      JSON.stringify(
        { ok: true, count: annotated.length, reminders: annotated },
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
