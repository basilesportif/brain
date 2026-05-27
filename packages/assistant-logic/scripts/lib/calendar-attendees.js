function normalizeCalendarAttendee(attendee) {
  if (typeof attendee === "string") {
    const email = attendee.trim();
    return email ? { email } : null;
  }
  if (!attendee || typeof attendee !== "object") return null;
  const email = typeof attendee.email === "string" ? attendee.email.trim() : "";
  if (!email) return null;
  return { ...attendee, email };
}

function collectOwnCalendarEmails(composio = {}, calendarId) {
  const emails = new Set();
  const add = (value) => {
    if (isPersonalEmailCalendarId(value)) {
      emails.add(value.toLowerCase());
    }
  };

  add(calendarId);
  add(composio.composioConfig?.accounts?.google_calendar?.email);
  for (const account of composio.composioConfig?.accounts?.gmail || []) {
    add(account?.email);
  }
  return emails;
}

function buildCalendarAttendees(inputAttendees, options = {}) {
  if (!Array.isArray(inputAttendees) || inputAttendees.length === 0) return undefined;

  const includeSelfAttendees = options.includeSelfAttendees === true;
  const ownEmails = includeSelfAttendees
    ? new Set()
    : collectOwnCalendarEmails(options.composio, options.calendarId);
  const seen = new Set();
  const attendees = [];

  for (const raw of inputAttendees) {
    const attendee = normalizeCalendarAttendee(raw);
    if (!attendee) continue;
    const emailKey = attendee.email.toLowerCase();
    if (seen.has(emailKey)) continue;
    seen.add(emailKey);
    if (ownEmails.has(emailKey)) continue;
    attendees.push(attendee);
  }

  return attendees.length > 0 ? attendees : undefined;
}

function isPersonalEmailCalendarId(value) {
  return (
    typeof value === "string" &&
    value.includes("@") &&
    !value.toLowerCase().endsWith("@group.calendar.google.com")
  );
}

module.exports = {
  buildCalendarAttendees,
  collectOwnCalendarEmails,
  normalizeCalendarAttendee,
  isPersonalEmailCalendarId,
};
