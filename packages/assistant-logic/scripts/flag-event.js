#!/usr/bin/env node
/**
 * Manage flagged calendar event reminders.
 *
 * Flags:
 *   --title "text" [--note "..."] [--remind-before "24h,2h"]   fuzzy-match upcoming events, add to flagged list
 *   --event <id> [--note "..."] [--remind-before "24h,2h"]     add by event ID directly
 *   --unflag --title "text"                                    remove by title fuzzy-match
 *   --unflag --event <id>                                      remove by event ID
 *   --snooze --title "text" <duration>                         snooze by title match
 *   --snooze --event <id> <duration>                           snooze by event ID
 *   --note --event <id> "new note text"                        update note on existing entry
 *   --list                                                     print all flagged entries
 *
 * Output: JSON to stdout, errors to stderr.
 */
const {
  loadComposioConfig,
  requireGoogleCalendarAccount,
} = require("./lib/config");
const { getAccessToken, googleFetch } = require("./lib/google-auth");
const { createStateStore } = require("./lib/state-stores");
const { fuzzyScore } = require("./lib/fuzzy");

const GCAL_BASE = "https://www.googleapis.com/calendar/v3";

function getFlaggedEventsStore() {
  return createStateStore("flaggedEvents", {
    defaultValue: () => ({ events: {} }),
    onLoad(store) {
      const next = store && typeof store === "object" ? store : {};
      if (!next.events || typeof next.events !== "object") next.events = {};
      return next;
    },
  });
}

function loadData() {
  return getFlaggedEventsStore().load();
}

function saveData(data) {
  return getFlaggedEventsStore().save(data);
}

function parseArgs(argv) {
  const args = { positional: [] };
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--list") {
      args.list = true;
      i++;
    } else if (arg === "--unflag") {
      args.unflag = true;
      i++;
    } else if (arg === "--snooze") {
      args.snooze = true;
      i++;
    } else if (arg === "--note") {
      // If next arg exists and is not a flag, treat as --note <value>
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        args.note = argv[++i];
      } else {
        // Mode flag: --note --event <id> "text"
        args.noteMode = true;
      }
      i++;
    } else if (arg === "--title" && argv[i + 1]) {
      args.title = argv[++i];
      i++;
    } else if (arg === "--event" && argv[i + 1]) {
      args.event = argv[++i];
      i++;
    } else if (arg === "--remind-before" && argv[i + 1]) {
      args.remindBefore = argv[++i];
      i++;
    } else if (arg.startsWith("--")) {
      i++;
    } else {
      args.positional.push(arg);
      i++;
    }
  }
  return args;
}

/** Parse snooze duration into an ISO date string. */
function parseSnoozeUntil(duration) {
  const now = new Date();

  // Nh (hours)
  const hourMatch = duration.match(/^(\d+)h$/i);
  if (hourMatch) {
    const d = new Date(now.getTime() + parseInt(hourMatch[1], 10) * 60 * 60 * 1000);
    return d.toISOString();
  }

  // Nm (minutes)
  const minMatch = duration.match(/^(\d+)m$/i);
  if (minMatch) {
    const d = new Date(now.getTime() + parseInt(minMatch[1], 10) * 60 * 1000);
    return d.toISOString();
  }

  // tomorrow
  if (duration.toLowerCase() === "tomorrow") {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  }

  // Weekday names
  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayIdx = weekdays.indexOf(duration.toLowerCase());
  if (dayIdx !== -1) {
    const d = new Date(now);
    let daysUntil = dayIdx - d.getDay();
    if (daysUntil <= 0) daysUntil += 7;
    d.setDate(d.getDate() + daysUntil);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  }

  // YYYY-MM-DDTHH:MM
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(duration)) {
    return new Date(duration).toISOString();
  }

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(duration)) {
    const d = new Date(duration + "T09:00:00");
    return d.toISOString();
  }

  console.error(`Cannot parse snooze duration: "${duration}". Use: 2h, 30m, tomorrow, monday, 2026-03-25, 2026-03-25T14:00`);
  process.exit(1);
}

