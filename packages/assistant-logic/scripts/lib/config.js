const fs = require("fs");
const yaml = require("yaml");
const { getWorkspaceContext, getWorkspacePaths } = require("./workspace");
const { loadWorkspaceEnv, requireEnv } = require("./runtime-env");

const COMPOSIO_BASE = "https://backend.composio.dev";

function loadComposioConfig(options = {}) {
  const context = options.context || getWorkspaceContext(options);
  const paths = getWorkspacePaths(context);
  const { env } = loadWorkspaceEnv({
    context,
    processEnv: options.processEnv,
  });

  const COMPOSIO_API_KEY = requireEnv(
    env,
    "COMPOSIO_API_KEY",
    `COMPOSIO_API_KEY not set. Add it to ${paths.workspaceEnvPath} or export it in the shell.`
  );

  let composioConfig = {};
  if (fs.existsSync(paths.composioPath)) {
    composioConfig = yaml.parse(fs.readFileSync(paths.composioPath, "utf-8")) || {};
  }
  const gmailAccounts = Array.isArray(composioConfig.accounts?.gmail)
    ? composioConfig.accounts.gmail
    : [];
  const googleCalendarId = composioConfig.accounts?.google_calendar?.id || null;

  const ACCOUNTS = {
    google_calendar: googleCalendarId,
    gmail: gmailAccounts.map((entry) => entry.id),
  };

  const ACCOUNT_LABELS = {};
  for (const entry of gmailAccounts) {
    if (entry?.id) {
      ACCOUNT_LABELS[entry.id] = entry.email || entry.id;
    }
  }
  if (googleCalendarId && composioConfig.accounts?.google_calendar?.email) {
    ACCOUNT_LABELS[googleCalendarId] = composioConfig.accounts.google_calendar.email;
  }

  return {
    context,
    paths,
    env,
    COMPOSIO_API_KEY,
    COMPOSIO_BASE: env.COMPOSIO_BASE_URL || COMPOSIO_BASE,
    ACCOUNTS,
    ACCOUNT_LABELS,
    CALENDAR_ALIASES: composioConfig.calendars || {},
    composioConfig,
  };
}

function requireGoogleCalendarAccount(composio) {
  if (!composio.ACCOUNTS.google_calendar) {
    throw new Error(
      `Missing accounts.google_calendar.id in ${composio.paths.composioPath}. Run /setup-composio or update the workspace config.`
    );
  }
  return composio.ACCOUNTS.google_calendar;
}

function requireGmailAccounts(composio) {
  if (!Array.isArray(composio.ACCOUNTS.gmail) || composio.ACCOUNTS.gmail.length === 0) {
    throw new Error(
      `No Gmail connected-account IDs found in ${composio.paths.composioPath}. Run /setup-composio or update the workspace config.`
    );
  }
  return composio.ACCOUNTS.gmail;
}

module.exports = {
  COMPOSIO_BASE,
  loadComposioConfig,
  requireGoogleCalendarAccount,
  requireGmailAccounts,
};
