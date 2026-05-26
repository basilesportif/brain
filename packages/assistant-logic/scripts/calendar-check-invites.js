#!/usr/bin/env node
/**
 * Check calendar invites against an allowlist.
 *
 * For each pending invite (responseStatus "needsAction") across ALL calendars:
 *   - Self-created events → skip (always allowed)
 *   - Allowlisted sender (email or domain match) → auto-accept
 *   - Non-allowlisted / missing organizer → decline (whole series for recurring)
 *
 * Tracks seen invite IDs to avoid reprocessing.
 *
 * Usage:
 *   node scripts/calendar-check-invites.js          → process pending invites
 *   node scripts/calendar-check-invites.js --dry-run → show what would happen without acting
 *
 * Output: JSON with accepted and declined arrays.
 */
const {
  loadComposioConfig,
  requireGoogleCalendarAccount,
} = require("./lib/config");
const {
  createCalendarAllowlistStore,
  createDeclinedInvitesLogStore,
  createSeenInvitesStore,
} = require("./lib/calendar-allowlist-store");
const { getAccessToken, googleFetch } = require("./lib/google-auth");

const GCAL_BASE = "https://www.googleapis.com/calendar/v3";
const composio = loadComposioConfig();
const OWN_EMAILS = new Set(
  Object.values(composio.ACCOUNT_LABELS).map((email) => email.toLowerCase())
);

function loadAllowlist() {
  return createCalendarAllowlistStore().load();
}

function loadDeclineLog() {
  return createDeclinedInvitesLogStore().load();
}

function saveDeclineLog(data) {
  createDeclinedInvitesLogStore().save(data);
}

function appendDeclineLog(entry) {
  const data = loadDeclineLog();
  data.log.push(entry);
  saveDeclineLog(data);
}

function loadSeen() {
  return createSeenInvitesStore().load();
}

function saveSeen(data) {
  data.updatedAt = new Date().toISOString();
  createSeenInvitesStore().save(data);
}

/**
 * Extract email from an organizer/creator object.
 * Returns lowercase email or null.
 */
function extractEmail(obj) {
  if (!obj || !obj.email) return null;
  return obj.email.toLowerCase();
}

/**
 * Extract domain from an email address.
 */
function getDomain(email) {
  if (!email) return null;
  const parts = email.split("@");
  return parts.length === 2 ? parts[1] : null;
}

/**
 * Check if an email is allowed by the allowlist (exact email or domain match).
 */
function isAllowlisted(email, allowlist) {
  if (!email) return false;
  const lower = email.toLowerCase();

  // Own emails always allowed
  if (OWN_EMAILS.has(lower)) return true;

  // Exact email match
  if (allowlist.emails.some((e) => e.toLowerCase() === lower)) return true;

  // Domain match
  const domain = getDomain(lower);
  if (domain && allowlist.domains.some((d) => d.toLowerCase() === domain)) return true;

  return false;
}

/**
 * Check if any of the event's emails (organizer, creator) are self-created.
 */
function isSelfCreated(event) {
  const organizerEmail = extractEmail(event.organizer);
  const creatorEmail = extractEmail(event.creator);
  return (
    (organizerEmail && OWN_EMAILS.has(organizerEmail)) ||
    (creatorEmail && OWN_EMAILS.has(creatorEmail))
  );
}

/**
 * Determine if the event's organizer or creator is allowed.
 */
function senderIsAllowed(event, allowlist) {
  const organizerEmail = extractEmail(event.organizer);
  const creatorEmail = extractEmail(event.creator);
  return isAllowlisted(organizerEmail, allowlist) || isAllowlisted(creatorEmail, allowlist);
}

/**
 * Find self attendee entry in the event.
 */
function findSelfAttendee(event) {
  if (!event.attendees) return null;
  return event.attendees.find(
    (a) => a.self === true || (a.email && OWN_EMAILS.has(a.email.toLowerCase()))
  );
}

/**
 * Fetch all calendars and their pending invites.
 */
async function fetchPendingInvites(token) {
  // Get all calendars
  const calendarList = await googleFetch(
    token,
    `${GCAL_BASE}/users/me/calendarList?maxResults=250`
  );
  const calendars = calendarList.items || [];

  const now = new Date();
  // Look at events from now to 90 days ahead
  const future = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

  const allPending = [];

  // Query each calendar for pending invites
  const promises = calendars.map(async (cal) => {
    try {
      const params = new URLSearchParams({
        timeMin: now.toISOString(),
        timeMax: future.toISOString(),
        maxResults: "250",
        singleEvents: "false", // Get recurring event masters too
      });
      const data = await googleFetch(
        token,
        `${GCAL_BASE}/calendars/${encodeURIComponent(cal.id)}/events?${params}`
      );
      const events = data.items || [];

      for (const ev of events) {
        const selfAttendee = findSelfAttendee(ev);
        if (selfAttendee && selfAttendee.responseStatus === "needsAction") {
          allPending.push({
            ...ev,
            _calendarId: cal.id,
            _selfAttendee: selfAttendee,
          });
        }
      }
    } catch (err) {
      process.stderr.write(`Warning: ${cal.id}: ${err.message}\n`);
    }
  });

  await Promise.all(promises);
  return allPending;
}

