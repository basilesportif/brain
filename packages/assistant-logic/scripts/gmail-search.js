#!/usr/bin/env node
const { loadComposioConfig } = require("./lib/config");
const { searchGmailMessages } = require("./lib/gmail-service");

async function main() {
  const query = process.argv[2];
  if (!query) {
    console.error("Usage: node gmail-search.js <query> [ca_id|all] [max]");
    process.exit(1);
  }

  const arg2 = process.argv[3];
  const arg3 = process.argv[4];
  const composio = loadComposioConfig();

  let accountIds;
  let maxResults;

  if (!arg2 || arg2 === "all") {
    accountIds = composio.ACCOUNTS.gmail;
    maxResults = parseInt(arg3 || "10", 10);
  } else if (arg2.startsWith("ca_")) {
    accountIds = [arg2];
    maxResults = parseInt(arg3 || "10", 10);
  } else {
    accountIds = composio.ACCOUNTS.gmail;
    maxResults = parseInt(arg2 || "10", 10);
  }

  const messages = await searchGmailMessages({
    composio,
    query,
    accountIds,
    maxResults,
  });
  console.log(JSON.stringify(messages, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
