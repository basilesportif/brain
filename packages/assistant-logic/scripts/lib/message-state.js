const { createStateStore } = require("./state-stores");

function createDismissedMessagesStore(options = {}) {
  return createStateStore("dismissedMessages", {
    ...options,
    defaultValue: () => ({ chats: {} }),
    onLoad(store) {
      const next = store && typeof store === "object" ? store : {};
      if (!next.chats || typeof next.chats !== "object") next.chats = {};
      return next;
    },
  });
}

function createUrgentMessagesStore(options = {}) {
  return createStateStore("urgentMessages", {
    ...options,
    defaultValue: () => ({ chats: {} }),
    onLoad(store) {
      const next = store && typeof store === "object" ? store : {};
      if (!next.chats || typeof next.chats !== "object") next.chats = {};
      return next;
    },
  });
}

function filterDismissedChats(chats, dismissals) {
  return chats.filter((chat) => {
    const key = `${chat.platform}:${chat.chatId}`;
    const dismissed = dismissals.chats[key];
    if (!dismissed) return true;

    const latestMessage =
      chat.messages && chat.messages.length > 0 ? chat.messages[chat.messages.length - 1] : null;
    if (!latestMessage) return false;

    return new Date(latestMessage.date) > new Date(dismissed.dismissedAt);
  });
}

module.exports = {
  createDismissedMessagesStore,
  createUrgentMessagesStore,
  filterDismissedChats,
};
