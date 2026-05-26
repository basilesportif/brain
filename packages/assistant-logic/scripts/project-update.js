#!/usr/bin/env node
/**
 * Update an existing project.
 *
 * Flags:
 *   --id "pj_..."              required
 *   --name "Name"              optional
 *   --description "..."        optional
 *   --status "active"          optional (active/on-hold/completed/archived)
 *   --target-date "2026-04-15" optional
 *   --add-person "ct_..."      optional (repeatable)
 *   --remove-person "ct_..."   optional (repeatable)
 *   --add-business "bz_..."    optional (repeatable)
 *   --remove-business "bz_..." optional (repeatable)
 *
 * Only provided fields are updated; omitted fields are left unchanged.
 * Output: JSON to stdout, errors to stderr.
 */
const { updateProject } = require("./lib/project-store");

function parseArgs(argv) {
  const args = {};
  const addPersonIds = [];
  const removePersonIds = [];
  const addBusinessIds = [];
  const removeBusinessIds = [];
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--id" && argv[i + 1]) { args.id = argv[++i]; i++; }
    else if (arg === "--name" && argv[i + 1]) { args.name = argv[++i]; i++; }
    else if (arg === "--description" && argv[i + 1]) { args.description = argv[++i]; i++; }
    else if (arg === "--status" && argv[i + 1]) { args.status = argv[++i]; i++; }
    else if (arg === "--target-date" && argv[i + 1]) { args.targetDate = argv[++i]; i++; }
    else if (arg === "--add-person" && argv[i + 1]) { addPersonIds.push(argv[++i]); i++; }
    else if (arg === "--remove-person" && argv[i + 1]) { removePersonIds.push(argv[++i]); i++; }
    else if (arg === "--add-business" && argv[i + 1]) { addBusinessIds.push(argv[++i]); i++; }
    else if (arg === "--remove-business" && argv[i + 1]) { removeBusinessIds.push(argv[++i]); i++; }
    else { i++; }
  }
  if (addPersonIds.length) args._addPersonIds = addPersonIds;
  if (removePersonIds.length) args._removePersonIds = removePersonIds;
  if (addBusinessIds.length) args._addBusinessIds = addBusinessIds;
  if (removeBusinessIds.length) args._removeBusinessIds = removeBusinessIds;
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.id) {
    console.error("Usage: project-update.js --id pj_... [--name ...] [--description ...] [--status ...] [--target-date ...] [--add-person ...] [--remove-person ...] [--add-business ...] [--remove-business ...]");
    process.exit(1);
  }
  try {
    const id = args.id;
    delete args.id;
    const project = updateProject(id, args);
    if (!project) {
      console.error(JSON.stringify({ error: `Project not found: ${id}` }));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, project }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
