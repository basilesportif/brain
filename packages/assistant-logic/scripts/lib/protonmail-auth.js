const fs = require("fs");
const yaml = require("yaml");
const { getWorkspaceContext, getWorkspacePaths } = require("./workspace");
const { loadWorkspaceEnv, requireEnv } = require("./runtime-env");

function loadProtonmailConfig(options = {}) {
  const context = options.context || getWorkspaceContext(options);
  const paths = getWorkspacePaths(context);
  const { env } = loadWorkspaceEnv({
    context,
    processEnv: options.processEnv,
  });

  let protonConfig = null;
  if (fs.existsSync(paths.protonmailPath)) {
    protonConfig = yaml.parse(fs.readFileSync(paths.protonmailPath, "utf-8")) || null;
  }

  const PROTON_ACCOUNTS = protonConfig?.protonmail?.accounts || [];
  const PROTON_ACCOUNT_LABELS = {};
  for (const account of PROTON_ACCOUNTS) {
    if (account?.email) {
      PROTON_ACCOUNT_LABELS[account.email] = account.label || account.email;
    }
  }

  return {
    context,
    paths,
    env,
    protonConfig,
    BRIDGE_HOST: protonConfig?.protonmail?.bridge_host || "127.0.0.1",
    BRIDGE_IMAP_PORT: protonConfig?.protonmail?.bridge_imap_port || 1143,
    BRIDGE_SMTP_PORT: protonConfig?.protonmail?.bridge_smtp_port || 1025,
    BRIDGE_USER: env.PROTONMAIL_BRIDGE_USER || null,
    BRIDGE_PASSWORD: env.PROTONMAIL_BRIDGE_PASSWORD || null,
    PROTON_ACCOUNTS,
    PROTON_ACCOUNT_LABELS,
  };
}

function requireBridgeCredentials(config) {
  return {
    user: requireEnv(
      config,
      "BRIDGE_USER",
      `PROTONMAIL_BRIDGE_USER must be set in ${config.paths.workspaceEnvPath}. Run /setup-protonmail first.`
    ),
    password: requireEnv(
      config,
      "BRIDGE_PASSWORD",
      `PROTONMAIL_BRIDGE_PASSWORD must be set in ${config.paths.workspaceEnvPath}. Run /setup-protonmail first.`
    ),
  };
}

function createImapClient(options = {}) {
  const config = options.protonmail || loadProtonmailConfig(options);
  const creds = requireBridgeCredentials(config);
  const { ImapFlow } = require("imapflow");

  return new ImapFlow({
    host: config.BRIDGE_HOST,
    port: config.BRIDGE_IMAP_PORT,
    secure: false,
    auth: {
      user: creds.user,
      pass: creds.password,
    },
    tls: {
      rejectUnauthorized: false,
    },
    logger: false,
  });
}

function createSmtpTransport(options = {}) {
  const config = options.protonmail || loadProtonmailConfig(options);
  const creds = requireBridgeCredentials(config);
  const nodemailer = require("nodemailer");

  return nodemailer.createTransport({
    host: config.BRIDGE_HOST,
    port: config.BRIDGE_SMTP_PORT,
    secure: false,
    auth: {
      user: creds.user,
      pass: creds.password,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });
}

function getAccountLabel(options = {}) {
  const config = options.protonmail || loadProtonmailConfig(options);
  if (config.PROTON_ACCOUNTS.length > 0) {
    return config.PROTON_ACCOUNTS[0].label || config.PROTON_ACCOUNTS[0].email;
  }
  return config.BRIDGE_USER || "ProtonMail";
}

module.exports = {
  loadProtonmailConfig,
  createImapClient,
  createSmtpTransport,
  getAccountLabel,
};
