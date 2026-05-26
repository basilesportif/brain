#!/usr/bin/env node
/**
 * Manage urgent message reminders.
 *
 * Flags:
 *   --chat "Name" [--platform telegram] [--note "..."]  fuzzy-match unread chats, add to urgent
 *   --chat-id "123" --platform telegram [--note "..."]  add by exact chat ID
 *   --resolve --chat "Name"                             resolve by chat name (matches urgent list)
 *   --resolve --chat-id "123"                           resolve by chat ID
 *   --snooze --chat "Name" <duration>                   snooze by chat name
 *   --snooze --chat-id "123" <duration>                 snooze by chat ID
 *   --note --chat "Name" "new note"                     update note by chat name
 *   --note --chat-id "123" "new note"                   update note by chat ID
 *   --list                                              print all urgent entries
 *
 * Output: JSON to stdout, errors to stderr.
 */
const { createDismissedMessagesStore, createUrgentMessagesStore } = require("./lib/message-state");
const { listUnreadMessages } = require("./lib/message-service");
const { fuzzyScore } = require("./lib/fuzzy");

function loadData() {
  return createUrgentMessagesStore().load();
}

function saveData(data) {
  createUrgentMessagesStore().save(data);
}

function loadDismissed() {
  return createDismissedMessagesStore().load();
}

function saveDismissed(data) {
  createDismissedMessagesStore().save(data);
}

function parseArgs(argv) {
  const args = { positional: [], platform: "telegram" };
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
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        args.note = argv[++i];
      } else {
        args.noteMode = true;
      }
      i++;
    } else if (arg === "--chat" && argv[i + 1]) {
      args.chat = argv[++i];
      i++;
    } else if (arg === "--chat-id" && argv[i + 1]) {
      args.chatId = argv[++i];
      i++;
    } else if (arg === "--platform" && argv[i + 1]) {
      args.platform = argv[++i];
      i++;
    } else if (arg === "--message-id" && argv[i + 1]) {
      args.messageId = argv[++i];
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

  const hourMatch = duration.match(/^(\d+)h$/i);
  if (hourMatch) {
    const d = new Date(now.getTime() + parseInt(hourMatch[1], 10) * 60 * 60 * 1000);
    return d.toISOString();
  }

  if (duration.toLowerCase() === "tomorrow") {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  }

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

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(duration)) {
    return new Date(duration).toISOString();
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(duration)) {
    const d = new Date(duration + "T09:00:00");
    return d.toISOString();
  }

  console.error(`Cannot parse snooze duration: "${duration}". Use: 2h, tomorrow, monday, 2026-03-25, 2026-03-25T14:00`);
  process.exit(1);
}

function makeKey(platform, chatId) {
  return `${platform}:${chatId}`;
}

