#!/usr/bin/env node
// @ts-nocheck
/**
 * Add a project.
 *
 * Flags:
 *   --name "Name"              required
 *   --description "..."        optional
 *   --status "active"          optional (active/on-hold/completed/archived, default: active)
 *   --target-date "2026-04-15" optional
 *   --person-id "ct_..."       optional (repeatable)
 *   --business-id "bz_..."     optional (repeatable)
 *   --notes "Initial setup"    optional (first note)
 *
 * Output: JSON to stdout, errors to stderr.
 */
import { addProject } from "../lib/project-store.js";

function parseArgs(argv) {
  const args = {};
  const personIds = [];
  const businessIds = [];
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--name" && argv[i + 1]) { args.name = argv[++i]; i++; }
    else if (arg === "--description" && argv[i + 1]) { args.description = argv[++i]; i++; }
    else if (arg === "--status" && argv[i + 1]) { args.status = argv[++i]; i++; }
    else if (arg === "--target-date" && argv[i + 1]) { args.targetDate = argv[++i]; i++; }
    else if (arg === "--person-id" && argv[i + 1]) { personIds.push(argv[++i]); i++; }
    else if (arg === "--business-id" && argv[i + 1]) { businessIds.push(argv[++i]); i++; }
    else if (arg === "--notes" && argv[i + 1]) { args.initialNote = argv[++i]; i++; }
    else { i++; }
  }
  if (personIds.length) args.personIds = personIds;
  if (businessIds.length) args.businessIds = businessIds;
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.name) {
    console.error("Usage: project-add.js --name \"Name\" [--description ...] [--status ...] [--target-date ...] [--person-id ...] [--business-id ...] [--notes ...]");
    process.exit(1);
  }
  try {
    const project = addProject(args);
    console.log(JSON.stringify({ ok: true, project }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
