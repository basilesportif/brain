#!/usr/bin/env node
const { getTransactions } = require("./lib/finance-service");

function parseArgs(argv) {
  const args = {
    provider: null,
    account: null,
    days: 30,
    start: null,
    end: null,
    limit: 50,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--provider":
        args.provider = argv[++i];
        break;
      case "--account":
        args.account = argv[++i];
        break;
      case "--days":
        args.days = parseInt(argv[++i], 10);
        break;
      case "--start":
        args.start = argv[++i];
        break;
      case "--end":
        args.end = argv[++i];
        break;
      case "--limit":
        args.limit = parseInt(argv[++i], 10);
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        console.error(
          "Usage: node finance-transactions.js [--provider <name>] [--account <id>] [--days N] [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--limit N]"
        );
        process.exit(1);
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const transactions = await getTransactions({
    provider: args.provider,
    account: args.account,
    days: args.days,
    start: args.start,
    end: args.end,
    limit: args.limit,
  });
  console.log(JSON.stringify(transactions, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