async function handleChat(args) {
  if (args.platform !== "telegram") {
    console.error(`Unknown platform "${args.platform}". Supported: telegram`);
    process.exit(1);
  }

  const chats = await listUnreadMessages({ telegram: true });

  if (chats.length === 0) {
    console.error("No unread chats found to match against.");
    process.exit(1);
  }

  const scored = chats.map((c) => ({
    ...c,
    score: fuzzyScore(args.chat, c.chatName),
  }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  if (best.score === 0) {
    console.error(`No chat match found for "${args.chat}".`);
    console.error("Available chats:");
    chats.slice(0, 10).forEach((c) => console.error(`  - ${c.chatName}`));
    process.exit(1);
  }

  const key = makeKey(args.platform, best.chatId);
  const data = loadData();
  const now = new Date().toISOString();
  const existing = data.chats[key];

  // Get message preview from most recent message
  const latestMsg = best.messages && best.messages.length > 0 ? best.messages[0] : null;
  const messagePreview = latestMsg
    ? (latestMsg.text || "").slice(0, 120)
    : null;

  const note = args.note || (existing ? existing.note : null);
  data.chats[key] = {
    platform: args.platform,
    chatId: best.chatId,
    chatName: best.chatName,
    messagePreview,
    note,
    createdAt: existing ? existing.createdAt : now,
    remindCount: existing ? existing.remindCount : 0,
    lastRemindedAt: existing ? existing.lastRemindedAt : null,
    snoozeUntil: existing ? existing.snoozeUntil : null,
  };
  saveData(data);

  const result = {
    action: "added_urgent",
    key,
    platform: args.platform,
    chatId: best.chatId,
    chatName: best.chatName,
    matchScore: best.score,
  };
  if (messagePreview) result.messagePreview = messagePreview;
  if (note) result.note = note;
  console.log(JSON.stringify(result, null, 2));
}

async function handleChatId(args) {
  const key = makeKey(args.platform, args.chatId);
  const data = loadData();
  const now = new Date().toISOString();
  const existing = data.chats[key];

  const note = args.note || (existing ? existing.note : null);
  data.chats[key] = {
    platform: args.platform,
    chatId: args.chatId,
    chatName: existing ? existing.chatName : args.chatId,
    messagePreview: existing ? existing.messagePreview : null,
    note,
    createdAt: existing ? existing.createdAt : now,
    remindCount: existing ? existing.remindCount : 0,
    lastRemindedAt: existing ? existing.lastRemindedAt : null,
    snoozeUntil: existing ? existing.snoozeUntil : null,
  };
  saveData(data);

  const result = {
    action: "added_urgent",
    key,
    platform: args.platform,
    chatId: args.chatId,
    chatName: data.chats[key].chatName,
  };
  if (note) result.note = note;
  console.log(JSON.stringify(result, null, 2));
}

/** Find entry by --chat (fuzzy against urgent list) or --chat-id. */
function findEntry(args, data, action) {
  if (args.chatId) {
    // Try with platform prefix first, then scan all entries
    const key = makeKey(args.platform, args.chatId);
    const entry = data.chats[key];
    if (!entry) {
      // Try matching just the chatId across platforms
      const found = Object.entries(data.chats).find(([, e]) => e.chatId === args.chatId);
      if (found) return { key: found[0], entry: found[1] };
      console.error(`Chat ID ${args.chatId} not found in urgent list.`);
      process.exit(1);
    }
    return { key, entry };
  }

  if (args.chat) {
    const entries = Object.entries(data.chats);
    if (entries.length === 0) {
      console.error(`Urgent list is empty, nothing to ${action}.`);
      process.exit(1);
    }
    const scored = entries.map(([k, e]) => ({
      key: k,
      entry: e,
      score: fuzzyScore(args.chat, e.chatName),
    }));
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (best.score === 0) {
      console.error(`No chat match found for "${args.chat}" in urgent list.`);
      console.error("Urgent chats:");
      entries.slice(0, 10).forEach(([, e]) => console.error(`  - ${e.chatName}`));
      process.exit(1);
    }
    return { key: best.key, entry: best.entry };
  }

  console.error(`--${action} requires --chat "Name" or --chat-id "123"`);
  process.exit(1);
}

async function handleResolve(args) {
  const data = loadData();
  const { key, entry } = findEntry(args, data, "resolve");

  // Remove from urgent list
  delete data.chats[key];
  saveData(data);

  // Auto-dismiss from unread reports
  const dismissed = loadDismissed();
  dismissed.chats[key] = {
    chatName: entry.chatName,
    platform: entry.platform,
    dismissedAt: new Date().toISOString(),
    note: "resolved from urgent list",
  };
  saveDismissed(dismissed);

  const result = {
    action: "resolved_urgent",
    key,
    platform: entry.platform,
    chatId: entry.chatId,
    chatName: entry.chatName,
  };
  console.log(JSON.stringify(result, null, 2));
}

async function handleSnooze(args) {
  const data = loadData();
  const { key, entry } = findEntry(args, data, "snooze");

  const duration = args.positional[0];
  if (!duration) {
    console.error("--snooze requires a duration: 2h, tomorrow, monday, 2026-03-25, 2026-03-25T14:00");
    process.exit(1);
  }

  const snoozeUntil = parseSnoozeUntil(duration);
  data.chats[key].snoozeUntil = snoozeUntil;
  saveData(data);

  const result = {
    action: "snoozed_urgent",
    key,
    platform: entry.platform,
    chatName: entry.chatName,
    snoozeUntil,
  };
  console.log(JSON.stringify(result, null, 2));
}

async function handleNote(args) {
  const data = loadData();
  const { key, entry } = findEntry(args, data, "note");

  const note = args.positional[0] || args.note;
  if (!note) {
    console.error("--note requires a note string");
    process.exit(1);
  }

  data.chats[key].note = note;
  saveData(data);

  const result = {
    action: "updated_note",
    key,
    chatName: entry.chatName,
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
  } else if (args.chat) {
    await handleChat(args);
  } else if (args.chatId) {
    await handleChatId(args);
  } else {
    console.error(
      "Usage:\n" +
        '  --chat "Name" [--platform telegram] [--note "..."]  add by chat name match\n' +
        '  --chat-id "123" --platform telegram [--note "..."]  add by exact chat ID\n' +
        '  --resolve --chat "Name"                             resolve by chat name\n' +
        "  --resolve --chat-id \"123\"                           resolve by chat ID\n" +
        '  --snooze --chat "Name" <duration>                   snooze by chat name\n' +
        "  --snooze --chat-id \"123\" <duration>                 snooze by chat ID\n" +
        '  --note --chat "Name" "new note"                     update note\n' +
        "  --note --chat-id \"123\" \"new note\"                   update note by ID\n" +
        "  --list                                              list all urgent entries"
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
