#!/usr/bin/env node
const { searchProtonmailMessages } = require("./lib/protonmail-service");

async function main() {
  const query = process.argv[2];
  if (!query) {
    console.error("Usage: node protonmail-search.js <query> [max]");
    process.exit(1);
  }

  const maxResults = parseInt(process.argv[3] || "10", 10);
  const messages = await searchProtonmailMessages({ query, maxResults });
  console.log(JSON.stringify(messages, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
