#!/usr/bin/env node
/**
 * Generate Composio connection links, check connection status, and list accounts.
 *
 * Usage:
 *   node scripts/composio-connect.js --list-configs                         → list auth configs
 *   node scripts/composio-connect.js --list-configs --app gmail             → filter by app
 *   node scripts/composio-connect.js --generate --app gmail --user-id "your-username"   → generate link
 *   node scripts/composio-connect.js --check --id ca_xxxxx                  → check status
 *   node scripts/composio-connect.js --list                                 → list connected accounts
 *
 * Output: JSON to stdout. Errors to stderr.
 */
const { loadComposioConfig } = require("./lib/config");

const COMPOSIO_API_VERSION = "v3.1";
const COMPOSIO_API_PREFIX = `/api/${COMPOSIO_API_VERSION}`;

// App name aliases — map common/friendly names to actual Composio app names
const APP_ALIASES = {
  google_calendar: "googlecalendar",
  google_sheets: "googlesheets",
  google_drive: "googledrive",
  google_docs: "googledocs",
};

function resolveAppName(name) {
  if (!name) return name;
  const lower = name.toLowerCase();
  return APP_ALIASES[lower] || lower;
}

async function api(method, path, body) {
  const composio = loadComposioConfig();
  const url = `${composio.COMPOSIO_BASE}${path}`;
  const opts = {
    method,
    headers: {
      "x-api-key": composio.COMPOSIO_API_KEY,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`API ${res.status}: ${path}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function itemsFrom(data) {
  return Array.isArray(data) ? data : data.items || [];
}

// --list-configs [--app <name>]
async function listConfigs(appFilter) {
  const params = new URLSearchParams({
    limit: "1000",
    show_disabled: "true",
  });
  if (appFilter) params.set("toolkit_slug", resolveAppName(appFilter));

  const data = await api("GET", `${COMPOSIO_API_PREFIX}/auth_configs?${params}`);
  let items = itemsFrom(data).map((c) => ({
    id: c.id,
    name: c.name,
    app: c.toolkit?.slug || c.appName || c.app_name,
    authScheme: c.auth_scheme || c.authScheme,
    status: c.status,
    createdAt: c.created_at || c.createdAt,
  }));
  if (appFilter) {
    const filter = resolveAppName(appFilter);
    items = items.filter(
      (c) => c.app && c.app.toLowerCase().includes(filter)
    );
  }
  return items;
}

// --generate --app <name> --user-id <id> [--redirect-url <url>] [--integration-id <id>] [--v3]
async function generateLink(opts) {
  const { app, userId, redirectUrl, integrationId } = opts;
  const resolvedApp = resolveAppName(app);

  if (!userId) {
    throw new Error("--user-id is required for --generate");
  }

  // If no auth config ID is given, find one for the app. The option is
  // still named --integration-id for CLI compatibility with the old v1 flow.
  let intId = integrationId;
  if (!intId) {
    const configs = await listConfigs(resolvedApp);
    if (configs.length === 0) {
      throw new Error(
        `No integration found for app "${resolvedApp}". Run --list-configs to see available integrations.`
      );
    }
    const config = configs.find((c) => c.status !== "DISABLED") || configs[0];
    intId = config.id;
    process.stderr.write(
      `Using auth config: ${config.name} (${intId})\n`
    );
  }

  return generateLinkV3({ authConfigId: intId, userId, redirectUrl });
}

// v3 endpoint: POST /api/v3.1/connected_accounts/link
async function generateLinkV3(opts) {
  const { authConfigId, userId, redirectUrl } = opts;
  const body = {
    auth_config_id: authConfigId,
    user_id: userId,
  };
  if (redirectUrl) body.callback_url = redirectUrl;

  const data = await api("POST", `${COMPOSIO_API_PREFIX}/connected_accounts/link`, body);
  return {
    connectionStatus: data.status || "INITIATED",
    connectedAccountId: data.connected_account_id || data.id,
    redirectUrl: data.redirect_url || data.url,
    linkToken: data.link_token,
    expiresAt: data.expires_at,
    authConfigId: authConfigId,
  };
}

// --check --id <connected_account_id>
async function checkConnection(id) {
  const data = await api("GET", `${COMPOSIO_API_PREFIX}/connected_accounts/${id}`);
  return {
    id: data.id,
    status: data.status || data.connectionStatus,
    app: data.toolkit?.slug || data.appName || data.app_name,
    authConfigId: data.auth_config?.id,
    userId: data.user_id,
    createdAt: data.created_at || data.createdAt,
    updatedAt: data.updated_at || data.updatedAt,
  };
}

// --list
async function listConnected() {
  const params = new URLSearchParams({
    limit: "1000",
    account_type: "ALL",
  });
  const data = await api("GET", `${COMPOSIO_API_PREFIX}/connected_accounts?${params}`);
  const items = itemsFrom(data).map((c) => ({
    id: c.id,
    status: c.status || c.connectionStatus,
    app: c.toolkit?.slug || c.appName || c.app_name,
    authConfigId: c.auth_config?.id,
    userId: c.user_id,
    createdAt: c.created_at || c.createdAt,
  }));
  return items;
}

function usage() {
  process.stderr.write(`Usage:
  --list-configs [--app <name>]           List integrations (auth configs)
  --generate --app <name> --user-id <id>  Generate a connection link
    [--redirect-url <url>]
    [--integration-id <auth_config_id>]   Existing flag name; expects ac_ auth config ID
    [--v3]                                Accepted for backwards compatibility (v3.1 is always used)
  --check --id <ca_id>                    Check connection status
  --refresh --id <ca_id>                  Trigger token refresh (v3)
  --list                                  List all connected accounts

App aliases: google_calendar → googlecalendar, google_sheets → googlesheets
`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list-configs") args.command = "list-configs";
    else if (a === "--generate") args.command = "generate";
    else if (a === "--check") args.command = "check";
    else if (a === "--list") args.command = "list";
    else if (a === "--app" && argv[i + 1]) args.app = argv[++i];
    else if (a === "--user-id" && argv[i + 1]) args.userId = argv[++i];
    else if (a === "--redirect-url" && argv[i + 1]) args.redirectUrl = argv[++i];
    else if (a === "--integration-id" && argv[i + 1]) args.integrationId = argv[++i];
    else if (a === "--id" && argv[i + 1]) args.id = argv[++i];
    else if (a === "--v3") args.useV3 = true;
    else if (a === "--refresh") args.command = "refresh";
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command) usage();

  let result;
  switch (args.command) {
    case "list-configs":
      result = await listConfigs(args.app);
      break;
    case "generate":
      if (!args.app) {
        process.stderr.write("Error: --app is required for --generate\n");
        process.exit(1);
      }
      result = await generateLink({ ...args, useV3: args.useV3 });
      break;
    case "check":
      if (!args.id) {
        process.stderr.write("Error: --id is required for --check\n");
        process.exit(1);
      }
      result = await checkConnection(args.id);
      break;
    case "refresh":
      if (!args.id) {
        process.stderr.write("Error: --id is required for --refresh\n");
        process.exit(1);
      }
      result = await api("POST", `${COMPOSIO_API_PREFIX}/connected_accounts/${args.id}/refresh`, {});
      break;
    case "list":
      result = await listConnected();
      break;
    default:
      usage();
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  if (err.body) process.stderr.write(JSON.stringify(err.body, null, 2) + "\n");
  process.exit(1);
});