/**
 * Accept an event by PATCHing self attendee status to "accepted".
 */
async function acceptEvent(token, calendarId, eventId, selfEmail) {
  const url = `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;

  // Fetch current event to get attendees
  const event = await googleFetch(token, url);
  const attendees = (event.attendees || []).map((a) => {
    if (a.email && a.email.toLowerCase() === selfEmail.toLowerCase()) {
      return { ...a, responseStatus: "accepted" };
    }
    return a;
  });

  await googleFetch(token, url, {
    method: "PATCH",
    body: JSON.stringify({ attendees }),
  });
}

/**
 * Decline an event. For recurring events, decline the series master.
 */
async function declineEvent(token, calendarId, eventId, recurringEventId, selfEmail) {
  // If it's a recurring event instance, target the master
  const targetId = recurringEventId || eventId;
  const url = `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(targetId)}`;

  // Fetch current event to get attendees
  const event = await googleFetch(token, url);
  const attendees = (event.attendees || []).map((a) => {
    if (a.email && a.email.toLowerCase() === selfEmail.toLowerCase()) {
      return { ...a, responseStatus: "declined" };
    }
    return a;
  });

  await googleFetch(token, url, {
    method: "PATCH",
    body: JSON.stringify({ attendees }),
  });
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const allowlist = loadAllowlist();

  // Exit early if allowlist is disabled
  if (!allowlist.enabled) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: "allowlist disabled" }, null, 2));
    return;
  }

  const token = await getAccessToken(requireGoogleCalendarAccount(composio), { composio });
  const seen = loadSeen();

  const pending = await fetchPendingInvites(token);

  const accepted = [];
  const declined = [];
  const skipped = [];

  // Determine self email from the calendar account
  const calEmail =
    composio.ACCOUNT_LABELS[requireGoogleCalendarAccount(composio)] ||
    Array.from(OWN_EMAILS)[0] ||
    "";

  for (const event of pending) {
    const eventKey = event.recurringEventId
      ? `${event._calendarId}:${event.recurringEventId}`
      : `${event._calendarId}:${event.id}`;

    // Skip already processed
    if (seen.seenIds[eventKey]) {
      continue;
    }

    const summary = event.summary || "(no title)";
    const organizerEmail = extractEmail(event.organizer);
    const creatorEmail = extractEmail(event.creator);
    const start = event.start?.dateTime || event.start?.date || "unknown";

    // Self-created → skip
    if (isSelfCreated(event)) {
      seen.seenIds[eventKey] = { action: "skipped_self", at: new Date().toISOString() };
      skipped.push({ eventId: event.id, summary, reason: "self-created" });
      continue;
    }

    // Determine sender email for reporting
    const senderEmail = organizerEmail || creatorEmail || null;

    if (senderIsAllowed(event, allowlist)) {
      // Auto-accept
      if (!dryRun) {
        try {
          await acceptEvent(token, event._calendarId, event.id, calEmail);
        } catch (err) {
          process.stderr.write(`Error accepting ${event.id}: ${err.message}\n`);
          continue;
        }
      }
      seen.seenIds[eventKey] = { action: "accepted", at: new Date().toISOString() };
      accepted.push({
        eventId: event.id,
        calendarId: event._calendarId,
        summary,
        start,
        sender: senderEmail,
      });
    } else {
      // Decline (whole series for recurring)
      if (!dryRun) {
        try {
          await declineEvent(
            token,
            event._calendarId,
            event.id,
            event.recurringEventId,
            calEmail
          );
        } catch (err) {
          process.stderr.write(`Error declining ${event.id}: ${err.message}\n`);
          continue;
        }
      }
      seen.seenIds[eventKey] = { action: "declined", at: new Date().toISOString() };
      if (!dryRun) {
        appendDeclineLog({
          eventId: event.id,
          summary,
          organizer: organizerEmail,
          creator: creatorEmail,
          calendarId: event._calendarId,
          declinedAt: new Date().toISOString(),
        });
      }
      declined.push({
        eventId: event.id,
        calendarId: event._calendarId,
        recurringEventId: event.recurringEventId || null,
        summary,
        start,
        sender: senderEmail,
      });
    }
  }

  if (!dryRun) {
    saveSeen(seen);
  }

  const result = { accepted, declined, skipped, dryRun };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
