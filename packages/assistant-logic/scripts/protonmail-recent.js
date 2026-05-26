#!/usr/bin/env node
const { listRecentProtonmail } = require("./lib/protonmail-service");

async function main() {
  const maxResults = parseInt(process.argv[2] || "10", 10);
  const messages = await listRecentProtonmail({ maxResults });
  console.log(JSON.stringify(messages, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
