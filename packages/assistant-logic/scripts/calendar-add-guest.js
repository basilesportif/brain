#!/usr/bin/env node
/**
 * Add one or more guests to an existing Google Calendar event.
 * Sends invitation emails by default.
 *
 * Usage:
 *   node scripts/calendar-add-guest.js EVENT_ID guest@example.com another@example.com
 *   node scripts/calendar-add-guest.js EVENT_ID guest@example.com --calendar-id my_cal_id
 *   node scripts/calendar-add-guest.js EVENT_ID guest@example.com --send-updates all
 */
const {
  loadComposioConfig,
  requireGoogleCalendarAccount,
} = require("./lib/config");
const { getAccessToken, googleFetch } = require("./lib/google-auth");

const GCAL_BASE = "https://www.googleapis.com/calendar/v3";

async function main() {
  const args = process.argv.slice(2);
  const composio = loadComposioConfig();

  if (args.length < 2) {
    throw new Error("Usage: calendar-add-guest.js EVENT_ID email1 [email2 ...] [--calendar-id ID] [--send-updates VALUE]");
  }

  // Parse args: first positional is event ID, remaining positionals are emails, plus optional flags
  let calendarId = "primary";
  let sendUpdates = "all";
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--calendar-id" && i + 1 < args.length) {
      calendarId = args[++i];
    } else if (args[i] === "--send-updates" && i + 1 < args.length) {
      sendUpdates = args[++i];
    } else {
      positional.push(args[i]);
    }
  }

  // Resolve calendar alias
  calendarId = composio.CALENDAR_ALIASES[calendarId] || calendarId;

  const eventId = positional[0];
  const newEmails = positional.slice(1);

  if (!eventId || newEmails.length === 0) {
    throw new Error("Must provide an event ID and at least one email address.");
  }

  // Get OAuth token
  const token = await getAccessToken(requireGoogleCalendarAccount(composio), { composio });

  // GET existing event to retrieve current attendees
  const getUrl = `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  const existing = await googleFetch(token, getUrl);

  // Merge attendees, deduplicating by email
  const currentAttendees = existing.attendees || [];
  const seen = new Set(currentAttendees.map((a) => a.email.toLowerCase()));
  const merged = [...currentAttendees];

  for (const email of newEmails) {
    if (!seen.has(email.toLowerCase())) {
      merged.push({ email });
      seen.add(email.toLowerCase());
    }
  }

  // PATCH the event with merged attendees
  const patchUrl = `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${sendUpdates}`;
  const updated = await googleFetch(token, patchUrl, {
    method: "PATCH",
    body: JSON.stringify({ attendees: merged }),
  });

  console.log(JSON.stringify(updated, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
