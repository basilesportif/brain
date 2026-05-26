#!/usr/bin/env node
// Thin wrapper — delegates to the unified finance script with --provider mercury.
const { getBalances } = require("./lib/finance-service");

async function main() {
  const balances = await getBalances({ provider: "mercury" });
  console.log(JSON.stringify(balances, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
