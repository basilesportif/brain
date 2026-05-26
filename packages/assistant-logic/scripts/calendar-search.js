#!/usr/bin/env node
/**
 * Search calendar events by query string.
 *
 * Usage:
 *   node scripts/calendar-search.js "meeting"        → search next 30 days
 *   node scripts/calendar-search.js "meeting" 90     → search next 90 days
 *
 * Output: JSON array of matching events sorted by start time.
 */
const {
  loadComposioConfig,
  requireGoogleCalendarAccount,
} = require("./lib/config");
const { getAccessToken, googleFetch } = require("./lib/google-auth");

const GCAL_BASE = "https://www.googleapis.com/calendar/v3";

async function main() {
  const query = process.argv[2];
  if (!query) {
    console.error("Usage: node calendar-search.js <query> [days_ahead]");
    process.exit(1);
  }
  const daysAhead = parseInt(process.argv[3] || "30", 10);

  const now = new Date();
  const timeMin = now.toISOString();
  const future = new Date(now.getTime() + daysAhead * 86400000);
  const timeMax = future.toISOString();
  const composio = loadComposioConfig();

  const token = await getAccessToken(requireGoogleCalendarAccount(composio), { composio });

  // Get all calendars
  const calendarList = await googleFetch(
    token,
    `${GCAL_BASE}/users/me/calendarList?maxResults=250`
  );
  const calendars = calendarList.items || [];

  // Search across all calendars in parallel
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    q: query,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "100",
  });

  const results = await Promise.all(
    calendars.map((cal) =>
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
          htmlLink: ev.htmlLink,
        }))
      ).catch(() => [])
    )
  );

  const events = results.flat().filter((ev) => ev.status !== "cancelled");
  events.sort((a, b) => new Date(a.start) - new Date(b.start));

  console.log(JSON.stringify(events, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
