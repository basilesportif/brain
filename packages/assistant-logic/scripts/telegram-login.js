#!/usr/bin/env node
/**
 * Interactive Telegram login — run once to authenticate.
 *
 * Prerequisites:
 *   1. Get API credentials from https://my.telegram.org → API development tools
 *   2. Set api_id and api_hash in workspace/messaging.yaml
 *
 * Usage:
 *   node scripts/telegram-login.js
 *
 * After successful login, the session string is saved to workspace/messaging.yaml.
 */
const fs = require("fs");
const yaml = require("yaml");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");
const { loadMessagingConfig } = require("./lib/messaging-config");

async function main() {
  const messaging = loadMessagingConfig();
  const { TELEGRAM_USER, messagingPath, messagingConfig } = messaging;
  const { api_id, api_hash } = TELEGRAM_USER;

  if (!api_id || !api_hash) {
    console.error("Error: Telegram API credentials not configured.");
    console.error("1. Go to https://my.telegram.org → API development tools");
    console.error("2. Create an app to get api_id and api_hash");
    console.error("3. Set them in workspace/messaging.yaml");
    process.exit(1);
  }

  const client = new TelegramClient(
    new StringSession(""),
    Number(api_id),
    api_hash,
    { connectionRetries: 5 }
  );

  await client.start({
    phoneNumber: async () => await input.text("Phone number (with country code): "),
    phoneCode: async () => await input.text("Enter the code you received: "),
    password: async () => await input.text("2FA password (if enabled): "),
    onError: (err) => console.error("Login error:", err.message),
  });

  const sessionString = client.session.save();

  // Save session back to messaging.yaml
  const config = { ...messagingConfig };
  if (!config.telegram) config.telegram = {};
  config.telegram.session = sessionString;

  fs.writeFileSync(messagingPath, yaml.stringify(config), "utf-8");

  await client.disconnect();

  console.log(JSON.stringify({
    status: "ok",
    message: "Telegram login successful. Session saved to workspace/messaging.yaml.",
    sessionLength: sessionString.length,
  }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
