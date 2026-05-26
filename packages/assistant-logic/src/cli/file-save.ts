#!/usr/bin/env node
// @ts-nocheck
/**
 * Copy a source attachment/file into durable private document storage and append metadata.
 *
 * Examples:
 *   node scripts/file-save.js --source /tmp/input.pdf
 *   node scripts/file-save.js --source /tmp/input.pdf --project "Decisive Outcomes" --title "conference prospectus"
 *   node scripts/file-save.js --source /tmp/input.pdf --contact "Bill Pate" --received-at "2026-05-22T12:00:00Z" --source-chat 253768951 --source-message 456
 */
import { saveDocument } from "../lib/file-save-store.js";

function parseArgs(argv) {
  const args = {};
  const aliases = {
    "--source": "source",
    "--path": "source",
    "--file": "source",
    "--project": "project",
    "--contact": "contact",
    "--label": "label",
    "--title": "title",
    "--as": "title",
    "--note": "note",
    "--retention": "retention",
    "--received-at": "receivedAt",
    "--source-chat": "sourceChat",
    "--chat": "sourceChat",
    "--source-message": "sourceMessage",
    "--message": "sourceMessage",
    "--original-filename": "originalFilename",
    "--mime-type": "mimeType",
    "--size-bytes": "sizeBytes",
    "--sha256": "sha256",
    "--private-dir": "privateRoot",
    "--private-root": "privateRoot",
    "--workspace": "workspacePath",
    "--filename": "filename",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (aliases[arg]) {
      if (!argv[i + 1]) throw new Error(`${arg} requires a value`);
      args[aliases[arg]] = argv[++i];
    } else if (!arg.startsWith("-") && !args.source) {
      args.source = arg;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return `Usage: node scripts/file-save.js --source <path> [--project <label>] [--contact <label>] [--title <title>] [--note <text>] [--retention <policy>] [--received-at <iso>] [--source-chat <id/name>] [--source-message <id>] [--original-filename <name>] [--mime-type <type>] [--private-dir <abs-path>]`;
}

async function main() {
  try {
    const args = parseArgs(process.argv);
    if (args.help) {
      console.log(usage());
      return;
    }
    if (!args.source) {
      console.error(usage());
      process.exit(2);
    }
    const result = await saveDocument(args, { workspacePath: args.workspacePath, privateRoot: args.privateRoot });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exit(1);
  }
}

main();
