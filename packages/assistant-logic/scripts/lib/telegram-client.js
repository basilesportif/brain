const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { loadMessagingConfig } = require("./messaging-config");

async function createTelegramClient(options = {}) {
  const messaging = options.messaging || loadMessagingConfig(options);
  const { api_id, api_hash, session } = messaging.TELEGRAM_USER;

  if (!api_id || !api_hash) {
    throw new Error(
      `Telegram API credentials not configured. Set api_id and api_hash in ${messaging.messagingPath}\n` +
      "Get them from https://my.telegram.org → API development tools"
    );
  }

  if (!session) {
    throw new Error(
      "Telegram session not found. Run: node scripts/telegram-login.js"
    );
  }

  const client = new TelegramClient(
    new StringSession(session),
    Number(api_id),
    api_hash,
    { connectionRetries: 5 }
  );

  await client.connect();
  return client;
}

module.exports = { createTelegramClient };
