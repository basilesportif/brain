#!/usr/bin/env node
// @ts-nocheck
/**
 * Add a reminder.
 *
 * Flags:
 *   --title "TEXT"                  required
 *   --daily --time "HH:MM"         daily reminder
 *   --weekly DAY --time "HH:MM"    weekly reminder (e.g. --weekly friday)
 *   --once "ISO_DATETIME"          one-time reminder
 *   --cron "EXPR"                  cron expression (5-field)
 *   --timezone "TZ"                optional (default: America/New_York)
 *
 * Output: JSON to stdout, errors to stderr.
 */
import { addReminder, describeSchedule } from "../lib/reminder-store.js";

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--title" && argv[i + 1]) {
      args.title = argv[++i];
    } else if (arg === "--daily") {
      args.type = "daily";
    } else if (arg === "--weekly" && argv[i + 1]) {
      args.type = "weekly";
      args.day = argv[++i].toLowerCase();
    } else if (arg === "--once" && argv[i + 1]) {
      args.type = "once";
      args.datetime = argv[++i];
    } else if (arg === "--cron" && argv[i + 1]) {
      args.type = "cron";
      args.expression = argv[++i];
    } else if (arg === "--time" && argv[i + 1]) {
      args.time = argv[++i];
    } else if (arg === "--timezone" && argv[i + 1]) {
      args.timezone = argv[++i];
    }
    i++;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);

  if (!args.title) {
    console.error(
      'Usage: reminder-add.js --title "TEXT" --daily --time "09:00"'
    );
    console.error(
      '       reminder-add.js --title "TEXT" --weekly friday --time "17:00"'
    );
    console.error(
      '       reminder-add.js --title "TEXT" --once "2026-04-15T10:00:00-04:00"'
    );
    console.error(
      '       reminder-add.js --title "TEXT" --cron "0 9 * * 1-5"'
    );
    process.exit(1);
  }

  if (!args.type) {
    console.error("Error: Must specify --daily, --weekly, --once, or --cron");
    process.exit(1);
  }

  let schedule;
  const tz = args.timezone || "America/New_York";

  if (args.type === "daily") {
    if (!args.time) {
      console.error("Error: --daily requires --time HH:MM");
      process.exit(1);
    }
    schedule = { type: "daily", time: args.time, timezone: tz };
  } else if (args.type === "weekly") {
    if (!args.time) {
      console.error("Error: --weekly requires --time HH:MM");
      process.exit(1);
    }
    schedule = { type: "weekly", day: args.day, time: args.time, timezone: tz };
  } else if (args.type === "once") {
    schedule = { type: "once", datetime: args.datetime, timezone: tz };
  } else if (args.type === "cron") {
    schedule = { type: "cron", expression: args.expression, timezone: tz };
  }

  try {
    const reminder = addReminder(args.title, schedule);
    console.log(
      JSON.stringify(
        {
          ok: true,
          reminder,
          description: describeSchedule(reminder.schedule),
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
