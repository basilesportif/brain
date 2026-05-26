#!/usr/bin/env node
const { listActionableGmail } = require("./lib/gmail-service");

async function main() {
  const maxResults = parseInt(process.argv[2] || "10", 10);
  const messages = await listActionableGmail({ maxResults });
  console.log(JSON.stringify(messages, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
