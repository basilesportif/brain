#!/usr/bin/env node
// @ts-nocheck
/**
 * Update the body or structured metadata of an existing project note.
 *
 * Flags:
 *   --id "pj_..."                  required
 *   --note-id "pn_..."             required
 *   --text "..."                   optional replacement body
 *   --title "..."                  optional metadata title override
 *   --summary "..."                optional metadata summary override
 *   --kind "note|runbook|..."      optional metadata kind
 *   --category "..."               optional metadata category
 *   --tag "tag" / --tags "a,b"     optional metadata tags; repeatable
 *   --remove-tag "tag"              optional tag removal; repeatable
 *   --trigger "phrase"             optional additive trigger; repeatable
 *   --triggers "a,b"               optional comma-separated additive triggers
 *   --remove-trigger "phrase"       optional trigger removal; repeatable
 *   --canonical-key "key"          optional stable canonical key
 *   --current / --not-current       optional canonical/current marker
 *   --ref "type:value"             optional metadata ref; repeatable
 *   --relationship "type:value"    optional relationship; repeatable
 *   --metadata-json '{...}'         optional raw metadata object merged with flags
 *
 * Output: JSON to stdout, errors to stderr.
 */
import { getProject, updateNote } from "../lib/project-store.js";

function parseArgs(argv) {
  const args = {
    tags: [],
    removeTags: [],
    addTriggers: [],
    removeTriggers: [],
    refs: [],
    relationships: [],
  };
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--id" && argv[i + 1]) { args.id = argv[++i]; i++; }
    else if (arg === "--note-id" && argv[i + 1]) { args.noteId = argv[++i]; i++; }
    else if (arg === "--text" && argv[i + 1]) { args.text = argv[++i]; i++; }
    else if (arg === "--title" && argv[i + 1]) { args.title = argv[++i]; i++; }
    else if (arg === "--summary" && argv[i + 1]) { args.summary = argv[++i]; i++; }
    else if (arg === "--kind" && argv[i + 1]) { args.kind = argv[++i]; i++; }
    else if (arg === "--category" && argv[i + 1]) { args.category = argv[++i]; i++; }
    else if (arg === "--tag" && argv[i + 1]) { args.tags.push(argv[++i]); i++; }
    else if (arg === "--tags" && argv[i + 1]) { args.tags.push(...argv[++i].split(",")); i++; }
    else if (arg === "--remove-tag" && argv[i + 1]) { args.removeTags.push(argv[++i]); i++; }
    else if (arg === "--trigger" && argv[i + 1]) { args.addTriggers.push(argv[++i]); i++; }
    else if (arg === "--triggers" && argv[i + 1]) { args.addTriggers.push(...argv[++i].split(",")); i++; }
    else if (arg === "--remove-trigger" && argv[i + 1]) { args.removeTriggers.push(argv[++i]); i++; }
    else if (arg === "--canonical-key" && argv[i + 1]) { args.canonicalKey = argv[++i]; i++; }
    else if (arg === "--current") { args.current = true; i++; }
    else if (arg === "--not-current") { args.current = false; i++; }
    else if (arg === "--ref" && argv[i + 1]) { args.refs.push(argv[++i]); i++; }
    else if (arg === "--relationship" && argv[i + 1]) { args.relationships.push(argv[++i]); i++; }
    else if (arg === "--metadata-json" && argv[i + 1]) { args.metadataJson = argv[++i]; i++; }
    else { i++; }
  }
  return args;
}

function buildMetadata(args) {
  let metadata = {};
  if (args.metadataJson) {
    metadata = JSON.parse(args.metadataJson);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error("--metadata-json must be a JSON object");
    }
  }
  for (const key of ["title", "summary", "kind", "category", "canonicalKey", "current"]) {
    if (args[key] !== undefined) metadata[key] = args[key];
  }
  if (args.tags.length) metadata.tags = [...(Array.isArray(metadata.tags) ? metadata.tags : []), ...args.tags.map((tag) => tag.trim()).filter(Boolean)];
  if (args.refs.length) metadata.refs = [...(Array.isArray(metadata.refs) ? metadata.refs : []), ...args.refs];
  if (args.relationships.length) metadata.relationships = [...(Array.isArray(metadata.relationships) ? metadata.relationships : []), ...args.relationships];
  return metadata;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.id || !args.noteId) {
    console.error("Usage: project-note-update.js --id pj_... --note-id pn_... [--text ...] [--title ...] [--summary ...] [--kind ...] [--category ...] [--tag ...] [--tags a,b] [--remove-tag ...] [--trigger ...] [--triggers a,b] [--remove-trigger ...] [--canonical-key ...] [--current|--not-current] [--ref type:value] [--relationship type:value] [--metadata-json '{...}']");
    process.exit(1);
  }
  try {
    const result = updateNote(args.id, args.noteId, {
      text: args.text,
      metadata: buildMetadata(args),
      addTriggers: args.addTriggers,
      removeTags: args.removeTags,
      removeTriggers: args.removeTriggers,
    });
    if (!result) {
      const project = getProject(args.id);
      const error = project
        ? `Note not found: ${args.noteId} in ${args.id}`
        : `Project not found: ${args.id}`;
      console.error(JSON.stringify({ error }));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, project: result.project, note: result.note }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
