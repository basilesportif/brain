#!/usr/bin/env node
const { getCycles } = require("./lib/whoop-service");

function parseArgs(argv) {
  const args = {
    start: null,
    end: null,
    limit: 25,
    nextToken: null,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--start":
        args.start = argv[++i];
        break;
      case "--end":
        args.end = argv[++i];
        break;
      case "--limit":
        args.limit = parseInt(argv[++i], 10);
        break;
      case "--next-token":
        args.nextToken = argv[++i];
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        console.error(
          "Usage: node scripts/whoop-cycle.js [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--limit N] [--next-token TOKEN]"
        );
        process.exit(1);
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await getCycles(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
