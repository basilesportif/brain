#!/usr/bin/env node
const { listUnreadTelegram } = require("./lib/telegram-service");

async function main() {
  const args = process.argv.slice(2);
  let limit = 50;
  let chatFilter = null;

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--chat" && args[index + 1]) {
      chatFilter = args[++index];
    } else if (/^\d+$/.test(args[index])) {
      limit = parseInt(args[index], 10);
    }
  }

  const results = await listUnreadTelegram({ limit, chatFilter });
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
