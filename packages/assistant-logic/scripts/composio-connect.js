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

// --list-configs [--app <name>]
async function listConfigs(appFilter) {
  const data = await api("GET", "/api/v1/integrations");
  let items = (data.items || data).map((c) => ({
    id: c.id,
    name: c.name,
    app: c.appName || c.app_name,
    authScheme: c.authScheme || c.auth_scheme,
    createdAt: c.createdAt || c.created_at,
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
  const { app, userId, redirectUrl, integrationId, useV3 } = opts;
  const resolvedApp = resolveAppName(app);

  // If no integration ID given, find one for the app
  let intId = integrationId;
  if (!intId) {
    const configs = await listConfigs(resolvedApp);
    if (configs.length === 0) {
      throw new Error(
        `No integration found for app "${resolvedApp}". Run --list-configs to see available integrations.`
      );
    }
    intId = configs[0].id;
    process.stderr.write(
      `Using integration: ${configs[0].name} (${intId})\n`
    );
  }

  // Use v3 endpoint if requested or if integration ID is nanoid format (ac_xxx)
  if (useV3 || (intId && /^ac_/.test(intId))) {
    return generateLinkV3({ authConfigId: intId, userId, redirectUrl });
  }

  // v1 endpoint — requires data: {} in body
  const body = {
    integrationId: intId,
    data: {},
    redirectUri: redirectUrl || undefined,
  };
  if (userId) body.userUuid = userId;

  const data = await api("POST", "/api/v1/connectedAccounts", body);
  return {
    connectionStatus: data.connectionStatus,
    connectedAccountId: data.id,
    redirectUrl: data.redirectUrl,
    integrationId: intId,
  };
}

// v3 endpoint: POST /api/v3/connected_accounts/link
async function generateLinkV3(opts) {
  const { authConfigId, userId, redirectUrl } = opts;
  const body = {
    auth_config_id: authConfigId,
  };
  if (userId) body.entity_id = userId;
  if (redirectUrl) body.redirect_url = redirectUrl;

  const data = await api("POST", "/api/v3/connected_accounts/link", body);
  return {
    connectionStatus: data.status || "INITIATED",
    connectedAccountId: data.id || data.connected_account_id,
    redirectUrl: data.redirect_url || data.url,
    authConfigId: authConfigId,
  };
}

// --check --id <connected_account_id>
async function checkConnection(id) {
  const data = await api("GET", `/api/v1/connectedAccounts/${id}`);
  return {
    id: data.id,
    status: data.connectionStatus || data.status,
    app: data.appName || data.app_name,
    createdAt: data.createdAt || data.created_at,
    updatedAt: data.updatedAt || data.updated_at,
  };
}

// --list
async function listConnected() {
  const data = await api("GET", "/api/v1/connectedAccounts?showActiveOnly=false");
  const items = (data.items || data).map((c) => ({
    id: c.id,
    status: c.connectionStatus || c.status,
    app: c.appName || c.app_name,
    createdAt: c.createdAt || c.created_at,
  }));
  return items;
}

function usage() {
  process.stderr.write(`Usage:
  --list-configs [--app <name>]           List integrations (auth configs)
  --generate --app <name> --user-id <id>  Generate a connection link
    [--redirect-url <url>]
    [--integration-id <id>]
    [--v3]                                Use v3 endpoint (auto if ac_ ID)
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
      result = await api("POST", `/api/v3/connected_accounts/${args.id}/refresh`, {});
      break;
    case "list":
      result = await listConnected();
      break;
    default:
      usage();
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  if (err.body) process.stderr.write(JSON.stringify(err.body, null, 2) + "\n");
  process.exit(1);
});
