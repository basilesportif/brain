#!/usr/bin/env node
/**
 * One-off script: fix incorrect Football calendar events.
 */
const { loadComposioConfig, requireGoogleCalendarAccount } = require("./lib/config");
const { getAccessToken, googleFetch } = require("./lib/google-auth");

const GCAL_BASE = "https://www.googleapis.com/calendar/v3";
function resolveFootballCalendarId(composio) {
  return process.env.FOOTBALL_CALENDAR_ID
    || composio.env?.FOOTBALL_CALENDAR_ID
    || composio.CALENDAR_ALIASES?.football
    || composio.composioConfig?.football_calendar_id
    || null;
}

const patches = [
  {
    name: "Fulham vs Aston Villa",
    id: "paasl9ujvf9l19hvm0h4i7bal4",
    body: {
      start: { dateTime: "2026-04-25T07:30:00-04:00", timeZone: "America/New_York" },
      end:   { dateTime: "2026-04-25T09:30:00-04:00", timeZone: "America/New_York" },
      description: "Premier League",
      transparency: "transparent",
    },
  },
  {
    name: "West Ham vs Everton",
    id: "7fpnphe3e2t50ookrikcejjfo0",
    body: {
      start: { dateTime: "2026-04-25T10:00:00-04:00", timeZone: "America/New_York" },
      end:   { dateTime: "2026-04-25T12:00:00-04:00", timeZone: "America/New_York" },
      description: "Premier League",
      transparency: "transparent",
    },
  },
  {
    name: "Arsenal vs Newcastle",
    id: "p4v5q9ko0dts9uj6g9nb4glsv4",
    body: {
      start: { dateTime: "2026-04-25T12:30:00-04:00", timeZone: "America/New_York" },
      end:   { dateTime: "2026-04-25T14:30:00-04:00", timeZone: "America/New_York" },
      description: "Premier League",
      transparency: "transparent",
    },
  },
  {
    name: "Man Utd vs Brentford",
    id: "gufbrh6kbke59c68mu4ghd1hb0",
    body: {
      start: { dateTime: "2026-04-27T15:00:00-04:00", timeZone: "America/New_York" },
      end:   { dateTime: "2026-04-27T17:00:00-04:00", timeZone: "America/New_York" },
      description: "Premier League",
      transparency: "transparent",
    },
  },
];

async function main() {
  const composio = loadComposioConfig();
  const connectedAccountId = requireGoogleCalendarAccount(composio);
  const calendarId = resolveFootballCalendarId(composio);
  if (!calendarId) {
    throw new Error("Football calendar id is not configured. Set FOOTBALL_CALENDAR_ID in the private workspace .env or calendars.football in composio.yaml.");
  }
  const client = await getAccessToken(connectedAccountId, { composio });

  const results = [];

  for (const patch of patches) {
    const url = `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${patch.id}`;
    try {
      const result = await googleFetch(client, url, {
        method: "PATCH",
        body: JSON.stringify(patch.body),
      });
      console.log(`OK: ${patch.name} — id: ${result?.id || patch.id}`);
      results.push({ name: patch.name, status: "ok" });
    } catch (err) {
      console.error(`FAIL: ${patch.name} — ${err.message}`);
      results.push({ name: patch.name, status: "fail", error: err.message });
    }
  }

  console.log("\nSummary:", JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
