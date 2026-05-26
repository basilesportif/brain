#!/usr/bin/env node
const { loadComposioConfig } = require("./lib/config");
const { listRecentGmail } = require("./lib/gmail-service");

async function main() {
  const arg1 = process.argv[2];
  const arg2 = process.argv[3];
  const composio = loadComposioConfig();

  let accountIds;
  let maxResults;

  if (!arg1 || arg1 === "all") {
    accountIds = composio.ACCOUNTS.gmail;
    maxResults = parseInt(arg2 || "10", 10);
  } else if (arg1.startsWith("ca_")) {
    accountIds = [arg1];
    maxResults = parseInt(arg2 || "10", 10);
  } else {
    accountIds = composio.ACCOUNTS.gmail;
    maxResults = parseInt(arg1 || "10", 10);
  }

  const messages = await listRecentGmail({ composio, accountIds, maxResults });
  console.log(JSON.stringify(messages, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
