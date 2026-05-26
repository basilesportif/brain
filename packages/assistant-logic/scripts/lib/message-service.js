const { listUnreadTelegram } = require("./telegram-service");
const { createDismissedMessagesStore, filterDismissedChats } = require("./message-state");

async function listUnreadMessages(options = {}) {
  const includeTelegram = options.telegram !== false;
  const limit = options.limit || null;
  let results = [];

  if (includeTelegram) {
    results = results.concat(
      await listUnreadTelegram({
        ...options,
        limit: limit || 50,
      })
    );
  }

  const dismissed = createDismissedMessagesStore(options).load();
  const filtered = filterDismissedChats(results, dismissed);
  filtered.sort((left, right) => {
    const leftDate =
      left.messages && left.messages.length > 0 ? left.messages[left.messages.length - 1].date : "";
    const rightDate =
      right.messages && right.messages.length > 0
        ? right.messages[right.messages.length - 1].date
        : "";
    return rightDate.localeCompare(leftDate);
  });
  return filtered;
}

module.exports = {
  listUnreadMessages,
};
