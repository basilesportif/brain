#!/usr/bin/env node
/**
 * One-off script: PATCH a Google Calendar event with new details via Composio proxy.
 * Usage: node scripts/update-calendar-event.js
 */
const { loadComposioConfig, requireGoogleCalendarAccount } = require("./lib/config");
const { getAccessToken, googleFetch } = require("./lib/google-auth");

const GCAL_BASE = "https://www.googleapis.com/calendar/v3";

const EVENT_ID = "80am25tfio0k4bkj1361d6855o";
const CALENDAR_ID = "primary";

const PATCH_BODY = {
  summary: "Knicks vs Hawks - Game 5 Watch Party",
  location: "1 West End, 6th Floor Lounge",
  description:
    "Knicks vs Hawks Game 5 Watch Party. 7:00 PM tip-off. Hosted by Empire National Title Agency & Wexler & Kaufman PLLC.",
};

async function main() {
  const composio = loadComposioConfig();
  const accountId = requireGoogleCalendarAccount(composio);
  const client = await getAccessToken(accountId, { composio });

  const url = `${GCAL_BASE}/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(EVENT_ID)}`;

  console.log(`PATCHing event ${EVENT_ID} on calendar "${CALENDAR_ID}" ...`);
  const updated = await googleFetch(client, url, {
    method: "PATCH",
    body: JSON.stringify(PATCH_BODY),
  });

  console.log("Success! Updated event:");
  console.log(JSON.stringify(updated, null, 2));
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
