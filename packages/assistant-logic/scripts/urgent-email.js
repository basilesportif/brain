#!/usr/bin/env node
/**
 * Manage urgent email reminders.
 *
 * Flags:
 *   --subject "text" [--account <email>] [--note "..."]  fuzzy-match actionable emails, add to urgent list
 *   --thread <id> --account <email> [--note "..."]       add by thread ID directly
 *   --resolve --subject "text"                           resolve by subject fuzzy-match
 *   --resolve --thread <id>                              resolve by thread ID
 *   --snooze --thread <id> <duration>                    snooze a thread
 *   --snooze --subject "text" <duration>                 snooze by subject match
 *   --note --thread <id> "new note"                      update note on existing entry
 *   --list                                               print all urgent entries
 *
 * Output: JSON to stdout, errors to stderr.
 */
const { loadComposioConfig } = require("./lib/config");
const { listActionableEmail } = require("./lib/email-service");
const { createDismissedEmailsStore, createUrgentEmailsStore } = require("./lib/email-state");
const { getAccessToken, googleFetch } = require("./lib/google-auth");
const { fuzzyScore } = require("./lib/fuzzy");

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";
const composio = loadComposioConfig();

const LABEL_TO_ACCOUNT = Object.fromEntries(
  Object.entries(composio.ACCOUNT_LABELS).map(([key, value]) => [value, key])
);

function loadData() {
  return createUrgentEmailsStore().load();
}

function saveData(data) {
  createUrgentEmailsStore().save(data);
}

function loadDismissed() {
  return createDismissedEmailsStore().load();
}

function saveDismissed(data) {
  createDismissedEmailsStore().save(data);
}

function parseArgs(argv) {
  const args = { positional: [] };
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--list") {
      args.list = true;
      i++;
    } else if (arg === "--resolve") {
      args.resolve = true;
      i++;
    } else if (arg === "--snooze") {
      args.snooze = true;
      i++;
    } else if (arg === "--note") {
      // If next arg exists and is not a flag, treat as --note <value>
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        args.note = argv[++i];
      } else {
        // Mode flag: --note --thread <id> "text"
        args.noteMode = true;
      }
      i++;
    } else if (arg === "--thread" && argv[i + 1]) {
      args.thread = argv[++i];
      i++;
    } else if (arg === "--subject" && argv[i + 1]) {
      args.subject = argv[++i];
      i++;
    } else if (arg === "--account" && argv[i + 1]) {
      args.account = argv[++i];
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

  console.error(`Cannot parse snooze duration: "${duration}". Use: 2h, tomorrow, monday, 2026-03-25, 2026-03-25T14:00`);
  process.exit(1);
}

/** Fetch thread metadata via Gmail API. */
async function getThreadInfo(accountId, threadId) {
  try {
    const token = await getAccessToken(accountId, { composio });
    const thread = await googleFetch(
      token,
      `${GMAIL_BASE}/users/me/threads/${threadId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`
    );
    const messages = thread.messages || [];
    let subject = null;
    let from = null;
    for (const msg of messages) {
      const headers = {};
      (msg.payload?.headers || []).forEach((h) => {
        headers[h.name.toLowerCase()] = h.value;
      });
      if (!subject && headers.subject) subject = headers.subject;
      if (!from && headers.from) from = headers.from;
    }
    return { subject: subject || "unknown", from: from || "unknown" };
  } catch {
    return { subject: "unknown", from: "unknown" };
  }
}

async function getActionableEmails(account) {
  let emails = await listActionableEmail();
  if (account) {
    emails = emails.filter((email) => email.account === account);
  }
  return emails;
}