/** Parse remind-before string "24h,2h,30m" into array ["24h", "2h", "30m"]. */
function parseRemindBefore(str) {
  if (!str) return ["24h", "2h"];
  return str.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Fetch upcoming events (next 14 days) from ALL visible Google Calendars. */
async function fetchUpcomingEvents() {
  const composio = loadComposioConfig();
  const token = await getAccessToken(requireGoogleCalendarAccount(composio), { composio });
  const now = new Date();
  const future = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  // Fetch all visible calendars
  const calendarList = await googleFetch(
    token,
    `${GCAL_BASE}/users/me/calendarList?maxResults=250`
  );
  const calendars = calendarList.items || [];

  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    maxResults: "250",
  });

  // Query all calendars in parallel
  const eventPromises = calendars.map((cal) =>
    googleFetch(
      token,
      `${GCAL_BASE}/calendars/${encodeURIComponent(cal.id)}/events?${params}`
    ).then((data) =>
      (data.items || []).map((ev) => ({
        id: ev.id,
        calendarId: cal.id,
        summary: ev.summary || "(no title)",
        start: ev.start?.dateTime || ev.start?.date,
        end: ev.end?.dateTime || ev.end?.date,
      }))
    ).catch((err) => {
      process.stderr.write(`Warning: ${cal.id}: ${err.message}\n`);
      return [];
    })
  );

  const results = await Promise.all(eventPromises);
  const allEvents = results.flat();

  // Deduplicate by event ID (same event may appear in multiple calendars)
  const seen = new Map();
  for (const ev of allEvents) {
    if (!seen.has(ev.id)) {
      seen.set(ev.id, ev);
    }
  }

  return Array.from(seen.values());
}

/** Fetch a single event by ID, searching all visible calendars. */
async function fetchEventById(eventId) {
  const composio = loadComposioConfig();
  const token = await getAccessToken(requireGoogleCalendarAccount(composio), { composio });

  // Try primary first for speed
  try {
    const ev = await googleFetch(
      token,
      `${GCAL_BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`
    );
    return {
      id: ev.id,
      calendarId: "primary",
      summary: ev.summary || "(no title)",
      start: ev.start?.dateTime || ev.start?.date,
      end: ev.end?.dateTime || ev.end?.date,
    };
  } catch {
    // Not in primary — search all calendars
  }

  const calendarList = await googleFetch(
    token,
    `${GCAL_BASE}/users/me/calendarList?maxResults=250`
  );
  const calendars = (calendarList.items || []).filter((c) => c.id !== "primary");

  for (const cal of calendars) {
    try {
      const ev = await googleFetch(
        token,
        `${GCAL_BASE}/calendars/${encodeURIComponent(cal.id)}/events/${encodeURIComponent(eventId)}`
      );
      return {
        id: ev.id,
        calendarId: cal.id,
        summary: ev.summary || "(no title)",
        start: ev.start?.dateTime || ev.start?.date,
        end: ev.end?.dateTime || ev.end?.date,
      };
    } catch {
      continue;
    }
  }

  throw new Error(`Event ${eventId} not found in any calendar`);
}

