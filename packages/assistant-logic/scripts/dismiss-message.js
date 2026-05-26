#!/usr/bin/env node
/**
 * Dismiss message chats from unread reports.
 *
 * Flags:
 *   --chat "Name" [--platform telegram]   dismiss by chat name (fuzzy match)
 *   --chat-id "123" [--platform telegram]  dismiss by exact chat ID
 *   --list                                          print current dismissals
 *   --undo --chat "Name"                            remove dismissal by name match
 *   --undo --chat-id "123"                          remove dismissal by chat ID
 *
 * Output: JSON to stdout, errors to stderr.
 */
const { listUnreadMessages } = require("./lib/message-service");
const { createDismissedMessagesStore } = require("./lib/message-state");
const { fuzzyScore } = require("./lib/fuzzy");

function loadData() {
  return createDismissedMessagesStore().load();
}

function saveData(data) {
  createDismissedMessagesStore().save(data);
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
    } else if (arg === "--chat" && argv[i + 1]) {
      args.chat = argv[++i];
      i++;
    } else if (arg === "--chat-id" && argv[i + 1]) {
      args.chatId = argv[++i];
      i++;
    } else if (arg === "--platform" && argv[i + 1]) {
      args.platform = argv[++i];
      i++;
    } else {
      i++;
    }
  }
  return args;
}

async function handleChat(args) {
  // Fetch current unread to fuzzy match against
  const unread = await listUnreadMessages({
    telegram: args.platform ? args.platform === "telegram" : true,
  });

  if (unread.length === 0) {
    console.error("No unread chats found to match against.");
    process.exit(1);
  }

  // Score each chat by name match
  const scored = unread.map((chat) => ({
    ...chat,
    score: fuzzyScore(args.chat, chat.chatName),
  }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  if (best.score === 0) {
    console.error(`No chat name match found for "${args.chat}".`);
    console.error("Available chats:");
    unread.slice(0, 10).forEach((c) =>
      console.error(`  - [${c.platform}] ${c.chatName}`)
    );
    process.exit(1);
  }

  const key = `${best.platform}:${best.chatId}`;
  const now = new Date().toISOString();

  const data = loadData();
  data.chats[key] = {
    chatName: best.chatName,
    platform: best.platform,
    dismissedAt: now,
  };
  saveData(data);

  const result = {
    action: "dismissed_chat",
    key,
    chatName: best.chatName,
    platform: best.platform,
    chatId: best.chatId,
    dismissedAt: now,
    matchScore: best.score,
  };
  console.log(JSON.stringify(result, null, 2));
}

function handleChatId(args) {
  const platform = args.platform || "telegram";
  const key = `${platform}:${args.chatId}`;
  const now = new Date().toISOString();

  const data = loadData();
  data.chats[key] = {
    chatName: data.chats[key]?.chatName || "(unknown)",
    platform,
    dismissedAt: now,
  };
  saveData(data);

  const result = {
    action: "dismissed_chat",
    key,
    chatId: args.chatId,
    platform,
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

  if (args.chatId) {
    // Find matching key(s) by chat ID
    const matchingKeys = Object.keys(data.chats).filter((k) =>
      k.endsWith(`:${args.chatId}`)
    );
    if (matchingKeys.length === 0) {
      console.error(`Chat ID ${args.chatId} not found in dismissals.`);
      process.exit(1);
    }
    const key = matchingKeys[0];
    const removed = data.chats[key];
    delete data.chats[key];
    saveData(data);
    console.log(JSON.stringify({ action: "undone_chat", key, was: removed }, null, 2));
  } else if (args.chat) {
    // Fuzzy match against dismissed chat names
    const entries = Object.entries(data.chats);
    if (entries.length === 0) {
      console.error("No dismissed chats to match against.");
      process.exit(1);
    }
    const scored = entries.map(([key, entry]) => ({
      key,
      entry,
      score: fuzzyScore(args.chat, entry.chatName),
    }));
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    if (best.score === 0) {
      console.error(`No chat name match found for "${args.chat}".`);
      console.error("Dismissed chats:");
      entries.slice(0, 10).forEach(([, e]) =>
        console.error(`  - [${e.platform}] ${e.chatName}`)
      );
      process.exit(1);
    }

    const removed = data.chats[best.key];
    delete data.chats[best.key];
    saveData(data);
    console.log(JSON.stringify({ action: "undone_chat", key: best.key, was: removed }, null, 2));
  } else {
    console.error("--undo requires --chat \"Name\" or --chat-id \"123\"");
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.list) {
    handleList();
  } else if (args.undo) {
    handleUndo(args);
  } else if (args.chat) {
    await handleChat(args);
  } else if (args.chatId) {
    handleChatId(args);
  } else {
    console.error(
      "Usage:\n" +
        '  --chat "Name" [--platform telegram]\n' +
        '  --chat-id "123" [--platform telegram]\n' +
        "  --list\n" +
        '  --undo --chat "Name"\n' +
        '  --undo --chat-id "123"'
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
