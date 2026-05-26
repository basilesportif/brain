const { createTelegramClient } = require("./telegram-client");

async function listUnreadTelegram(options = {}) {
  const limit = options.limit || 50;
  const chatFilter = options.chatFilter ? String(options.chatFilter).toLowerCase() : null;
  const client = await createTelegramClient(options);

  try {
    const dialogs = await client.getDialogs({ limit });
    const results = [];

    for (const dialog of dialogs) {
      if (dialog.unreadCount === 0) continue;

      const chatName = dialog.title || dialog.name || "Unknown";
      if (chatFilter && !chatName.toLowerCase().includes(chatFilter)) continue;

      let chatType = "private";
      if (dialog.isGroup) chatType = "group";
      else if (dialog.isChannel) chatType = "channel";

      const messageLimit = Math.min(dialog.unreadCount, 20);
      const messages = await client.getMessages(dialog.id, { limit: messageLimit });

      results.push({
        platform: "telegram",
        chatId: String(dialog.id),
        chatName,
        chatType,
        unreadCount: dialog.unreadCount,
        messages: messages.map((message) => ({
          id: message.id,
          from: message.sender?.firstName
            ? `${message.sender.firstName}${message.sender.lastName ? ` ${message.sender.lastName}` : ""}`
            : message.sender?.title || "Unknown",
          fromId: String(message.senderId || ""),
          text: message.text || "",
          date: new Date(message.date * 1000).toISOString(),
          replyTo: message.replyTo?.replyToMsgId || null,
          media: message.media ? message.media.className || "media" : null,
        })),
      });
    }

    results.sort((left, right) => {
      const leftDate = left.messages[0]?.date || "";
      const rightDate = right.messages[0]?.date || "";
      return rightDate.localeCompare(leftDate);
    });

    return results;
  } finally {
    await client.disconnect();
  }
}

module.exports = {
  listUnreadTelegram,
};
