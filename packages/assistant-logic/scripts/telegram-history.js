#!/usr/bin/env node
/**
 * Fetch message history from a specific Telegram chat.
 *
 * Usage:
 *   node scripts/telegram-history.js --chat "Name"              → newest 20 messages from exact match
 *   node scripts/telegram-history.js --chat-id "123456"         → by chat ID
 *   node scripts/telegram-history.js --chat "Name" --limit 50   → fetch 50 messages
 *   node scripts/telegram-history.js --chat "Name" --before 789 → pagination: messages older than ID 789
 *
 * Output: JSON object with messages (newest first) and pagination metadata.
 */
const { createTelegramClient } = require("./lib/telegram-client");

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = { chat: null, chatId: null, limit: 20, before: null };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--chat":
        if (!args[i + 1]) throw new Error("--chat requires a value");
        parsed.chat = args[++i];
        break;
      case "--chat-id":
        if (!args[i + 1]) throw new Error("--chat-id requires a value");
        parsed.chatId = args[++i];
        break;
      case "--limit":
        if (!args[i + 1]) throw new Error("--limit requires a value");
        parsed.limit = parseInt(args[++i], 10);
        if (isNaN(parsed.limit) || parsed.limit < 1) {
          throw new Error("--limit must be a positive integer");
        }
        if (parsed.limit > 100) parsed.limit = 100;
        break;
      case "--before":
      case "--offset":
        if (!args[i + 1]) throw new Error(`${args[i]} requires a message ID`);
        parsed.before = parseInt(args[++i], 10);
        if (isNaN(parsed.before)) {
          throw new Error("--before must be a valid message ID (integer)");
        }
        break;
      case "--help":
        console.log(
          "Usage: node scripts/telegram-history.js --chat <name> [--chat-id <id>] [--limit N] [--before <msgId>]"
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${args[i]}`);
    }
  }

  if (!parsed.chat && !parsed.chatId) {
    throw new Error("Either --chat or --chat-id is required");
  }

  return parsed;
}

async function main() {
  const opts = parseArgs(process.argv);
  const client = await createTelegramClient();

  try {
    // Find the target chat
    const dialogs = await client.getDialogs({ limit: 200 });
    let matched = null;

    if (opts.chatId) {
      // Exact ID match
      matched = dialogs.find((d) => String(d.id) === opts.chatId);
      if (!matched) {
        throw new Error(`No chat found with ID: ${opts.chatId}`);
      }
    } else {
      // Exact name match (case-insensitive)
      const filter = opts.chat.toLowerCase();
      const matches = dialogs.filter((d) => {
        const name = (d.title || d.name || "").toLowerCase();
        return name === filter;
      });

      if (matches.length === 0) {
        throw new Error(`No chat found matching: "${opts.chat}"`);
      }
      if (matches.length > 1) {
        const candidates = matches.map((d) => ({
          chatId: String(d.id),
          chatName: d.title || d.name || "Unknown",
        }));
        console.log(
          JSON.stringify(
            {
              error: "Multiple chats matched --chat value",
              matches: candidates,
            },
            null,
            2
          )
        );
        process.exit(1);
      }
      matched = matches[0];
    }

    const chatName = matched.title || matched.name || "Unknown";
    let chatType = "private";
    if (matched.isGroup) chatType = "group";
    else if (matched.isChannel) chatType = "channel";

    // Fetch messages — over-fetch by 1 to determine hasMore
    const fetchLimit = opts.limit + 1;
    const msgOpts = { limit: fetchLimit };
    if (opts.before) {
      msgOpts.offsetId = opts.before;
    }

    const raw = await client.getMessages(matched.id, msgOpts);

    const hasMore = raw.length > opts.limit;
    const messages = raw.slice(0, opts.limit);

    const formatted = messages.map((msg) => ({
      id: msg.id,
      from: msg.sender?.firstName
        ? `${msg.sender.firstName}${msg.sender.lastName ? " " + msg.sender.lastName : ""}`
        : msg.sender?.title || "Unknown",
      fromId: String(msg.senderId || ""),
      text: msg.text || "",
      date: new Date(msg.date * 1000).toISOString(),
      replyTo: msg.replyTo?.replyToMsgId || null,
      media: msg.media ? msg.media.className || "media" : null,
    }));

    const result = {
      platform: "telegram",
      chatId: String(matched.id),
      chatName,
      chatType,
      messages: formatted,
      pagination: {
        requestedLimit: opts.limit,
        returned: formatted.length,
        nextBefore: formatted.length > 0 ? formatted[formatted.length - 1].id : null,
        hasMore,
      },
    };

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
