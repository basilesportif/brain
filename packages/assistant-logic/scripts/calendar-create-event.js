#!/usr/bin/env node
/**
 * Create a Google Calendar event, optionally with attendees.
 *
 * Input: JSON via stdin OR as first CLI argument.
 * Fields:
 *   summary     (required) — event title
 *   start       (required) — ISO datetime e.g. "2026-03-21T10:00:00"
 *   end         (required) — ISO datetime
 *   timeZone    (optional, default "America/New_York")
 *   attendees   (optional) — array of email strings or attendee objects
 *                 Own/self emails are omitted by default to avoid self-invites
 *   description (optional)
 *   location    (optional)
 *   transparency (optional) — "transparent" (free) or "opaque" (busy, default)
 *   reminders   (optional) — Google reminders object
 *   recurrence  (optional) — array of RRULE strings
 *   calendarId  (optional, default "primary")
 *   sendUpdates (optional, default "all")
 *   includeSelfAttendees (optional, default false) — set true only if you
 *                 intentionally want to invite one of the configured own emails
 *
 * Usage:
 *   echo '{"summary":"Lunch","start":"...","end":"..."}' | node scripts/calendar-create-event.js
 *   node scripts/calendar-create-event.js '{"summary":"Meeting","start":"...","end":"..."}'
 */
const {
  loadComposioConfig,
  requireGoogleCalendarAccount,
} = require("./lib/config");
const { getAccessToken, googleFetch } = require("./lib/google-auth");
const { buildCalendarAttendees } = require("./lib/calendar-attendees");

const GCAL_BASE = "https://www.googleapis.com/calendar/v3";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

async function main() {
  // Read input from CLI arg or stdin
  let raw = process.argv[2];
  if (!raw) {
    raw = await readStdin();
  }
  if (!raw) {
    throw new Error("No input provided. Pass JSON as first argument or pipe via stdin.");
  }

  const input = JSON.parse(raw);

  const { summary, start, end } = input;
  if (!summary || !start || !end) {
    throw new Error("summary, start, and end are required fields.");
  }

  const composio = loadComposioConfig();
  const timeZone = input.timeZone || "America/New_York";
  const rawCalendarId = input.calendarId || "primary";
  const calendarId = composio.CALENDAR_ALIASES[rawCalendarId] || rawCalendarId;
  const sendUpdates = input.sendUpdates || "all";

  // Build request body
  const body = {
    summary,
    start: { dateTime: start, timeZone },
    end: { dateTime: end, timeZone },
  };

  const attendees = buildCalendarAttendees(input.attendees, {
    composio,
    calendarId,
    includeSelfAttendees: input.includeSelfAttendees,
  });
  if (attendees) body.attendees = attendees;
  if (input.description) body.description = input.description;
  if (input.location) body.location = input.location;
  if (input.transparency) body.transparency = input.transparency;
  if (input.recurrence) body.recurrence = input.recurrence;
  if (input.reminders) body.reminders = input.reminders;

  const connectedAccountId = requireGoogleCalendarAccount(composio);
  const client = await getAccessToken(connectedAccountId, { composio });

  const url = `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=${sendUpdates}`;
  const event = await googleFetch(client, url, {
    method: "POST",
    body: JSON.stringify(body),
  });

  const finalEvent = attendees
    ? event
    : await clearImplicitSelfAttendee(client, calendarId, event, body);

  console.log(JSON.stringify(finalEvent, null, 2));
}

async function clearImplicitSelfAttendee(client, calendarId, createdEvent, requestBody) {
  const eventId =
    createdEvent?.id ||
    createdEvent?.event_id ||
    createdEvent?.response_data?.id ||
    createdEvent?.response_data?.event_id ||
    createdEvent?.response_data?.event?.id;

  const resolvedEventId =
    eventId || (await findCreatedEventId(client, calendarId, requestBody));

  if (!resolvedEventId) {
    process.stderr.write(
      "Warning: created event id not found; could not clear implicit self attendee.\n"
    );
    return createdEvent;
  }

  try {
    return await googleFetch(
      client,
      `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(
        resolvedEventId
      )}?sendUpdates=none`,
      {
        method: "PATCH",
        body: JSON.stringify({ attendees: [] }),
      }
    );
  } catch (err) {
    process.stderr.write(
      `Warning: could not clear implicit self attendee for created event: ${err.message}\n`
    );
    return createdEvent;
  }
}

async function findCreatedEventId(client, calendarId, requestBody) {
  const start = new Date(requestBody.start.dateTime || requestBody.start.date);
  const end = new Date(requestBody.end.dateTime || requestBody.end.date);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;

  const timeMin = new Date(start.getTime() - 60 * 60 * 1000).toISOString();
  const timeMax = new Date(end.getTime() + 60 * 60 * 1000).toISOString();
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    q: requestBody.summary,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "10",
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const data = await googleFetch(
      client,
      `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`
    );
    const match = (data.items || [])
      .filter((ev) => ev.status !== "cancelled")
      .find((ev) => {
        const evStart = ev.start?.dateTime || ev.start?.date;
        return ev.summary === requestBody.summary && sameEventStart(evStart, requestBody.start);
      });
    if (match?.id) return match.id;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

function sameEventStart(eventStart, requestedStart) {
  if (!eventStart) return false;
  if (requestedStart.date && !requestedStart.dateTime) {
    return eventStart === requestedStart.date;
  }
  const eventMs = new Date(eventStart).getTime();
  const requestedMs = new Date(requestedStart.dateTime).getTime();
  return !Number.isNaN(eventMs) && !Number.isNaN(requestedMs) && eventMs === requestedMs;
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
