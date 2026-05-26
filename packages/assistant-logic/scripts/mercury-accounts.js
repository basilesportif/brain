#!/usr/bin/env node
// Thin wrapper — delegates to the unified finance script with --provider mercury.
const { listAccounts } = require("./lib/finance-service");

async function main() {
  const accounts = await listAccounts({ provider: "mercury" });
  console.log(JSON.stringify(accounts, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
