#!/usr/bin/env node
/**
 * List saved private document metadata.
 */
const { listDocuments } = require("./lib/file-save-store");

function parseArgs(argv) {
  const args = {};
  const aliases = {
    "--query": "query",
    "--project": "project",
    "--contact": "contact",
    "--label": "label",
    "--limit": "limit",
    "--private-dir": "privateRoot",
    "--private-root": "privateRoot",
    "--workspace": "workspacePath",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (aliases[arg]) {
      if (!argv[i + 1]) throw new Error(`${arg} requires a value`);
      args[aliases[arg]] = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return `Usage: node scripts/file-list.js [--query <text>] [--project <label>] [--contact <label>] [--label <label>] [--limit <n>] [--private-dir <abs-path>]`;
}

function main() {
  try {
    const args = parseArgs(process.argv);
    if (args.help) {
      console.log(usage());
      return;
    }
    console.log(JSON.stringify(listDocuments(args, { workspacePath: args.workspacePath, privateRoot: args.privateRoot }), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exit(1);
  }
}

main();
