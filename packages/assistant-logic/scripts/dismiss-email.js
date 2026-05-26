#!/usr/bin/env node
/**
 * Dismiss emails from actionable reports.
 *
 * Flags:
 *   --thread <threadId> --account <email> [--note "reason"]  dismiss a thread
 *   --sender <email> [--note "reason"]                       dismiss all from sender permanently
 *   --subject "text" [--account <email>]                     fuzzy-match against actionable emails
 *   --list                                                   print current dismissals
 *   --undo --thread <threadId>                               remove thread dismissal
 *   --undo --sender <email>                                  remove sender dismissal
 *
 * Output: JSON to stdout, errors to stderr.
 */
const { loadComposioConfig } = require("./lib/config");
const { listActionableEmail } = require("./lib/email-service");
const { createDismissedEmailsStore } = require("./lib/email-state");
const { getAccessToken, googleFetch } = require("./lib/google-auth");
const { fuzzyScore } = require("./lib/fuzzy");

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";
const composio = loadComposioConfig();

// Reverse lookup: email -> ca_ ID
const LABEL_TO_ACCOUNT = Object.fromEntries(
  Object.entries(composio.ACCOUNT_LABELS).map(([key, value]) => [value, key])
);

function loadData() {
  return createDismissedEmailsStore().load();
}

function saveData(data) {
  createDismissedEmailsStore().save(data);
}

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--list") {
      args.list = true;
      i++;
    } else if (arg === "--undo") {
      args.undo = true;
      i++;
    } else if (arg === "--thread" && argv[i + 1]) {
      args.thread = argv[++i];
      i++;
    } else if (arg === "--sender" && argv[i + 1]) {
      args.sender = argv[++i];
      i++;
    } else if (arg === "--subject" && argv[i + 1]) {
      args.subject = argv[++i];
      i++;
    } else if (arg === "--account" && argv[i + 1]) {
      args.account = argv[++i];
      i++;
    } else if (arg === "--note" && argv[i + 1]) {
      args.note = argv[++i];
      i++;
    } else {
      i++;
    }
  }
  return args;
}

/** Fetch the latest message date in a thread via Gmail API. */
async function getThreadLatestDate(accountId, threadId) {
  const token = await getAccessToken(accountId, { composio });
  const thread = await googleFetch(
    token,
    `${GMAIL_BASE}/users/me/threads/${threadId}?format=metadata&metadataHeaders=Date&metadataHeaders=Subject`
  );
  const messages = thread.messages || [];
  let latestDate = null;
  let subject = null;
  for (const msg of messages) {
    const headers = {};
    (msg.payload?.headers || []).forEach((h) => {
      headers[h.name.toLowerCase()] = h.value;
    });
    if (!subject && headers.subject) subject = headers.subject;
    if (headers.date) {
      const d = new Date(headers.date);
      if (!latestDate || d > latestDate) latestDate = d;
    }
  }
  return { latestDate, subject };
}


async function handleSubject(args) {
  let emails = await listActionableEmail();

  if (args.account) {
    emails = emails.filter((email) => email.account === args.account);
  }

  if (emails.length === 0) {
    console.error("No actionable emails found to match against.");
    process.exit(1);
  }

  // Score each email by subject match
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

  // Dismiss the matched thread
  const data = loadData();
  const now = new Date().toISOString();
  data.threads[best.threadId] = {
    account: best.account,
    subject: best.subject,
    dismissedAt: now,
    ...(args.note ? { note: args.note } : {}),
  };
  saveData(data);

  const result = {
    action: "dismissed_thread",
    threadId: best.threadId,
    account: best.account,
    subject: best.subject,
    dismissedAt: now,
    matchScore: best.score,
  };
  console.log(JSON.stringify(result, null, 2));
}

async function handleThread(args) {
  if (!args.account) {
    console.error("--thread requires --account <email>");
    process.exit(1);
  }

  const accountId = LABEL_TO_ACCOUNT[args.account];
  if (!accountId) {
    console.error(
      `Unknown account: ${args.account}. Known: ${Object.values(composio.ACCOUNT_LABELS).join(", ")}`
    );
    process.exit(1);
  }

  // Fetch thread to get latest date and subject
  const { latestDate, subject } = await getThreadLatestDate(accountId, args.thread);
  const dismissedAt = latestDate ? latestDate.toISOString() : new Date().toISOString();

  const data = loadData();
  data.threads[args.thread] = {
    account: args.account,
    subject: subject || "(unknown)",
    dismissedAt,
    ...(args.note ? { note: args.note } : {}),
  };
  saveData(data);

  const result = {
    action: "dismissed_thread",
    threadId: args.thread,
    account: args.account,
    subject: subject || "(unknown)",
    dismissedAt,
  };
  console.log(JSON.stringify(result, null, 2));
}

async function handleSender(args) {
  const data = loadData();
  const now = new Date().toISOString();
  data.senders[args.sender] = {
    dismissedAt: now,
    ...(args.note ? { note: args.note } : {}),
  };
  saveData(data);

  const result = {
    action: "dismissed_sender",
    sender: args.sender,
    dismissedAt: now,
  };
  console.log(JSON.stringify(result, null, 2));
}

function handleList() {
  const data = loadData();
  console.log(JSON.stringify(data, null, 2));
}

function handleUndo(args) {
  const data = loadData();
  if (args.thread) {
    if (!data.threads[args.thread]) {
      console.error(`Thread ${args.thread} not found in dismissals.`);
      process.exit(1);
    }
    const removed = data.threads[args.thread];
    delete data.threads[args.thread];
    saveData(data);
    console.log(JSON.stringify({ action: "undone_thread", threadId: args.thread, was: removed }, null, 2));
  } else if (args.sender) {
    if (!data.senders[args.sender]) {
      console.error(`Sender ${args.sender} not found in dismissals.`);
      process.exit(1);
    }
    const removed = data.senders[args.sender];
    delete data.senders[args.sender];
    saveData(data);
    console.log(JSON.stringify({ action: "undone_sender", sender: args.sender, was: removed }, null, 2));
  } else {
    console.error("--undo requires --thread <id> or --sender <email>");
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.list) {
    handleList();
  } else if (args.undo) {
    handleUndo(args);
  } else if (args.subject) {
    await handleSubject(args);
  } else if (args.thread) {
    await handleThread(args);
  } else if (args.sender) {
    await handleSender(args);
  } else {
    console.error(
      "Usage:\n" +
        "  --thread <id> --account <email> [--note ...]\n" +
        "  --sender <email> [--note ...]\n" +
        "  --subject \"text\" [--account <email>] [--note ...]\n" +
        "  --list\n" +
        "  --undo --thread <id>\n" +
        "  --undo --sender <email>"
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
