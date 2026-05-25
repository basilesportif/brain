#!/usr/bin/env node
/**
 * Manage resources (links/docs/references) on a project.
 *
 * Flags:
 *   --id "pj_..."              required
 *   --add                      add a resource (requires --label and --url)
 *   --remove                   remove a resource (requires --index or --label)
 *   --list                     list all resources
 *   --label "Tax guide"        resource label
 *   --url "https://..."        resource URL
 *   --index 0                  resource index (for removal)
 *
 * Output: JSON to stdout, errors to stderr.
 */
const { getProject, addResource, removeResource } = require("./lib/project-store");

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--id" && argv[i + 1]) { args.id = argv[++i]; i++; }
    else if (arg === "--label" && argv[i + 1]) { args.label = argv[++i]; i++; }
    else if (arg === "--url" && argv[i + 1]) { args.url = argv[++i]; i++; }
    else if (arg === "--index" && argv[i + 1]) { args.index = argv[++i]; i++; }
    else if (arg === "--add") { args.action = "add"; i++; }
    else if (arg === "--remove") { args.action = "remove"; i++; }
    else if (arg === "--list") { args.action = "list"; i++; }
    else { i++; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.id || !args.action) {
    console.error("Usage: project-resource.js --id pj_... --add --label \"...\" --url \"...\"");
    console.error("       project-resource.js --id pj_... --remove --index 0");
    console.error("       project-resource.js --id pj_... --remove --label \"...\"");
    console.error("       project-resource.js --id pj_... --list");
    process.exit(1);
  }
  try {
    if (args.action === "list") {
      const project = getProject(args.id);
      if (!project) {
        console.error(JSON.stringify({ error: `Project not found: ${args.id}` }));
        process.exit(1);
      }
      console.log(JSON.stringify({ ok: true, resources: project.resources }, null, 2));
      return;
    }

    if (args.action === "add") {
      if (!args.label || !args.url) {
        console.error("--add requires --label and --url");
        process.exit(1);
      }
      const result = addResource(args.id, { label: args.label, url: args.url });
      if (!result) {
        console.error(JSON.stringify({ error: `Project not found: ${args.id}` }));
        process.exit(1);
      }
      console.log(JSON.stringify({ ok: true, project: result.project, resource: result.resource }, null, 2));
      return;
    }

    if (args.action === "remove") {
      if (args.index === undefined && !args.label) {
        console.error("--remove requires --index or --label");
        process.exit(1);
      }
      const result = removeResource(args.id, { index: args.index, label: args.label });
      if (!result) {
        console.error(JSON.stringify({ error: `Project not found: ${args.id}` }));
        process.exit(1);
      }
      if (result.error) {
        console.error(JSON.stringify({ error: result.error }));
        process.exit(1);
      }
      console.log(JSON.stringify({ ok: true, removed: result.removed, resources: result.project.resources }, null, 2));
    }
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
