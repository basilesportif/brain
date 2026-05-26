#!/usr/bin/env node
// @ts-nocheck
/**
 * Check all enabled reminders and output any that are due.
 *
 * This script is called by the reminder-check loop. It does NOT send
 * Telegram messages itself — the loop prompt handles that based on this
 * script's JSON output.
 *
 * Output: JSON to stdout with triggered reminders.
 * Never exits non-zero (robust for loop use).
 */
import { listReminders, isDue, markTriggered, describeSchedule } from "../lib/reminder-store.js";

function main() {
  try {
    const reminders = listReminders({ enabled: true });
    const triggered = [];

    for (const reminder of reminders) {
      try {
        if (isDue(reminder)) {
          markTriggered(reminder.id);
          triggered.push({
            id: reminder.id,
            title: reminder.title,
            schedule: describeSchedule(reminder.schedule),
            type: reminder.schedule.type,
          });
        }
      } catch (err) {
        // Log per-reminder errors but don't stop processing
        console.error(`Error checking reminder ${reminder.id}: ${err.message}`);
      }
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          checked: reminders.length,
          triggered,
          triggeredCount: triggered.length,
        },
        null,
        2
      )
    );
  } catch (err) {
    // Even on fatal error, output valid JSON so the loop can parse it
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: err.message,
          checked: 0,
          triggered: [],
          triggeredCount: 0,
        },
        null,
        2
      )
    );
  }
}

main();
