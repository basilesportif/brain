#!/usr/bin/env node
/**
 * Manage the calendar invite allowlist.
 *
 * Flags:
 *   --add email@example.com       add email to allowlist
 *   --add-domain company.com      add domain wildcard
 *   --remove email@example.com    remove email from allowlist
 *   --remove-domain company.com   remove domain from allowlist
 *   --list                        show current allowlist
 *   --enable                      enable invite checking
 *   --disable                     disable invite checking
 *   --status                      show enabled/disabled state
 *   --approve EVENT_ID --calendar-id CAL_ID   accept a declined invite and add sender to allowlist
 *
 * Output: JSON to stdout, errors to stderr.
 */
const {
  loadComposioConfig,
  requireGoogleCalendarAccount,
} = require("./lib/config");
const {
  createCalendarAllowlistStore,
  createSeenInvitesStore,
} = require("./lib/calendar-allowlist-store");
const { getAccessToken, googleFetch } = require("./lib/google-auth");

const GCAL_BASE = "https://www.googleapis.com/calendar/v3";
const composio = loadComposioConfig();
const OWN_EMAILS = new Set(Object.values(composio.ACCOUNT_LABELS).map((email) => email.toLowerCase()));

function loadAllowlist() {
  return createCalendarAllowlistStore().load();
}

function saveAllowlist(data) {
  data.updatedAt = new Date().toISOString();
  createCalendarAllowlistStore().save(data);
}

function loadSeen() {
  return createSeenInvitesStore().load();
}

function saveSeen(data) {
  data.updatedAt = new Date().toISOString();
  createSeenInvitesStore().save(data);
}

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--list") {
      args.list = true;
      i++;
    } else if (arg === "--enable") {
      args.enable = true;
      i++;
    } else if (arg === "--disable") {
      args.disable = true;
      i++;
    } else if (arg === "--status") {
      args.status = true;
      i++;
    } else if (arg === "--add" && argv[i + 1]) {
      args.add = argv[++i];
      i++;
    } else if (arg === "--add-domain" && argv[i + 1]) {
      args.addDomain = argv[++i];
      i++;
    } else if (arg === "--remove" && argv[i + 1]) {
      args.remove = argv[++i];
      i++;
    } else if (arg === "--remove-domain" && argv[i + 1]) {
      args.removeDomain = argv[++i];
      i++;
    } else if (arg === "--approve" && argv[i + 1]) {
      args.approve = argv[++i];
      i++;
    } else if (arg === "--calendar-id" && argv[i + 1]) {
      args.calendarId = argv[++i];
      i++;
    } else {
      i++;
    }
  }
  return args;
}

function handleAdd(email) {
  const data = loadAllowlist();
  const lower = email.toLowerCase();
  if (data.emails.some((e) => e.toLowerCase() === lower)) {
    console.log(JSON.stringify({ action: "already_exists", email: lower }, null, 2));
    return;
  }
  data.emails.push(lower);
  saveAllowlist(data);
  console.log(JSON.stringify({ action: "added_email", email: lower, allowlist: data }, null, 2));
}

function handleAddDomain(domain) {
  const data = loadAllowlist();
  const lower = domain.toLowerCase();
  if (data.domains.some((d) => d.toLowerCase() === lower)) {
    console.log(JSON.stringify({ action: "already_exists", domain: lower }, null, 2));
    return;
  }
  data.domains.push(lower);
  saveAllowlist(data);
  console.log(JSON.stringify({ action: "added_domain", domain: lower, allowlist: data }, null, 2));
}

function handleRemove(email) {
  const data = loadAllowlist();
  const lower = email.toLowerCase();
  const idx = data.emails.findIndex((e) => e.toLowerCase() === lower);
  if (idx === -1) {
    console.error(`Email "${email}" not found in allowlist.`);
    process.exit(1);
  }
  data.emails.splice(idx, 1);
  saveAllowlist(data);
  console.log(JSON.stringify({ action: "removed_email", email: lower, allowlist: data }, null, 2));
}

