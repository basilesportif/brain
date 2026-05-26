#!/usr/bin/env node
const { listUnreadMessages } = require("./lib/message-service");

function parseArgs(argv) {
  const args = { telegram: false, limit: null };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--telegram") args.telegram = true;
    else if (/^\d+$/.test(argv[index])) args.limit = parseInt(argv[index], 10);
  }
  if (!args.telegram) args.telegram = true;
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const chats = await listUnreadMessages({
    telegram: args.telegram,
    limit: args.limit,
  });
  console.log(JSON.stringify(chats, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
