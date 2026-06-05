#!/usr/bin/env node
const {
  addConferenceRecord,
  listConferences,
  listFavoriteConferences,
  updateConferenceFavorites,
} = require("./lib/conference-favorite-store");

const usage = `Usage:
  node scripts/conference-favorite.js favorite <conference-id-or-name> [options]
  node scripts/conference-favorite.js unfavorite <conference-id-or-name> [options]
  node scripts/conference-favorite.js add --list <list-id> --id <id> --name <name> [options]
  node scripts/conference-favorite.js list [options]
  node scripts/conference-favorite.js list-favorites [options]

Options:
  --list <list-id>          Limit to one conference list. Repeatable.
  --id <id>                 Conference id for add.
  --name <name>             Conference name for add.
  --data-json <json>        Extra/complete conference JSON object for add.
  --query <text>            Filter list output.
  --note <text>             Favorite note. Empty string clears the note.
  --keep-note               When unfavoriting, keep any existing favoriteNote.
  --at <iso-date>           Override favoritedAt/favoriteUpdatedAt timestamp.
  --workspace-path <path>   Assistant workspace root. Default: /home/tim/.assistant-claude/workspace
  --json                    Print JSON instead of a compact text summary.
`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command, listIds: [], json: false };
  const positionals = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--list") args.listIds.push(rest[++i]);
    else if (token === "--id") args.id = rest[++i];
    else if (token === "--name") args.name = rest[++i];
    else if (token === "--data-json") args.dataJson = rest[++i];
    else if (token === "--query") args.query = rest[++i];
    else if (token === "--note") args.note = rest[++i] ?? "";
    else if (token === "--keep-note") args.keepNote = true;
    else if (token === "--at") args.at = rest[++i];
    else if (token === "--workspace-path") args.workspacePath = rest[++i];
    else if (token === "--json") args.json = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else if (token?.startsWith("--")) throw new Error(`Unknown option: ${token}`);
    else positionals.push(token);
  }
  args.selector = positionals.join(" ").trim();
  return args;
}

function printTextResult(result) {
  for (const change of result.changes) {
    const status = change.favorite ? "favorited" : "unfavorited";
    const note = change.favoriteNote ? ` — ${change.favoriteNote}` : "";
    console.log(`${status}: ${change.name} [${change.id}] in ${change.listId}${note}`);
  }
}

function printFavorites(rows) {
  if (rows.length === 0) {
    console.log("No favorite conferences found.");
    return;
  }
  for (const row of rows) {
    const note = row.favoriteNote ? ` — ${row.favoriteNote}` : "";
    console.log(`${row.listId}: ${row.name} [${row.id}] ${row.dates || ""} ${row.city || ""}${row.region ? `, ${row.region}` : ""}${note}`);
  }
}

function printConferences(rows) {
  if (rows.length === 0) {
    console.log("No conferences found.");
    return;
  }
  for (const row of rows) {
    const fav = row.favorite ? " ★" : "";
    const note = row.favoriteNote ? ` — ${row.favoriteNote}` : "";
    console.log(`${row.listId}: ${row.name} [${row.id}] ${row.dates || ""} ${row.city || ""}${row.region ? `, ${row.region}` : ""}${fav}${note}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    process.stdout.write(usage);
    return;
  }

  if (args.command === "list-favorites") {
    const rows = listFavoriteConferences({ workspacePath: args.workspacePath, listIds: args.listIds.length ? args.listIds : undefined });
    if (args.json) console.log(JSON.stringify({ ok: true, favorites: rows }, null, 2));
    else printFavorites(rows);
    return;
  }

  if (args.command === "list") {
    const rows = listConferences({ workspacePath: args.workspacePath, listIds: args.listIds.length ? args.listIds : undefined, query: args.query });
    if (args.json) console.log(JSON.stringify({ ok: true, conferences: rows }, null, 2));
    else printConferences(rows);
    return;
  }

  if (args.command === "add") {
    if (args.listIds.length !== 1) throw new Error(`Add requires exactly one --list <list-id>.\n\n${usage}`);
    let record = {};
    if (args.dataJson) {
      record = JSON.parse(args.dataJson);
    }
    if (args.id) record.id = args.id;
    if (args.name) record.name = args.name;
    const result = addConferenceRecord(
      {
        workspacePath: args.workspacePath,
        listId: args.listIds[0],
        record,
        at: args.at,
      },
      { workspacePath: args.workspacePath }
    );
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`added: ${result.conference.name} [${result.conference.id}] in ${result.listId}`);
    return;
  }

  if (args.command !== "favorite" && args.command !== "unfavorite") {
    throw new Error(`Unknown command: ${args.command}\n\n${usage}`);
  }
  if (!args.selector) throw new Error(`Missing conference id or name.\n\n${usage}`);

  const result = updateConferenceFavorites(
    {
      selector: args.selector,
      favorite: args.command === "favorite",
      note: args.note,
      keepNote: args.keepNote,
      at: args.at,
      listIds: args.listIds.length ? args.listIds : undefined,
      workspacePath: args.workspacePath,
    },
    { workspacePath: args.workspacePath }
  );
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printTextResult(result);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