async function handleSubject(args) {
  const emails = await getActionableEmails(args.account);

  if (emails.length === 0) {
    console.error("No actionable emails found to match against.");
    process.exit(1);
  }

  const scored = emails.map((e) => ({
    ...e,
    score: fuzzyScore(args.subject, e.subject),
  }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  if (best.score === 0) {
    console.error(`No subject match found for "${args.subject}".`);
    console.error("Available subjects:");
    emails.slice(0, 10).forEach((e) => console.error(`  - ${e.subject}`));
    process.exit(1);
  }

  const data = loadData();
  const now = new Date().toISOString();
  const existing = data.threads[best.threadId];

  // Extract sender email from "Name <email>" format
  const fromMatch = (best.from || "").match(/<([^>]+)>/);
  const fromEmail = fromMatch ? fromMatch[1] : best.from || "unknown";

  const note = args.note || (existing ? existing.note : null);
  data.threads[best.threadId] = {
    account: best.account,
    subject: best.subject,
    from: fromEmail,
    note,
    addedAt: existing ? existing.addedAt : now,
    remindCount: existing ? existing.remindCount : 0,
    lastRemindedAt: existing ? existing.lastRemindedAt : null,
    snoozeUntil: existing ? existing.snoozeUntil : null,
  };
  saveData(data);

  const result = {
    action: "added_urgent",
    threadId: best.threadId,
    account: best.account,
    subject: best.subject,
    from: fromEmail,
    addedAt: data.threads[best.threadId].addedAt,
    matchScore: best.score,
  };
  if (note) result.note = note;
  console.log(JSON.stringify(result, null, 2));
}

async function handleThread(args) {
  if (!args.account) {
    console.error("--thread requires --account <email>");
    process.exit(1);
  }

  const accountId = LABEL_TO_ACCOUNT[args.account];
  let subject = "unknown";
  let from = "unknown";

  if (accountId) {
    const info = await getThreadInfo(accountId, args.thread);
    subject = info.subject;
    from = info.from;
  }

  const data = loadData();
  const now = new Date().toISOString();
  const existing = data.threads[args.thread];

  const note = args.note || (existing ? existing.note : null);
  data.threads[args.thread] = {
    account: args.account,
    subject,
    from,
    note,
    addedAt: existing ? existing.addedAt : now,
    remindCount: existing ? existing.remindCount : 0,
    lastRemindedAt: existing ? existing.lastRemindedAt : null,
    snoozeUntil: existing ? existing.snoozeUntil : null,
  };
  saveData(data);

  const result = {
    action: "added_urgent",
    threadId: args.thread,
    account: args.account,
    subject,
    from,
    addedAt: data.threads[args.thread].addedAt,
  };
  console.log(JSON.stringify(result, null, 2));
}

async function handleResolve(args) {
  const data = loadData();
  let threadId;
  let entry;

  if (args.thread) {
    threadId = args.thread;
    entry = data.threads[threadId];
    if (!entry) {
      console.error(`Thread ${threadId} not found in urgent list.`);
      process.exit(1);
    }
  } else if (args.subject) {
    const entries = Object.entries(data.threads);
    if (entries.length === 0) {
      console.error("Urgent list is empty, nothing to resolve.");
      process.exit(1);
    }
    const scored = entries.map(([id, e]) => ({
      id,
      entry: e,
      score: fuzzyScore(args.subject, e.subject),
    }));
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (best.score === 0) {
      console.error(`No subject match found for "${args.subject}" in urgent list.`);
      console.error("Urgent subjects:");
      entries.slice(0, 10).forEach(([, e]) => console.error(`  - ${e.subject}`));
      process.exit(1);
    }
    threadId = best.id;
    entry = best.entry;
  } else {
    console.error("--resolve requires --thread <id> or --subject \"text\"");
    process.exit(1);
  }

  // Remove from urgent list
  delete data.threads[threadId];
  saveData(data);

  // Add to dismissed list
  const dismissed = loadDismissed();
  dismissed.threads[threadId] = {
    account: entry.account,
    subject: entry.subject,
    dismissedAt: new Date().toISOString(),
    note: "resolved from urgent list",
  };
  saveDismissed(dismissed);

  const result = {
    action: "resolved_urgent",
    threadId,
    account: entry.account,
    subject: entry.subject,
  };
  console.log(JSON.stringify(result, null, 2));
}

async function handleSnooze(args) {
  const data = loadData();
  let threadId;
  let entry;

  if (args.thread) {
    threadId = args.thread;
    entry = data.threads[threadId];
    if (!entry) {
      console.error(`Thread ${threadId} not found in urgent list.`);
      process.exit(1);
    }
  } else if (args.subject) {
    const entries = Object.entries(data.threads);
    if (entries.length === 0) {
      console.error("Urgent list is empty, nothing to snooze.");
      process.exit(1);
    }
    const scored = entries.map(([id, e]) => ({
      id,
      entry: e,
      score: fuzzyScore(args.subject, e.subject),
    }));
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (best.score === 0) {
      console.error(`No subject match found for "${args.subject}" in urgent list.`);
      process.exit(1);
    }
    threadId = best.id;
    entry = best.entry;
  } else {
    console.error("--snooze requires --thread <id> or --subject \"text\"");
    process.exit(1);
  }

  const duration = args.positional[0];
  if (!duration) {
    console.error("--snooze requires a duration: 2h, tomorrow, monday, 2026-03-25, 2026-03-25T14:00");
    process.exit(1);
  }

  const snoozeUntil = parseSnoozeUntil(duration);
  data.threads[threadId].snoozeUntil = snoozeUntil;
  saveData(data);

  const result = {
    action: "snoozed_urgent",
    threadId,
    account: entry.account,
    subject: entry.subject,
    snoozeUntil,
  };
  console.log(JSON.stringify(result, null, 2));
}

async function handleNote(args) {
  if (!args.thread) {
    console.error("--note requires --thread <id>");
    process.exit(1);
  }

  const note = args.positional[0] || args.note;
  if (!note) {
    console.error("--note requires a note string");
    process.exit(1);
  }

  const data = loadData();
  const entry = data.threads[args.thread];
  if (!entry) {
    console.error(`Thread ${args.thread} not found in urgent list.`);
    process.exit(1);
  }

  entry.note = note;
  saveData(data);

  const result = {
    action: "updated_note",
    threadId: args.thread,
    subject: entry.subject,
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
  } else if (args.resolve) {
    await handleResolve(args);
  } else if (args.snooze) {
    await handleSnooze(args);
  } else if (args.noteMode) {
    await handleNote(args);
  } else if (args.subject) {
    await handleSubject(args);
  } else if (args.thread) {
    await handleThread(args);
  } else {
    console.error(
      "Usage:\n" +
        "  --subject \"text\" [--account <email>] [--note \"...\"]  add by subject match\n" +
        "  --thread <id> --account <email> [--note \"...\"]       add by thread ID\n" +
        "  --resolve --subject \"text\"                           resolve by subject\n" +
        "  --resolve --thread <id>                              resolve by thread ID\n" +
        "  --snooze --thread <id> <duration>                    snooze a thread\n" +
        "  --snooze --subject \"text\" <duration>                 snooze by subject\n" +
        "  --note --thread <id> \"new note\"                      update note\n" +
        "  --list                                               list all urgent entries"
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