function handleRemoveDomain(domain) {
  const data = loadAllowlist();
  const lower = domain.toLowerCase();
  const idx = data.domains.findIndex((d) => d.toLowerCase() === lower);
  if (idx === -1) {
    console.error(`Domain "${domain}" not found in allowlist.`);
    process.exit(1);
  }
  data.domains.splice(idx, 1);
  saveAllowlist(data);
  console.log(JSON.stringify({ action: "removed_domain", domain: lower, allowlist: data }, null, 2));
}

function handleList() {
  const data = loadAllowlist();
  console.log(JSON.stringify(data, null, 2));
}

function handleEnable() {
  const data = loadAllowlist();
  data.enabled = true;
  saveAllowlist(data);
  console.log(JSON.stringify({ action: "enabled", enabled: true }, null, 2));
}

function handleDisable() {
  const data = loadAllowlist();
  data.enabled = false;
  saveAllowlist(data);
  console.log(JSON.stringify({ action: "disabled", enabled: false }, null, 2));
}

function handleStatus() {
  const data = loadAllowlist();
  console.log(JSON.stringify({ enabled: !!data.enabled }, null, 2));
}

/**
 * Accept a previously declined invite and add its sender to the allowlist.
 */
async function handleApprove(eventId, calendarId) {
  if (!calendarId) {
    console.error("--approve requires --calendar-id <calendarId>");
    process.exit(1);
  }

  const token = await getAccessToken(requireGoogleCalendarAccount(composio), { composio });
  const calEmail =
    composio.ACCOUNT_LABELS[requireGoogleCalendarAccount(composio)] ||
    Array.from(OWN_EMAILS)[0] ||
    "";

  // Fetch the event
  const url = `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  const event = await googleFetch(token, url);

  // Accept the invite
  const attendees = (event.attendees || []).map((a) => {
    if (a.email && a.email.toLowerCase() === calEmail.toLowerCase()) {
      return { ...a, responseStatus: "accepted" };
    }
    return a;
  });

  await googleFetch(token, url, {
    method: "PATCH",
    body: JSON.stringify({ attendees }),
  });

  // Add sender to allowlist
  const senderEmail =
    (event.organizer && event.organizer.email) ||
    (event.creator && event.creator.email) ||
    null;

  const allowlist = loadAllowlist();
  if (senderEmail) {
    const lower = senderEmail.toLowerCase();
    if (!allowlist.emails.some((e) => e.toLowerCase() === lower)) {
      allowlist.emails.push(lower);
      saveAllowlist(allowlist);
    }
  }

  // Update seen-invites to reflect acceptance
  const seen = loadSeen();
  const eventKey = `${calendarId}:${eventId}`;
  seen.seenIds[eventKey] = { action: "approved", at: new Date().toISOString() };
  saveSeen(seen);

  const result = {
    action: "approved_invite",
    eventId,
    calendarId,
    summary: event.summary || "(no title)",
    sender: senderEmail,
    addedToAllowlist: !!senderEmail,
  };
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.enable) {
    handleEnable();
  } else if (args.disable) {
    handleDisable();
  } else if (args.status) {
    handleStatus();
  } else if (args.list) {
    handleList();
  } else if (args.add) {
    handleAdd(args.add);
  } else if (args.addDomain) {
    handleAddDomain(args.addDomain);
  } else if (args.remove) {
    handleRemove(args.remove);
  } else if (args.removeDomain) {
    handleRemoveDomain(args.removeDomain);
  } else if (args.approve) {
    await handleApprove(args.approve, args.calendarId);
  } else {
    console.error(
      "Usage:\n" +
        "  --add email@example.com       add email to allowlist\n" +
        "  --add-domain company.com      add domain wildcard\n" +
        "  --remove email@example.com    remove email\n" +
        "  --remove-domain company.com   remove domain\n" +
        "  --list                        show current allowlist\n" +
        "  --enable                      enable invite checking\n" +
        "  --disable                     disable invite checking\n" +
        "  --status                      show enabled/disabled state\n" +
        "  --approve EVENT_ID --calendar-id CAL_ID   accept + trust sender"
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
