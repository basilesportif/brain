#!/usr/bin/env node
const {
  loadSources,
  addSource,
  removeSource,
  getSourcesPath,
  resolveMercuryToken,
  getLegacyMercuryToken,
} = require("./lib/finance-sources");
const { getWorkspaceContext, getWorkspacePaths } = require("./lib/workspace");
const { loadWorkspaceEnv } = require("./lib/runtime-env");

function usage() {
  console.error(
    "Usage: node finance-source.js <command>\n" +
      "Commands:\n" +
      "  --add --provider <mercury|plaid> --label <label> [--env-key <KEY>] [--access-token <token>] [--item-id <id>]\n" +
      "  --remove --id <source_id>\n" +
      "  --list\n" +
      "\n" +
      "Examples:\n" +
      '  node finance-source.js --add --provider mercury --label "Mercury - Business" --env-key MERCURY_API_TOKEN_1\n' +
      '  node finance-source.js --add --provider plaid --label "Chase" --access-token access-development-xxx --item-id item_xxx\n' +
      "  node finance-source.js --remove --id mercury_1\n" +
      "  node finance-source.js --list"
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    command: null,
    provider: null,
    label: null,
    id: null,
    envKey: null,
    accessToken: null,
    itemId: null,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--add":
        args.command = "add";
        break;
      case "--remove":
        args.command = "remove";
        break;
      case "--list":
        args.command = "list";
        break;
      case "--provider":
        args.provider = argv[++i];
        break;
      case "--label":
        args.label = argv[++i];
        break;
      case "--id":
        args.id = argv[++i];
        break;
      case "--env-key":
        args.envKey = argv[++i];
        break;
      case "--access-token":
        args.accessToken = argv[++i];
        break;
      case "--item-id":
        args.itemId = argv[++i];
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        usage();
    }
  }

  return args;
}

function handleAdd(args) {
  if (!args.provider) {
    console.error(JSON.stringify({ error: "--provider is required for --add" }));
    process.exit(1);
  }
  if (!args.label) {
    console.error(JSON.stringify({ error: "--label is required for --add" }));
    process.exit(1);
  }

  const entry = {
    provider: args.provider,
    label: args.label,
  };

  if (args.provider === "mercury") {
    if (!args.envKey) {
      console.error(
        JSON.stringify({
          error:
            "--env-key is required for mercury sources (e.g. MERCURY_API_TOKEN_1). Add the actual token to workspace/.env under that key.",
        })
      );
      process.exit(1);
    }
    entry.envKey = args.envKey;
  } else if (args.provider === "plaid") {
    if (!args.accessToken) {
      console.error(
        JSON.stringify({
          error:
            "--access-token is required for plaid sources. Use plaid-link.js to obtain one, or pass it directly.",
        })
      );
      process.exit(1);
    }
    entry.accessToken = args.accessToken;
    if (args.itemId) entry.itemId = args.itemId;
    entry.cursor = null;
  } else {
    console.error(
      JSON.stringify({
        error: `Unknown provider: ${args.provider}. Supported: mercury, plaid`,
      })
    );
    process.exit(1);
  }

  const source = addSource(entry);
  console.log(JSON.stringify({ success: true, source }, null, 2));
}

function handleRemove(args) {
  if (!args.id) {
    console.error(JSON.stringify({ error: "--id is required for --remove" }));
    process.exit(1);
  }

  const removed = removeSource(args.id);
  if (!removed) {
    console.error(
      JSON.stringify({ error: `Source not found: ${args.id}` })
    );
    process.exit(1);
  }

  console.log(JSON.stringify({ success: true, removed }, null, 2));
}

function handleList() {
  const data = loadSources();
  const context = getWorkspaceContext();
  const { env } = loadWorkspaceEnv({ context });

  const sources = data.sources.map((s) => {
    const entry = {
      id: s.id,
      provider: s.provider,
      label: s.label,
      enabled: s.enabled !== false,
      addedAt: s.addedAt,
    };

    if (s.provider === "mercury") {
      entry.envKey = s.envKey;
      const token = s.envKey ? env[s.envKey] : null;
      entry.tokenPresent = Boolean(token);
    } else if (s.provider === "plaid") {
      entry.hasAccessToken = Boolean(s.accessToken);
      if (s.itemId) entry.itemId = s.itemId;
    }

    return entry;
  });

  // Also check for legacy MERCURY_API_TOKEN
  const legacyToken = env.MERCURY_API_TOKEN;
  const hasMercurySources = data.sources.some((s) => s.provider === "mercury");
  const legacyActive = Boolean(legacyToken) && !hasMercurySources;

  console.log(
    JSON.stringify(
      {
        sources,
        legacy: {
          mercuryApiToken: legacyActive
            ? "present (no finance-sources.json entries — will be used as fallback)"
            : hasMercurySources
              ? "present but overridden by finance-sources.json entries"
              : "not set",
        },
      },
      null,
      2
    )
  );
}

function main() {
  const args = parseArgs(process.argv);

  if (!args.command) usage();

  switch (args.command) {
    case "add":
      return handleAdd(args);
    case "remove":
      return handleRemove(args);
    case "list":
      return handleList();
    default:
      usage();
  }
}

main();
