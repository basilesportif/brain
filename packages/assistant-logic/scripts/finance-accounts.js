#!/usr/bin/env node
const { listAccounts } = require("./lib/finance-service");

function parseArgs(argv) {
  const args = { provider: null };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--provider":
        args.provider = argv[++i];
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        console.error("Usage: node finance-accounts.js [--provider <name>]");
        process.exit(1);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const accounts = await listAccounts({ provider: args.provider });
  console.log(JSON.stringify(accounts, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
