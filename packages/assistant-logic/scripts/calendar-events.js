#!/usr/bin/env node
/**
 * Fetch calendar events for a date range from ALL visible Google Calendars.
 *
 * Usage:
 *   node scripts/calendar-events.js                       → today's events
 *   node scripts/calendar-events.js 2026-03-20            → specific date
 *   node scripts/calendar-events.js 2026-03-20 2026-03-25 → date range
 *
 * Output: JSON array of events sorted by start time.
 */
const {
  loadComposioConfig,
  requireGoogleCalendarAccount,
} = require("./lib/config");
const { getAccessToken, googleFetch } = require("./lib/google-auth");

const GCAL_BASE = "https://www.googleapis.com/calendar/v3";

async function main() {
  const args = process.argv.slice(2);

  // Parse date range
  const now = new Date();
  let timeMin, timeMax;

  if (args.length === 0) {
    // Today
    const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    timeMin = new Date(y, m, d).toISOString();
    timeMax = new Date(y, m, d + 1).toISOString();
  } else if (args.length === 1) {
    // Single date
    const [y, m, d] = args[0].split("-").map(Number);
    timeMin = new Date(y, m - 1, d).toISOString();
    timeMax = new Date(y, m - 1, d + 1).toISOString();
  } else {
    // Date range (end date is inclusive)
    const [y1, m1, d1] = args[0].split("-").map(Number);
    const [y2, m2, d2] = args[1].split("-").map(Number);
    timeMin = new Date(y1, m1 - 1, d1).toISOString();
    timeMax = new Date(y2, m2 - 1, d2 + 1).toISOString();
  }

  const composio = loadComposioConfig();
  const token = await getAccessToken(requireGoogleCalendarAccount(composio), { composio });

  // Fetch all visible calendars
  const calendarList = await googleFetch(
    token,
    `${GCAL_BASE}/users/me/calendarList?maxResults=250`
  );
  const calendars = calendarList.items || [];

  // Query events from ALL calendars in parallel
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });

  const eventPromises = calendars.map((cal) =>
    googleFetch(
      token,
      `${GCAL_BASE}/calendars/${encodeURIComponent(cal.id)}/events?${params}`
    ).then((data) =>
      (data.items || []).map((ev) => ({
        id: ev.id,
        calendarId: cal.id,
        calendarName: cal.summary || cal.id,
        summary: ev.summary || "(no title)",
        start: ev.start?.dateTime || ev.start?.date,
        end: ev.end?.dateTime || ev.end?.date,
        location: ev.location || null,
        description: ev.description || null,
        status: ev.status,
        transparency: ev.transparency || "opaque",
        htmlLink: ev.htmlLink,
        attendees: (ev.attendees || []).map((a) => ({
          email: a.email,
          responseStatus: a.responseStatus,
        })),
      }))
    ).catch((err) => {
      // Skip calendars that error (e.g. permission issues)
      process.stderr.write(`Warning: ${cal.id}: ${err.message}\n`);
      return [];
    })
  );

  const results = await Promise.all(eventPromises);
  const allEvents = results.flat();

  // Sort by start time
  allEvents.sort((a, b) => {
    const ta = new Date(a.start).getTime();
    const tb = new Date(b.start).getTime();
    return ta - tb;
  });

  // Filter out declined events
  const filtered = allEvents.filter((ev) => ev.status !== "cancelled");

  console.log(JSON.stringify(filtered, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