async function handleTitle(args) {
  const events = await fetchUpcomingEvents();

  if (events.length === 0) {
    console.error("No upcoming events found to match against.");
    process.exit(1);
  }

  const scored = events.map((e) => ({
    ...e,
    score: fuzzyScore(args.title, e.summary),
  }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  if (best.score === 0) {
    console.error(`No event match found for "${args.title}".`);
    console.error("Available events:");
    events.slice(0, 10).forEach((e) => console.error(`  - ${e.summary}`));
    process.exit(1);
  }

  const data = loadData();
  const now = new Date().toISOString();
  const existing = data.events[best.id];
  const remindBefore = args.remindBefore
    ? parseRemindBefore(args.remindBefore)
    : existing
      ? existing.remindBefore
      : parseRemindBefore(null);

  const note = args.note || (existing ? existing.note : null);
  data.events[best.id] = {
    calendarId: best.calendarId,
    summary: best.summary,
    start: best.start,
    end: best.end,
    note,
    flaggedAt: existing ? existing.flaggedAt : now,
    remindBefore,
    remindCount: existing ? existing.remindCount : 0,
    lastRemindedAt: existing ? existing.lastRemindedAt : null,
    snoozeUntil: null,
  };
  saveData(data);

  const result = {
    action: "flagged_event",
    eventId: best.id,
    calendarId: best.calendarId,
    summary: best.summary,
    start: best.start,
    end: best.end,
    flaggedAt: data.events[best.id].flaggedAt,
    matchScore: best.score,
  };
  if (note) result.note = note;
  console.log(JSON.stringify(result, null, 2));
}

async function handleEvent(args) {
  let eventInfo;
  try {
    eventInfo = await fetchEventById(args.event);
  } catch (err) {
    console.error(`Failed to fetch event ${args.event}: ${err.message}`);
    process.exit(1);
  }

  const data = loadData();
  const now = new Date().toISOString();
  const existing = data.events[args.event];
  const remindBefore = args.remindBefore
    ? parseRemindBefore(args.remindBefore)
    : existing
      ? existing.remindBefore
      : parseRemindBefore(null);

  const note = args.note || (existing ? existing.note : null);
  data.events[args.event] = {
    calendarId: eventInfo.calendarId,
    summary: eventInfo.summary,
    start: eventInfo.start,
    end: eventInfo.end,
    note,
    flaggedAt: existing ? existing.flaggedAt : now,
    remindBefore,
    remindCount: existing ? existing.remindCount : 0,
    lastRemindedAt: existing ? existing.lastRemindedAt : null,
    snoozeUntil: null,
  };
  saveData(data);

  const result = {
    action: "flagged_event",
    eventId: args.event,
    calendarId: eventInfo.calendarId,
    summary: eventInfo.summary,
    start: eventInfo.start,
    end: eventInfo.end,
    flaggedAt: data.events[args.event].flaggedAt,
  };
  if (note) result.note = note;
  console.log(JSON.stringify(result, null, 2));
}

async function handleUnflag(args) {
  const data = loadData();

  if (args.event) {
    const entry = data.events[args.event];
    if (!entry) {
      console.error(`Event ${args.event} not found in flagged list.`);
      process.exit(1);
    }
    delete data.events[args.event];
    saveData(data);

    const result = {
      action: "unflagged_event",
      eventId: args.event,
      summary: entry.summary,
    };
    console.log(JSON.stringify(result, null, 2));
  } else if (args.title) {
    const entries = Object.entries(data.events);
    if (entries.length === 0) {
      console.error("Flagged list is empty, nothing to unflag.");
      process.exit(1);
    }
    const scored = entries.map(([id, e]) => ({
      id,
      entry: e,
      score: fuzzyScore(args.title, e.summary),
    }));
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (best.score === 0) {
      console.error(`No match found for "${args.title}" in flagged list.`);
      console.error("Flagged events:");
      entries.slice(0, 10).forEach(([, e]) => console.error(`  - ${e.summary}`));
      process.exit(1);
    }
    delete data.events[best.id];
    saveData(data);

    const result = {
      action: "unflagged_event",
      eventId: best.id,
      summary: best.entry.summary,
      matchScore: best.score,
    };
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error("--unflag requires --title \"text\" or --event <id>");
    process.exit(1);
  }
}

async function handleSnooze(args) {
  const data = loadData();
  let eventId;
  let entry;

  if (args.event) {
    eventId = args.event;
    entry = data.events[eventId];
    if (!entry) {
      console.error(`Event ${eventId} not found in flagged list.`);
      process.exit(1);
    }
  } else if (args.title) {
    const entries = Object.entries(data.events);
    if (entries.length === 0) {
      console.error("Flagged list is empty, nothing to snooze.");
      process.exit(1);
    }
    const scored = entries.map(([id, e]) => ({
      id,
      entry: e,
      score: fuzzyScore(args.title, e.summary),
    }));
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (best.score === 0) {
      console.error(`No match found for "${args.title}" in flagged list.`);
      process.exit(1);
    }
    eventId = best.id;
    entry = best.entry;
  } else {
    console.error("--snooze requires --title \"text\" or --event <id>");
    process.exit(1);
  }

  const duration = args.positional[0];
  if (!duration) {
    console.error("--snooze requires a duration: 2h, 30m, tomorrow, monday, 2026-03-25, 2026-03-25T14:00");
    process.exit(1);
  }

  const snoozeUntil = parseSnoozeUntil(duration);
  data.events[eventId].snoozeUntil = snoozeUntil;
  saveData(data);

  const result = {
    action: "snoozed_event",
    eventId,
    summary: entry.summary,
    snoozeUntil,
  };
  console.log(JSON.stringify(result, null, 2));
}

async function handleNote(args) {
  if (!args.event) {
    console.error("--note requires --event <id>");
    process.exit(1);
  }

  const note = args.positional[0] || args.note;
  if (!note) {
    console.error("--note requires a note string");
    process.exit(1);
  }

  const data = loadData();
  const entry = data.events[args.event];
  if (!entry) {
    console.error(`Event ${args.event} not found in flagged list.`);
    process.exit(1);
  }

  entry.note = note;
  saveData(data);

  const result = {
    action: "updated_note",
    eventId: args.event,
    summary: entry.summary,
    note,
  };
  console.log(JSON.stringify(result, null, 2));
}

function handleList() {
  const data = loadData();
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.list) {
    handleList();
  } else if (args.unflag) {
    await handleUnflag(args);
  } else if (args.snooze) {
    await handleSnooze(args);
  } else if (args.noteMode) {
    await handleNote(args);
  } else if (args.title) {
    await handleTitle(args);
  } else if (args.event) {
    await handleEvent(args);
  } else {
    console.error(
      "Usage:\n" +
        "  --title \"text\" [--note \"...\"] [--remind-before \"24h,2h\"]   flag by title match\n" +
        "  --event <id> [--note \"...\"] [--remind-before \"24h,2h\"]     flag by event ID\n" +
        "  --unflag --title \"text\"                                    unflag by title\n" +
        "  --unflag --event <id>                                      unflag by event ID\n" +
        "  --snooze --title \"text\" <duration>                         snooze by title\n" +
        "  --snooze --event <id> <duration>                           snooze by event ID\n" +
        "  --note --event <id> \"new note\"                              update note\n" +
        "  --list                                                     list all flagged entries"
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
